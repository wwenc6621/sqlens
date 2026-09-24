import * as mysql from 'mysql2/promise';
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
 * MySQL / MariaDB database driver using mysql2.
 * Connects via connection pool for auto-reconnect and connection reuse.
 */
export class MySQLDriver extends BaseDriver {
  readonly driverType = 'mysql';

  private pool: mysql.Pool | null = null;
  private currentDb: string = '';

  async connect(config: ConnectionConfig): Promise<void> {
    const poolConfig: mysql.PoolOptions = {
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database || undefined,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 10_000,
      multipleStatements: true,
      dateStrings: true,
    };

    if (config.ssl.mode !== 'disabled') {
      poolConfig.ssl = this.buildSSLOptions(config);
    }

    try {
      this.pool = mysql.createPool(poolConfig);
      const conn = await this.pool.getConnection();
      conn.release();
    } catch (err) {
      if (config.ssl.mode === 'preferred' && err instanceof Error && (err.message.includes('does not support secure connection') || err.message.includes('SSL'))) {
        Logger.getInstance().logInfo('MySQL server does not support secure connection. Falling back to unencrypted connection.');
        delete poolConfig.ssl;
        if (this.pool) {
          await this.pool.end().catch(() => {});
        }
        this.pool = mysql.createPool(poolConfig);
        const conn = await this.pool.getConnection();
        conn.release();
      } else {
        throw err;
      }
    }

    this.currentDb = config.database || '';
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
    let testPool: mysql.Pool | null = null;
    try {
      const poolConfig: mysql.PoolOptions = {
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database || undefined,
        connectTimeout: 10_000,
        connectionLimit: 1,
      };

      if (config.ssl.mode !== 'disabled') {
        poolConfig.ssl = this.buildSSLOptions(config);
      }

      let conn;
      try {
        testPool = mysql.createPool(poolConfig);
        conn = await testPool.getConnection();
      } catch (err) {
        if (config.ssl.mode === 'preferred' && err instanceof Error && (err.message.includes('does not support secure connection') || err.message.includes('SSL'))) {
          Logger.getInstance().logInfo('MySQL server does not support secure connection during test. Falling back to unencrypted connection.');
          delete poolConfig.ssl;
          if (testPool) {
            await testPool.end().catch(() => {});
          }
          testPool = mysql.createPool(poolConfig);
          conn = await testPool.getConnection();
        } else {
          throw err;
        }
      }

      const [versionRows] = await conn.query('SELECT VERSION() as version');
      const version = (versionRows as Array<{ version: string }>)[0]?.version || 'unknown';

      conn.release();

      return {
        success: true,
        message: `Connected to MySQL ${version}`,
        serverInfo: { version },
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (testPool) {
        await testPool.end().catch(() => {});
      }
    }
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();
    const start = performance.now();
    const conn = await this.pool!.getConnection();

    try {
      if (this.currentDb) {
        await conn.query(`USE ${this.escapeIdentifier(this.currentDb)}`);
      }
      const [rows, fields] = await conn.query(sql, params);
      const executionTime = Math.round(performance.now() - start);

      // DDL/DML statements return OkPacket
      if (!Array.isArray(rows)) {
        const result = rows as mysql.ResultSetHeader;
        const queryRes = {
          columns: [],
          rows: [],
          affectedRows: result.affectedRows || 0,
          executionTime,
          truncated: false,
          messages: [result.info || ''].filter(Boolean),
        };
        Logger.getInstance().logSQL(sql, executionTime);
        return queryRes;
      }

      const columns: ColumnHeader[] = (fields as mysql.FieldPacket[]).map(f => ({
        name: f.name,
        type: this.fieldTypeToString(f.type),
        normalizedType: this.normalizeType(f.type, f.flags as number),
        nullable: !((f.flags as number) & 0x01), // NOT_NULL_FLAG
        isPrimaryKey: !!((f.flags as number) & 0x02), // PRI_KEY_FLAG
        isAutoIncrement: !!((f.flags as number) & 0x200), // AUTO_INCREMENT_FLAG
        defaultValue: null,
        // NOTE: f.length is a byte budget, not the declared length, so it is
        // deliberately not used here. The declared type is resolved from
        // information_schema when the source table is known.
        rawType: this.fieldTypeToString(f.type),
        table: f.table,
        schema: f.db,
      }));

      const dataRows = (rows as Array<Record<string, unknown>>).map(row =>
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
    } finally {
      conn.release();
    }
  }

  async cancelQuery(): Promise<void> {
    // MySQL cancellation requires killing the connection thread
    // For now, this is a no-op; full implementation would use KILL QUERY
  }

  async getDatabases(): Promise<DatabaseInfo[]> {
    this.ensureConnected();
    const result = await this.query('SHOW DATABASES');
    return result.rows.map(row => ({
      name: row[0] as string,
    }));
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    // MySQL doesn't have schemas separate from databases
    return [];
  }

  /**
   * Fast, stats-free table listing (`SHOW TABLES`). On MySQL-compatible
   * distributed databases (e.g. OceanBase) information_schema.TABLES can take
   * many seconds because it aggregates internal statistics; this query returns
   * in milliseconds so UIs can render the list immediately and hydrate the
   * stats afterwards via getTables().
   */
  async getTableNames(schema?: string): Promise<{ name: string; type: 'table' | 'view' }[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;
    if (!db) { return []; }
    const result = await this.query(`SHOW TABLES FROM ${this.escapeIdentifier(db)}`);
    return result.rows.map(row => ({ name: row[0] as string, type: 'table' as const }));
  }

  async getTables(schema?: string): Promise<TableInfo[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;
    if (!db) { return []; }

    const result = await this.query(`
      SELECT
        TABLE_NAME as name,
        TABLE_TYPE as type,
        ENGINE as engine,
        TABLE_ROWS as row_count,
        DATA_LENGTH as data_size,
        TABLE_COMMENT as comment
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [db]);

    return result.rows.map(row => ({
      name: row[0] as string,
      schema: db,
      type: (row[1] as string) === 'VIEW' ? 'view' as const : 'table' as const,
      engine: row[2] as string | undefined,
      rowCount: row[3] as number | undefined,
      dataSize: row[4] as number | undefined,
      comment: row[5] as string | undefined,
    }));
  }

  async getColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;

    const result = await this.query(`
      SELECT
        COLUMN_NAME,
        COLUMN_TYPE,
        DATA_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        COLUMN_KEY,
        EXTRA,
        CHARACTER_MAXIMUM_LENGTH,
        NUMERIC_PRECISION,
        NUMERIC_SCALE,
        COLUMN_COMMENT,
        ORDINAL_POSITION
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [db, table]);

    return result.rows.map(row => ({
      name: row[0] as string,
      type: row[1] as string,
      normalizedType: this.normalizeDataType(row[2] as string),
      nullable: row[3] === 'YES',
      defaultValue: row[4],
      isPrimaryKey: row[5] === 'PRI',
      isAutoIncrement: (row[6] as string || '').includes('auto_increment'),
      isUnique: row[5] === 'UNI',
      maxLength: row[7] as number | undefined,
      precision: row[8] as number | undefined,
      scale: row[9] as number | undefined,
      comment: row[10] as string | undefined,
      ordinalPosition: row[11] as number,
    }));
  }

  async getIndexes(table: string, schema?: string): Promise<IndexInfo[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;

    const result = await this.query(`
      SELECT
        INDEX_NAME,
        GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns,
        NON_UNIQUE,
        INDEX_TYPE,
        INDEX_COMMENT
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE, INDEX_COMMENT
      ORDER BY INDEX_NAME
    `, [db, table]);

    return result.rows.map(row => ({
      name: row[0] as string,
      columns: (row[1] as string).split(','),
      unique: row[2] === 0,
      type: row[3] as string,
      comment: row[4] as string | undefined,
    }));
  }

  async getForeignKeys(table: string, schema?: string): Promise<ForeignKeyInfo[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;

    const result = await this.query(`
      SELECT
        kcu.CONSTRAINT_NAME,
        GROUP_CONCAT(kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION) as columns,
        kcu.REFERENCED_TABLE_NAME,
        kcu.REFERENCED_TABLE_SCHEMA,
        GROUP_CONCAT(kcu.REFERENCED_COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION) as ref_columns,
        rc.DELETE_RULE,
        rc.UPDATE_RULE
      FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
        AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
      WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      GROUP BY kcu.CONSTRAINT_NAME, kcu.REFERENCED_TABLE_NAME,
               kcu.REFERENCED_TABLE_SCHEMA, rc.DELETE_RULE, rc.UPDATE_RULE
    `, [db, table]);

    return result.rows.map(row => ({
      name: row[0] as string,
      columns: (row[1] as string).split(','),
      referencedTable: row[2] as string,
      referencedSchema: row[3] as string | undefined,
      referencedColumns: (row[4] as string).split(','),
      onDelete: row[5] as string,
      onUpdate: row[6] as string,
    }));
  }

  async getPrimaryKey(table: string, schema?: string): Promise<string[]> {
    this.ensureConnected();
    const db = schema || this.currentDb;

    const result = await this.query(`
      SELECT COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY ORDINAL_POSITION
    `, [db, table]);

    return result.rows.map(row => row[0] as string);
  }

  async switchDatabase(database: string): Promise<void> {
    this.ensureConnected();
    await this.query(`USE ${this.escapeIdentifier(database)}`);
    this.currentDb = database;
  }

  async getServerInfo(): Promise<ServerInfo> {
    this.ensureConnected();
    const result = await this.query("SELECT VERSION() as v, @@max_connections as mc");
    const row = result.rows[0];
    return {
      version: row[0] as string,
      maxConnections: row[1] as number,
    };
  }

  async getCurrentDatabase(): Promise<string> {
    if (!this._isConnected) { return ''; }
    const result = await this.query('SELECT DATABASE() as db');
    return (result.rows[0]?.[0] as string) || '';
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
    if (typeof value === 'boolean') { return value ? '1' : '0'; }
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  // ── Private helpers ──

  private buildSSLOptions(config: ConnectionConfig): mysql.SslOptions {
    const ssl: mysql.SslOptions = {};
    if (config.ssl.mode === 'preferred' || config.ssl.mode === 'required') {
      ssl.rejectUnauthorized = false;
    } else if (config.ssl.mode === 'verify-ca' || config.ssl.mode === 'verify-full') {
      ssl.rejectUnauthorized = true;
    }
    if (config.ssl.caPath) { ssl.ca = config.ssl.caPath; }
    if (config.ssl.certPath) { ssl.cert = config.ssl.certPath; }
    if (config.ssl.keyPath) { ssl.key = config.ssl.keyPath; }
    return ssl;
  }

  private fieldTypeToString(type?: number): string {
    const map: Record<number, string> = {
      0: 'DECIMAL', 1: 'TINYINT', 2: 'SMALLINT', 3: 'INT',
      4: 'FLOAT', 5: 'DOUBLE', 6: 'NULL', 7: 'TIMESTAMP',
      8: 'BIGINT', 9: 'MEDIUMINT', 10: 'DATE', 11: 'TIME',
      12: 'DATETIME', 13: 'YEAR', 14: 'NEWDATE', 15: 'VARCHAR',
      16: 'BIT', 245: 'JSON', 246: 'NEWDECIMAL', 247: 'ENUM',
      248: 'SET', 249: 'TINY_BLOB', 250: 'MEDIUM_BLOB',
      251: 'LONG_BLOB', 252: 'BLOB', 253: 'VAR_STRING',
      254: 'STRING', 255: 'GEOMETRY',
    };
    return map[type ?? -1] || 'UNKNOWN';
  }

  private normalizeType(type?: number, flags?: number): NormalizedColumnType {
    if (flags && (flags & 0x200)) { /* AUTO_INCREMENT */ }

    switch (type) {
      case 1: case 2: case 3: case 8: case 9: case 13:
        return NormalizedColumnType.Integer;
      case 0: case 246:
        return NormalizedColumnType.Decimal;
      case 4: case 5:
        return NormalizedColumnType.Float;
      case 10: case 14:
        return NormalizedColumnType.Date;
      case 7: case 12:
        return NormalizedColumnType.DateTime;
      case 11:
        return NormalizedColumnType.Time;
      case 16:
        return NormalizedColumnType.Integer;
      case 245:
        return NormalizedColumnType.JSON;
      case 247:
        return NormalizedColumnType.Enum;
      case 249: case 250: case 251: case 252:
        return NormalizedColumnType.Binary;
      case 15: case 253: case 254:
        return NormalizedColumnType.String;
      default:
        return NormalizedColumnType.Unknown;
    }
  }

  private normalizeDataType(dataType: string): NormalizedColumnType {
    const lower = dataType.toLowerCase();
    if (['int', 'tinyint', 'smallint', 'mediumint', 'bigint', 'year'].includes(lower)) {
      return NormalizedColumnType.Integer;
    }
    if (['decimal', 'numeric'].includes(lower)) { return NormalizedColumnType.Decimal; }
    if (['float', 'double', 'real'].includes(lower)) { return NormalizedColumnType.Float; }
    if (['date'].includes(lower)) { return NormalizedColumnType.Date; }
    if (['datetime', 'timestamp'].includes(lower)) { return NormalizedColumnType.DateTime; }
    if (['time'].includes(lower)) { return NormalizedColumnType.Time; }
    if (['json'].includes(lower)) { return NormalizedColumnType.JSON; }
    if (['enum'].includes(lower)) { return NormalizedColumnType.Enum; }
    if (['binary', 'varbinary', 'blob', 'tinyblob', 'mediumblob', 'longblob'].includes(lower)) {
      return NormalizedColumnType.Binary;
    }
    if (['char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext'].includes(lower)) {
      return NormalizedColumnType.String;
    }
    if (['bit', 'boolean', 'bool'].includes(lower)) { return NormalizedColumnType.Boolean; }
    return NormalizedColumnType.Unknown;
  }
}
