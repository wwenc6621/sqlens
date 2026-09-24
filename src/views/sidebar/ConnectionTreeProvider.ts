import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../core/i18n';
import { ConnectionManager } from '../../core/connection/ConnectionManager';
import { ConnectionConfig, DATABASE_TYPE_META, DatabaseType } from '../../core/types';

type TreeItem = ConnectionGroupItem | ConnectionItem | DatabaseItem;

/** globalState key holding folders that must survive even while empty. */
const GROUPS_KEY = 'sqlens.connectionGroups';

/**
 * Folders are an aggregation over `config.group`, so an empty folder would
 * otherwise vanish. This list keeps them around until they are deleted.
 */
export function readDeclaredGroups(context: vscode.ExtensionContext): string[] {
  return context.globalState.get<string[]>(GROUPS_KEY, []);
}

export class ConnectionGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupName: string,
    public readonly children: ConnectionItem[] = [],
  ) {
    super(groupName, vscode.TreeItemCollapsibleState.Expanded);
    // A stable id keeps the expand/collapse state across refreshes.
    this.id = `group:${groupName}`;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'group';
    this.description = children.length > 0 ? String(children.length) : 'empty';
  }
}

export class ConnectionItem extends vscode.TreeItem {
  constructor(
    public readonly config: ConnectionConfig,
    public readonly connected: boolean,
  ) {
    // Connected connections expand into their databases; disconnected ones have
    // nothing to show.
    super(
      config.name || 'Untitled',
      connected ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );

    const meta = DATABASE_TYPE_META[config.type] || { label: config.type, icon: '$(database)' };
    const isProject = config.options?.sqlensProjectConfig === true || config.tags?.includes('project-config');

    this.id = `conn:${config.id}`;
    this.description = isProject
      ? (connected ? `${t('[Project]')} ${meta.label} • ${t('Connected')}` : `${t('[Project]')} ${meta.label}`)
      : (connected ? `${meta.label} • ${t('Connected')}` : meta.label);

    this.tooltip = this.buildTooltip(config, connected, meta.label);

    this.iconPath = this.getIcon(config.type, connected, isProject);

    if (isProject) {
      this.contextValue = connected ? 'connection-connected-project' : 'connection-disconnected-project';
    } else {
      this.contextValue = connected ? 'connection-connected' : 'connection-disconnected';
    }

    this.command = {
      command: connected ? 'sqlens.selectConnection' : 'sqlens.connect',
      title: connected ? t('Select Connection') : t('Connect'),
      arguments: [config.id],
    };
  }

  private buildTooltip(config: ConnectionConfig, connected: boolean, typeLabel: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${config.name || t('Untitled')}**\n\n`);
    md.appendMarkdown(`${t('Type')}: ${typeLabel}\n\n`);

    if (config.type === DatabaseType.SQLite) {
      md.appendMarkdown(`${t('File')}: ${config.filepath || config.database}\n\n`);
    } else {
      md.appendMarkdown(`${t('Host')}: ${config.host}:${config.port}\n\n`);
      if (config.username) {
        md.appendMarkdown(`${t('User')}: ${config.username}\n\n`);
      }
      if (config.database) {
        md.appendMarkdown(`${t('Database')}: ${config.database}\n\n`);
      }
    }

    if (config.ssh.enabled) {
      md.appendMarkdown(`SSH: ${config.ssh.username}@${config.ssh.host}:${config.ssh.port}\n\n`);
    }

    if (config.group) {
      md.appendMarkdown(`${t('Folder')}: ${config.group}\n\n`);
    }

    md.appendMarkdown(`${t('Status')}: ${connected ? '$(pass-filled) ' + t('Connected') : '$(circle-slash) ' + t('Disconnected')}`);
    return md;
  }

  /**
   * Only a live connection gets a colour. Disconnected entries fall back to the
   * plain theme foreground so idle connections read as grey at a glance.
   */
  private getIcon(type: DatabaseType, connected: boolean, isProject: boolean): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
    if (isProject) {
      return new vscode.ThemeIcon('project', connected ? new vscode.ThemeColor('charts.green') : undefined);
    }

    const isFile = type === DatabaseType.SQLite;

    if (connected) {
      // Use a file-based icon with a hard-coded green fill: ThemeIcon colors
      // are overridden by the selection foreground when the row is selected,
      // while file icons keep their own color.
      const green = (name: string) =>
        vscode.Uri.file(path.join(__dirname, '..', 'media', name));
      const svg = isFile ? 'file-green.svg' : 'database-green.svg';
      return { light: green(svg), dark: green(svg) };
    }

    return new vscode.ThemeIcon(isFile ? 'file' : 'database');
  }
}

/** A database of a connection, shown under a connected connection node. */
export class DatabaseItem extends vscode.TreeItem {
  constructor(
    public readonly dbName: string,
    public readonly connectionId: string,
    public readonly isActive: boolean,
  ) {
    super(dbName, vscode.TreeItemCollapsibleState.None);
    this.id = `db:${connectionId}:${dbName}`;
    if (isActive) {
      const green = vscode.Uri.file(path.join(__dirname, '..', 'media', 'database-green.svg'));
      this.iconPath = { light: green, dark: green };
    } else {
      this.iconPath = new vscode.ThemeIcon('database');
    }
    // The existing database commands match on these context values.
    this.contextValue = isActive ? 'database-active' : 'database';
    this.description = isActive ? 'active' : '';
    this.tooltip = isActive ? `${dbName} (active database)` : `Switch to ${dbName}`;

    if (!isActive) {
      this.command = {
        command: 'sqlens.switchDatabase',
        title: 'Switch Database',
        arguments: [connectionId, dbName],
      };
    }
  }
}

/**
 * Tree data provider for the Connections sidebar view.
 *
 * Saved connections are grouped by `config.group`; a connected entry expands
 * into that connection's databases, with the active one highlighted. Folder
 * membership is edited through the `*Group` helpers below, which keep the
 * connection records and the folder registry in sync.
 */
export class ConnectionTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private connectionManager: ConnectionManager,
    private context: vscode.ExtensionContext,
  ) {
    connectionManager.onConnectionChanged(() => this.refresh());
    // The active database is highlighted, and switching databases does not
    // change the connection itself, so follow this event as well.
    connectionManager.onActiveConnectionChanged(() => this.refresh());
  }

  /** Coalesce rapid refresh calls so the welcome view never re-renders twice. */
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  refresh(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this._onDidChangeTreeData.fire(undefined);
    }, 50);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  /** Required for drag and drop inside the tree. */
  async getParent(element: TreeItem): Promise<TreeItem | undefined> {
    if (element instanceof ConnectionGroupItem) {
      return undefined;
    }

    const configs = await this.connectionManager.getSavedConnections();

    if (element instanceof DatabaseItem) {
      const owner = configs.find(c => c.id === element.connectionId);
      return owner ? new ConnectionItem(owner, true) : undefined;
    }

    if (element instanceof ConnectionItem && element.config.group) {
      return new ConnectionGroupItem(element.config.group);
    }

    return undefined;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (element instanceof ConnectionGroupItem) {
      return element.children;
    }

    if (element instanceof ConnectionItem) {
      return element.connected ? this.getDatabaseItems(element.config) : [];
    }

    if (element) {
      return [];
    }

    // Root level: get all connections
    const configs = await this.connectionManager.getSavedConnections();
    const grouped = new Map<string, ConnectionConfig[]>();
    const ungrouped: ConnectionConfig[] = [];

    for (const config of configs) {
      if (config.group) {
        if (!grouped.has(config.group)) {
          grouped.set(config.group, []);
        }
        grouped.get(config.group)!.push(config);
      } else {
        ungrouped.push(config);
      }
    }

    // Declared folders are listed even when they hold no connections yet.
    const declared = readDeclaredGroups(this.context);
    for (const name of declared) {
      if (!grouped.has(name)) {
        grouped.set(name, []);
      }
    }

    const items: TreeItem[] = [];

    // Declared folders keep their stored order, the rest follow alphabetically.
    const declaredPresent = declared.filter(name => grouped.has(name));
    const derived = [...grouped.keys()]
      .filter(name => !declaredPresent.includes(name))
      .sort((a, b) => a.localeCompare(b));

    for (const groupName of [...declaredPresent, ...derived]) {
      const children = (grouped.get(groupName) || []).map(
        c => new ConnectionItem(c, this.connectionManager.isConnected(c.id))
      );
      items.push(new ConnectionGroupItem(groupName, children));
    }

    // Add ungrouped connections
    for (const config of ungrouped) {
      items.push(new ConnectionItem(config, this.connectionManager.isConnected(config.id)));
    }

    return items;
  }

  /** Databases of a connected connection, active one first. */
  private async getDatabaseItems(config: ConnectionConfig): Promise<DatabaseItem[]> {
    const driver = this.connectionManager.getDriver(config.id);
    if (!driver) { return []; }

    try {
      const databases = await driver.getDatabases();
      const currentDb = await driver.getCurrentDatabase().catch(() => '');
      const activeDb = currentDb || config.database || databases[0]?.name;

      return databases
        .map(db => new DatabaseItem(db.name, config.id, db.name === activeDb))
        .sort((a, b) => {
          if (a.isActive) { return -1; }
          if (b.isActive) { return 1; }
          return a.dbName.localeCompare(b.dbName);
        });
    } catch {
      // A failing catalog query must not break the whole sidebar.
      return [];
    }
  }

  // ── Folder management ──────────────────────────────────────────────────────

  /** Folder names known to the tree: stored ones first, then those in use. */
  async listGroupNames(): Promise<string[]> {
    const configs = await this.connectionManager.getSavedConnections();
    const used = configs.map(c => c.group).filter((g): g is string => !!g);
    const declared = readDeclaredGroups(this.context);
    return [...new Set([...declared, ...used])];
  }

  async addGroup(name: string): Promise<void> {
    const declared = readDeclaredGroups(this.context);
    if (!declared.includes(name)) {
      await this.context.globalState.update(GROUPS_KEY, [...declared, name]);
    }
    this.refresh();
  }

  /** Rename a folder; every connection inside is re-pointed to the new name. */
  async renameGroup(from: string, to: string): Promise<number> {
    const declared = readDeclaredGroups(this.context);
    await this.context.globalState.update(
      GROUPS_KEY,
      declared.map(name => (name === from ? to : name)),
    );
    const moved = await this.moveConnectionsToGroup(
      (await this.connectionManager.getSavedConnections())
        .filter(c => c.group === from)
        .map(c => c.id),
      to,
      false,
    );
    this.refresh();
    return moved;
  }

  /**
   * Delete a folder. The connections inside are kept and simply become
   * ungrouped — removing connections is what `sqlens.deleteConnection` is for.
   */
  async removeGroup(name: string): Promise<number> {
    const declared = readDeclaredGroups(this.context);
    await this.context.globalState.update(
      GROUPS_KEY,
      declared.filter(existing => existing !== name),
    );
    const moved = await this.moveConnectionsToGroup(
      (await this.connectionManager.getSavedConnections())
        .filter(c => c.group === name)
        .map(c => c.id),
      undefined,
      false,
    );
    this.refresh();
    return moved;
  }

  /** Move connections into a folder, or out of any folder when `group` is undefined. */
  async moveConnectionsToGroup(
    ids: string[],
    group: string | undefined,
    refresh = true,
  ): Promise<number> {
    const configs = await this.connectionManager.getSavedConnections();
    let moved = 0;

    for (const id of ids) {
      const config = configs.find(c => c.id === id);
      if (!config || config.group === group) { continue; }
      await this.connectionManager.saveConnection({ ...config, group });
      moved++;
    }

    // A folder that just received connections must be listed even if it was
    // never declared explicitly.
    if (group && moved > 0) {
      const declared = readDeclaredGroups(this.context);
      if (!declared.includes(group)) {
        await this.context.globalState.update(GROUPS_KEY, [...declared, group]);
      }
    }

    if (refresh && moved > 0) { this.refresh(); }
    return moved;
  }

  /** Get the connection ID from a tree item (used by commands) */
  static getConnectionId(item: TreeItem): string | undefined {
    if (item instanceof ConnectionItem) {
      return item.config.id;
    }
    if (item instanceof DatabaseItem) {
      return item.connectionId;
    }
    return undefined;
  }
}

/** Mime type is tied to the view id, VS Code uses it for intra-tree drops. */
const CONNECTION_MIME = 'application/vnd.code.tree.sqlens.connections';

/**
 * Lets connections be dragged into a folder (or onto a connection, to join its
 * folder). VS Code cannot drop onto the tree root, so ungrouping is done
 * through the "Move to Folder" command instead.
 */
export class ConnectionDragAndDropController implements vscode.TreeDragAndDropController<TreeItem> {
  readonly dropMimeTypes = [CONNECTION_MIME];
  readonly dragMimeTypes = [CONNECTION_MIME];

  constructor(private provider: ConnectionTreeProvider) {}

  handleDrag(source: readonly TreeItem[], dataTransfer: vscode.DataTransfer): void {
    const ids = source
      .filter((item): item is ConnectionItem => item instanceof ConnectionItem)
      .map(item => item.config.id);
    if (ids.length > 0) {
      dataTransfer.set(CONNECTION_MIME, new vscode.DataTransferItem(ids));
    }
  }

  async handleDrop(target: TreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const ids = dataTransfer.get(CONNECTION_MIME)?.value as string[] | undefined;
    if (!ids || ids.length === 0) { return; }

    let group: string | undefined;
    if (target instanceof ConnectionGroupItem) {
      group = target.groupName;
    } else if (target instanceof ConnectionItem) {
      group = target.config.group;
    } else {
      // Dropped onto empty space: nothing sensible to infer.
      return;
    }

    await this.provider.moveConnectionsToGroup(ids, group);
  }
}
