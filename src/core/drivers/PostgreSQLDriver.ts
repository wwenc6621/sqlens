import { Client, Pool, types } from 'pg';
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

// Return raw strings for date/timestamp types instead of JS Date objects
types.setTypeParser(1082, (val: string) => val); // DATE
types.setTypeParser(1114, (val: string) => val); // TIMESTAMP
types.setTypeParser(1184, (val: string) => val); // TIMESTAMPTZ
types.setTypeParser(1083, (val: string) => val); // TIME
types.setTypeParser(1266, (val: string) => val); // TIMETZ
types.setTypeParser(20, (val: string) => val);   // INT8 as string to avoid BigInt issues

/**
 * PostgreSQL database driver using node-postgres (pg).
 * Supports schemas, rich type system, and full introspection.
 */
export class PostgreSQLDriver extends BaseDriver {
  readonly driverType = 'postgresql';

  private pool: Pool | null = null;
  private currentDb: string = '';
  private currentSchema: string = 'public';

  async connect(config: ConnectionConfig): Promise<void> {
    const poolConfig = {
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database || 'postgres',
      max: 5,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 10_000,
      ssl: this.buildSSLConfig(config),
    };

    try {
      this.pool = new Pool(poolConfig);
      const client = await this.pool.connect();
      client.release();
    } catch (err) {
      if (config.ssl.mode === 'preferred' && err instanceof Error && (err.message.includes('does not support SSL') || err.message.includes('secure connection'))) {
        Logger.getInstance().logInfo('PostgreSQL server does not support secure connection. Falling back to unencrypted connection.');
        delete poolConfig.ssl;
        if (this.pool) {
          await this.pool.end().catch(() => {});
        }
        this.pool = new Pool(poolConfig);
        const client = await this.pool.connect();
        client.release();
      } else {
        throw err;
      }
    }

    this.currentDb = config.database || 'postgres';
    this._config = config;
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this._isConnected = false;
    this._config = null;
  }

  async testConnection(config: ConnectionConfig): Promise<{ success: boolean; message: string; serverInfo?: ServerInfo }> {
    let client: Client | null = null;
    try {
      try {
        client = new Client({
          host: config.host,
          port: config.port,
          user: config.username,
          password: config.password,
          database: config.database || 'postgres',
          connectionTimeoutMillis: 10_000,
          ssl: this.buildSSLConfig(config),
        });
        await client.connect();
      } catch (err) {
        if (config.ssl.mode === 'preferred' && err instanceof Error && (err.message.includes('does not support SSL') || err.message.includes('secure connection'))) {
          Logger.getInstance().logInfo('PostgreSQL server does not support secure connection during test. Falling back to unencrypted connection.');
          if (client) {
            await client.end().catch(() => {});
          }
          client = new Client({
            host: config.host,
            port: config.port,
            user: config.username,
            password: config.password,
            database: config.database || 'postgres',
            connectionTimeoutMillis: 10_000,
            ssl: false,
          });
          await client.connect();
        } else {
          throw err;
        }
      }

      const res = await client.query('SELECT version()');
      const version = res.rows[0]?.version || 'unknown';

      return {
        success: true,
        message: `Connected: ${version}`,
        serverInfo: { version },
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (client) {
        await client.end().catch(() => {});
      }
    }
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();
    const start = performance.now();

    try {
      const result = await this.pool!.query(sql, params);
      const executionTime = Math.round(performance.now() - start);

      // DDL/DML with no rows returned
      if (!result.fields || result.fields.length === 0) {
        const queryRes = {
          columns: [],
          rows: [],
          affectedRows: result.rowCount || 0,
          executionTime,
          truncated: false,
          messages: result.command ? [`${result.command}: ${result.rowCount} rows`] : [],
        };
        Logger.getInstance().logSQL(sql, executionTime);
        return queryRes;
      }

      const columns: ColumnHeader[] = result.fields.map(f => ({
        name: f.name,
        type: this.oidToType(f.dataTypeID),
        normalizedType: this.normalizeOid(f.dataTypeID),
        nullable: true,
        isPrimaryKey: false,
        isAutoIncrement: false,
        defaultValue: null,
        rawType: this.oidToType(f.dataTypeID),
        // table holds the pg_class OID; columnId holds pg_attribute.attnum.
        // Both are resolved to a real declared type on demand.
        table: f.tableID ? String(f.tableID) : undefined,
        columnId: f.columnID,
      }));

      const dataRows = result.rows.map((row: Record<string, unknown>) =>
        columns.map(col => row[col.name])
      );

      const queryRes = {
        columns,
        rows: dataRows,
        affectedRows: 0,
        executionTime,
        truncated: false,
        messages: [],
      };
      Logger.getInstance().logSQL(sql, executionTime);
      return queryRes;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      Logger.getInstance().logSQL(sql, undefined, errMsg);
      throw err;
    }
  }

  async cancelQuery(): Promise<void> {
    // pg supports query cancellation via the connection
  }

  async getDatabases(): Promise<DatabaseInfo[]> {
    this.ensureConnected();
    const result = await this.query(`
      SELECT datname, pg_database_size(datname) as size, pg_encoding_to_char(encoding) as encoding
      FROM pg_database
      WHERE datistemplate = false
      ORDER BY datname
    `);

    return result.rows.map(row => ({
      name: row[0] as string,
      size: row[1] as number,
      encoding: row[2] as string,
    }));
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    this.ensureConnected();
    const result = await this.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY schema_name
    `);

    return result.rows.map(row => ({
      name: row[0] as string,
      isDefault: row[0] === 'public',
    }));
  }

  async getTables(schema?: string): Promise<TableInfo[]> {
    this.ensureConnected();
    const s = schema || this.currentSchema;

    const result = await this.query(`
      SELECT
        t.table_name,
        t.table_type,
        COALESCE(pg_stat.n_live_tup, 0) as row_count,
        pg_total_relation_size(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::bigint as data_size,
        obj_description((quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass, 'pg_class') as comment
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables pg_stat
        ON pg_stat.schemaname = t.table_schema AND pg_stat.relname = t.table_name
      WHERE t.table_schema = $1
      ORDER BY t.table_name
    `, [s]);

    return result.rows.map(row => ({
      name: row[0] as string,
      schema: s,
      type: this.mapTableType(row[1] as string),
      rowCount: row[2] as number,
      dataSize: row[3] as number,
      comment: row[4] as string | undefined,
    }));
  }

  async getColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    this.ensureConnected();
    const s = schema || this.currentSchema;

    const result = await this.query(`
      SELECT
        c.column_name,
        c.data_type,
        c.udt_name,
        c.is_nullable,
        c.column_default,
        c.character_maximum_length,
        c.numeric_precision,
        c.numeric_scale,
        c.ordinal_position,
        col_description((quote_ident($1) || '.' || quote_ident($2))::regclass, c.ordinal_position) as comment,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk,
        CASE WHEN c.column_default LIKE 'nextval%' THEN true ELSE false END as is_serial
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT ku.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku
          ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
        WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.column_name = c.column_name
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
    `, [s, table]);

    return result.rows.map(row => {
      const dataType = row[1] as string;
      const udtName = row[2] as string;
      return {
        name: row[0] as string,
        type: dataType === 'USER-DEFINED' ? udtName : dataType,
        normalizedType: this.normalizeDataType(dataType, udtName),
        nullable: row[3] === 'YES',
        defaultValue: row[4],
        isPrimaryKey: row[10] as boolean,
        isAutoIncrement: row[11] as boolean,
        isUnique: false,
        maxLength: row[5] as number | undefined,
        precision: row[6] as number | undefined,
        scale: row[7] as number | undefined,
        comment: row[9] as string | undefined,
        ordinalPosition: row[8] as number,
      };
    });
  }

  async getIndexes(table: string, schema?: string): Promise<IndexInfo[]> {
    this.ensureConnected();
    const s = schema || this.currentSchema;

    const result = await this.query(`
      SELECT
        i.relname as index_name,
        array_to_string(array_agg(a.attname ORDER BY k.ordinality), ',') as columns,
        ix.indisunique as is_unique,
        am.amname as index_type,
        obj_description(i.oid) as comment
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = $1 AND t.relname = $2
      GROUP BY i.relname, ix.indisunique, am.amname, i.oid
      ORDER BY i.relname
    `, [s, table]);

    return result.rows.map(row => ({
      name: row[0] as string,
      columns: (row[1] as string).split(','),
      unique: row[2] as boolean,
      type: row[3] as string,
      comment: row[4] as string | undefined,
    }));
  }

  async getForeignKeys(table: string, schema?: string): Promise<ForeignKeyInfo[]> {
    this.ensureConnected();
    const s = schema || this.currentSchema;

    const result = await this.query(`
      SELECT
        tc.constraint_name,
        string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) as columns,
        ccu.table_name as ref_table,
        ccu.table_schema as ref_schema,
        string_agg(ccu.column_name, ',' ORDER BY kcu.ordinal_position) as ref_columns,
        rc.delete_rule,
        rc.update_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
      WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
      GROUP BY tc.constraint_name, ccu.table_name, ccu.table_schema, rc.delete_rule, rc.update_rule
    `, [s, table]);

    return result.rows.map(row => ({
      name: row[0] as string,
      columns: (row[1] as string).split(','),
      referencedTable: row[2] as string,
      referencedSchema: row[3] as string,
      referencedColumns: (row[4] as string).split(','),
      onDelete: row[5] as string,
      onUpdate: row[6] as string,
    }));
  }

  async getPrimaryKey(table: string, schema?: string): Promise<string[]> {
    this.ensureConnected();
    const s = schema || this.currentSchema;

    const result = await this.query(`
      SELECT ku.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage ku
        ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
      WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY ku.ordinal_position
    `, [s, table]);

    return result.rows.map(row => row[0] as string);
  }

  async switchDatabase(database: string): Promise<void> {
    // PostgreSQL requires reconnecting to switch databases
    if (!this._config) { throw new Error('No connection config'); }

    await this.disconnect();
    await this.connect({ ...this._config, database });
    this.currentDb = database;
  }

  async getServerInfo(): Promise<ServerInfo> {
    this.ensureConnected();
    const result = await this.query(`
      SELECT version(),
             current_setting('max_connections')::int,
             (SELECT count(*) FROM pg_stat_activity)::int as current_connections
    `);
    const row = result.rows[0];
    return {
      version: row[0] as string,
      maxConnections: row[1] as number,
      currentConnections: row[2] as number,
    };
  }

  async getCurrentDatabase(): Promise<string> {
    if (!this._isConnected) { return ''; }
    const result = await this.query('SELECT current_database()');
    return (result.rows[0]?.[0] as string) || '';
  }

  async getCurrentSchema(): Promise<string | undefined> {
    if (!this._isConnected) { return undefined; }
    const result = await this.query('SELECT current_schema()');
    return (result.rows[0]?.[0] as string) || 'public';
  }

  escapeIdentifier(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  }

  escapeValue(value: unknown): string {
    if (value === null || value === undefined) { return 'NULL'; }
    if (typeof value === 'number') { return String(value); }
    if (typeof value === 'boolean') { return value ? 'TRUE' : 'FALSE'; }
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  // ── Private helpers ──

  private buildSSLConfig(config: ConnectionConfig): boolean | object | undefined {
    switch (config.ssl.mode) {
      case 'disabled': return false;
      case 'preferred': return { rejectUnauthorized: false };
      case 'required': return { rejectUnauthorized: false };
      case 'verify-ca': return { rejectUnauthorized: true, ca: config.ssl.caPath };
      case 'verify-full': return { rejectUnauthorized: true, ca: config.ssl.caPath, cert: config.ssl.certPath, key: config.ssl.keyPath };
      default: return undefined;
    }
  }

  private mapTableType(pgType: string): 'table' | 'view' | 'materializedView' | 'foreignTable' {
    switch (pgType) {
      case 'VIEW': return 'view';
      case 'FOREIGN TABLE': return 'foreignTable';
      default: return 'table';
    }
  }

  private oidToType(oid: number): string {
    const map: Record<number, string> = {
      16: 'bool', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text',
      26: 'oid', 700: 'float4', 701: 'float8', 1042: 'bpchar',
      1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp',
      1184: 'timestamptz', 1266: 'timetz', 1700: 'numeric',
      2950: 'uuid', 3802: 'jsonb', 114: 'json', 17: 'bytea',
      1015: 'varchar[]', 1009: 'text[]', 1007: 'int4[]',
    };
    return map[oid] || `oid:${oid}`;
  }

  private normalizeOid(oid: number): NormalizedColumnType {
    switch (oid) {
      case 16: return NormalizedColumnType.Boolean;
      case 20: case 21: case 23: case 26: return NormalizedColumnType.Integer;
      case 700: case 701: return NormalizedColumnType.Float;
      case 1700: return NormalizedColumnType.Decimal;
      case 25: case 1042: case 1043: return NormalizedColumnType.String;
      case 1082: return NormalizedColumnType.Date;
      case 1114: case 1184: return NormalizedColumnType.DateTime;
      case 1083: case 1266: return NormalizedColumnType.Time;
      case 2950: return NormalizedColumnType.UUID;
      case 114: case 3802: return NormalizedColumnType.JSON;
      case 17: return NormalizedColumnType.Binary;
      default: return NormalizedColumnType.Unknown;
    }
  }

  private normalizeDataType(dataType: string, udtName: string): NormalizedColumnType {
    const dt = dataType.toLowerCase();
    if (['integer', 'smallint', 'bigint', 'serial', 'bigserial', 'smallserial'].includes(dt)) {
      return NormalizedColumnType.Integer;
    }
    if (['numeric', 'decimal', 'money'].includes(dt)) { return NormalizedColumnType.Decimal; }
    if (['real', 'double precision'].includes(dt)) { return NormalizedColumnType.Float; }
    if (dt === 'boolean') { return NormalizedColumnType.Boolean; }
    if (['character varying', 'character', 'text'].includes(dt)) { return NormalizedColumnType.String; }
    if (dt === 'date') { return NormalizedColumnType.Date; }
    if (dt.includes('timestamp')) { return NormalizedColumnType.DateTime; }
    if (dt.includes('time')) { return NormalizedColumnType.Time; }
    if (dt === 'uuid') { return NormalizedColumnType.UUID; }
    if (['json', 'jsonb'].includes(dt)) { return NormalizedColumnType.JSON; }
    if (dt === 'bytea') { return NormalizedColumnType.Binary; }
    if (dt === 'ARRAY') { return NormalizedColumnType.Array; }
    if (dt === 'USER-DEFINED' && udtName === 'geometry') { return NormalizedColumnType.Unknown; }
    return NormalizedColumnType.Unknown;
  }
}
