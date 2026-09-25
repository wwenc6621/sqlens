import { createClient, ClickHouseClient } from '@clickhouse/client';
import { BaseDriver } from './DatabaseDriver';
import { Logger } from '../utils/Logger';
import {
  ConnectionConfig,
  QueryResult,
  ColumnHeader,
  NormalizedColumnType,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  SchemaInfo,
  DatabaseInfo,
  ServerInfo,
} from '../types';

/**
 * ClickHouse database driver (HTTP protocol, official @clickhouse/client).
 *
 * ClickHouse-specific behaviours (see docs/CLICKHOUSE_SUPPORT_DESIGN.md):
 *  - Introspection goes through system.databases / system.tables / system.columns
 *    (there is no information_schema).
 *  - There is no schema layer: getSchemas() returns [].
 *  - There are no foreign keys: getForeignKeys() returns [].
 *  - "Primary key" means the sorting key (ORDER BY of the MergeTree engine);
 *    columns report is_in_primary_key from system.columns.
 *  - `USE <db>` does not persist across HTTP requests, so the current database
 *    is tracked client-side and passed per request.
 *  - Statements that return a result set run through query() with
 *    JSONCompactEachRowWithNamesAndTypes (one request yields names + types +
 *    rows); everything else runs through command() and reports written_rows.
 */
export class ClickHouseDriver extends BaseDriver {
  readonly driverType = 'clickhouse';

  private client: ClickHouseClient | null = null;
  private currentDb: string = '';

  async connect(config: ConnectionConfig): Promise<void> {
    this.client = createClient(this.buildClientConfig(config));
    try {
      // Cheap round-trip to validate credentials/URL before declaring success.
      await this.client.query({ query: 'SELECT 1', format: 'JSONEachRow' }).then(r => r.text());
    } catch (err) {
      await this.client.close().catch(() => {});
      this.client = null;
      throw err;
    }

    this.currentDb = config.database || 'default';
    this._config = config;
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    this._isConnected = false;
    this._config = null;
  }

  async testConnection(config: ConnectionConfig): Promise<{ success: boolean; message: string; serverInfo?: ServerInfo }> {
    let testClient: ClickHouseClient | null = null;
    try {
      testClient = createClient({ ...this.buildClientConfig(config), request_timeout: 10_000 });
      const result = await testClient.query({
        query: 'SELECT version() AS version, uptime() AS uptime',
        format: 'JSONEachRow',
      });
      // JSONEachRow emits one JSON object per line (not an array).
      const rows = (await result.text())
        .split('\n').filter(Boolean)
        .map(line => JSON.parse(line)) as Array<{ version?: string; uptime?: string }>;
      const version = rows[0]?.version || 'unknown';
      return {
        success: true,
        message: `Connected to ClickHouse ${version}`,
        serverInfo: { version, uptime: Number(rows[0]?.uptime) || undefined },
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (testClient) {
        await testClient.close().catch(() => {});
      }
    }
  }

  async query(sql: string, _params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();
    const start = performance.now();
    // ClickHouse HTTP is a single-statement protocol; drop trailing semicolon.
    const stmt = sql.trim().replace(/;\s*$/, '');

    try {
      if (RESULT_SET_RE.test(stmt)) {
        const res = await this.runResultSet(stmt);
        res.executionTime = Math.round(performance.now() - start);
        Logger.getInstance().logSQL(sql, res.executionTime);
        return res;
      }

      // Non-result statements (INSERT / CREATE / ALTER / mutations...).
      const command = await this.client!.command({ query: stmt });
      const executionTime = Math.round(performance.now() - start);
      const written = Number(command.summary?.written_rows ?? 0) || 0;
      Logger.getInstance().logSQL(sql, executionTime);
      return {
        columns: [],
        rows: [],
        affectedRows: written,
        executionTime,
        truncated: false,
        messages: [`OK. ${written} row(s) affected (mutations are asynchronous in ClickHouse).`],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      Logger.getInstance().logSQL(sql, undefined, errMsg);
      throw err;
    }
  }

  async cancelQuery(): Promise<void> {
    // P2: KILL QUERY WHERE query_id = ...
  }

  // ── Schema introspection ──

  async getDatabases(): Promise<DatabaseInfo[]> {
    this.ensureConnected();
    const res = await this.query('SELECT name FROM system.databases ORDER BY name');
    return res.rows.map(row => ({ name: row[0] as string }));
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    // ClickHouse has no schema layer; its "database" is the top namespace.
    return [];
  }

  async getTables(schema?: string): Promise<TableInfo[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;
    if (!db) { return []; }

    const res = await this.query(`
      SELECT name, engine, total_rows, total_bytes, comment
      FROM system.tables
      WHERE database = ${this.escapeValue(db)}
      ORDER BY name
    `);

    return res.rows.map(row => ({
      name: row[0] as string,
      schema: db,
      type: isViewEngine(row[1] as string) ? 'view' as const : 'table' as const,
      engine: row[1] as string | undefined,
      rowCount: toNumber(row[2]),
      dataSize: toNumber(row[3]),
      comment: (row[4] as string) || undefined,
    }));
  }

  async getColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;

    const res = await this.query(`
      SELECT name, type, default_expression, is_in_primary_key, comment, position
      FROM system.columns
      WHERE database = ${this.escapeValue(db)} AND table = ${this.escapeValue(table)}
      ORDER BY position
    `);

    return res.rows.map(row => {
      const rawType = row[1] as string;
      return {
        name: row[0] as string,
        type: rawType,
        normalizedType: normalizeClickHouseType(rawType),
        nullable: rawType.startsWith('Nullable('),
        defaultValue: row[2] || null,
        isPrimaryKey: Number(row[3]) === 1,
        isAutoIncrement: false,
        isUnique: false,
        comment: (row[4] as string) || undefined,
        ordinalPosition: Number(row[5]) || 0,
      };
    });
  }

  async getIndexes(_table: string, _schema?: string): Promise<IndexInfo[]> {
    // P2: data-skipping indices via system.data_skipping_indices.
    return [];
  }

  async getForeignKeys(_table: string, _schema?: string): Promise<ForeignKeyInfo[]> {
    // ClickHouse has no foreign keys.
    return [];
  }

  async getPrimaryKey(table: string, schema?: string): Promise<string[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;

    // The "primary key" is the engine's sorting key (not unique, not a
    // constraint); the UI labels it as such.
    const res = await this.query(`
      SELECT name
      FROM system.columns
      WHERE database = ${this.escapeValue(db)} AND table = ${this.escapeValue(table)} AND is_in_primary_key = 1
      ORDER BY position
    `);
    return res.rows.map(row => row[0] as string);
  }

  // ── Database operations ──

  async switchDatabase(database: string): Promise<void> {
    this.ensureConnected();
    // `USE` does not persist across HTTP requests and @clickhouse/client does
    // not accept a per-request database, so the current database is tracked
    // here and applied by re-binding the client to it.
    if (database === this.currentDb) { return; }
    this.currentDb = database;
    if (this._config) {
      await this.client?.close().catch(() => {});
      this.client = createClient(this.buildClientConfig({ ...this._config, database }));
    }
  }

  async getServerInfo(): Promise<ServerInfo> {
    this.ensureConnected();
    const res = await this.query('SELECT version() AS v, uptime() AS uptime');
    const row = res.rows[0];
    return {
      version: (row?.[0] as string) || 'unknown',
      uptime: Number(row?.[1]) || undefined,
    };
  }

  async getCurrentDatabase(): Promise<string> {
    return this.currentDb;
  }

  async getCurrentSchema(): Promise<string | undefined> {
    return undefined;
  }

  escapeIdentifier(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`';
  }

  escapeValue(value: unknown): string {
    if (value === null || value === undefined) { return 'NULL'; }
    if (typeof value === 'number') { return String(value); }
    if (typeof value === 'boolean') { return value ? 'true' : 'false'; }
    return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }

  // ── Private helpers ──

  private buildClientConfig(config: ConnectionConfig) {
    const tls = config.options?.tls === true;
    return {
      url: `${tls ? 'https' : 'http'}://${config.host}:${config.port}`,
      username: config.username || 'default',
      password: config.password || '',
      database: config.database || undefined,
      request_timeout: 30_000,
    };
  }

  /**
   * Run a result-set statement and build the QueryResult from a single
   * JSONCompactEachRowWithNamesAndTypes response: line 1 = column names,
   * line 2 = column types, the rest = data rows (JSON-typed values, so
   * Array/Map/Tuple columns arrive pre-parsed).
   */
  private async runResultSet(stmt: string): Promise<QueryResult> {
    // Pass the metadata format via the client's `format` param (the client
    // appends it itself; a manually concatenated FORMAT clause would clash
    // with the one it appends). A user-written trailing FORMAT clause is
    // stripped — the grid always renders our JSON metadata format.
    const query = stmt.replace(FORMAT_CLAUSE_RE, '');

    const result = await this.client!.query({
      query,
      format: 'JSONCompactEachRowWithNamesAndTypes',
    });
    const text = await result.text();

    const lines = text.split('\n').filter(line => line.trim() !== '');
    const names: string[] = lines.length > 0 ? JSON.parse(lines[0]) : [];
    const types: string[] = lines.length > 1 ? JSON.parse(lines[1]) : [];
    const dataRows = lines.slice(2).map(line => JSON.parse(line) as unknown[]);

    const columns: ColumnHeader[] = names.map((name, i) => {
      const rawType = types[i] ?? 'String';
      return {
        name,
        type: rawType,
        normalizedType: normalizeClickHouseType(rawType),
        nullable: rawType.startsWith('Nullable('),
        isPrimaryKey: false,
        isAutoIncrement: false,
        defaultValue: null,
        rawType,
      };
    });

    return {
      columns,
      rows: dataRows,
      affectedRows: 0,
      executionTime: 0,
      truncated: false,
      messages: [],
    };
  }
}

/** Statements that return a result set (everything else runs via command()). */
const RESULT_SET_RE = /^\s*(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|EXISTS|CHECK)\b/i;
/** A FORMAT clause already written by the user, at the end of the statement. */
const FORMAT_CLAUSE_RE = /\bFORMAT\s+\w+\s*$/i;

function isViewEngine(engine?: string): boolean {
  return !!engine && /View$/i.test(engine);
}

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) { return undefined; }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Map a ClickHouse type string (e.g. `Nullable(DateTime64(3))`,
 * `LowCardinality(String)`, `Array(Map(String, UInt64))`) to the normalized
 * column type used by the grid renderer.
 */
export function normalizeClickHouseType(rawType: string): NormalizedColumnType {
  let type = rawType.trim();
  // Unwrap single-argument wrappers (Nested stays as JSON anyway).
  for (const wrapper of ['Nullable(', 'LowCardinality(']) {
    while (type.startsWith(wrapper)) {
      const inner = type.slice(wrapper.length, -1);
      // Strip only if the closing paren actually closes this wrapper.
      let depth = 1;
      let end = -1;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '(') { depth++; }
        if (inner[i] === ')') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      type = end >= 0 ? inner.slice(0, end) : inner;
    }
  }

  const base = type.replace(/\(.*/, '').toLowerCase();

  if (/^(u?int\d*)$/.test(base)) { return NormalizedColumnType.Integer; }
  if (base === 'float' || base === 'float32' || base === 'float64') { return NormalizedColumnType.Float; }
  if (base === 'decimal' || base.startsWith('decimal')) { return NormalizedColumnType.Decimal; }
  if (base === 'bool' || base === 'boolean') { return NormalizedColumnType.Boolean; }
  if (base === 'date' || base === 'date32') { return NormalizedColumnType.Date; }
  if (base === 'datetime' || base === 'datetime64' || base === 'time') { return NormalizedColumnType.DateTime; }
  if (base === 'uuid') { return NormalizedColumnType.UUID; }
  if (base === 'enum8' || base === 'enum16') { return NormalizedColumnType.Enum; }
  if (['string', 'fixedstring', 'ipv4', 'ipv6'].includes(base)) { return NormalizedColumnType.String; }
  if (['array', 'tuple', 'map', 'nested', 'json', "object", 'aggregatefunction', 'ring', 'polygon', 'point'].includes(base)) {
    return base === 'array' ? NormalizedColumnType.Array : NormalizedColumnType.JSON;
  }
  return NormalizedColumnType.Unknown;
}
