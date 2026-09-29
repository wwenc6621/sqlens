/**
 * Normalizes parser output into complete `ConnectionConfig` drafts.
 *
 * Every parser produces partial configs; this module fills in defaults from
 * `createDefaultConnectionConfig`, validates required fields and records
 * non-fatal issues. The existing import chain (enc: dropping, id
 * regeneration, name de-duplication) stays in `ConnectionTransfer`.
 */

import {
  ConnectionConfig,
  createDefaultConnectionConfig,
  DatabaseType,
  SSLMode,
} from '../../types';
import { ParseIssue, ParsedConnection } from './types';

/** Common aliases seen in URIs, env keys and CSV "type" columns. */
const TYPE_ALIASES: Record<string, DatabaseType> = {
  mysql: DatabaseType.MySQL,
  mariadb: DatabaseType.MariaDB,
  postgres: DatabaseType.PostgreSQL,
  postgresql: DatabaseType.PostgreSQL,
  pg: DatabaseType.PostgreSQL,
  sqlite: DatabaseType.SQLite,
  sqlite3: DatabaseType.SQLite,
  redis: DatabaseType.Redis,
  mongodb: DatabaseType.MongoDB,
  mongo: DatabaseType.MongoDB,
  mssql: DatabaseType.MSSQL,
  sqlserver: DatabaseType.MSSQL,
  clickhouse: DatabaseType.ClickHouse,
  elasticsearch: DatabaseType.Elasticsearch,
  es: DatabaseType.Elasticsearch,
};

const PORT_HINTS: Record<number, DatabaseType> = {
  3306: DatabaseType.MySQL,
  5432: DatabaseType.PostgreSQL,
  6379: DatabaseType.Redis,
  27017: DatabaseType.MongoDB,
  1433: DatabaseType.MSSQL,
  8123: DatabaseType.ClickHouse,
  9200: DatabaseType.Elasticsearch,
};

export function normalizeType(raw: string): DatabaseType | undefined {
  return TYPE_ALIASES[String(raw || '').trim().toLowerCase()];
}

export function inferTypeFromPort(port: number | undefined): DatabaseType | undefined {
  if (port === undefined || !Number.isFinite(port)) { return undefined; }
  return PORT_HINTS[port];
}

export interface NormalizeInput {
  partial: Partial<ConnectionConfig>;
  format: ParsedConnection['source']['format'];
  line?: number;
  raw?: string;
  /** Parser-specific issues to attach regardless of normalization outcome. */
  extraIssues?: ParseIssue[];
}

export interface NormalizeOutput {
  parsed?: ParsedConnection;
  issues: ParseIssue[];
}

/**
 * Merge a partial config over the defaults for its type. Returns `undefined`
 * (with issues) when the entry is unusable.
 */
export function normalizeConnection(input: NormalizeInput): NormalizeOutput {
  const issues: ParseIssue[] = [...(input.extraIssues || [])];
  const { partial, format, line, raw } = input;

  // Resolve type: explicit value (with aliasing) → port hint.
  let type: DatabaseType | undefined;
  if (typeof partial.type === 'string') {
    type = normalizeType(partial.type);
    if (!type) {
      issues.push({ severity: 'error', message: `Unknown database type "${partial.type}"`, line });
    }
  }
  if (!type && partial.port !== undefined) {
    const inferred = inferTypeFromPort(Number(partial.port));
    if (inferred) {
      type = inferred;
      issues.push({ severity: 'warning', message: `Type inferred as "${inferred}" from port ${partial.port}`, line });
    }
  }
  if (!type) {
    issues.push({ severity: 'error', message: 'Missing or unresolvable "type"', line });
    return { issues };
  }

  const base = createDefaultConnectionConfig(type);
  const draft: ConnectionConfig = {
    ...base,
    ...partial,
    type,
    id: '',
    name: partial.name || '',
    ssl: { ...base.ssl, ...(partial.ssl || {}) },
    ssh: { ...base.ssh, ...(partial.ssh || {}) },
    options: { ...base.options, ...(partial.options || {}) },
    tags: [...(partial.tags || [])],
  };

  // Required fields per type.
  if (type === DatabaseType.SQLite) {
    if (!draft.filepath) {
      issues.push({ severity: 'error', message: 'SQLite connection requires a "filepath"', line });
      return { issues };
    }
  } else if (!draft.host) {
    issues.push({ severity: 'error', message: 'Missing "host"', line });
    return { issues };
  }

  // Port sanity.
  if (draft.port !== undefined && draft.port !== 0) {
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      issues.push({ severity: 'warning', message: `Invalid port ${draft.port}, reset to default`, line });
      draft.port = base.port;
    } else {
      draft.port = port;
    }
  }

  // Auto-name when the parser could not produce one.
  if (!draft.name) {
    draft.name = type === DatabaseType.SQLite
      ? draft.filepath!.split('/').pop() || 'SQLite'
      : `${draft.host}${draft.port ? `:${draft.port}` : ''}${draft.database ? `/${draft.database}` : ''} (${type})`;
  }

  return {
    parsed: { draft, source: { format, line, raw }, issues },
    issues,
  };
}

/** Normalize a batch, dropping entries that produced fatal errors. */
export function normalizeBatch(
  items: NormalizeInput[],
): { connections: ParsedConnection[]; droppedIssues: ParseIssue[] } {
  const connections: ParsedConnection[] = [];
  const droppedIssues: ParseIssue[] = [];
  for (const item of items) {
    const { parsed, issues } = normalizeConnection(item);
    if (parsed) {
      connections.push(parsed);
    } else {
      droppedIssues.push(...issues);
    }
  }
  return { connections, droppedIssues };
}

/** Map common sslmode spellings onto the SSLMode enum. */
export function mapSslMode(raw: string): SSLMode | undefined {
  const v = String(raw || '').trim().toLowerCase();
  switch (v) {
    case 'disable':
    case 'disabled':
    case 'false':
      return SSLMode.Disabled;
    case 'prefer':
    case 'preferred':
      return SSLMode.Preferred;
    case 'require':
    case 'required':
    case 'true':
    case 'yes':
      return SSLMode.Required;
    case 'verify-ca':
    case 'verify_ca':
      return SSLMode.VerifyCA;
    case 'verify-full':
    case 'verify_full':
      return SSLMode.VerifyFull;
    default:
      return undefined;
  }
}
