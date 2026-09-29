/**
 * Parser for DataGrip / IntelliJ "Copy Settings" output:
 *
 *   #DataSourceSettings#
 *   #LocalDataSource: jsaap1570
 *   #BEGIN#
 *   <data-source source="LOCAL" name="jsaap1570" ...>
 *     <... jdbc-url="jdbc:mysql://10.19.32.107:3306/jsaap1570?useSSL=false..." ...>
 *     <user-name>root</user-name>
 *     ...
 *   </data-source>
 *   #END#
 *
 * Passwords are never included in this format (DataGrip asks for them on
 * first connect) — the draft keeps an empty password and records an issue.
 * Extra JDBC query params land in `options`; `useSSL=false` maps to
 * ssl.mode=disabled.
 */

import { DatabaseType, SSLMode } from '../../types';
import { parseJdbcUrl } from './dbeaverParser';
import { normalizeBatch } from './normalizer';
import { ImportFormat, ParseIssue, ParsedConnection, Parser } from './types';

const PRODUCT_TYPES: Record<string, DatabaseType> = {
  MYSQL: DatabaseType.MySQL,
  MARIADB: DatabaseType.MariaDB,
  POSTGRESQL: DatabaseType.PostgreSQL,
  SQLITE: DatabaseType.SQLite,
  SQLSERVER: DatabaseType.MSSQL,
  MONGO: DatabaseType.MongoDB,
  MONGODB: DatabaseType.MongoDB,
  REDIS: DatabaseType.Redis,
  CLICKHOUSE: DatabaseType.ClickHouse,
  ELASTICSEARCH: DatabaseType.Elasticsearch,
};

const NO_PASSWORD_ISSUE: ParseIssue = {
  severity: 'warning',
  message: 'DataGrip does not export passwords — fill it in before connecting',
};

/** jdbc:mysql://host:port/db?param=1&param=2 */
const JDBC_URL_RE = /^jdbc:([a-z0-9]+):\/\/([^/?]+)/i;
const PARAMS_RE = /\?([^#]*)/;

export class DataGripParser implements Parser {
  get format(): ImportFormat { return 'datagrip'; }

  probe(text: string): number {
    return /#DataSourceSettings#/.test(text) && /<data-source\b/.test(text)
      ? 1
      : 0;
  }

  parse(text: string): ParsedConnection[] {
    const items: Parameters<typeof normalizeBatch>[0] = [];

    for (const block of this.extractBlocks(text)) {
      const parsed = this.parseBlock(block.xml);
      if (parsed) { items.push(parsed); }
    }
    return normalizeBatch(items).connections;
  }

  /** One item per <data-source> element (a copied block may hold several). */
  private extractBlocks(text: string): Array<{ xml: string }> {
    const blocks: Array<{ xml: string }> = [];
    const re = /<data-source\b[^>]*>[\s\S]*?<\/data-source>|<data-source\b[^/>]*\/>/g;
    for (const m of text.matchAll(re)) {
      blocks.push({ xml: m[0] });
    }
    return blocks;
  }

  private attr(xml: string, attr: string): string | undefined {
    const m = xml.match(new RegExp(`${attr}="([^"]*)"`));
    return m ? m[1] : undefined;
  }

  private parseBlock(xml: string): Parameters<typeof normalizeBatch>[0][number] | undefined {
    const product = (this.attr(xml, 'product') || this.attr(xml, 'dbms') || '').toUpperCase();
    const type = PRODUCT_TYPES[product];
    if (!type) { return undefined; }

    const jdbcUrl = this.decodeEntities(this.attr(xml, 'jdbc-url') || this.element(xml, 'jdbc-url') || '');
    const partial: Record<string, unknown> = {
      type,
      name: this.attr(xml, 'name'),
      username: this.element(xml, 'user-name') || undefined,
    };

    // Host/port/database primarily from the JDBC URL.
    const urlMatch = jdbcUrl.match(JDBC_URL_RE);
    if (urlMatch) {
      const authority = urlMatch[2];
      const pathStart = jdbcUrl.indexOf('/', jdbcUrl.indexOf('//') + 2);
      const queryStart = jdbcUrl.indexOf('?', pathStart);
      const db = pathStart >= 0
        ? decodeURIComponent(jdbcUrl.slice(pathStart + 1, queryStart >= 0 ? queryStart : undefined))
        : '';
      if (authority.startsWith('[')) {
        // IPv6 literal [::1]:3306
        const close = authority.indexOf(']');
        partial.host = authority.slice(1, close >= 0 ? close : undefined);
        const tail = close >= 0 ? authority.slice(close + 1) : '';
        if (tail.startsWith(':')) { partial.port = Number(tail.slice(1)); }
      } else {
        const colon = authority.lastIndexOf(':');
        if (colon > 0 && /^\d+$/.test(authority.slice(colon + 1))) {
          partial.host = authority.slice(0, colon);
          partial.port = Number(authority.slice(colon + 1));
        } else {
          partial.host = authority;
        }
      }
      if (db) { partial.database = db; }
    } else if (jdbcUrl) {
      // Non-network JDBC dialects (e.g. jdbc:sqlite:/path/file.db).
      const fallback = parseJdbcUrl(jdbcUrl);
      Object.assign(partial, fallback.host ? fallback : {});
      if (type === DatabaseType.SQLite && !partial.filepath) {
        partial.filepath = jdbcUrl.replace(/^jdbc:sqlite:/i, '');
      }
    }

    // Query params → options; ssl flags → ssl config.
    const paramsMatch = jdbcUrl.match(PARAMS_RE);
    const ssl: Record<string, unknown> = {};
    if (paramsMatch) {
      const options: Record<string, unknown> = {};
      for (const pair of paramsMatch[1].split('&')) {
        const eq = pair.indexOf('=');
        const key = eq >= 0 ? pair.slice(0, eq) : pair;
        const value = eq >= 0 ? pair.slice(eq + 1) : '';
        const lower = key.toLowerCase();
        if (lower === 'usessl') {
          if (value === 'false') { ssl.mode = SSLMode.Disabled; }
          else if (value === 'true' || value === 'required') { ssl.mode = SSLMode.Required; }
          continue;
        }
        if (lower === 'sslmode') {
          if (value === 'disable' || value === 'disabled') { ssl.mode = SSLMode.Disabled; }
          else if (value === 'require' || value === 'required') { ssl.mode = SSLMode.Required; }
          else if (value === 'verify-ca' || value === 'verify-ca-full' || value === 'verify-full') {
            ssl.mode = value === 'verify-full' ? SSLMode.VerifyFull : SSLMode.VerifyCA;
          }
          continue;
        }
        options[key] = value;
      }
      if (Object.keys(options).length > 0) { partial.options = options; }
    }
    if (Object.keys(ssl).length > 0) { partial.ssl = ssl; }

    return {
      partial,
      format: 'datagrip' as ImportFormat,
      raw: this.attr(xml, 'name'),
      extraIssues: [NO_PASSWORD_ISSUE],
    };
  }

  private element(xml: string, tag: string): string | undefined {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? this.decodeEntities(m[1].trim()) : undefined;
  }

  /** Resolve the XML entities DataGrip uses inside element values (&amp; etc.). */
  private decodeEntities(value: string): string {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }
}
