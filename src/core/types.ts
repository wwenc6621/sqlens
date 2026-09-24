/**
 * Core type definitions for Sqlens VSCode Extension.
 * Defines all shared interfaces, types, and enums used across the extension.
 */

export enum DatabaseType {
  MySQL = 'mysql',
  PostgreSQL = 'postgresql',
  SQLite = 'sqlite',
  Redis = 'redis',
  MongoDB = 'mongodb',
  MSSQL = 'mssql',
  MariaDB = 'mariadb',
}

export enum SSLMode {
  Disabled = 'disabled',
  Preferred = 'preferred',
  Required = 'required',
  VerifyCA = 'verify-ca',
  VerifyFull = 'verify-full',
}

export interface SSHConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'privateKey' | 'agent';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface SSLConfig {
  mode: SSLMode;
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  rejectUnauthorized?: boolean;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  username: string;
  password?: string;
  database?: string;
  /** SQLite file path */
  filepath?: string;
  ssl: SSLConfig;
  ssh: SSHConfig;
  /** Database-specific options (e.g., charset, timezone) */
  options: Record<string, unknown>;
  /** Connection group for organizing in sidebar */
  group?: string;
  /** Tags for filtering */
  tags: string[];
  /** Color label for visual identification */
  color?: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last modified timestamp */
  updatedAt: number;
}

export interface QueryResult {
  /** Column definitions */
  columns: ColumnHeader[];
  /** Row data as arrays (ordered by columns) */
  rows: unknown[][];
  /** Number of rows affected (for INSERT/UPDATE/DELETE) */
  affectedRows: number;
  /** Execution time in milliseconds */
  executionTime: number;
  /** Whether the result set was truncated */
  truncated: boolean;
  /** Total row count (if available from COUNT query) */
  totalRows?: number;
  /** Informational messages from the server */
  messages: string[];
}

export interface ColumnHeader {
  name: string;
  type: string;
  /** Normalized type for rendering logic */
  normalizedType: NormalizedColumnType;
  nullable: boolean;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  defaultValue: unknown;
  /** Max length for string types */
  maxLength?: number;
  /** Precision for numeric types */
  precision?: number;
  /** Scale for decimal types */
  scale?: number;
  /** Database-specific raw type name */
  rawType: string;
  /** Table name (for JOIN results) */
  table?: string;
  /** Schema name */
  schema?: string;
  /** Attribute number of the source column, when the driver can report it */
  columnId?: number;
  /** Column comment / description from the database catalog */
  comment?: string;
}

export enum NormalizedColumnType {
  String = 'string',
  Integer = 'integer',
  Float = 'float',
  Decimal = 'decimal',
  Boolean = 'boolean',
  Date = 'date',
  DateTime = 'datetime',
  Time = 'time',
  Timestamp = 'timestamp',
  JSON = 'json',
  Binary = 'binary',
  Enum = 'enum',
  UUID = 'uuid',
  Array = 'array',
  Unknown = 'unknown',
}

export interface TableInfo {
  name: string;
  schema?: string;
  type: 'table' | 'view' | 'materializedView' | 'foreignTable';
  engine?: string;
  rowCount?: number;
  dataSize?: number;
  comment?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  normalizedType: NormalizedColumnType;
  nullable: boolean;
  defaultValue: unknown;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  isUnique: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
  comment?: string;
  enumValues?: string[];
  /** Ordinal position (1-based) */
  ordinalPosition: number;
  /** Foreign key reference */
  foreignKey?: ForeignKeyRef;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
  comment?: string;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedSchema?: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export interface ForeignKeyRef {
  table: string;
  column: string;
  schema?: string;
}

export interface SchemaInfo {
  name: string;
  isDefault: boolean;
}

export interface DatabaseInfo {
  name: string;
  size?: number;
  encoding?: string;
}

export interface ServerInfo {
  version: string;
  platform?: string;
  uptime?: number;
  maxConnections?: number;
  currentConnections?: number;
}

/** Change tracking types */
export enum ChangeType {
  Insert = 'insert',
  Update = 'update',
  Delete = 'delete',
}

export interface CellChange {
  rowIndex: number;
  columnName: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface RowChange {
  type: ChangeType;
  /** Primary key values for identifying the row */
  primaryKeys: Record<string, unknown>;
  /** Changed cell values */
  changes: Record<string, unknown>;
  /** Full row data (for inserts) */
  rowData?: Record<string, unknown>;
}

/** Messages between extension and webview */
export type ExtensionMessage =
  | { type: 'queryResult'; data: QueryResult; tableName?: string; schemaName?: string }
  | { type: 'connectionStatus'; data: { id: string; connected: boolean } }
  | { type: 'schemaUpdate'; data: { tables: TableInfo[] } }
  | { type: 'error'; data: { message: string; code?: string } }
  | { type: 'loading'; data: { loading: boolean; message?: string } }
  | { type: 'connectionConfig'; data: ConnectionConfig }
  | { type: 'connections'; data: ConnectionConfig[] }
  | { type: 'saveResult'; data: { success: boolean; message: string } }
  | { type: 'theme'; data: { kind: 'light' | 'dark' | 'highContrast' } }
  | { type: 'erDiagramData'; data: any[] }
  | { type: 'planData'; data: { sql: string; driverType: string; plan: any } }
  | { type: 'structureData'; data: { tableName: string; schemaName?: string; columns: ColumnInfo[]; indexes: IndexInfo[]; foreignKeys: ForeignKeyInfo[]; ddl: string } }
  | { type: 'reloadStructure' }
  | { type: 'sshHosts'; data: any[] }
  | { type: 'quickViewData'; data: { columns: any[]; rowData: any[] } }
  | { type: 'rowSelected'; data: { columns: any[]; rowData: any[] } }
  | { type: 'pageData'; page: number; data: QueryResult; sortState?: any }
  | { type: 'ddlData'; data: { ddl: string } }
  | { type: 'totalRowsCount'; data: { totalRows: number } }
  | { type: 'driverType'; data: { type: string } }
  | { type: 'tableList'; data: { tables: TableInfo[] } };

export type WebviewMessage =
  | { type: 'executeQuery'; data: { sql: string; connectionId: string } }
  | { type: 'saveConnection'; data: ConnectionConfig }
  | { type: 'testConnection'; data: ConnectionConfig }
  | { type: 'deleteConnection'; data: { id: string } }
  | { type: 'fetchTableData'; data: { connectionId: string; table: string; page: number; pageSize: number; sort?: SortConfig; filters?: FilterConfig[] } }
  | { type: 'saveChanges'; data: { rows: any[] } }
  | { type: 'executeDDL'; data: { sql: string; renameTo?: string | null } }
  | { type: 'previewSQL'; data: { rows: any[] } }
  | { type: 'getConnections' }
  | { type: 'ready' }
  | { type: 'openQuickView'; data: { columns: any[]; rowData: any[] } }
  | { type: 'rowSelected'; data: { columns: any[]; rowData: any[] } }
  | { type: 'countRows'; data?: { whereFilter?: string } }
  | { type: 'getDDL' }
  | { type: 'copyTableData'; data: { format: 'csv' | 'tsv'; includeHeader?: boolean; sortStates?: any[]; whereFilter?: string } }
  | { type: 'fetchPage'; data: { page: number; sortColumn?: string; sortDirection?: 'asc' | 'desc'; sortStates?: any[]; whereFilter?: string } }
  | { type: 'getDriverType' }
  | { type: 'getTableList'; data?: { schemaName?: string } }
  | { type: 'executeCreateTable'; data: { sql: string; tableName: string; schemaName?: string } }
  | { type: 'saveImage'; data: { base64: string; fileName: string } }
  | { type: 'exportQueryResults'; data: { format: 'csv' | 'json' | 'sql'; columns: string[]; rows: unknown[][]; tableName?: string } };

export interface SortConfig {
  column: string;
  direction: 'asc' | 'desc';
}

export interface FilterConfig {
  column: string;
  operator: FilterOperator;
  value: unknown;
  value2?: unknown; // for BETWEEN
}

export enum FilterOperator {
  Equal = '=',
  NotEqual = '!=',
  GreaterThan = '>',
  LessThan = '<',
  GreaterOrEqual = '>=',
  LessOrEqual = '<=',
  Like = 'LIKE',
  NotLike = 'NOT LIKE',
  In = 'IN',
  NotIn = 'NOT IN',
  IsNull = 'IS NULL',
  IsNotNull = 'IS NOT NULL',
  Between = 'BETWEEN',
}

/** Default connection config factory */
export function createDefaultConnectionConfig(type: DatabaseType): ConnectionConfig {
  const defaults: Record<DatabaseType, Partial<ConnectionConfig>> = {
    [DatabaseType.MySQL]: { host: '127.0.0.1', port: 3306, username: 'root' },
    [DatabaseType.PostgreSQL]: { host: '127.0.0.1', port: 5432, username: 'postgres' },
    [DatabaseType.SQLite]: { host: '', port: 0, username: '' },
    [DatabaseType.Redis]: { host: '127.0.0.1', port: 6379, username: '' },
    [DatabaseType.MongoDB]: { host: '127.0.0.1', port: 27017, username: '' },
    [DatabaseType.MSSQL]: { host: '127.0.0.1', port: 1433, username: 'sa' },
    [DatabaseType.MariaDB]: { host: '127.0.0.1', port: 3306, username: 'root' },
  };

  const now = Date.now();
  return {
    id: '',
    name: '',
    type,
    host: '127.0.0.1',
    port: 3306,
    username: '',
    database: '',
    ssl: { mode: SSLMode.Preferred },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password', privateKeyPath: '~/.ssh/id_rsa' },
    options: {},
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...defaults[type],
  };
}

/** Database type display metadata */
export const DATABASE_TYPE_META: Record<DatabaseType, { label: string; icon: string; defaultPort: number }> = {
  [DatabaseType.MySQL]: { label: 'MySQL', icon: '$(database)', defaultPort: 3306 },
  [DatabaseType.PostgreSQL]: { label: 'PostgreSQL', icon: '$(database)', defaultPort: 5432 },
  [DatabaseType.SQLite]: { label: 'SQLite', icon: '$(file)', defaultPort: 0 },
  [DatabaseType.Redis]: { label: 'Redis', icon: '$(database)', defaultPort: 6379 },
  [DatabaseType.MongoDB]: { label: 'MongoDB', icon: '$(database)', defaultPort: 27017 },
  [DatabaseType.MSSQL]: { label: 'SQL Server', icon: '$(database)', defaultPort: 1433 },
  [DatabaseType.MariaDB]: { label: 'MariaDB', icon: '$(database)', defaultPort: 3306 },
};
