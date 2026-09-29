/**
 * Parser for backend config files: Spring Boot `application.yml` /
 * `application.properties` (and generic properties files carrying JDBC URLs).
 *
 * Recognized shapes:
 *
 *   YAML:
 *     spring:
 *       datasource:
 *         url: jdbc:mysql://10.0.0.1:3306/shop?useSSL=false
 *         username: root
 *         password: secret
 *
 *   Properties:
 *     spring.datasource.url=jdbc:mysql://10.0.0.1:3306/shop
 *     spring.datasource.username=root
 *     spring.datasource.password=secret
 *
 *   Split-style keys for other engines (YAML nesting or dotted properties):
 *     spring:
 *       redis:
 *         host: cache.local
 *         port: 6380
 *     spring.elasticsearch.uris=http://es:9200
 *
 * Passwords found in configs are imported as-is (they are plaintext in these
 * files by definition); nothing is decrypted.
 */

import { DatabaseType, SSLMode } from '../../types';
import { normalizeBatch } from './normalizer';
import { ImportFormat, ParsedConnection, Parser } from './types';

/** jdbc dialect → sqlens type. */
const DIALECT_TYPES: Record<string, DatabaseType> = {
  mysql: DatabaseType.MySQL,
  mariadb: DatabaseType.MariaDB,
  postgresql: DatabaseType.PostgreSQL,
  postgres: DatabaseType.PostgreSQL,
  sqlite: DatabaseType.SQLite,
  sqlserver: DatabaseType.MSSQL,
  mssql: DatabaseType.MSSQL,
  clickhouse: DatabaseType.ClickHouse,
};

/** Split-key prefixes (spring.redis, spring.data.redis, …) → type. */
const PREFIX_TYPES: Record<string, DatabaseType> = {
  'spring.redis': DatabaseType.Redis,
  'spring.data.redis': DatabaseType.Redis,
  redis: DatabaseType.Redis,
  'spring.mongodb': DatabaseType.MongoDB,
  'spring.data.mongodb': DatabaseType.MongoDB,
  'spring.elasticsearch': DatabaseType.Elasticsearch,
  'spring.elasticsearch.rest': DatabaseType.Elasticsearch,
};

const SUFFIX_FIELDS: Record<string, string> = {
  host: 'host',
  node: 'host',
  port: 'port',
  username: 'username',
  user: 'username',
  password: 'password',
  database: 'database',
  uris: 'uris',
  url: 'url',
};

const JDBC_RE = /^jdbc:([a-z0-9]+):\/\/([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/i;

export class SpringConfigParser implements Parser {
  get format(): ImportFormat { return 'spring'; }

  probe(text: string): number {
    if (/jdbc:[a-z0-9]+:\/\//i.test(text)) {
      return /(^|\n)\s*[\w.-]*datasource|spring\.datasource|jdbc-url/i.test(text) ? 1 : 0.7;
    }
    if (/^\s*(spring\.)?(data\.)?(datasource|redis|mongodb|elasticsearch)\b/m.test(text)
      && /^\s*[\w.-]*(host|url|uris|port)\s*[:=]/mi.test(text)) {
      return 0.8;
    }
    return 0;
  }

  parse(text: string): ParsedConnection[] {
    const items: Parameters<typeof normalizeBatch>[0] = [];
    const isProperties = /^[ \t]*[\w.-]+\s*=[^>]/m.test(text) && !/^\s*[\w-]+:\s*$/m.test(text);

    if (isProperties) {
      const pairs = this.propertiesPairs(text);
      items.push(...this.jdbcGroups(pairs));
      items.push(...this.splitKeyGroups(pairs));
    } else {
      items.push(...this.parseYamlJdbcBlocks(text));
      items.push(...this.splitKeyGroups(this.flattenYamlKeys(text)));
    }

    return normalizeBatch(items).connections;
  }

  /** YAML: consecutive `url: jdbc:...` + username/password lines. */
  private parseYamlJdbcBlocks(text: string): Array<Parameters<typeof normalizeBatch>[0][number]> {
    const items: Array<Parameters<typeof normalizeBatch>[0][number]> = [];
    const lines = text.split(/\r?\n/);
    let current: Record<string, unknown> | undefined;
    let urlIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const urlMatch = line.match(/^(\s*)url\s*:\s*(\S+)/);
      if (urlMatch && /^jdbc:/i.test(urlMatch[2])) {
        const partial = this.fromJdbcUrl(this.unquote(urlMatch[2]));
        if (partial) {
          current = partial;
          urlIndent = urlMatch[1].length;
          items.push({ partial, format: 'spring', line: i + 1, raw: urlMatch[2] });
        } else {
          current = undefined;
        }
        continue;
      }
      if (!current) { continue; }
      // username/password are siblings of `url:` under datasource:; the block
      // only ends when a key dedents ABOVE the url: line (e.g. `redis:`).
      const indent = line.length - line.trimStart().length;
      if (indent < urlIndent) {
        current = undefined;
        continue;
      }
      const userMatch = line.match(/^\s*(?:username|user)\s*:\s*(\S+)/);
      if (userMatch) { current.username = this.unquote(userMatch[1]); continue; }
      const passMatch = line.match(/^\s*password\s*:\s*(\S+)/);
      if (passMatch) { current.password = this.unquote(passMatch[1]); continue; }
      const dbMatch = line.match(/^\s*database\s*:\s*(\S+)/);
      if (dbMatch && !current.database) { current.database = this.unquote(dbMatch[1]); }
    }
    return items;
  }

  /** Flatten YAML nesting into `spring.redis.host`-style full keys. */
  private flattenYamlKeys(text: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const stack: Array<{ indent: number; key: string }> = [];
    for (const raw of text.split(/\r?\n/)) {
      if (/^\s*#/.test(raw) || !raw.trim()) { continue; }
      const indent = raw.length - raw.trimStart().length;
      const m = raw.trim().match(/^([\w.-]+)\s*:\s*(.*)$/);
      if (!m) { continue; }
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      const key = m[1];
      const value = m[2].trim();
      if (value === '' || value === '|' || value === '>') {
        stack.push({ indent, key });
        continue;
      }
      const fullKey = [...stack.map(s => s.key), key].join('.').toLowerCase();
      out.push([fullKey, this.unquote(value)]);
    }
    return out;
  }

  private propertiesPairs(text: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (m) { out.push([m[1].toLowerCase(), this.unquote(m[2])]); }
    }
    return out;
  }

  /** Groups with a JDBC url (spring.datasource.url=jdbc:...). */
  private jdbcGroups(pairs: Array<[string, string]>): Array<Parameters<typeof normalizeBatch>[0][number]> {
    const items: Array<Parameters<typeof normalizeBatch>[0][number]> = [];
    const groups = new Map<string, Record<string, string>>();
    for (const [key, value] of pairs) {
      const dot = key.lastIndexOf('.');
      if (dot <= 0) { continue; }
      const prefix = key.slice(0, dot);
      const field = key.slice(dot + 1);
      if (!['url', 'jdbc-url', 'username', 'user', 'password', 'database'].includes(field)) { continue; }
      const group = groups.get(prefix) || {};
      group[field] = value;
      groups.set(prefix, group);
    }
    for (const [prefix, group] of groups) {
      const url = group['url'] || group['jdbc-url'];
      if (!url || !/^jdbc:/i.test(url)) { continue; }
      const partial = this.fromJdbcUrl(url);
      if (!partial) { continue; }
      if (group.username) { partial.username = group.username; }
      if (group.password) { partial.password = group.password; }
      if (group.database && !partial.database) { partial.database = group.database; }
      items.push({ partial, format: 'spring', raw: prefix });
    }
    return items;
  }

  /** redis/mongo/es split keys (spring.redis.host=…, mongodb.uris=…). */
  private splitKeyGroups(pairs: Array<[string, string]>): Array<Parameters<typeof normalizeBatch>[0][number]> {
    const items: Array<Parameters<typeof normalizeBatch>[0][number]> = [];
    const groups = new Map<string, Record<string, string>>();
    for (const [key, value] of pairs) {
      for (const prefix of Object.keys(PREFIX_TYPES)) {
        const p = prefix.toLowerCase();
        if (key !== p && !key.startsWith(`${p}.`)) { continue; }
        const suffix = key === p ? '' : key.slice(p.length + 1);
        // Skip jdbc datasource keys — those belong to the JDBC path.
        if (suffix === 'url' && /^jdbc:/i.test(value)) { break; }
        const field = suffix ? SUFFIX_FIELDS[suffix] : undefined;
        if (!field) { break; }
        const group = groups.get(prefix) || {};
        group[field] = value;
        groups.set(prefix, group);
        break;
      }
    }
    for (const [prefix, group] of groups) {
      const type = PREFIX_TYPES[prefix];
      if (!type || Object.keys(group).length === 0) { continue; }

      const partial: Record<string, unknown> = { type };
      if (group.uris) {
        // spring.elasticsearch.uris=http://host:9200 (comma separated)
        Object.assign(partial, this.parseHttpUri(group.uris.split(',')[0].trim()));
      } else if (group.url) {
        Object.assign(partial, this.parseHttpUri(group.url));
      } else {
        if (group.host) { partial.host = group.host; }
        if (group.port) { const n = Number(group.port); if (Number.isFinite(n)) { partial.port = n; } }
      }
      if (group.username) { partial.username = group.username; }
      if (group.password) { partial.password = group.password; }
      if (Object.keys(partial).length > 1) {
        items.push({ partial, format: 'spring', raw: prefix });
      }
    }
    return items;
  }

  /** jdbc:mysql://host:port/db?useSSL=false → partial config. */
  private fromJdbcUrl(url: string): Record<string, unknown> | undefined {
    const m = url.match(JDBC_RE);
    if (!m) { return undefined; }
    const dialect = m[1].toLowerCase();
    const type = DIALECT_TYPES[dialect];
    if (!type) { return undefined; }

    const partial: Record<string, unknown> = { type };
    if (type === DatabaseType.SQLite) {
      partial.filepath = url.replace(/^jdbc:sqlite:/i, '');
      return partial;
    }

    const authority = m[2];
    const colon = authority.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(authority.slice(colon + 1))) {
      partial.host = authority.slice(0, colon);
      partial.port = Number(authority.slice(colon + 1));
    } else {
      partial.host = authority;
    }
    if (m[3]) {
      const db = decodeURIComponent(m[3]);
      if (db) { partial.database = db; }
    }

    const ssl: Record<string, unknown> = {};
    const options: Record<string, unknown> = {};
    if (m[4]) {
      for (const pair of m[4].split('&')) {
        const eq = pair.indexOf('=');
        const key = eq >= 0 ? pair.slice(0, eq) : pair;
        const value = eq >= 0 ? pair.slice(eq + 1) : '';
        const lower = key.toLowerCase();
        if (lower === 'usessl') {
          if (value === 'false') { ssl.mode = SSLMode.Disabled; }
          else if (value === 'true' || value === 'required') { ssl.mode = SSLMode.Required; }
        } else if (lower === 'sslmode') {
          if (value === 'disable' || value === 'disabled') { ssl.mode = SSLMode.Disabled; }
          else if (value === 'require' || value === 'required') { ssl.mode = SSLMode.Required; }
        } else {
          options[key] = value;
        }
      }
    }
    if (Object.keys(ssl).length > 0) { partial.ssl = ssl; }
    if (Object.keys(options).length > 0) { partial.options = options; }
    return partial;
  }

  /** http://host:9200 style URI (redis/es over plain URLs). */
  private parseHttpUri(uri: string): { host?: string; port?: number } {
    const m = uri.match(/^[a-z]+:\/\/([^/:?]+)(?::(\d+))?/i);
    if (!m) { return {}; }
    return {
      host: m[1],
      port: m[2] ? Number(m[2]) : undefined,
    };
  }

  private unquote(value: string): string {
    return value.replace(/^["']|["']$/g, '');
  }
}
