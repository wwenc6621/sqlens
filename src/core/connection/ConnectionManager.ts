import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { ConnectionConfig, DatabaseType, QueryResult, ServerInfo } from '../types';
import { DatabaseDriver, DriverFactory } from '../drivers';
import { ConnectionStorage } from './ConnectionStorage';
import { ProjectConnectionStorage } from './ProjectConnectionStorage';
import { SSHTunnelManager, TunnelInfo } from './SSHTunnelManager';
import { Logger } from '../utils/Logger';

interface ActiveConnection {
  config: ConnectionConfig;
  driver: DatabaseDriver;
  tunnel?: TunnelInfo;
}

/** Drivers with a relational model (ER diagram, structure editing, SQL dump). */
const RELATIONAL_DRIVERS: string[] = [
  DatabaseType.MySQL, DatabaseType.MariaDB, DatabaseType.PostgreSQL,
  DatabaseType.SQLite, DatabaseType.MSSQL,
];

/** Drivers that support an EXPLAIN-style query plan or profile. */
const EXPLAIN_DRIVERS: string[] = [
  ...RELATIONAL_DRIVERS,
  DatabaseType.ClickHouse,   // EXPLAIN <query>
  DatabaseType.MongoDB,      // cursor.explain()
  DatabaseType.Elasticsearch, // _search?profile=true
];

/**
 * Central manager for all database connections.
 * Handles connection lifecycle, driver creation, SSH tunneling, and events.
 */
export class ConnectionManager {
  private connections = new Map<string, ActiveConnection>();
  private storage: ConnectionStorage;
  private tunnelManager: SSHTunnelManager;

  private _onConnectionChanged = new vscode.EventEmitter<void>();
  readonly onConnectionChanged = this._onConnectionChanged.event;

  private _onActiveConnectionChanged = new vscode.EventEmitter<string | undefined>();
  readonly onActiveConnectionChanged = this._onActiveConnectionChanged.event;

  private _activeConnectionId: string | undefined;

  constructor(private context: vscode.ExtensionContext) {
    this.storage = new ConnectionStorage(context);
    this.tunnelManager = new SSHTunnelManager();
  }

  get activeConnectionId(): string | undefined {
    return this._activeConnectionId;
  }

  get activeConnection(): ActiveConnection | undefined {
    return this._activeConnectionId ? this.connections.get(this._activeConnectionId) : undefined;
  }

  get activeDriver(): DatabaseDriver | undefined {
    return this.activeConnection?.driver;
  }

  /** Get all saved connection configs */
  async getSavedConnections(): Promise<ConnectionConfig[]> {
    return this.storage.getAll();
  }

  /** Check if a connection is currently active */
  isConnected(id: string): boolean {
    return this.connections.has(id) && this.connections.get(id)!.driver.isConnected;
  }

  /** Get all connected connection IDs */
  getConnectedIds(): string[] {
    return Array.from(this.connections.entries())
      .filter(([, conn]) => conn.driver.isConnected)
      .map(([id]) => id);
  }

  /** Create a new connection config with a generated ID */
  createConnectionConfig(type: DatabaseType): ConnectionConfig {
    const { createDefaultConnectionConfig } = require('../types');
    const config = createDefaultConnectionConfig(type);
    config.id = uuidv4();
    return config;
  }

  /** Save a connection configuration */
  async saveConnection(config: ConnectionConfig): Promise<string> {
    const id = config.id || uuidv4();
    const toSave = {
      ...config,
      id,
      createdAt: config.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await this.storage.save(toSave);
    this._onConnectionChanged.fire();
    return id;
  }

  /** Delete a saved connection */
  async deleteConnection(id: string): Promise<void> {
    await this.disconnect(id);
    await this.storage.delete(id);
    this._onConnectionChanged.fire();
  }

  /** Connect to a database */
  async connect(id: string): Promise<void> {
    let config = await this.storage.get(id);
    if (!config) {
      throw new Error(`Connection not found: ${id}`);
    }

    config = await this.resolvePasswords(config);

    // If already connected, disconnect first
    if (this.connections.has(id)) {
      await this.disconnect(id);
    }

    const driver = DriverFactory.createDriver(config.type);
    let tunnel: TunnelInfo | undefined;

    try {
      let connectConfig = { ...config };

      // Set up SSH tunnel if enabled
      if (config.ssh.enabled) {
        tunnel = await this.tunnelManager.createTunnel(
          id,
          config.ssh,
          config.host,
          config.port,
        );
        // Override host/port to use tunnel's local endpoint
        connectConfig = {
          ...connectConfig,
          host: tunnel.localHost,
          port: tunnel.localPort,
        };
      }

      await driver.connect(connectConfig);

      this.connections.set(id, { config, driver, tunnel });
      await this.ensureInitialDatabase(id);
      this.setActiveConnection(id);
      this._onConnectionChanged.fire();
      Logger.getInstance().logInfo(`Successfully connected to database: ${config.name || config.host}`);

    } catch (err) {
      // Clean up tunnel on failure
      if (tunnel) {
        this.tunnelManager.closeTunnel(id);
      }
      Logger.getInstance().logError(`Failed to connect to database ${config.name || config.host}: ${err instanceof Error ? err.message : String(err)}`, err);
      throw err;
    }
  }

  /** Disconnect from a database */
  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (conn) {
      try {
        await conn.driver.disconnect();
      } catch (err) {
        Logger.getInstance().logError(`Error during driver disconnect for ${conn.config.name}: ${err instanceof Error ? err.message : String(err)}`, err);
      }
      this.tunnelManager.closeTunnel(id);
      this.connections.delete(id);

      if (this._activeConnectionId === id) {
        // Switch to another connected connection or none
        const remaining = this.getConnectedIds();
        this.setActiveConnection(remaining[0] || undefined);
      }

      this._onConnectionChanged.fire();
      Logger.getInstance().logInfo(`Disconnected from database: ${conn.config.name}`);
    }
  }

  /** Test a connection without saving it */
  async testConnection(config: ConnectionConfig): Promise<{ success: boolean; message: string; serverInfo?: ServerInfo }> {
    const driver = DriverFactory.createDriver(config.type);
    let tunnel: TunnelInfo | undefined;

    try {
      let testConfig = await this.resolvePasswords(config);

      if (config.ssh.enabled) {
        tunnel = await this.tunnelManager.createTunnel(
          `test-${Date.now()}`,
          config.ssh,
          config.host,
          config.port,
        );
        testConfig = {
          ...testConfig,
          host: tunnel.localHost,
          port: tunnel.localPort,
        };
      }

      const result = await driver.testConnection(testConfig);
      Logger.getInstance().logInfo(`Connection test to ${config.name || config.host} succeeded: ${result.message}`);
      return result;

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      Logger.getInstance().logError(`Connection test to ${config.name || config.host} failed: ${errMsg}`, err);
      return { success: false, message: errMsg };
    } finally {
      if (tunnel) {
        tunnel.close();
      }
    }
  }

  /** Execute a query on a specific connection */
  async query(connectionId: string, sql: string, params?: unknown[]): Promise<QueryResult> {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.driver.isConnected) {
      throw new Error('Not connected');
    }
    return conn.driver.query(sql, params);
  }
  /** Get the driver for a specific connection */
  getDriver(connectionId: string): DatabaseDriver | undefined {
    return this.connections.get(connectionId)?.driver;
  }

  /** Get active connection info including SSH tunnel */
  getActiveConnection(connectionId: string) {
    return this.connections.get(connectionId);
  }

  /** Select an already-connected connection as active without reconnecting. */
  async selectConnection(id: string): Promise<void> {
    if (!this.isConnected(id)) {
      throw new Error('Connection is not active. Connect first.');
    }
    await this.ensureInitialDatabase(id);
    this.setActiveConnection(id);
  }

  /** Set the active connection (for the sidebar, query context, etc.) */
  setActiveConnection(id: string | undefined): void {
    this._activeConnectionId = id;
    vscode.commands.executeCommand('setContext', 'sqlens.hasActiveConnection', !!id);

    // Expose the active driver's family so menus can hide relational-only
    // actions (ER diagram, structure editing, SQL dump) on document/columnar/
    // key-value connections.
    const type = id ? this.connections.get(id)?.config.type : undefined;
    const relational = !!type && RELATIONAL_DRIVERS.includes(type);
    const explains = !!type && EXPLAIN_DRIVERS.includes(type);
    vscode.commands.executeCommand('setContext', 'sqlens.activeDriverRelational', relational);
    vscode.commands.executeCommand('setContext', 'sqlens.activeDriverExplains', explains);
    vscode.commands.executeCommand('setContext', 'sqlens.activeDriverType', type ?? '');

    this._onActiveConnectionChanged.fire(id);
  }

  private async ensureInitialDatabase(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn || !conn.driver.isConnected || conn.config.type === DatabaseType.SQLite) {
      return;
    }

    try {
      const currentDb = await conn.driver.getCurrentDatabase();
      if (currentDb) { return; }

      const databases = await conn.driver.getDatabases();
      const firstDb = databases[0]?.name;
      if (firstDb) {
        await conn.driver.switchDatabase(firstDb);
      }
    } catch (err) {
      Logger.getInstance().logError(`Failed to select initial database for ${conn.config.name}: ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }

  /** Dispose all connections and tunnels */
  dispose(): void {
    for (const [id] of this.connections) {
      this.disconnect(id).catch(() => {});
    }
    this.tunnelManager.closeAll();
    this._onConnectionChanged.dispose();
    this._onActiveConnectionChanged.dispose();
  }

  /** Save a connection configuration specifically to a workspace folder */
  async saveConnectionToProject(config: ConnectionConfig, workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
    const id = config.id || uuidv4();
    const toSave: ConnectionConfig = {
      ...config,
      id,
      createdAt: config.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    if (!toSave.tags.includes('project-config')) {
      toSave.tags.push('project-config');
    }
    toSave.options.sqlensProjectConfig = true;
    toSave.options.sqlensWorkspaceRoot = workspaceFolder.uri.fsPath;

    const projectStorage = new ProjectConnectionStorage(this.context);
    await projectStorage.addConnection(workspaceFolder, toSave);
    this._onConnectionChanged.fire();
    return id;
  }

  /**
   * Fill in the passwords needed to connect.
   *
   * Resolution order per secret:
   * 1. the value already carried by the config (e.g. from the shared
   *    connections file, which works across IDEs),
   * 2. this IDE's SecretStorage,
   * 3. prompt the user (and remember the answer in SecretStorage).
   */
  private async resolvePasswords(config: ConnectionConfig): Promise<ConnectionConfig> {
    const resolved = { ...config, ssh: { ...config.ssh } };

    // An empty password string means "no password" (e.g. a local/Dev Redis with
    // no auth), which is a valid value — only prompt when the password is
    // missing entirely (undefined) or explicitly marked as '<ask>'.
    if (resolved.type !== DatabaseType.SQLite) {
      let pwd = resolved.password;
      if (pwd === undefined || pwd === '<ask>') {
        pwd = await this.context.secrets.get(`sqlens.pwd.${resolved.id}`);
      }
      if (pwd === undefined || pwd === '<ask>') {
        pwd = await vscode.window.showInputBox({
          prompt: `Enter password for connection ${resolved.name || resolved.host}`,
          password: true,
          ignoreFocusOut: true,
        });
        if (pwd === undefined) {
          throw new Error('Connection cancelled: Password required');
        }
        await this.context.secrets.store(`sqlens.pwd.${resolved.id}`, pwd);
      }
      resolved.password = pwd ?? '';
    }

    if (resolved.ssh.enabled) {
      if (resolved.ssh.authMethod === 'password') {
        let sshPwd = resolved.ssh.password;
        if (sshPwd === undefined || sshPwd === '<ask>') {
          sshPwd = await this.context.secrets.get(`sqlens.ssh.pwd.${resolved.id}`);
        }
        if (sshPwd === undefined || sshPwd === '<ask>') {
          sshPwd = await vscode.window.showInputBox({
            prompt: `Enter SSH password for connection ${resolved.name || resolved.host}`,
            password: true,
            ignoreFocusOut: true,
          });
          if (sshPwd === undefined) {
            throw new Error('Connection cancelled: SSH password required');
          }
          await this.context.secrets.store(`sqlens.ssh.pwd.${resolved.id}`, sshPwd);
        }
        resolved.ssh.password = sshPwd ?? '';
      } else if (resolved.ssh.authMethod === 'privateKey') {
        let passphrase = resolved.ssh.passphrase;
        if (passphrase === undefined || passphrase === '<ask>') {
          passphrase = await this.context.secrets.get(`sqlens.ssh.pp.${resolved.id}`);
        }
        if (passphrase === undefined || passphrase === '<ask>') {
          passphrase = await vscode.window.showInputBox({
            prompt: `Enter SSH private key passphrase for connection ${resolved.name || resolved.host}`,
            password: true,
            ignoreFocusOut: true,
          });
          if (passphrase === undefined) {
            throw new Error('Connection cancelled: SSH passphrase required');
          }
          await this.context.secrets.store(`sqlens.ssh.pp.${resolved.id}`, passphrase);
        }
        resolved.ssh.passphrase = passphrase ?? '';
      }
    }
    return resolved;
  }
}
