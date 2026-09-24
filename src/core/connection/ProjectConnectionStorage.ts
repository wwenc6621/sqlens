import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConnectionConfig, DatabaseType } from '../types';

import { t } from '../i18n';

export class ProjectConnectionStorage {
  constructor(private context: vscode.ExtensionContext) {}

  getProjectConfigPath(workspaceFolder: vscode.WorkspaceFolder): string {
    return path.join(workspaceFolder.uri.fsPath, '.sqlens.json');
  }

  getDeterministicId(conn: any, workspacePath: string): string {
    const hash = crypto.createHash('md5')
      .update(`${workspacePath}-${conn.name || ''}-${conn.type || ''}-${conn.host || ''}-${conn.port || ''}-${conn.username || ''}-${conn.database || ''}-${conn.filepath || ''}`)
      .digest('hex');
    return `project-${hash}`;
  }

  async loadFromProject(workspaceFolder: vscode.WorkspaceFolder): Promise<ConnectionConfig[]> {
    const configPath = this.getProjectConfigPath(workspaceFolder);
    if (!fs.existsSync(configPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const data = JSON.parse(content);
      const connections: ConnectionConfig[] = [];

      if (data && Array.isArray(data.connections)) {
        for (const conn of data.connections) {
          const id = conn.id || this.getDeterministicId(conn, workspaceFolder.uri.fsPath);

          const config: ConnectionConfig = {
            id,
            name: conn.name || 'Project Connection',
            type: conn.type || DatabaseType.PostgreSQL,
            host: conn.host || 'localhost',
            port: conn.port || 5432,
            username: conn.username || '',
            password: conn.password || '<ask>',
            database: conn.database || '',
            filepath: conn.filepath,
            ssl: conn.ssl || { mode: 'disabled' },
            ssh: conn.ssh || { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
            options: conn.options || {},
            // A missing key means "never assigned" and falls back to the default
            // folder; an empty string means the user removed it from any folder.
            group: typeof conn.group === 'string' ? (conn.group || undefined) : 'Project Connections',
            tags: conn.tags || [],
            color: conn.color,
            createdAt: conn.createdAt || Date.now(),
            updatedAt: conn.updatedAt || Date.now(),
          };

          if (!config.tags.includes('project-config')) {
            config.tags.push('project-config');
          }
          config.options.sqlensProjectConfig = true;
          config.options.sqlensWorkspaceRoot = workspaceFolder.uri.fsPath;

          connections.push(config);
        }
      }
      return connections;
    } catch (err) {
      console.error(`Error reading .sqlens.json: ${err}`);
      return [];
    }
  }

  async saveToProject(workspaceFolder: vscode.WorkspaceFolder, configs: ConnectionConfig[]): Promise<void> {
    const configPath = this.getProjectConfigPath(workspaceFolder);

    const sanitizedConnections = configs.map(config => {
      const { id, name, type, host, port, username, database, filepath, ssl, ssh, options, group, tags, color, createdAt, updatedAt } = config;

      const cleanedTags = tags.filter(t => t !== 'project-config');
      const cleanedOptions = { ...options };
      delete cleanedOptions.sqlensProjectConfig;
      delete cleanedOptions.sqlensWorkspaceRoot;

      const fileConn: any = {
        id,
        name,
        type,
        host,
        port,
        username,
        database,
        filepath,
        ssl,
        ssh: {
          ...ssh,
          password: ssh.password ? '<ask>' : undefined,
          passphrase: ssh.passphrase ? '<ask>' : undefined,
        },
        options: cleanedOptions,
        // Written even when empty: an explicit '' means "no folder", which keeps
        // a connection the user moved out of a folder from snapping back into
        // the default one on the next load.
        group: group ?? '',
        tags: cleanedTags,
        color,
        createdAt,
        updatedAt,
      };

      if (config.password) {
        fileConn.password = '<ask>';
      }

      return fileConn;
    });

    const data = {
      $schema: 'https://sqlens.dev/schema/connections.json',
      version: 1,
      connections: sanitizedConnections,
    };

    try {
      fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      vscode.window.showErrorMessage(t('Failed to save project connection config: {0}', err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async addConnection(workspaceFolder: vscode.WorkspaceFolder, config: ConnectionConfig): Promise<void> {
    const configs = await this.loadFromProject(workspaceFolder);
    const existingIndex = configs.findIndex(c => c.id === config.id);

    if (config.password && config.password !== '<ask>') {
      await this.context.secrets.store(`sqlens.pwd.${config.id}`, config.password);
    }
    if (config.ssh.password && config.ssh.password !== '<ask>') {
      await this.context.secrets.store(`sqlens.ssh.pwd.${config.id}`, config.ssh.password);
    }
    if (config.ssh.passphrase && config.ssh.passphrase !== '<ask>') {
      await this.context.secrets.store(`sqlens.ssh.pp.${config.id}`, config.ssh.passphrase);
    }

    if (existingIndex >= 0) {
      configs[existingIndex] = config;
    } else {
      configs.push(config);
    }

    await this.saveToProject(workspaceFolder, configs);
  }

  async removeConnection(workspaceFolder: vscode.WorkspaceFolder, configId: string): Promise<void> {
    const configs = await this.loadFromProject(workspaceFolder);
    const filtered = configs.filter(c => c.id !== configId);
    await this.saveToProject(workspaceFolder, filtered);

    await this.context.secrets.delete(`sqlens.pwd.${configId}`);
    await this.context.secrets.delete(`sqlens.ssh.pwd.${configId}`);
    await this.context.secrets.delete(`sqlens.ssh.pp.${configId}`);
  }
}
