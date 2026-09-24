import {
  ConnectionConfig,
  QueryResult,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  SchemaInfo,
  DatabaseInfo,
  ServerInfo,
} from '../types';

/**
 * Abstract database driver interface.
 * All database-specific drivers must implement this interface.
 * 
 * The driver manages a single connection lifecycle and exposes
 * methods for querying, schema introspection, and metadata retrieval.
 */
export interface DatabaseDriver {
  /** Driver identifier matching DatabaseType enum value */
  readonly driverType: string;

  /** Whether the driver is currently connected */
  readonly isConnected: boolean;

  // ── Connection lifecycle ──

  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;
  testConnection(config: ConnectionConfig): Promise<{ success: boolean; message: string; serverInfo?: ServerInfo }>;

  // ── Query execution ──

  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  /** Execute multiple statements separated by semicolons */
  queryMultiple(sql: string): Promise<QueryResult[]>;
  /** Cancel a currently running query (if supported) */
  cancelQuery(): Promise<void>;

  // ── Schema introspection ──

  getDatabases(): Promise<DatabaseInfo[]>;
  getSchemas(database?: string): Promise<SchemaInfo[]>;
  getTables(schema?: string): Promise<TableInfo[]>;
  getColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
  getIndexes(table: string, schema?: string): Promise<IndexInfo[]>;
  getForeignKeys(table: string, schema?: string): Promise<ForeignKeyInfo[]>;
  getPrimaryKey(table: string, schema?: string): Promise<string[]>;

  // ── Database operations ──

  switchDatabase(database: string): Promise<void>;
  getServerInfo(): Promise<ServerInfo>;
  getCurrentDatabase(): Promise<string>;
  getCurrentSchema(): Promise<string | undefined>;

  // ── Utilities ──

  /** Escape an identifier (table name, column name) for this database */
  escapeIdentifier(name: string): string;
  /** Escape a string value for this database */
  escapeValue(value: unknown): string;
  /** Get the SQL for LIMIT/OFFSET pagination */
  paginationSQL(limit: number, offset: number): string;
}

/**
 * Base class with shared utility methods for database drivers.
 * Concrete drivers extend this and implement the abstract methods.
 */
export abstract class BaseDriver implements DatabaseDriver {
  abstract readonly driverType: string;

  protected _isConnected = false;
  protected _config: ConnectionConfig | null = null;

  get isConnected(): boolean {
    return this._isConnected;
  }

  abstract connect(config: ConnectionConfig): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract testConnection(config: ConnectionConfig): Promise<{ success: boolean; message: string; serverInfo?: ServerInfo }>;
  abstract query(sql: string, params?: unknown[]): Promise<QueryResult>;
  abstract cancelQuery(): Promise<void>;
  abstract getDatabases(): Promise<DatabaseInfo[]>;
  abstract getSchemas(database?: string): Promise<SchemaInfo[]>;
  abstract getTables(schema?: string): Promise<TableInfo[]>;
  abstract getColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
  abstract getIndexes(table: string, schema?: string): Promise<IndexInfo[]>;
  abstract getForeignKeys(table: string, schema?: string): Promise<ForeignKeyInfo[]>;
  abstract getPrimaryKey(table: string, schema?: string): Promise<string[]>;
  abstract switchDatabase(database: string): Promise<void>;
  abstract getServerInfo(): Promise<ServerInfo>;
  abstract getCurrentDatabase(): Promise<string>;
  abstract getCurrentSchema(): Promise<string | undefined>;
  abstract escapeIdentifier(name: string): string;
  abstract escapeValue(value: unknown): string;

  async queryMultiple(sql: string): Promise<QueryResult[]> {
    const statements = this.splitStatements(sql);
    const results: QueryResult[] = [];
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed) {
        results.push(await this.query(trimmed));
      }
    }
    return results;
  }

  paginationSQL(limit: number, offset: number): string {
    return `LIMIT ${limit} OFFSET ${offset}`;
  }

  /**
   * Split SQL text into individual statements by semicolons.
   * Respects string literals and comments.
   */
  protected splitStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < sql.length; i++) {
      const char = sql[i];
      const next = sql[i + 1];

      if (inLineComment) {
        current += char;
        if (char === '\n') {
          inLineComment = false;
        }
        continue;
      }

      if (inBlockComment) {
        current += char;
        if (char === '*' && next === '/') {
          current += '/';
          i++;
          inBlockComment = false;
        }
        continue;
      }

      if (inSingleQuote) {
        current += char;
        if (char === "'" && next === "'") {
          current += "'";
          i++;
        } else if (char === "'") {
          inSingleQuote = false;
        }
        continue;
      }

      if (inDoubleQuote) {
        current += char;
        if (char === '"') {
          inDoubleQuote = false;
        }
        continue;
      }

      if (char === '-' && next === '-') {
        current += '--';
        i++;
        inLineComment = true;
        continue;
      }

      if (char === '/' && next === '*') {
        current += '/*';
        i++;
        inBlockComment = true;
        continue;
      }

      if (char === "'") {
        inSingleQuote = true;
        current += char;
        continue;
      }

      if (char === '"') {
        inDoubleQuote = true;
        current += char;
        continue;
      }

      if (char === ';') {
        const trimmed = current.trim();
        if (trimmed) {
          statements.push(trimmed);
        }
        current = '';
        continue;
      }

      current += char;
    }

    const trimmed = current.trim();
    if (trimmed) {
      statements.push(trimmed);
    }

    return statements;
  }

  protected ensureConnected(): void {
    if (!this._isConnected) {
      throw new Error('Not connected to database');
    }
  }
}
