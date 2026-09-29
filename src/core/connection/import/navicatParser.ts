/**
 * Parser for Navicat's "Export Connections" `.ncx` plaintext XML.
 *
 * Navicat has used several ncx shapes over the years; this parser is
 * deliberately tolerant and supports the two most common ones:
 *
 *   1) Legacy per-provider tags:
 *      <NavicatConnection>
 *        <mysql ConnectionName="prod" Host="10.0.0.1" Port="3306" UserName="root" Database="shop"/>
 *        <postgresql ConnectionName="pg" Host="db" Port="5432" UserName="dev" Database="app"/>
 *      </NavicatConnection>
 *
 *   2) Newer <server> style:
 *      <NavicatConnection>
 *        <server>
 *          <general ConnectionName="prod" ConnectionType="MYSQL" Host="10.0.0.1" Port="3306" UserName="root" Database="shop"/>
 *        </server>
 *      </NavicatConnection>
 *
 * Password policy: passwords in ncx are encrypted (Blowfish-derived, machine
 * dependent) and we do NOT attempt to decrypt them — any password attribute
 * is ignored and a warning issue is recorded.
 */

import { DatabaseType } from '../../types';
import { normalizeBatch } from './normalizer';
import { ImportFormat, ParseIssue, ParsedConnection, Parser } from './types';

/** ncx tag names / ConnectionType values → sqlens types. */
const PROVIDER_TYPES: Record<string, DatabaseType> = {
  mysql: DatabaseType.MySQL,
  mariadb: DatabaseType.MariaDB,
  postgresql: DatabaseType.PostgreSQL,
  pgsql: DatabaseType.PostgreSQL,
  sqlite: DatabaseType.SQLite,
  sqlserver: DatabaseType.MSSQL,
  mssql: DatabaseType.MSSQL,
  mongodb: DatabaseType.MongoDB,
  mongo: DatabaseType.MongoDB,
  redis: DatabaseType.Redis,
  clickhouse: DatabaseType.ClickHouse,
  elasticsearch: DatabaseType.Elasticsearch,
};

const NO_PASSWORD_ISSUE: ParseIssue = {
  severity: 'warning',
  message: 'Navicat encrypts stored passwords — the password was not imported, fill it in before connecting',
};

const ATTRIBUTE_ALIASES: Record<string, string[]> = {
  name: ['ConnectionName', 'Name', 'connectionName'],
  host: ['Host', 'ServerName', 'host'],
  port: ['Port', 'port'],
  username: ['UserName', 'User', 'userName', 'username'],
  database: ['Database', 'InitialCatalog', 'database'],
  filepath: ['DatabaseFilePath', 'DatabaseFile', 'filePath'],
};

export class NavicatParser implements Parser {
  get format(): ImportFormat { return 'navicat'; }

  probe(text: string): number {
    // Encrypted ncx (binary or base64 blob) is out of scope — XML only.
    if (!/<NavicatConnection|<navicat/i.test(text)) { return 0; }
    const providerTags = Object.keys(PROVIDER_TYPES)
      .map(k => `<${k}\\b`).join('|');
    return new RegExp(providerTags, 'i').test(text) || /<server\b|<general\b/i.test(text)
      ? 0.9
      : 0;
  }

  parse(text: string): ParsedConnection[] {
    const items: Parameters<typeof normalizeBatch>[0] = [];

    // Shape 1: direct provider tags.
    for (const [provider, type] of Object.entries(PROVIDER_TYPES)) {
      const re = new RegExp(`<${provider}\\b([^>]*)/>|<${provider}\\b[^>]*>([\\s\\S]*?)</${provider}>`, 'gi');
      for (const m of text.matchAll(re)) {
        const attrs = m[1] ?? m[2] ?? '';
        items.push(this.build(type, attrs));
      }
    }

    // Shape 2: <server><general .../></server> (ConnectionType attribute).
    if (items.length === 0) {
      for (const m of text.matchAll(/<(?:general|server)\b([^>]*)>/gi)) {
        const attrs = m[1] || '';
        const typeValue = this.attr(attrs, 'ConnectionType') || this.attr(attrs, 'connectionType') || this.attr(attrs, 'Type');
        const type = PROVIDER_TYPES[String(typeValue || '').toLowerCase()];
        if (type) { items.push(this.build(type, attrs)); }
      }
    }

    return normalizeBatch(items).connections;
  }

  private build(type: DatabaseType, attrs: string): Parameters<typeof normalizeBatch>[0][number] {
    const partial: Record<string, unknown> = {
      type,
      name: this.firstAttr(attrs, ATTRIBUTE_ALIASES.name),
      username: this.firstAttr(attrs, ATTRIBUTE_ALIASES.username) || undefined,
    };
    if (type === DatabaseType.SQLite) {
      partial.filepath = this.firstAttr(attrs, ATTRIBUTE_ALIASES.filepath)
        || this.firstAttr(attrs, ATTRIBUTE_ALIASES.database)
        || undefined;
    } else {
      partial.host = this.firstAttr(attrs, ATTRIBUTE_ALIASES.host);
      const port = Number(this.firstAttr(attrs, ATTRIBUTE_ALIASES.port));
      if (Number.isFinite(port) && port > 0) { partial.port = port; }
      partial.database = this.firstAttr(attrs, ATTRIBUTE_ALIASES.database) || undefined;
    }
    return {
      partial,
      format: 'navicat' as ImportFormat,
      raw: this.firstAttr(attrs, ATTRIBUTE_ALIASES.name),
      extraIssues: [NO_PASSWORD_ISSUE],
    };
  }

  private firstAttr(attrs: string, names: string[]): string | undefined {
    for (const name of names) {
      const value = this.attr(attrs, name);
      if (value !== undefined && value !== '') { return value; }
    }
    return undefined;
  }

  private attr(attrs: string, name: string): string | undefined {
    const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
    return m ? this.decodeEntities(m[1]) : undefined;
  }

  private decodeEntities(value: string): string {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }
}
