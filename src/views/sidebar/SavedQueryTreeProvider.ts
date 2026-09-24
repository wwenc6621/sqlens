import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { ConnectionManager } from '../../core/connection/ConnectionManager';
import { ConnectionConfig } from '../../core/types';

/**
 * Saved queries are plain `.sql` files kept next to the shared connections
 * file, one directory per connection:
 *
 *   ~/.config/sqlens/saved-queries/<connectionId>/<name>.sql   (macOS/Linux)
 *   %APPDATA%\sqlens\saved-queries\<connectionId>\<name>.sql   (Windows)
 *
 * Keeping them outside any IDE's private storage means VS Code and VS Code
 * forks (Trae, ...) share the same saved queries, just like the shared
 * connections file.
 */
const QUERIES_DIR = 'saved-queries';

function sharedQueriesDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'sqlens', QUERIES_DIR);
  }
  return path.join(os.homedir(), '.config', 'sqlens', QUERIES_DIR);
}

export function savedQueriesRoot(_context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.file(sharedQueriesDir());
}

export function connectionQueriesDir(context: vscode.ExtensionContext, connectionId: string): vscode.Uri {
  return vscode.Uri.joinPath(savedQueriesRoot(context), connectionId);
}

/** Sanitise a display name into something usable as a file name. */
export function toQueryFileName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 80).trim();
  return cleaned || 'query';
}

function baseName(uri: vscode.Uri): string {
  const file = uri.path.split('/').pop() || '';
  return file.replace(/\.sql$/i, '');
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export class SavedQueryConnectionItem extends vscode.TreeItem {
  constructor(
    public readonly config: ConnectionConfig,
    public readonly connected: boolean,
    queryCount: number,
  ) {
    super(
      config.name || 'Untitled',
      queryCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );

    this.id = `savedQueryConnection:${config.id}`;
    this.description = queryCount === 1 ? '1 query' : `${queryCount} queries`;
    this.tooltip = `${config.name || 'Untitled'} — ${queryCount} saved ${queryCount === 1 ? 'query' : 'queries'}`;
    // Same colour rule as the Connections view: live = coloured, idle = grey.
    this.iconPath = new vscode.ThemeIcon(
      'database',
      connected ? new vscode.ThemeColor('charts.green') : undefined,
    );
    this.contextValue = 'savedQueryConnection';
  }
}

export class SavedQueryItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly connectionId: string,
  ) {
    super(baseName(uri), vscode.TreeItemCollapsibleState.None);
    this.id = `savedQuery:${uri.toString()}`;
    this.resourceUri = uri;
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.contextValue = 'savedQuery';
    this.tooltip = uri.fsPath;
    this.command = { command: 'vscode.open', title: 'Open Query', arguments: [uri] };
  }
}

type TreeItem = SavedQueryConnectionItem | SavedQueryItem;

/**
 * Tree data provider for the Saved SQL view: connections on top, their saved
 * queries underneath. Queries follow their connection — deleting a connection
 * removes the whole directory.
 */
export class SavedQueryTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private connectionManager: ConnectionManager,
    private context: vscode.ExtensionContext,
  ) {
    connectionManager.onConnectionChanged(() => this.refresh());
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

  async getParent(element: TreeItem): Promise<TreeItem | undefined> {
    if (element instanceof SavedQueryConnectionItem) { return undefined; }

    const config = (await this.connectionManager.getSavedConnections())
      .find(c => c.id === element.connectionId);
    return config
      ? new SavedQueryConnectionItem(config, this.connectionManager.isConnected(config.id), 0)
      : undefined;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (element instanceof SavedQueryConnectionItem) {
      const files = await this.listQueries(element.config.id);
      return files.map(uri => new SavedQueryItem(uri, element.config.id));
    }

    if (element) { return []; }

    const configs = await this.connectionManager.getSavedConnections();
    const items: SavedQueryConnectionItem[] = [];
    for (const config of configs) {
      // The view mirrors the Connections view: only live connections show up,
      // and only when they actually hold queries. Disconnecting hides the
      // connection and its saved SQL; reconnecting brings it back.
      if (!this.connectionManager.isConnected(config.id)) { continue; }
      const count = (await this.listQueries(config.id)).length;
      if (count === 0) { continue; }
      items.push(new SavedQueryConnectionItem(config, true, count));
    }
    return items;
  }

  // ── Storage helpers ────────────────────────────────────────────────────────

  /** The connection a saved query belongs to, derived from its path. */
  connectionIdForUri(uri: vscode.Uri): string | undefined {
    const root = savedQueriesRoot(this.context).path;
    if (!uri.path.startsWith(`${root}/`)) { return undefined; }
    const relative = uri.path.slice(root.length + 1);
    const [connectionId] = relative.split('/');
    return connectionId || undefined;
  }

  async listQueries(connectionId: string): Promise<vscode.Uri[]> {
    const dir = connectionQueriesDir(this.context, connectionId);
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      return entries
        .filter(([name, type]) => type === vscode.FileType.File && /\.sql$/i.test(name))
        .map(([name]) => vscode.Uri.joinPath(dir, name))
        .sort((a, b) => baseName(a).localeCompare(baseName(b)));
    } catch {
      // The directory only exists once the connection has a query.
      return [];
    }
  }

  /** Create `<name>.sql`, appending a counter if that name is taken. */
  async createQuery(connectionId: string, name: string, connectionName: string): Promise<vscode.Uri> {
    const dir = connectionQueriesDir(this.context, connectionId);
    await vscode.workspace.fs.createDirectory(dir);

    const stem = toQueryFileName(name);
    let uri = vscode.Uri.joinPath(dir, `${stem}.sql`);
    for (let suffix = 2; await fileExists(uri); suffix++) {
      uri = vscode.Uri.joinPath(dir, `${stem} ${suffix}.sql`);
    }

    const header = `-- ${stem}\n-- Connection: ${connectionName}\n\n`;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(header, 'utf8'));
    this.refresh();
    return uri;
  }

  /** Rename a query file, keeping any open editor pointed at the new path. */
  async renameQuery(uri: vscode.Uri, newName: string): Promise<vscode.Uri> {
    const target = vscode.Uri.joinPath(uri, '..', `${toQueryFileName(newName)}.sql`);
    if (target.toString() === uri.toString()) { return uri; }

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(uri, target, { overwrite: false });
    await vscode.workspace.applyEdit(edit);
    this.refresh();
    return target;
  }

  async deleteQuery(uri: vscode.Uri): Promise<void> {
    // Prefer the trash so a deleted query stays recoverable, but never fail the
    // command because the platform cannot move this entry there.
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } catch {
      await vscode.workspace.fs.delete(uri);
    }
    this.refresh();
  }

  /** Remove every saved query of a connection (called when it is deleted). */
  async deleteAllForConnection(connectionId: string): Promise<void> {
    const dir = connectionQueriesDir(this.context, connectionId);
    try {
      await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: true });
    } catch {
      try {
        await vscode.workspace.fs.delete(dir, { recursive: true });
      } catch {
        // Nothing stored for this connection.
      }
    }
    this.refresh();
  }

  /** Query names already used by a connection, for duplicate validation. */
  async existingNames(connectionId: string): Promise<string[]> {
    return (await this.listQueries(connectionId)).map(baseName);
  }
}
