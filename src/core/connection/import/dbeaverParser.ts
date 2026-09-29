/**
 * Parser for DBeaver's `data-sources.json` (File → Export → DBeaver project
 * or the connections file inside the DBeaver workspace).
 *
 * Structure:
 *   { "data-sources": { "<uuid>": { provider, name, configuration: {...} } } }
 *
 * Passwords live in the separately AES-encrypted `credentials-config.json`;
 * they are intentionally NOT decrypted here — the draft keeps an empty
 * password and records an issue so the user knows to fill it in later.
 */

import { DatabaseType } from '../../types';
import { normalizeBatch } from './normalizer';
import { ImportFormat, ParsedConnection, Parser } from './types';

const PROVIDER_TYPES: Record<string, DatabaseType> = {
  mysql: DatabaseType.MySQL,
  mariadb: DatabaseType.MariaDB,
  postgresql: DatabaseType.PostgreSQL,
  postgres: DatabaseType.PostgreSQL,
  sqlite: DatabaseType.SQLite,
  sqlserver: DatabaseType.MSSQL,
  mssql: DatabaseType.MSSQL,
  mongo: DatabaseType.MongoDB,
  mongodb: DatabaseType.MongoDB,
  redis: DatabaseType.Redis,
  clickhouse: DatabaseType.ClickHouse,
  elastic: DatabaseType.Elasticsearch,
  elasticsearch: DatabaseType.Elasticsearch,
};

/** Extract host/port/db from a JDBC URL when the configuration lacks fields. */
export function parseJdbcUrl(url: string): { host?: string; port?: number; database?: string } {
  const m = url.match(/^jdbc:[a-z0-9]+:\/\/([^/:?]+)(?::(\d+))?(?:\/([^?]*))?/i);
  if (!m) { return {}; }
  return {
    host: m[1],
    port: m[2] ? Number(m[2]) : undefined,
    database: m[3] || undefined,
  };
}

const NO_PASSWORD_ISSUE = {
  severity: 'warning' as const,
  message: 'DBeaver stores passwords in an encrypted credentials file — the password was not imported, fill it in before connecting',
};

export class DBeaverParser implements Parser {
  get format(): ImportFormat { return 'dbeaver'; }

  probe(text: string): number {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) { return 0; }
    try {
      const parsed = JSON.parse(trimmed) as { 'data-sources'?: unknown };
      return parsed && typeof parsed === 'object' && parsed['data-sources'] && typeof parsed['data-sources'] === 'object'
        ? 1
        : 0;
    } catch {
      return 0;
    }
  }

  parse(text: string): ParsedConnection[] {
    let parsed: { 'data-sources'?: Record<string, DBeaverSource> };
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      return [];
    }
    const sources = parsed['data-sources'];
    if (!sources || typeof sources !== 'object') { return []; }

    const items: Parameters<typeof normalizeBatch>[0] = [];
    let index = 0;
    for (const entry of Object.values(sources)) {
      index++;
      if (!entry || typeof entry !== 'object') { continue; }
      const type = PROVIDER_TYPES[String(entry.provider || '').toLowerCase()];
      if (!type) { continue; }

      const cfg = entry.configuration || {};
      const partial: Record<string, unknown> = {
        type,
        name: entry.name,
        host: cfg.host,
        port: cfg.port !== undefined && cfg.port !== '' ? Number(cfg.port) : undefined,
        username: cfg.user || cfg.userName || undefined,
        database: cfg.database || undefined,
      };

      if (type === DatabaseType.SQLite) {
        // SQLite configurations carry the file path in `database` or `path`.
        partial.filepath = cfg.path || cfg.database;
        delete partial.host;
        delete partial.port;
        delete partial.username;
        delete partial.database;
      } else if (!partial.host && cfg.url) {
        Object.assign(partial, parseJdbcUrl(String(cfg.url)));
      }

      items.push({
        partial,
        format: 'dbeaver',
        line: index,
        raw: entry.name,
        extraIssues: [NO_PASSWORD_ISSUE],
      });
    }
    return normalizeBatch(items).connections;
  }
}

interface DBeaverSource {
  provider?: string;
  name?: string;
  configuration?: {
    host?: string;
    port?: string | number;
    database?: string;
    path?: string;
    user?: string;
    userName?: string;
    url?: string;
  };
}
