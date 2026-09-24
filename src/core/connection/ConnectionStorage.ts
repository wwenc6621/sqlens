import * as vscode from 'vscode';
import { ConnectionConfig } from '../types';
import { ProjectConnectionStorage } from './ProjectConnectionStorage';
import {
  loadSharedConnections,
  saveSharedConnections,
} from './SharedConnectionFile';

const CONNECTIONS_KEY = 'sqlens.connections';

/**
 * Persistent storage for connection configurations.
 *
 * Two backends for the global connection list:
 * - Shared file backend (default): `~/.config/sqlens/connections.json`
 *   (Windows: `%APPDATA%\sqlens\connections.json`) — shared by all VS Code
 *   forks on the machine, so connections created in one IDE show up in the
 *   others. Existing globalState connections are migrated automatically.
 * - Legacy backend: VS Code globalState (+ SecretStorage for passwords),
 *   used when `sqlens.sharedConnections` is disabled.
 *
 * Passwords live in SecretStorage unless the shared backend stores them
 * (`sqlens.sharedConnections.storePasswords`).
 */
export class ConnectionStorage {
  constructor(private context: vscode.ExtensionContext) {}

  private sharedEnabled(): boolean {
    return vscode.workspace.getConfiguration('sqlens').get<boolean>('sharedConnections', true);
  }

  private sharedStoresPasswords(): boolean {
    return vscode.workspace.getConfiguration('sqlens').get<boolean>('sharedConnections.storePasswords', true);
  }

  /** Read the global connection list from the active backend. */
  private readGlobalConnections(): ConnectionConfig[] {
    if (this.sharedEnabled()) {
      return loadSharedConnections();
    }
    return this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
  }

  /** Write the global connection list to the active backend. */
  private writeGlobalConnections(connections: ConnectionConfig[]): void {
    if (this.sharedEnabled()) {
      saveSharedConnections(connections);
    } else {
      void this.context.globalState.update(CONNECTIONS_KEY, connections);
    }
  }

  async getAll(): Promise<ConnectionConfig[]> {
    const globalConnections = this.filterForCurrentWorkspace(
      this.readGlobalConnections()
    );

    const projectStorage = new ProjectConnectionStorage(this.context);
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const projectConnections: ConnectionConfig[] = [];
    for (const folder of workspaceFolders) {
      const folderConns = await projectStorage.loadFromProject(folder);
      projectConnections.push(...folderConns);
    }

    const connections = [...globalConnections, ...projectConnections];

    if (this.sharedEnabled() && this.sharedStoresPasswords()) {
      // Passwords already ride inside the shared file.
      return connections;
    }

    // Restore passwords from secret storage
    for (const conn of connections) {
      conn.password = await this.getPassword(conn.id);
      if (conn.ssh.enabled && conn.ssh.authMethod === 'password') {
        conn.ssh.password = await this.getSSHPassword(conn.id);
      }
    }
    return connections;
  }

  async get(id: string): Promise<ConnectionConfig | undefined> {
    const connections = await this.getAll();
    return connections.find(c => c.id === id);
  }

  async save(config: ConnectionConfig): Promise<void> {
    if (config.options?.sqlensProjectConfig === true || config.tags?.includes('project-config')) {
      const workspaceFolders = vscode.workspace.workspaceFolders || [];
      const root = config.options?.sqlensWorkspaceRoot;
      const folder = workspaceFolders.find(f => f.uri.fsPath === root) || workspaceFolders[0];
      if (folder) {
        const projectStorage = new ProjectConnectionStorage(this.context);
        await projectStorage.addConnection(folder, config);
        return;
      }
    }

    const keepPasswords = this.sharedEnabled() && this.sharedStoresPasswords();
    const connections = keepPasswords
      ? this.readGlobalConnections()
      : await this.getAllWithoutPasswords();

    const index = connections.findIndex(c => c.id === config.id);
    const sanitized = keepPasswords
      ? config
      : { ...config, password: undefined, ssh: { ...config.ssh, password: undefined, passphrase: undefined } };

    if (index >= 0) {
      connections[index] = sanitized;
    } else {
      connections.push(sanitized);
    }

    this.writeGlobalConnections(connections);

    // Always mirror passwords into SecretStorage so the legacy backend keeps
    // working if shared mode is ever disabled.
    if (config.password) {
      await this.context.secrets.store(`sqlens.pwd.${config.id}`, config.password);
    }
    if (config.ssh.password) {
      await this.context.secrets.store(`sqlens.ssh.pwd.${config.id}`, config.ssh.password);
    }
    if (config.ssh.passphrase) {
      await this.context.secrets.store(`sqlens.ssh.pp.${config.id}`, config.ssh.passphrase);
    }
  }

  async delete(id: string): Promise<void> {
    const conn = await this.get(id);
    if (conn && (conn.options?.sqlensProjectConfig === true || conn.tags?.includes('project-config'))) {
      const workspaceFolders = vscode.workspace.workspaceFolders || [];
      const root = conn.options?.sqlensWorkspaceRoot;
      const folder = workspaceFolders.find(f => f.uri.fsPath === root) || workspaceFolders[0];
      if (folder) {
        const projectStorage = new ProjectConnectionStorage(this.context);
        await projectStorage.removeConnection(folder, id);
        return;
      }
    }

    const connections = this.readGlobalConnections();
    const filtered = connections.filter(c => c.id !== id);
    this.writeGlobalConnections(filtered);

    // Clean up secrets
    await this.context.secrets.delete(`sqlens.pwd.${id}`);
    await this.context.secrets.delete(`sqlens.ssh.pwd.${id}`);
    await this.context.secrets.delete(`sqlens.ssh.pp.${id}`);
  }

  async reorder(ids: string[]): Promise<void> {
    const connections = this.readGlobalConnections();
    const ordered = ids
      .map(id => connections.find(c => c.id === id))
      .filter((c): c is ConnectionConfig => c !== undefined);

    // Add any connections not in the ids list at the end
    const remaining = connections.filter(c => !ids.includes(c.id));
    this.writeGlobalConnections([...ordered, ...remaining]);
  }

  private async getAllWithoutPasswords(): Promise<ConnectionConfig[]> {
    return this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
  }

  private filterForCurrentWorkspace(connections: ConnectionConfig[]): ConnectionConfig[] {
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    if (workspaceFolders.length === 0) {
      return connections.filter(c => !this.isAutoImported(c));
    }

    const roots = workspaceFolders.map(f => this.normalizePath(f.uri.fsPath));
    const names = new Set(workspaceFolders.map(f => f.name));

    return connections.filter(conn => {
      if (!this.isAutoImported(conn)) {
        return true;
      }

      const options = conn.options || {};
      const workspaceRoot = typeof options.sqlensWorkspaceRoot === 'string'
        ? this.normalizePath(options.sqlensWorkspaceRoot)
        : '';
      if (workspaceRoot && roots.includes(workspaceRoot)) {
        return true;
      }

      const sourceFile = typeof options.sqlensSourceFile === 'string'
        ? this.normalizePath(options.sqlensSourceFile)
        : '';
      if (sourceFile && roots.some(root => this.isPathInside(sourceFile, root))) {
        return true;
      }

      const dbPath = conn.filepath || (conn.type === 'sqlite' ? conn.database : '');
      if (dbPath) {
        const normalizedDbPath = this.normalizePath(dbPath);
        if (roots.some(root => this.isPathInside(normalizedDbPath, root))) {
          return true;
        }
      }

      const legacyWorkspaceTag = conn.tags?.find(tag => names.has(tag));
      return !!legacyWorkspaceTag;
    });
  }

  private isAutoImported(conn: ConnectionConfig): boolean {
    return conn.tags?.includes('auto-imported') || /^Imported \(.+\)$/.test(conn.group || '');
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  private isPathInside(filePath: string, root: string): boolean {
    return filePath === root || filePath.startsWith(`${root}/`);
  }

  private async getPassword(id: string): Promise<string | undefined> {
    return await this.context.secrets.get(`sqlens.pwd.${id}`);
  }

  private async getSSHPassword(id: string): Promise<string | undefined> {
    return await this.context.secrets.get(`sqlens.ssh.pwd.${id}`);
  }
}
