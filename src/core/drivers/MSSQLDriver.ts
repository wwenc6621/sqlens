import * as mssql from 'mssql';
import { spawn } from 'child_process';
import { BaseDriver } from './DatabaseDriver';
import { Logger } from '../utils/Logger';
import { driverSettingOrOption } from '../utils/settings';
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
 * Microsoft SQL Server driver (official `mssql` / tedious client).
 *
 * See docs/MSSQL_SUPPORT_DESIGN.md. T-SQL specifics:
 *  - Bracketed identifiers `[name]` (with `]]` escaping), N'' string literals.
 *  - Pagination uses OFFSET/FETCH which requires ORDER BY — the grid is
 *    expected to sort by primary key; the driver only produces the clause.
 *  - `GO` is a client-side batch separator, not SQL — queryMultiple() splits
 *    on it before delegating to the semicolon splitter.
 *  - Multi-result-set requests are collected and the first recordset is
 *    returned (a result-set tab per recordset is a P2 webview feature).
 */
export class MSSQLDriver extends BaseDriver {
  readonly driverType = 'mssql';

  private pool: mssql.ConnectionPool | null = null;
  private currentDb: string = '';
  /** Primary key per `schema.table`, captured by getPrimaryKey for paging. */
  private pkCache = new Map<string, string[]>();

  async connect(config: ConnectionConfig): Promise<void> {
    try {
      this.pool = await new mssql.ConnectionPool(this.buildPoolConfig(config)).connect();
    } catch (err) {
      this.pool = null;
      throw err;
    }

    this.currentDb = config.database || 'master';
    this._config = config;
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close().catch(() => {});
      this.pool = null;
    }
    this._isConnected = false;
    this._config = null;
  }

  async testConnection(config: ConnectionConfig): Promise<{ success: boolean; message: string; serverInfo?: ServerInfo }> {
    let testPool: mssql.ConnectionPool | null = null;
    try {
      testPool = await new mssql.ConnectionPool({
        ...this.buildPoolConfig(config),
        requestTimeout: 10_000,
      }).connect();
      const res = await testPool.request().query('SELECT @@VERSION AS v');
      const version = (res.recordset?.[0]?.v as string)?.split('\n')[0] || 'unknown';
      return {
        success: true,
        message: `Connected to SQL Server ${version}`,
        serverInfo: { version },
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (testPool) {
        await testPool.close().catch(() => {});
      }
    }
  }

  async query(sql: string, _params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();
    const start = performance.now();

    try {
      const res = await this.pool!.request().query(sql);
      const executionTime = Math.round(performance.now() - start);
      Logger.getInstance().logSQL(sql, executionTime);

      // Multi-result-set responses: the first recordset is the grid (a
      // per-recordset tab is a P2 webview feature).
      const recordset = res.recordset;
      if (!recordset || recordset.length === 0) {
        return {
          columns: [],
          rows: [],
          affectedRows: res.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
          executionTime,
          truncated: false,
          messages: res.rowsAffected?.length ? [`${res.rowsAffected.length} result set(s), ${res.rowsAffected.reduce((a: number, b: number) => a + b, 0)} row(s) affected`] : [],
        };
      }

      // Prefer the driver's column metadata (ordered by index) so unnamed
      // expression columns and duplicate names cannot shift the row values.
      const meta = (res.recordset as unknown as {
        columns?: Record<string, { index: number; name: string; type?: { declaration?: string; name?: string } }>;
      }).columns;
      const ordered = meta
        ? Object.values(meta).sort((a, b) => a.index - b.index)
        : null;

      const columns: ColumnHeader[] = ordered
        ? ordered.map(col => {
            // `declaration` carries the T-SQL form ("int", "nvarchar (20)");
            // `name` is the JS name ("Int") which normalizeSqlType doesn't know.
            const declaration = col.type?.declaration || col.type?.name || 'unknown';
            const base = declaration.split(/[\s(]/)[0].toLowerCase();
            return {
              name: col.name || `column${col.index + 1}`,
              type: declaration,
              normalizedType: normalizeSqlType(base),
              nullable: true,
              isPrimaryKey: false,
              isAutoIncrement: false,
              defaultValue: null,
              rawType: declaration,
            };
          })
        : Object.entries(recordset[0] as Record<string, unknown>).map(([name, value]) => ({
            name,
            type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : typeof value === 'object' && value instanceof Date ? 'datetime' : 'string',
            normalizedType: inferNormalizedType(value),
            nullable: true,
            isPrimaryKey: false,
            isAutoIncrement: false,
            defaultValue: null,
            rawType: value === null || value === undefined ? 'unknown' : value instanceof Date ? 'datetime' : typeof value,
          }));

      const mainRows = (recordset as Array<Record<string, unknown>>)
        .map(row => columns.map(col => normalizeCell(row[col.name])));

      // Extra result sets (stored procedures / multi-SELECT batches) are handed
      // to the UI as additional read-only grids.
      const extraSets: Array<{ columns: ColumnHeader[]; rows: unknown[][] }> = [];
      const recordsets = (res as unknown as { recordsets?: unknown[][] }).recordsets || [];
      for (let i = 1; i < recordsets.length; i++) {
        const set = recordsets[i] as unknown as Array<Record<string, unknown>> & {
          columns?: Record<string, { index: number; name: string; type?: { declaration?: string; name?: string } }>;
        };
        const setColumns: ColumnHeader[] = set.columns
          ? Object.values(set.columns).sort((a, b) => a.index - b.index).map(col => {
              const declaration = col.type?.declaration || col.type?.name || 'unknown';
              const base = declaration.split(/[\s(]/)[0].toLowerCase();
              return {
                name: col.name || `column${col.index + 1}`,
                type: declaration,
                normalizedType: normalizeSqlType(base),
                nullable: true,
                isPrimaryKey: false,
                isAutoIncrement: false,
                defaultValue: null,
                rawType: declaration,
              };
            })
          : columns;
        extraSets.push({
          columns: setColumns,
          rows: (set as unknown as Array<Record<string, unknown>>)
            .map(row => setColumns.map(col => normalizeCell(row[col.name]))),
        });
      }

      return {
        columns,
        rows: mainRows,
        affectedRows: 0,
        executionTime,
        truncated: false,
        messages: extraSets.length > 0 ? [`${extraSets.length + 1} result sets returned — see the additional tabs.`] : [],
        ...(extraSets.length > 0 ? { resultSets: extraSets } : {}),
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      Logger.getInstance().logSQL(sql, undefined, errMsg);
      throw err;
    }
  }

  /**
   * Split on `GO` batch separators (a client-side keyword on its own line)
   * first, then on semicolons — GO must not leak into the server.
   */
  async queryMultiple(sql: string): Promise<QueryResult[]> {
    const results: QueryResult[] = [];
    for (const batch of splitBatches(sql)) {
      results.push(...await super.queryMultiple(batch));
    }
    return results;
  }

  async cancelQuery(): Promise<void> {
    // P2: track the live request and call request.cancel().
  }

  // ── Schema introspection ──

  async getDatabases(): Promise<DatabaseInfo[]> {
    this.ensureConnected();
    const res = await this.query(
      `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`,
    );
    return res.rows.map(row => ({ name: row[0] as string }));
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    this.ensureConnected();
    const res = await this.query(`
      SELECT name FROM sys.schemas
      WHERE name NOT IN ('guest', 'INFORMATION_SCHEMA', 'sys',
                         'db_accessadmin', 'db_backupoperator', 'db_datareader',
                         'db_datawriter', 'db_ddladmin', 'db_denydatareader',
                         'db_denydatawriter', 'db_owner', 'db_securityadmin')
      ORDER BY name
    `);
    return res.rows.map(row => ({ name: row[0] as string, isDefault: (row[0] as string) === 'dbo' }));
  }

  /**
   * High-speed table export through the SQL Server `bcp` utility (P4). Throws
   * with an actionable message when the command-line tools are not installed.
   */
  async exportBcp(table: string, filePath: string, schema?: string): Promise<void> {
    this.ensureConnected();
    const cfg = this._config!;
    const target = `${this.escapeIdentifier(schema || 'dbo')}.${this.escapeIdentifier(table)}`;
    const args = [
      `SELECT * FROM ${target}`, 'queryout', filePath,
      '-S', `${cfg.host},${cfg.port || 1433}`,
      '-U', cfg.username,
      '-P', cfg.password || '',
      '-c', '-t', '\t', '-r', '\n',
    ];
    if (driverSettingOrOption<boolean>('mssql.trustServerCertificate', cfg.options?.trustServerCertificate, false)) {
      args.push('-C');
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn('bcp', args, { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', (err: NodeJS.ErrnoException) => {
        reject(new Error(err.code === 'ENOENT'
          ? 'bcp was not found on PATH. Install the SQL Server command-line tools (mssql-tools) to use high-speed export.'
          : `bcp failed to start: ${err.message}`));
      });
      child.on('close', code => {
        if (code === 0) { resolve(); }
        else { reject(new Error(`bcp exited with code ${code}: ${stderr.trim().slice(0, 300) || 'unknown error'}`)); }
      });
    });
  }

  /**
   * Load one grid page. OFFSET/FETCH requires ORDER BY, so the primary key is
   * used when it can be resolved, otherwise `(SELECT NULL)` keeps the query
   * valid (page order is then not guaranteed).
   */
  pageQuery(table: string, limit: number, schema?: string, offset = 0): string {
    const sch = schema || 'dbo';
    const target = `${this.escapeIdentifier(sch)}.${this.escapeIdentifier(table)}`;
    const order = this.cachedOrderBy(table, sch) ?? 'ORDER BY (SELECT NULL)';
    return `SELECT * FROM ${target} ${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  /** Primary-key ORDER BY captured during introspection, if any. */
  private cachedOrderBy(table: string, schema: string): string | undefined {
    const pk = (this as unknown as { pkCache?: Map<string, string[]> }).pkCache?.get(`${schema}.${table}`);
    return pk && pk.length > 0
      ? `ORDER BY ${pk.map(c => this.escapeIdentifier(c)).join(', ')}`
      : undefined;
  }

  /**
   * Run a statement with SET STATISTICS PROFILE ON so the plan/profile rows
   * come back as a result set (P4 EXPLAIN).
   */
  async explainQuery(sql: string): Promise<QueryResult> {
    this.ensureConnected();
    const stmt = sql.trim().replace(/;\s*$/, '');
    return this.query(`SET STATISTICS PROFILE ON;\n${stmt}`);
  }

  /**
   * Fast name listing for progressive tree loading (sys catalog only — the
   * dm_db_partition_stats / extended-properties hydration happens after).
   */
  async getTableNames(schema?: string): Promise<{ name: string; type: 'table' | 'view' }[]> {
    this.ensureConnected();
    const sch = schema || 'dbo';
    const res = await this.query(`
      SELECT t.name, 0 AS is_view FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id AND s.name = ${this.escapeValue(sch)}
      UNION ALL
      SELECT v.name, 1 AS is_view FROM sys.views v
      JOIN sys.schemas s ON s.schema_id = v.schema_id AND s.name = ${this.escapeValue(sch)}
      ORDER BY 1
    `);
    return res.rows.map(row => ({
      name: row[0] as string,
      type: Number(row[1]) === 1 ? 'view' as const : 'table' as const,
    }));
  }

  async getTables(schema?: string): Promise<TableInfo[]> {
    this.ensureConnected();
    const sch = schema || 'dbo';

    const res = await this.query(`
      SELECT
        t.name AS name,
        CASE WHEN t.is_view = 1 THEN 'view' ELSE 'table' END AS kind,
        ISNULL(p.row_count, 0) AS row_count,
        ISNULL(p.reserved_kb * 1024, 0) AS size_bytes,
        ISNULL(ep.value, '') AS comment
      FROM (
        SELECT name, 0 AS is_view, object_id, schema_id FROM sys.tables
        UNION ALL
        SELECT name, 1 AS is_view, object_id, schema_id FROM sys.views
      ) t
      JOIN sys.schemas s ON s.schema_id = t.schema_id AND s.name = ${this.escapeValue(sch)}
      LEFT JOIN (
        SELECT object_id,
               SUM(row_count) AS row_count,
               SUM(reserved_page_count) * 8 AS reserved_kb
        FROM sys.dm_db_partition_stats
        WHERE index_id IN (0, 1)
        GROUP BY object_id
      ) p ON p.object_id = t.object_id
      LEFT JOIN sys.extended_properties ep
        ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
      ORDER BY t.name
    `);

    return res.rows.map(row => ({
      name: row[0] as string,
      schema: sch,
      type: row[1] === 'view' ? 'view' as const : 'table' as const,
      engine: undefined,
      rowCount: Number(row[2]) || undefined,
      dataSize: Number(row[3]) || undefined,
      comment: (row[4] as string) || undefined,
    }));
  }

  async getColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    this.ensureConnected();
    const sch = schema || 'dbo';

    const res = await this.query(`
      SELECT
        c.name,
        ty.name AS type_name,
        c.is_nullable,
        dc.definition,
        c.is_identity,
        c.precision,
        c.scale,
        c.max_length,
        ep.value AS comment,
        c.column_id
      FROM sys.columns c
      JOIN sys.tables t ON t.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id AND s.name = ${this.escapeValue(sch)}
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
      LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
      WHERE t.name = ${this.escapeValue(table)}
      ORDER BY c.column_id
    `);

    return res.rows.map(row => ({
      name: row[0] as string,
      type: row[1] as string,
      normalizedType: normalizeSqlType(row[1] as string),
      nullable: row[2] === true,
      defaultValue: row[3] ?? null,
      isPrimaryKey: false,
      isAutoIncrement: row[4] === true,
      isUnique: false,
      precision: row[5] === null || row[5] === undefined ? undefined : Number(row[5]),
      scale: row[6] === null || row[6] === undefined ? undefined : Number(row[6]),
      maxLength: row[7] === null || row[7] === undefined ? undefined : Number(row[7]),
      comment: (row[8] as string) || undefined,
      ordinalPosition: Number(row[9]) || 0,
    }));
  }

  async getIndexes(table: string, schema?: string): Promise<IndexInfo[]> {
    this.ensureConnected();
    const sch = schema || 'dbo';

    const res = await this.query(`
      SELECT
        i.name,
        i.is_unique,
        i.type_desc,
        STUFF((
          SELECT ',' + c.name
          FROM sys.index_columns ic
          JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
          ORDER BY ic.key_ordinal
          FOR XML PATH('')
        ), 1, 1, '') AS columns
      FROM sys.indexes i
      JOIN sys.tables t ON t.object_id = i.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id AND s.name = ${this.escapeValue(sch)}
      WHERE t.name = ${this.escapeValue(table)} AND i.name IS NOT NULL
      ORDER BY i.index_id
    `);

    return res.rows.map(row => ({
      name: row[0] as string,
      columns: (row[3] as string || '').split(',').filter(Boolean),
      unique: row[1] === true,
      type: (row[2] as string) || 'INDEX',
    }));
  }

  async getForeignKeys(table: string, schema?: string): Promise<ForeignKeyInfo[]> {
    this.ensureConnected();
    const sch = schema || 'dbo';

    const res = await this.query(`
      SELECT
        fk.name,
        STUFF((
          SELECT ',' + pc.name
          FROM sys.foreign_key_columns fkc
          JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
          WHERE fkc.constraint_object_id = fk.object_id
          ORDER BY fkc.constraint_column_id
          FOR XML PATH('')
        ), 1, 1, '') AS columns,
        OBJECT_NAME(fk.referenced_object_id) AS ref_table,
        STUFF((
          SELECT ',' + rc.name
          FROM sys.foreign_key_columns fkc
          JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
          WHERE fkc.constraint_object_id = fk.object_id
          ORDER BY fkc.constraint_column_id
          FOR XML PATH('')
        ), 1, 1, '') AS ref_columns
      FROM sys.foreign_keys fk
      JOIN sys.tables t ON t.object_id = fk.parent_object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id AND s.name = ${this.escapeValue(sch)}
      WHERE t.name = ${this.escapeValue(table)}
      ORDER BY fk.name
    `);

    return res.rows.map(row => ({
      name: row[0] as string,
      columns: (row[1] as string || '').split(',').filter(Boolean),
      referencedTable: row[2] as string,
      referencedColumns: (row[3] as string || '').split(',').filter(Boolean),
      onDelete: '',
      onUpdate: '',
    }));
  }

  async getPrimaryKey(table: string, schema?: string): Promise<string[]> {
    this.ensureConnected();
    const sch = schema || 'dbo';

    const res = await this.query(`
      SELECT c.name
      FROM sys.key_constraints kc
      JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
      JOIN sys.columns c ON c.object_id = kc.parent_object_id AND c.column_id = ic.column_id
      JOIN sys.tables t ON t.object_id = kc.parent_object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id AND s.name = ${this.escapeValue(sch)}
      WHERE kc.type = 'PK' AND t.name = ${this.escapeValue(table)}
      ORDER BY ic.key_ordinal
    `);
    const columns = res.rows.map(row => row[0] as string);
    if (columns.length > 0) { this.pkCache.set(`${sch}.${table}`, columns); }
    return columns;
  }

  // ── Database operations ──

  async switchDatabase(database: string): Promise<void> {
    this.ensureConnected();
    await this.query(`USE ${this.escapeIdentifier(database)}`);
    this.currentDb = database;
  }

  async getServerInfo(): Promise<ServerInfo> {
    this.ensureConnected();
    const res = await this.query(`
      SELECT
        @@VERSION AS v,
        CAST(SERVERPROPERTY('ProductLevel') AS NVARCHAR(64)) AS level,
        (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS sessions
    `);
    const row = res.rows[0];
    return {
      version: ((row?.[0] as string) || '').split('\n')[0] || 'unknown',
      platform: (row?.[1] as string) || undefined,
      currentConnections: row?.[2] === null || row?.[2] === undefined ? undefined : Number(row[2]),
    };
  }

  async getCurrentDatabase(): Promise<string> {
    if (!this._isConnected) { return ''; }
    const res = await this.query('SELECT DB_NAME()');
    return (res.rows[0]?.[0] as string) || '';
  }

  async getCurrentSchema(): Promise<string | undefined> {
    if (!this._isConnected) { return undefined; }
    const res = await this.query('SELECT SCHEMA_NAME()');
    return (res.rows[0]?.[0] as string) || undefined;
  }

  /**
   * T-SQL pagination clause. OFFSET/FETCH requires ORDER BY — the grid is
   * expected to sort by primary key before appending this clause.
   */
  paginationSQL(limit: number, offset: number): string {
    return `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  escapeIdentifier(name: string): string {
    return `[${name.replace(/\]/g, ']]')}]`;
  }

  escapeValue(value: unknown): string {
    if (value === null || value === undefined) { return 'NULL'; }
    if (typeof value === 'number') { return String(value); }
    if (typeof value === 'boolean') { return value ? '1' : '0'; }
    if (value instanceof Date) { return `'${value.toISOString()}'`; }
    // N'' prefix — NVARCHAR literals keep Unicode (Chinese/emoji) intact.
    return `N'${String(value).replace(/'/g, "''")}'`;
  }

  // ── Private helpers ──

  private buildPoolConfig(config: ConnectionConfig): mssql.config {
    const options: Record<string, unknown> = {
      encrypt: driverSettingOrOption<boolean>('mssql.encrypt', config.options?.encrypt, true) !== false,
      trustServerCertificate: driverSettingOrOption<boolean>('mssql.trustServerCertificate', config.options?.trustServerCertificate, false) === true,
    };

    // Windows (NTLM) / Azure AD authentication, when selected in the form.
    const authType = String(config.options?.authentication ?? '');
    let authentication: unknown;
    if (authType === 'ntlm') {
      options.domain = String(config.options?.domain ?? '');
      authentication = {
        type: 'ntlm',
        options: {
          domain: String(config.options?.domain ?? ''),
          userName: config.username,
          password: config.password || '',
        },
      };
    } else if (authType.startsWith('azure-active-directory')) {
      authentication = {
        type: authType,
        options: {
          clientId: String(config.options?.clientId ?? ''),
          clientSecret: String(config.options?.clientSecret ?? ''),
          tenantId: String(config.options?.tenantId ?? ''),
        },
      };
    }

    return {
      server: config.host,
      port: config.port || 1433,
      user: config.username,
      password: config.password || '',
      database: config.database || undefined,
      connectionTimeout: 10_000,
      requestTimeout: driverSettingOrOption<number>('mssql.requestTimeout', config.options?.requestTimeout, 30_000),
      options: options as mssql.config['options'],
      ...(authentication ? { authentication: authentication as never } : {}),
    };
  }
}

/** Split a T-SQL script into batches at standalone `GO` lines. */
function splitBatches(sql: string): string[] {
  return sql
    .split(/^\s*GO\s*$/gim)
    .map(batch => batch.trim())
    .filter(Boolean);
}

function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) { return null; }
  if (value instanceof Date) { return value.toISOString(); }
  if (Buffer.isBuffer(value)) { return `0x${value.toString('hex').slice(0, 256)}`; }
  if (typeof value === 'object') { return JSON.stringify(value); }
  return value;
}

function inferNormalizedType(value: unknown): NormalizedColumnType {
  if (typeof value === 'number') { return Number.isInteger(value) ? NormalizedColumnType.Integer : NormalizedColumnType.Float; }
  if (typeof value === 'boolean') { return NormalizedColumnType.Boolean; }
  if (value instanceof Date) { return NormalizedColumnType.DateTime; }
  return NormalizedColumnType.String;
}

/** Map a SQL Server system type name to the normalized column type. */
export function normalizeSqlType(typeName: string): NormalizedColumnType {
  switch (typeName) {
    case 'bigint': case 'int': case 'smallint': case 'tinyint': case 'bit':
      return NormalizedColumnType.Integer;
    case 'decimal': case 'numeric': case 'money': case 'smallmoney':
      return NormalizedColumnType.Decimal;
    case 'float': case 'real':
      return NormalizedColumnType.Float;
    case 'date':
      return NormalizedColumnType.Date;
    case 'datetime': case 'datetime2': case 'smalldatetime': case 'datetimeoffset':
      return NormalizedColumnType.DateTime;
    case 'time':
      return NormalizedColumnType.Time;
    case 'uniqueidentifier':
      return NormalizedColumnType.UUID;
    case 'varbinary': case 'binary': case 'image': case 'timestamp':
      return NormalizedColumnType.Binary;
    case 'xml':
      return NormalizedColumnType.JSON;
    case 'char': case 'nchar': case 'varchar': case 'nvarchar': case 'text': case 'ntext':
      return NormalizedColumnType.String;
    default:
      return NormalizedColumnType.Unknown;
  }
}
