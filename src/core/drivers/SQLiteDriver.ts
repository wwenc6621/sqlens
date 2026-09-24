import * as path from 'path';
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
 * SQLite driver using sql.js (WASM-based SQLite).
 * Using sql.js instead of better-sqlite3 to avoid native module compilation issues
 * across different VSCode/Electron versions.
 */

// sql.js types (loaded dynamically)
interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  getRowsModified(): number;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

export class SQLiteDriver extends BaseDriver {
  readonly driverType = 'sqlite';

  private db: SqlJsDatabase | null = null;
  private filePath: string = '';
  private SQL: SqlJsStatic | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    const filePath = config.filepath || config.database || '';
    if (!filePath) {
      throw new Error('SQLite file path is required');
    }

    // Dynamically load sql.js
    const initSqlJs = await this.loadSqlJs();
    this.SQL = initSqlJs;

    const fs = await import('fs');
    if (fs.existsSync(filePath)) {
      const fileBuffer = fs.readFileSync(filePath);
      this.db = new this.SQL.Database(fileBuffer);
    } else {
      this.db = new this.SQL.Database();
    }

    // Enable WAL mode and foreign keys
    this.db.run('PRAGMA journal_mode=WAL');
    this.db.run('PRAGMA foreign_keys=ON');

    this.filePath = filePath;
    this._config = config;
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      // Save to file before closing
      await this.saveToFile();
      this.db.close();
      this.db = null;
    }
    this._isConnected = false;
    this._config = null;
  }

  async testConnection(config: ConnectionConfig): Promise<{ success: boolean; message: string; serverInfo?: ServerInfo }> {
    try {
      const filePath = config.filepath || config.database || '';
      if (!filePath) {
        return { success: false, message: 'File path is required' };
      }

      const fs = await import('fs');
      if (!fs.existsSync(filePath)) {
        return {
          success: true,
          message: 'File does not exist yet. A new database will be created.',
          serverInfo: { version: 'SQLite (new)' },
        };
      }

      const initSqlJs = await this.loadSqlJs();
      const fileBuffer = fs.readFileSync(filePath);
      const testDb = new initSqlJs.Database(fileBuffer);
      const result = testDb.exec('SELECT sqlite_version()');
      const version = result[0]?.values[0]?.[0] as string || 'unknown';
      testDb.close();

      return {
        success: true,
        message: `Connected to SQLite ${version}`,
        serverInfo: { version: `SQLite ${version}` },
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();
    const start = performance.now();

    try {
      const trimmed = sql.trim().toUpperCase();
      const isSelect = trimmed.startsWith('SELECT') ||
                       trimmed.startsWith('PRAGMA') ||
                       trimmed.startsWith('EXPLAIN') ||
                       trimmed.startsWith('WITH');

      if (isSelect) {
        const results = this.db!.exec(sql, params);
        const executionTime = Math.round(performance.now() - start);

        if (results.length === 0) {
          const queryRes = {
            columns: [],
            rows: [],
            affectedRows: 0,
            executionTime,
            truncated: false,
            messages: [],
          };
          Logger.getInstance().logSQL(sql, executionTime);
          return queryRes;
        }

        const result = results[0];
        const columns: ColumnHeader[] = result.columns.map(name => ({
          name,
          type: 'TEXT', // SQLite is dynamically typed
          normalizedType: NormalizedColumnType.String,
          nullable: true,
          isPrimaryKey: false,
          isAutoIncrement: false,
          defaultValue: null,
          rawType: 'TEXT',
        }));

        const queryRes = {
          columns,
          rows: result.values,
          affectedRows: 0,
          executionTime,
          truncated: false,
          messages: [],
        };
        Logger.getInstance().logSQL(sql, executionTime);
        return queryRes;
      } else {
        this.db!.run(sql, params);
        const affectedRows = this.db!.getRowsModified();
        const executionTime = Math.round(performance.now() - start);

        // Auto-save after modifications
        await this.saveToFile();

        const queryRes = {
          columns: [],
          rows: [],
          affectedRows,
          executionTime,
          truncated: false,
          messages: [`${affectedRows} rows affected`],
        };
        Logger.getInstance().logSQL(sql, executionTime);
        return queryRes;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      Logger.getInstance().logSQL(sql, undefined, errMsg);
      throw new Error(`SQLite error: ${errMsg}`);
    }
  }

  async cancelQuery(): Promise<void> {
    // SQLite operations are synchronous, can't cancel
  }

  async getDatabases(): Promise<DatabaseInfo[]> {
    return [{ name: path.basename(this.filePath) }];
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    return [{ name: 'main', isDefault: true }];
  }

  async getTables(schema?: string): Promise<TableInfo[]> {
    this.ensureConnected();

    const result = await this.query(`
      SELECT name, type
      FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    return result.rows.map(row => ({
      name: row[0] as string,
      schema: schema || 'main',
      type: (row[1] as string) === 'view' ? 'view' as const : 'table' as const,
    }));
  }

  async getColumns(table: string): Promise<ColumnInfo[]> {
    this.ensureConnected();

    const result = await this.query(`PRAGMA table_info(${this.escapeIdentifier(table)})`);

    return result.rows.map(row => ({
      name: row[1] as string,
      type: row[2] as string,
      normalizedType: this.normalizeSQLiteType(row[2] as string),
      nullable: !(row[3] as number),
      defaultValue: row[4],
      isPrimaryKey: !!(row[5] as number),
      isAutoIncrement: false, // Need to check separately
      isUnique: false,
      ordinalPosition: (row[0] as number) + 1,
    }));
  }

  async getIndexes(table: string): Promise<IndexInfo[]> {
    this.ensureConnected();

    const result = await this.query(`PRAGMA index_list(${this.escapeIdentifier(table)})`);

    const indexes: IndexInfo[] = [];
    for (const row of result.rows) {
      const indexName = row[1] as string;
      const colResult = await this.query(`PRAGMA index_info(${this.escapeIdentifier(indexName)})`);

      indexes.push({
        name: indexName,
        columns: colResult.rows.map(r => r[2] as string),
        unique: !!(row[2] as number),
        type: 'BTREE',
      });
    }

    return indexes;
  }

  async getForeignKeys(table: string): Promise<ForeignKeyInfo[]> {
    this.ensureConnected();

    const result = await this.query(`PRAGMA foreign_key_list(${this.escapeIdentifier(table)})`);

    // Group by FK id
    const fkMap = new Map<number, ForeignKeyInfo>();
    for (const row of result.rows) {
      const id = row[0] as number;
      if (!fkMap.has(id)) {
        fkMap.set(id, {
          name: `fk_${table}_${id}`,
          columns: [],
          referencedTable: row[2] as string,
          referencedColumns: [],
          onUpdate: row[5] as string,
          onDelete: row[6] as string,
        });
      }
      const fk = fkMap.get(id)!;
      fk.columns.push(row[3] as string);
      fk.referencedColumns.push(row[4] as string);
    }

    return Array.from(fkMap.values());
  }

  async getPrimaryKey(table: string): Promise<string[]> {
    const columns = await this.getColumns(table);
    return columns.filter(c => c.isPrimaryKey).map(c => c.name);
  }

  async switchDatabase(): Promise<void> {
    // SQLite is a single-database system
    throw new Error('SQLite does not support database switching');
  }

  async getServerInfo(): Promise<ServerInfo> {
    this.ensureConnected();
    const result = await this.query('SELECT sqlite_version()');
    return {
      version: `SQLite ${result.rows[0]?.[0] || 'unknown'}`,
    };
  }

  async getCurrentDatabase(): Promise<string> {
    return path.basename(this.filePath);
  }

  async getCurrentSchema(): Promise<string | undefined> {
    return 'main';
  }

  escapeIdentifier(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  }

  escapeValue(value: unknown): string {
    if (value === null || value === undefined) { return 'NULL'; }
    if (typeof value === 'number') { return String(value); }
    if (typeof value === 'boolean') { return value ? '1' : '0'; }
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  // ── Private helpers ──

  private async loadSqlJs(): Promise<SqlJsStatic> {
    const initSqlJs = require('sql.js');
    return await initSqlJs({
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
    });
  }

  private async saveToFile(): Promise<void> {
    if (!this.db || !this.filePath) { return; }

    try {
      const fs = await import('fs');
      const data = (this.db as any).export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.filePath, buffer);
    } catch (err) {
      console.error('Failed to save SQLite database:', err);
    }
  }

  private normalizeSQLiteType(type: string): NormalizedColumnType {
    const upper = type.toUpperCase();

    if (upper.includes('INT')) { return NormalizedColumnType.Integer; }
    if (upper.includes('REAL') || upper.includes('FLOAT') || upper.includes('DOUBLE')) {
      return NormalizedColumnType.Float;
    }
    if (upper.includes('DECIMAL') || upper.includes('NUMERIC')) {
      return NormalizedColumnType.Decimal;
    }
    if (upper.includes('BOOL')) { return NormalizedColumnType.Boolean; }
    if (upper.includes('DATE') && !upper.includes('DATETIME')) {
      return NormalizedColumnType.Date;
    }
    if (upper.includes('DATETIME') || upper.includes('TIMESTAMP')) {
      return NormalizedColumnType.DateTime;
    }
    if (upper.includes('TIME')) { return NormalizedColumnType.Time; }
    if (upper.includes('BLOB')) { return NormalizedColumnType.Binary; }
    if (upper.includes('JSON')) { return NormalizedColumnType.JSON; }
    if (upper.includes('TEXT') || upper.includes('CHAR') || upper.includes('CLOB') || upper.includes('VARCHAR')) {
      return NormalizedColumnType.String;
    }

    return NormalizedColumnType.Unknown;
  }
}
