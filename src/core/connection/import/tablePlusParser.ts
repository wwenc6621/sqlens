/**
 * Parser for TablePlus connection exports (JSON).
 *
 * TablePlus exports connections as JSON — either a bare array or
 * `{ "Connections": [...] }` (Export Connections / backup file). Field
 * spelling varies slightly across versions, so keys are matched
 * case-insensitively against a set of aliases.
 *
 * Password policy: TablePlus stores passwords in the macOS Keychain and
 * exports never contain them — the draft keeps an empty password and a
 * warning issue is recorded.
 */

import { DatabaseType } from '../../types';
import { normalizeBatch } from './normalizer';
import { ImportFormat, ParseIssue, ParsedConnection, Parser } from './types';

const KEY_ALIASES: Record<string, string[]> = {
  name: ['name', 'connectionName', 'displayName'],
  type: ['database', 'driver', 'type', 'connectionType'],
  host: ['host', 'server', 'hostname'],
  port: ['port'],
  username: ['user', 'username', 'login'],
  database: ['databaseName', 'initialDatabase', 'dbName'],
  filepath: ['path', 'file', 'sqliteFile'],
  ssl: ['ssl', 'sslEnabled', 'useSSL', 'useTls'],
  sshHost: ['sshHost', 'sshServer'],
  sshPort: ['sshPort'],
  sshUser: ['sshUser', 'sshUsername'],
};

const TYPE_ALIASES: Record<string, DatabaseType> = {
  mysql: DatabaseType.MySQL,
  mariadb: DatabaseType.MariaDB,
  postgres: DatabaseType.PostgreSQL,
  postgresql: DatabaseType.PostgreSQL,
  pgsql: DatabaseType.PostgreSQL,
  sqlite: DatabaseType.SQLite,
  sqlite3: DatabaseType.SQLite,
  sqlserver: DatabaseType.MSSQL,
  mssql: DatabaseType.MSSQL,
  mongodb: DatabaseType.MongoDB,
  mongo: DatabaseType.MongoDB,
  redis: DatabaseType.Redis,
  rediss: DatabaseType.Redis,
  clickhouse: DatabaseType.ClickHouse,
  elasticsearch: DatabaseType.Elasticsearch,
};

const NO_PASSWORD_ISSUE: ParseIssue = {
  severity: 'warning',
  message: 'TablePlus keeps passwords in the system keychain — the password was not imported, fill it in before connecting',
};

const IGNORED_TYPES = new Set(['cassandra', 'h2', 'derby']);

export class TablePlusParser implements Parser {
  get format(): ImportFormat { return 'tableplus'; }

  probe(text: string): number {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) { return 0; }
    try {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : parsed?.Connections;
      if (!Array.isArray(list)) { return 0; }
      return list.some(entry =>
        entry && typeof entry === 'object'
        && typeof (entry as { database?: unknown }).database === 'string'
        && TYPE_ALIASES[(entry as { database: string }).database.toLowerCase()] !== undefined,
      ) ? 0.95 : 0;
    } catch {
      return 0;
    }
  }

  parse(text: string): ParsedConnection[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      return [];
    }
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { Connections?: unknown }).Connections))
          ? (parsed as { Connections: unknown[] }).Connections
          : [];

    const items: Parameters<typeof normalizeBatch>[0] = [];
    list.forEach((entry, i) => {
      const item = this.build(entry);
      if (item) {
        items.push({ ...item, line: i + 1 });
      }
    });
    return normalizeBatch(items).connections;
  }

  private build(entry: unknown): Parameters<typeof normalizeBatch>[0][number] | undefined {
    if (!entry || typeof entry !== 'object') { return undefined; }
    const record = entry as Record<string, unknown>;

    const typeKey = this.first(record, KEY_ALIASES.type) || '';
    const type = TYPE_ALIASES[String(typeKey).toLowerCase()];
    if (!type || IGNORED_TYPES.has(String(typeKey).toLowerCase())) { return undefined; }

    const partial: Record<string, unknown> = {
      type,
      name: this.first(record, KEY_ALIASES.name),
      username: this.first(record, KEY_ALIASES.username) || undefined,
    };

    if (type === DatabaseType.SQLite) {
      partial.filepath = this.first(record, KEY_ALIASES.filepath) || undefined;
    } else {
      partial.host = this.first(record, KEY_ALIASES.host) || undefined;
      const port = Number(this.first(record, KEY_ALIASES.port));
      if (Number.isFinite(port) && port > 0) { partial.port = port; }
      partial.database = this.first(record, KEY_ALIASES.database) || undefined;
    }

    const sslValue = String(this.first(record, KEY_ALIASES.ssl) || '').toLowerCase();
    if (sslValue === 'true' || sslValue === '1' || sslValue === 'required') {
      partial.ssl = { mode: 'required' };
    }

    const sshHost = this.first(record, KEY_ALIASES.sshHost);
    if (sshHost) {
      const sshPort = Number(this.first(record, KEY_ALIASES.sshPort));
      partial.ssh = {
        enabled: true,
        host: sshHost,
        port: Number.isFinite(sshPort) && sshPort > 0 ? sshPort : 22,
        username: this.first(record, KEY_ALIASES.sshUser) || '',
      };
    }

    return {
      partial,
      format: 'tableplus' as ImportFormat,
      raw: this.first(record, KEY_ALIASES.name),
      extraIssues: [NO_PASSWORD_ISSUE],
    };
  }

  /** First defined, non-empty value among the alias keys (case-insensitive). */
  private first(record: Record<string, unknown>, aliases: string[]): string | undefined {
    const lowerMap = new Map<string, unknown>();
    for (const [key, value] of Object.entries(record)) {
      lowerMap.set(key.toLowerCase(), value);
    }
    for (const alias of aliases) {
      const value = lowerMap.get(alias.toLowerCase());
      if (value !== undefined && value !== null && String(value) !== '') {
        return String(value);
      }
    }
    return undefined;
  }
}
