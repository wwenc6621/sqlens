/**
 * Connection URI mapping helpers — scheme → DatabaseType, and the reverse
 * direction used by "Copy as URI" (export side).
 */

import { DatabaseType, SSLMode } from '../../types';

export interface UriSchemeInfo {
  type: DatabaseType;
  /** Extra schemes that alias to the same type */
  aliases: string[];
  defaultPort: number;
}

export const URI_SCHEMES: Record<string, UriSchemeInfo> = {
  'mysql': { type: DatabaseType.MySQL, aliases: [], defaultPort: 3306 },
  'mariadb': { type: DatabaseType.MariaDB, aliases: [], defaultPort: 3306 },
  'postgres': { type: DatabaseType.PostgreSQL, aliases: ['postgresql'], defaultPort: 5432 },
  'sqlite': { type: DatabaseType.SQLite, aliases: [], defaultPort: 0 },
  'redis': { type: DatabaseType.Redis, aliases: [], defaultPort: 6379 },
  'rediss': { type: DatabaseType.Redis, aliases: [], defaultPort: 6379 },
  'mongodb': { type: DatabaseType.MongoDB, aliases: [], defaultPort: 27017 },
  'mongodb+srv': { type: DatabaseType.MongoDB, aliases: [], defaultPort: 27017 },
  'sqlserver': { type: DatabaseType.MSSQL, aliases: ['mssql'], defaultPort: 1433 },
  'clickhouse': { type: DatabaseType.ClickHouse, aliases: ['clickhousedb'], defaultPort: 8123 },
  'es': { type: DatabaseType.Elasticsearch, aliases: ['elastic', 'elasticsearch'], defaultPort: 9200 },
};

/** Resolve a URI scheme (case-insensitive) to its database type. */
export function schemeToType(scheme: string): DatabaseType | undefined {
  const s = String(scheme || '').trim().toLowerCase();
  for (const key of Object.keys(URI_SCHEMES)) {
    const info = URI_SCHEMES[key];
    if (s === key || info.aliases.includes(s)) { return info.type; }
  }
  return undefined;
}

/** Reverse mapping: DatabaseType → canonical scheme. */
export function typeToScheme(type: DatabaseType): string {
  switch (type) {
    case DatabaseType.MySQL: return 'mysql';
    case DatabaseType.MariaDB: return 'mariadb';
    case DatabaseType.PostgreSQL: return 'postgres';
    case DatabaseType.SQLite: return 'sqlite';
    case DatabaseType.Redis: return 'redis';
    case DatabaseType.MongoDB: return 'mongodb';
    case DatabaseType.MSSQL: return 'sqlserver';
    case DatabaseType.ClickHouse: return 'clickhouse';
    case DatabaseType.Elasticsearch: return 'es';
  }
}

const SSL_MODE_TO_PARAM: Record<SSLMode, string> = {
  [SSLMode.Disabled]: 'disabled',
  [SSLMode.Preferred]: 'preferred',
  [SSLMode.Required]: 'required',
  [SSLMode.VerifyCA]: 'verify-ca',
  [SSLMode.VerifyFull]: 'verify-full',
};

export interface BuildUriOptions {
  includePassword?: boolean;
  includeSsh?: boolean;
}

/** Build a standard connection URI from a config (export side). */
export function buildConnectionUri(config: {
  type: DatabaseType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  filepath?: string;
  ssl?: { mode: SSLMode };
  ssh?: { enabled: boolean; host?: string; port?: number; username?: string; password?: string };
}, opts: BuildUriOptions = {}): string {
  const scheme = typeToScheme(config.type);

  if (config.type === DatabaseType.SQLite) {
    return `sqlite://${config.filepath ?? ''}`;
  }

  let auth = '';
  if (config.username) {
    auth = encodeURIComponent(config.username);
    if (opts.includePassword && config.password) {
      auth += `:${encodeURIComponent(config.password)}`;
    }
    auth += '@';
  }

  let hostPart = config.host || '';
  if (hostPart.includes(':') && !hostPart.startsWith('[')) {
    hostPart = `[${hostPart}]`; // IPv6
  }
  const port = config.port && config.port !== URI_SCHEMES[scheme]?.defaultPort ? `:${config.port}` : '';
  const database = config.database ? `/${config.database}` : '';

  const params: string[] = [];
  if (config.ssl && config.ssl.mode && config.ssl.mode !== SSLMode.Preferred) {
    params.push(`sslmode=${SSL_MODE_TO_PARAM[config.ssl.mode]}`);
  }
  if (opts.includeSsh && config.ssh?.enabled && config.ssh.host) {
    params.push(`ssh=true`);
    params.push(`ssh_host=${encodeURIComponent(config.ssh.host)}`);
    if (config.ssh.port && config.ssh.port !== 22) { params.push(`ssh_port=${config.ssh.port}`); }
    if (config.ssh.username) { params.push(`ssh_user=${encodeURIComponent(config.ssh.username)}`); }
    if (opts.includePassword && config.ssh.password) { params.push(`ssh_pass=${encodeURIComponent(config.ssh.password)}`); }
  }

  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return `${scheme}://${auth}${hostPart}${port}${database}${query}`;
}
