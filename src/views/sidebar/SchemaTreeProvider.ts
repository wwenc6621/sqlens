import * as vscode from 'vscode';
import { t } from '../../core/i18n';
import { ConnectionManager } from '../../core/connection/ConnectionManager';
import { TableInfo, ColumnInfo, DatabaseType } from '../../core/types';
import type { MySQLDriver } from '../../core/drivers/MySQLDriver';
import type { RedisDriver } from '../../core/drivers/RedisDriver';
import { isRedisGroup, encodeRedisKeyTable } from '../../core/drivers/redisTableEncoding';

type SchemaTreeItem = SchemaGroupItem | TableGroupItem | TableItem | ColumnItem | RedisKeyItem;

class SchemaGroupItem extends vscode.TreeItem {
  constructor(
    public readonly schemaName: string,
    public readonly connectionId: string,
  ) {
    super(schemaName, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
    this.contextValue = 'schema';
  }
}

class TableGroupItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly groupType: 'tables' | 'views',
    public readonly connectionId: string,
    public readonly tables: TableInfo[],
    public readonly schema?: string,
  ) {
    super(label, tables.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(groupType === 'tables' ? 'list-tree' : 'eye');
    this.description = `${tables.length}`;
    this.contextValue = 'tableGroup';
  }
}

class TableItem extends vscode.TreeItem {
  constructor(
    public readonly tableInfo: TableInfo,
    public readonly connectionId: string,
  ) {
    super(tableInfo.name, vscode.TreeItemCollapsibleState.Collapsed);

    const isView = tableInfo.type === 'view' || tableInfo.type === 'materializedView';
    this.iconPath = new vscode.ThemeIcon(isView ? 'eye' : 'table');
    this.contextValue = 'table';

    const parts: string[] = [];
    if (tableInfo.rowCount !== undefined) {
      parts.push(t('~{0} rows', `~${this.formatNumber(tableInfo.rowCount)}`));
    }
    // Prefer the table comment over the storage engine, and fall back to the
    // engine when the table has no comment.
    const comment = this.formatComment(tableInfo.comment);
    if (comment) {
      parts.push(comment);
    } else if (tableInfo.engine) {
      parts.push(tableInfo.engine);
    }
    this.description = parts.join(' • ');

    this.tooltip = this.buildTooltip();

    this.command = {
      command: 'sqlens.openTable',
      title: t('Open Table'),
      arguments: [connectionId, tableInfo],
    };
  }

  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${this.tableInfo.name}**\n\n`);
    if (this.tableInfo.type !== 'table') {
      md.appendMarkdown(`${t('Type')}: ${this.tableInfo.type}\n\n`);
    }
    if (this.tableInfo.rowCount !== undefined) {
      md.appendMarkdown(`${t('Rows')}: ~${this.formatNumber(this.tableInfo.rowCount)}\n\n`);
    }
    if (this.tableInfo.dataSize) {
      md.appendMarkdown(`${t('Size')}: ${this.formatBytes(this.tableInfo.dataSize)}\n\n`);
    }
    if (this.tableInfo.comment) {
      md.appendMarkdown(`${t('Comment')}: ${this.tableInfo.comment}`);
    }
    return md;
  }

  /** Collapse a table comment into one line, capped for the tree description. */
  private formatComment(comment?: string): string {
    const text = (comment || '').replace(/\s+/g, ' ').trim();
    // MySQL reports the literal "VIEW" as the comment of every view.
    if (!text || text.toUpperCase() === 'VIEW') { return ''; }
    const limit = 10;
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }

  private formatNumber(n: number): string {
    if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
    if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
    return String(n);
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1_073_741_824) { return `${(bytes / 1_073_741_824).toFixed(1)} GB`; }
    if (bytes >= 1_048_576) { return `${(bytes / 1_048_576).toFixed(1)} MB`; }
    if (bytes >= 1_024) { return `${(bytes / 1_024).toFixed(1)} KB`; }
    return `${bytes} B`;
  }
}

class ColumnItem extends vscode.TreeItem {
  constructor(public readonly column: ColumnInfo) {
    super(column.name, vscode.TreeItemCollapsibleState.None);

    let icon = 'symbol-field';
    let color: vscode.ThemeColor | undefined;

    if (column.isPrimaryKey) {
      icon = 'key';
      color = new vscode.ThemeColor('charts.yellow');
    } else if (column.foreignKey) {
      icon = 'link';
      color = new vscode.ThemeColor('charts.blue');
    } else if (column.isUnique) {
      icon = 'star';
    }

    this.iconPath = new vscode.ThemeIcon(icon, color);
    this.contextValue = 'column';

    const parts = [column.type];
    if (!column.nullable) { parts.push('NOT NULL'); }
    if (column.isAutoIncrement) { parts.push('AUTO_INCREMENT'); }

    // Append the column comment to the description, ellipsized when long.
    const comment = this.formatComment(column.comment);
    if (comment) {
      parts.push(comment);
    }
    this.description = parts.join(' ');

    this.tooltip = this.buildTooltip();
  }

  /** Full column definition + the untruncated comment, for the hover tooltip. */
  private buildTooltip(): vscode.MarkdownString {
    const { column } = this;
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;

    const badges: string[] = [];
    if (column.isPrimaryKey) { badges.push('$(key) ' + t('Primary Key')); }
    if (column.isUnique) { badges.push('$(star) ' + t('Unique')); }
    if (column.isAutoIncrement) { badges.push(t('Auto Increment')); }

    md.appendMarkdown(`**${column.name}**${badges.length ? `　${badges.join('　')}` : ''}\n\n`);
    md.appendMarkdown(`${t('Type')}: \`${column.type}\`\n\n`);
    md.appendMarkdown(`${t('Nullable')}: ${column.nullable ? t('YES') : t('NO')}\n\n`);
    if (column.defaultValue !== undefined && column.defaultValue !== null) {
      md.appendMarkdown(`${t('Default Value')}: \`${String(column.defaultValue)}\`\n\n`);
    }
    if (column.maxLength) {
      md.appendMarkdown(`${t('Length')}: ${column.maxLength}\n\n`);
    }

    const comment = (column.comment || '').replace(/\s+/g, ' ').trim();
    if (comment) {
      md.appendMarkdown(`---\n\n${t('Comment')}: ${comment}`);
    }
    return md;
  }

  /** Collapse a comment into one line, capped for the tree description. */
  private formatComment(comment?: string): string {
    const text = (comment || '').replace(/\s+/g, ' ').trim();
    if (!text) { return ''; }
    const limit = 10;
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }
}

class RedisKeyItem extends vscode.TreeItem {
  constructor(
    public readonly keyName: string,
    public readonly keyType: string,
    connectionId: string,
    ttl: number,
    size: number,
  ) {
    super(keyName, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('symbol-variable', new vscode.ThemeColor('charts.red'));
    this.contextValue = 'redisKey';

    const ttlText = ttl === -1 ? '∞' : ttl < 0 ? '?' : `${ttl}s`;
    const parts = [`${keyType}`, `TTL ${ttlText}`];
    if (size > 0) { parts.push(`${size}B`); }
    this.description = parts.join(' • ');

    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${keyName}**\n\n`);
    md.appendMarkdown(`${t('Type')}: \`${keyType}\`\n\n`);
    md.appendMarkdown(`${t('TTL')}: ${ttlText}\n\n`);
    if (size > 0) { md.appendMarkdown(`${t('Size')}: ${size} B\n\n`); }
    md.appendMarkdown('_' + t('Double-click to open entries') + '_');
    this.tooltip = md;

    this.command = {
      command: 'sqlens.openTable',
      title: t('Open Key'),
      arguments: [connectionId, { name: encodeRedisKeyTable(keyType, keyName), type: 'table' as const }],
    };
  }
}

/**
 * Tree data provider for the Schema sidebar view.
 * Shows database objects (tables, views, columns) for the active connection.
 */
export class SchemaTreeProvider implements vscode.TreeDataProvider<SchemaTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SchemaTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedTables = new Map<string, TableInfo[]>();
  private cachedColumns = new Map<string, ColumnInfo[]>();

  constructor(private connectionManager: ConnectionManager) {
    connectionManager.onActiveConnectionChanged(() => {
      this.clearCache();
      this.refresh();
    });
    connectionManager.onConnectionChanged(() => this.refresh());
  }

  /** Coalesce rapid refresh calls so the welcome view never re-renders twice. */
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  refresh(): void {
    // Invalidate any in-flight table loads: they belong to a previous
    // connection state once a refresh (manual or connection change) happens.
    this.loadGeneration++;
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this._onDidChangeTreeData.fire(undefined);
    }, 50);
  }

  clearCache(): void {
    this.cachedTables.clear();
    this.cachedColumns.clear();
  }

  getTreeItem(element: SchemaTreeItem): vscode.TreeItem {
    return element;
  }

  async findTableItem(tableName: string, connectionId: string, schema?: string): Promise<SchemaTreeItem | undefined> {
    const groups = await this.getTableGroups(connectionId, schema);
    for (const group of groups) {
      if (group instanceof TableGroupItem) {
        const table = group.tables.find(t => t.name === tableName && (t.schema || '') === (schema || ''));
        if (table) {
          return new TableItem(table, connectionId);
        }
      }
    }
    return undefined;
  }

  async getChildren(element?: SchemaTreeItem): Promise<SchemaTreeItem[]> {
    const conn = this.connectionManager.activeConnection;
    if (!conn) { return []; }

    const connectionId = this.connectionManager.activeConnectionId!;
    const driver = conn.driver;

    // Column level — Redis type groups expand into their keys instead.
    if (element instanceof TableItem) {
      if (conn.config.type === DatabaseType.Redis && isRedisGroup(element.tableInfo.name)) {
        return this.getRedisKeys(element.tableInfo.name, connectionId);
      }
      return this.getColumnsForTable(element.tableInfo.name, connectionId, element.tableInfo.schema);
    }

    // Table group level - return table items
    if (element instanceof TableGroupItem) {
      return element.tables.map(t => new TableItem(t, element.connectionId));
    }

    // Schema level - return table groups
    if (element instanceof SchemaGroupItem) {
      return this.getTableGroups(element.connectionId, element.schemaName);
    }

    // Root level
    if (!element) {
      // The database list is handled by the Databases view. Schema always reflects
      // the active database for the selected connection.
      if (conn.config.type === DatabaseType.PostgreSQL) {
        try {
          const schemas = await driver.getSchemas();
          return schemas.map(s => new SchemaGroupItem(s.name, connectionId));
        } catch {
          return this.getTableGroups(connectionId);
        }
      }

      return this.getTableGroups(connectionId);
    }

    return [];
  }

  /** Cache keys currently being hydrated with full table stats. */
  private hydratingTables = new Set<string>();
  /**
   * Bumped on every refresh/connection change. Async loads capture the value
   * at start and discard their result when it has gone stale — otherwise a
   * slow load for a disconnected/switched-away connection would render its
   * tables into the tree.
   */
  private loadGeneration = 0;

  private async getTableGroups(connectionId: string, schema?: string): Promise<SchemaTreeItem[]> {
    const gen = this.loadGeneration;
    const conn = this.connectionManager.activeConnection;
    const driver = this.connectionManager.getDriver(connectionId);
    if (!driver) { return []; }

    const currentDb = await driver.getCurrentDatabase().catch(() => '');
    if (gen !== this.loadGeneration) { return []; }

    const cacheKey = `${connectionId}:${currentDb}:${schema || ''}`;
    let tables = this.cachedTables.get(cacheKey);

    if (!tables) {
      try {
        // Progressive loading for MySQL-family servers: SHOW TABLES returns in
        // milliseconds on distributed databases (OceanBase etc.) where the
        // information_schema stats query takes many seconds. Render the names
        // immediately, then hydrate row counts/sizes/comments in the background.
        const mysql = driver as MySQLDriver;
        if (conn && (conn.config.type === DatabaseType.MySQL || conn.config.type === DatabaseType.MariaDB)
          && typeof mysql.getTableNames === 'function') {
          const fast = await mysql.getTableNames(schema);
          if (gen !== this.loadGeneration) { return []; }
          tables = fast.map(tf => ({
            name: tf.name,
            schema: schema || currentDb,
            type: tf.type,
          } as TableInfo));
          this.cachedTables.set(cacheKey, tables);
          this.hydrateTableStats(connectionId, schema, cacheKey, gen);
        } else {
          tables = await driver.getTables(schema);
          if (gen !== this.loadGeneration) { return []; }
          this.cachedTables.set(cacheKey, tables);
        }
      } catch (err) {
        if (gen !== this.loadGeneration) { return []; }
        vscode.window.showErrorMessage(t('Failed to load tables: {0}', err));
        return [];
      }
    }

    return this.buildTableGroups(tables, connectionId, schema);
  }

  /** Fetch full table metadata in the background and refresh once it lands. */
  private hydrateTableStats(connectionId: string, schema: string | undefined, cacheKey: string, gen: number): void {
    if (this.hydratingTables.has(cacheKey)) { return; }
    this.hydratingTables.add(cacheKey);
    const driver = this.connectionManager.getDriver(connectionId);
    if (!driver) { return; }
    void driver.getTables(schema)
      .then(full => {
        // Discard when the user disconnected or switched connections while
        // the stats query was in flight.
        if (gen !== this.loadGeneration) { return; }
        if (this.connectionManager.activeConnectionId !== connectionId) { return; }
        if (this.cachedTables.get(cacheKey)) {
          this.cachedTables.set(cacheKey, full);
          this.refresh();
        }
      })
      .catch(() => { /* stats are optional; the fast list stays usable */ })
      .finally(() => { this.hydratingTables.delete(cacheKey); });
  }

  private buildTableGroups(tables: TableInfo[], connectionId: string, schema?: string): SchemaTreeItem[] {
    const regularTables = tables.filter(t => t.type === 'table');
    const views = tables.filter(t => t.type === 'view' || t.type === 'materializedView');

    const groups: SchemaTreeItem[] = [];
    groups.push(new TableGroupItem(t('Tables'), 'tables', connectionId, regularTables, schema));
    if (views.length > 0) {
      groups.push(new TableGroupItem(t('Views'), 'views', connectionId, views, schema));
    }
    return groups;
  }

  private async getRedisKeys(group: string, connectionId: string): Promise<SchemaTreeItem[]> {
    const driver = this.connectionManager.getDriver(connectionId) as RedisDriver | undefined;
    if (!driver || typeof (driver as any).getKeyList !== 'function') { return []; }
    try {
      const { result } = await driver.getKeyList(group, 0, 200);
      return result.rows.map(r =>
        new RedisKeyItem(String(r[0]), String(r[1]), connectionId, Number(r[2]), Number(r[3])),
      );
    } catch (err) {
      vscode.window.showErrorMessage(t('Failed to load Redis keys: {0}', err));
      return [];
    }
  }

  private async getColumnsForTable(table: string, connectionId: string, schema?: string): Promise<ColumnItem[]> {
    const driver = this.connectionManager.getDriver(connectionId);
    if (!driver) { return []; }

    const currentDb = await driver.getCurrentDatabase().catch(() => '');
    const cacheKey = `${connectionId}:${currentDb}:${schema || ''}:${table}`;
    let columns = this.cachedColumns.get(cacheKey);

    if (!columns) {
      try {
        columns = await driver.getColumns(table, schema);
        this.cachedColumns.set(cacheKey, columns);
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to load columns for {0}: {1}', table, err));
        return [];
      }
    }

    return columns.map(c => new ColumnItem(c));
  }
}
