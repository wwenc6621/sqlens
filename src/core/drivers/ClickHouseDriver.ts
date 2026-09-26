import { createClient, ClickHouseClient } from '@clickhouse/client';
import { BaseDriver, RowEdit } from './DatabaseDriver';
import { Logger } from '../utils/Logger';
import { driverSetting, driverSettingOrOption } from '../utils/settings';
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
  /** Id of the in-flight result-set query, for KILL QUERY cancellation. */
  private lastQueryId?: string;
  /** Sorting key per `db.table`, captured by getPrimaryKey for stable paging. */
  private sortKeyCache = new Map<string, string[]>();

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
    // HTTP queries can be cancelled by query id (best effort — the request may
    // have already finished).
    if (!this.client || !this.lastQueryId) { return; }
    try {
      await this.client.command({ query: `KILL QUERY WHERE query_id = ${this.escapeValue(this.lastQueryId)}` });
    } catch { /* nothing to cancel */ }
  }

  // ── Schema introspection ──

  async getDatabases(): Promise<DatabaseInfo[]> {
    this.ensureConnected();
    const res = await this.query('SELECT name FROM system.databases ORDER BY name');
    const names = res.rows.map(row => row[0] as string);
    // System databases are noisy (hundreds of tables); hidden unless the
    // `sqlens.clickhouse.showSystemDatabase` setting is on.
    const showSystem = driverSetting('clickhouse.showSystemDatabase', false);
    return names
      .filter(name => showSystem || !SYSTEM_DATABASES.has(name.toLowerCase()))
      .map(name => ({ name }));
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    // ClickHouse has no schema layer; its "database" is the top namespace.
    return [];
  }

  // ── In-grid editing (RowEditCapable) ──

  /**
   * Load one page of a table. ClickHouse pages need an ORDER BY to be stable,
   * so the sorting key is applied when the setting asks for it.
   */
  pageQuery(table: string, limit: number, schema?: string, offset = 0): string {
    const db = schema || this.currentDb;
    const requireOrder = driverSetting('clickhouse.requireOrderByPagination', true);
    const order = requireOrder ? this.sortKeyClause(table, db) : '';
    return `SELECT * FROM ${this.escapeIdentifier(db)}.${this.escapeIdentifier(table)}${order} LIMIT ${limit} OFFSET ${offset}`;
  }

  /** ` ORDER BY <sorting key>` when the sorting key is known, else ''. */
  private sortKeyClause(table: string, db: string): string {
    const names = this.sortKeyCache.get(`${db}.${table}`) || [];
    return names.length > 0
      ? ` ORDER BY ${names.map(n => this.escapeIdentifier(n)).join(', ')}`
      : '';
  }

  /**
   * Apply grid changes as ClickHouse mutations (`ALTER TABLE ... UPDATE/DELETE`)
   * plus plain INSERTs. Mutations are asynchronous and cannot be rolled back,
   * so editing is opt-in via `sqlens.clickhouse.allowMutations`.
   */
  async applyRowEdits(table: string, rows: RowEdit[], columns: string[], pkColumns: string[], schema?: string): Promise<number> {
    this.ensureConnected();
    if (!driverSetting('clickhouse.allowMutations', false)) {
      throw new Error('In-grid editing is disabled for ClickHouse. Enable "sqlens.clickhouse.allowMutations" to use mutations (asynchronous, not reversible).');
    }

    const target = `${this.escapeIdentifier(schema || this.currentDb)}.${this.escapeIdentifier(table)}`;
    const pk = pkColumns.length > 0 ? pkColumns : columns;
    const whereFor = (values: unknown[]) => pk.map(col => {
      const i = columns.indexOf(col);
      const v = values[i];
      return v === null || v === undefined
        ? `${this.escapeIdentifier(col)} IS NULL`
        : `${this.escapeIdentifier(col)} = ${this.escapeValue(v)}`;
    }).join(' AND ');

    let applied = 0;
    for (const row of rows) {
      if (row.status === 'modified') {
        const sets = row.changedCols
          .filter(ci => !pk.includes(columns[ci]))
          .map(ci => `${this.escapeIdentifier(columns[ci])} = ${this.escapeValue(row.data[ci])}`)
          .join(', ');
        if (!sets) { continue; }
        await this.query(`ALTER TABLE ${target} UPDATE ${sets} WHERE ${whereFor(row.original)}`);
        applied++;
      } else if (row.status === 'deleted') {
        await this.query(`ALTER TABLE ${target} DELETE WHERE ${whereFor(row.original)}`);
        applied++;
      } else if (row.status === 'added') {
        const pairs = columns
          .map((name, i) => ({ name, value: row.data[i] }))
          .filter(pair => pair.value !== null && pair.value !== undefined);
        if (pairs.length === 0) { continue; }
        await this.query(
          `INSERT INTO ${target} (${pairs.map(p => this.escapeIdentifier(p.name)).join(', ')}) VALUES (${pairs.map(p => this.escapeValue(p.value)).join(', ')})`,
        );
        applied++;
      }
    }
    return applied;
  }

  /**
   * Export a table (or a query) as text in the given ClickHouse FORMAT —
   * `JSONEachRow` (default), `CSV`, `TSV`, etc. (P4 Dump).
   */
  async exportTable(table: string, format = 'JSONEachRow', schema?: string): Promise<string> {
    this.ensureConnected();
    const db = schema || this.currentDb;
    const query = `SELECT * FROM ${this.escapeIdentifier(db)}.${this.escapeIdentifier(table)} FORMAT ${sanitizeFormat(format)}`;
    // `exec` returns the raw response body — `query` would append its own
    // FORMAT clause and clash with the one requested here.
    const { stream } = await this.client!.exec({ query });
    let text = '';
    for await (const chunk of stream) {
      text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    }
    return text;
  }

  /**
   * Fast table/view name listing for progressive tree loading: only names and
   * engines (no row counts / sizes), so the tree renders immediately.
   */
  async getTableNames(schema?: string): Promise<{ name: string; type: 'table' | 'view' }[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;
    if (!db) { return []; }
    const res = await this.query(`
      SELECT name, engine FROM system.tables
      WHERE database = ${this.escapeValue(db)}
      ORDER BY name
    `);
    return res.rows.map(row => ({
      name: row[0] as string,
      type: isViewEngine(row[1] as string) ? 'view' as const : 'table' as const,
    }));
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

  async getIndexes(table: string, schema?: string): Promise<IndexInfo[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;
    // ClickHouse indexes are data-skipping indices (no uniqueness); the
    // primary/sorting key is reported separately by getPrimaryKey().
    const res = await this.query(`
      SELECT name, expr, type
      FROM system.data_skipping_indices
      WHERE database = ${this.escapeValue(db)} AND table = ${this.escapeValue(table)}
      ORDER BY name
    `);
    return res.rows.map(row => ({
      name: row[0] as string,
      columns: [(row[1] as string) || ''],
      unique: false,
      type: (row[2] as string) || 'skip_index',
    }));
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
    const keys = res.rows.map(row => row[0] as string);
    if (keys.length > 0) { this.sortKeyCache.set(`${db}.${table}`, keys); }
    return keys;
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
    // Backticks are the ClickHouse-native quoting; some setups prefer the
    // ANSI double quotes (setting `sqlens.clickhouse.useBackticks = false`).
    if (driverSetting('clickhouse.useBackticks', true)) {
      return '`' + name.replace(/`/g, '``') + '`';
    }
    return '"' + name.replace(/"/g, '""') + '"';
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
    this.lastQueryId = result.query_id;
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

    // Long String values are truncated for the grid (full value via export /
    // Quick View); the cap is `sqlens.clickhouse.stringMaxBytes`.
    const maxBytes = driverSetting('clickhouse.stringMaxBytes', 512);
    const stringCols = columns
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => /^(Nullable\()?(LowCardinality\()?(Fixed)?String/.test(c.rawType))
      .map(({ i }) => i);
    const cappedRows = stringCols.length === 0 ? dataRows : dataRows.map(row => {
      const copy = [...row];
      for (const i of stringCols) {
        const v = copy[i];
        if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') > maxBytes) {
          copy[i] = `${truncateUtf8(v, maxBytes)}… [truncated]`;
        }
      }
      return copy;
    });

    return {
      columns,
      rows: cappedRows,
      affectedRows: 0,
      executionTime: 0,
      truncated: false,
      messages: [],
    };
  }
}

/** Only allow identifier-like FORMAT names (kept out of the SQL text). */
function sanitizeFormat(format: string): string {
  const clean = (format || 'JSONEachRow').replace(/[^A-Za-z0-9]/g, '');
  return clean || 'JSONEachRow';
}

/** System namespaces hidden from the tree unless explicitly enabled. */
const SYSTEM_DATABASES = new Set(['system', 'information_schema', 'information_schema_1', 'information_schema_2']);

/** Statements that return a result set (everything else runs via command()). */
const RESULT_SET_RE = /^\s*(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|EXISTS|CHECK)\b/i;
/** A FORMAT clause already written by the user, at the end of the statement. */
const FORMAT_CLAUSE_RE = /\bFORMAT\s+\w+\s*$/i;

function isViewEngine(engine?: string): boolean {
  return !!engine && /View$/i.test(engine);
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) { return value; }
  // Back off up to 3 bytes to land on a character boundary.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) { end--; }
  return buf.subarray(0, end).toString('utf8');
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
