import { TableInfo } from '../../core/types';

/**
 * Plain-object tree nodes shared with the Schema webview.
 *
 * The Schema sidebar used to be a native TreeView, so its nodes were VS Code
 * `TreeItem` instances. It is now rendered inside a webview, which can only
 * receive JSON — hence this serializable shape. Node `id`s are stable so the
 * webview can remember which rows are expanded across refreshes.
 */
export type SchemaNodeKind =
  | 'schemaGroup'
  | 'tableGroup'
  | 'table'
  | 'redisKey'
  | 'column';

export interface SchemaNode {
  /** Stable identity: React key, expand-state key and load dedupe key. */
  id: string;
  kind: SchemaNodeKind;
  label: string;
  /** Right-aligned grey text (row count, column type, ...). */
  description?: string;
  connectionId: string;
  /** Present on `schemaGroup` (PostgreSQL) and `table`. */
  schema?: string;
  /** Present on `tableGroup`. */
  groupType?: 'tables' | 'views';
  /** Whether the row shows an expand/collapse chevron. */
  collapsible: boolean;
  /** Present on `table` — replayed back verbatim when running table commands. */
  tableInfo?: TableInfo;
  /** Present on `redisKey` — shown in the row's tooltip. */
  redis?: { keyName: string; keyType: string; ttl: number; size: number };
  /** Present on `column`. */
  column?: {
    dataType: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    isUnique: boolean;
    isAutoIncrement: boolean;
    isForeignKey: boolean;
    maxLength?: number;
    defaultValue?: string;
    comment?: string;
  };
}

/** Capabilities the webview needs to decide which actions it can offer. */
export interface SchemaCapabilities {
  hasConnection: boolean;
  connectionId: string;
  connectionName: string;
  database: string;
  driverType: string;
  /** Relational drivers only (MySQL/MariaDB/PostgreSQL/SQLite/MSSQL). */
  relational: boolean;
  redis: boolean;
}

export interface SchemaInitPayload {
  capabilities: SchemaCapabilities;
  nodes: SchemaNode[];
  /** Set when the table list could not be read (connection dropped, ...). */
  error?: string;
}
