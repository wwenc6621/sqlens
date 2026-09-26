import * as vscode from 'vscode';
import { ConnectionConfig, DatabaseType } from '../types';
import { ConnectionStorage } from './ConnectionStorage';

/**
 * Import/export of connection configurations to a portable JSON file.
 *
 * Export format:
 *   { "version": 1, "source": "sqlens", "exportedAt": ISO, "connections": [...] }
 * (a bare `ConnectionConfig[]` is accepted on import for round-tripping with
 * the shared connections file / project `.sqlens.json`).
 *
 * Secrets handling: the export can include passwords only after an explicit
 * user choice + confirmation, and they are written as **plaintext** — the
 * recipient must be warned. By default secrets are stripped.
 */
export class ConnectionTransfer {
  constructor(private storage: ConnectionStorage) {}

  /** Export connections to a user-chosen file. Returns the file path or undefined if cancelled. */
  async exportConnections(): Promise<string | undefined> {
    const all = await this.storage.getAll();
    if (all.length === 0) {
      vscode.window.showInformationMessage('No connections to export.');
      return undefined;
    }

    // Pick which connections to export.
    const picked = await vscode.window.showQuickPick(
      all.map(c => ({
        label: `${c.name || 'Untitled'} (${c.type})`,
        description: c.host || c.filepath || '',
        picked: true,
        config: c,
      })),
      { canPickMany: true, placeHolder: 'Select connections to export', title: 'Export Connections' },
    );
    if (!picked || picked.length === 0) { return undefined; }

    // Decide secret handling — plaintext is opt-in with a double confirmation.
    const secretChoice = await vscode.window.showQuickPick(
      [
        { label: 'Without passwords (recommended)', includeSecrets: false },
        { label: 'Include passwords (plain text!)', includeSecrets: true },
      ],
      { placeHolder: 'Include passwords in the export file?', title: 'Export Connections' },
    );
    if (!secretChoice) { return undefined; }

    let includeSecrets = secretChoice.includeSecrets;
    if (includeSecrets) {
      const confirm = await vscode.window.showWarningMessage(
        'Passwords will be written as PLAIN TEXT into the export file. Anyone with the file can access your databases. Continue?',
        { modal: true },
        'Export with passwords',
      );
      if (confirm !== 'Export with passwords') { includeSecrets = false; }
    }

    const connections = picked.map(p => sanitizeForExport(p.config, includeSecrets));
    const payload = {
      version: 1,
      source: 'sqlens',
      exportedAt: new Date().toISOString(),
      includePasswords: includeSecrets,
      connections,
    };

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const target = await vscode.window.showSaveDialog({
      title: 'Export Connections',
      defaultUri: vscode.Uri.file(`sqlens-connections-${date}.json`),
      filters: { 'JSON files': ['json'] },
    });
    if (!target) { return undefined; }

    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
    return target.fsPath;
  }

  /** Import connections from a user-chosen file. Returns the number imported. */
  async importConnections(): Promise<number> {
    const source = await vscode.window.showOpenDialog({
      title: 'Import Connections',
      canSelectMany: false,
      filters: { 'JSON files': ['json'] },
    });
    if (!source || source.length === 0) { return 0; }

    let parsed: unknown;
    try {
      const content = await vscode.workspace.fs.readFile(source[0]);
      parsed = JSON.parse(Buffer.from(content).toString('utf8'));
    } catch (err) {
      vscode.window.showErrorMessage(`Cannot read connection file: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    const incoming = extractConnections(parsed);
    if (incoming.length === 0) {
      vscode.window.showErrorMessage('No valid connections found in the file (each entry needs "name" and "type").');
      return 0;
    }

    // Let the user pick which entries to import.
    const picked = await vscode.window.showQuickPick(
      incoming.map(c => ({
        label: `${c.name || 'Untitled'} (${c.type})`,
        description: c.host || c.filepath || '',
        picked: true,
        config: c,
      })),
      { canPickMany: true, placeHolder: `Select connections to import (${incoming.length} found)`, title: 'Import Connections' },
    );
    if (!picked || picked.length === 0) { return 0; }

    const existing = await this.storage.getAll();
    const existingIds = new Set(existing.map(c => c.id));
    const existingNames = new Set(existing.map(c => (c.name || '').toLowerCase()));

    let imported = 0;
    const renamed: string[] = [];
    for (const pick of picked) {
      const config: ConnectionConfig = {
        ...pick.config,
        id: existingIds.has(pick.config.id) ? generateConnectionId() : pick.config.id,
        // Encrypted values from another machine are unreadable here — drop them.
        password: isEncryptedValue(pick.config.password) ? undefined : pick.config.password,
        ssh: {
          ...pick.config.ssh,
          password: isEncryptedValue(pick.config.ssh.password) ? undefined : pick.config.ssh.password,
          passphrase: isEncryptedValue(pick.config.ssh.passphrase) ? undefined : pick.config.ssh.passphrase,
        },
      };

      // Avoid duplicate display names.
      let name = config.name || 'Untitled';
      if (existingNames.has(name.toLowerCase())) {
        const base = name;
        let suffix = 2;
        while (existingNames.has(`${base} (${suffix})`.toLowerCase())) { suffix++; }
        name = `${base} (${suffix})`;
        renamed.push(name);
      }
      config.name = name;
      existingNames.add(name.toLowerCase());
      existingIds.add(config.id);

      await this.storage.save(config);
      imported++;
    }

    if (imported > 0) {
      await vscode.commands.executeCommand('sqlens.refreshConnections');
      const msg = renamed.length > 0
        ? `Imported ${imported} connection(s), renamed to avoid duplicates: ${renamed.join(', ')}`
        : `Imported ${imported} connection(s).`;
      vscode.window.showInformationMessage(msg);
    }
    return imported;
  }
}

/** Strip secrets unless explicitly included; drop workspace-binding markers. */
function sanitizeForExport(config: ConnectionConfig, includeSecrets: boolean): ConnectionConfig {
  const options = { ...(config.options || {}) };
  // Workspace-local bindings make no sense on another machine.
  delete options.sqlensProjectConfig;
  delete options.sqlensWorkspaceRoot;
  delete options.sqlensSourceFile;

  return {
    ...config,
    password: includeSecrets ? config.password : undefined,
    ssh: {
      ...config.ssh,
      password: includeSecrets ? config.ssh.password : undefined,
      passphrase: includeSecrets ? config.ssh.passphrase : undefined,
    },
    options,
  };
}

/**
 * Accept `{ version, connections: [...] }` payloads as well as a bare array
 * (the shared connections file and `.sqlens.json` shapes).
 */
function extractConnections(parsed: unknown): ConnectionConfig[] {
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { connections?: unknown }).connections))
        ? (parsed as { connections: unknown[] }).connections
        : [];

  return list.filter((entry): entry is ConnectionConfig =>
    !!entry && typeof entry === 'object'
    && typeof (entry as ConnectionConfig).name === 'string'
    && typeof (entry as ConnectionConfig).type === 'string'
    && Object.values(DatabaseType).includes((entry as ConnectionConfig).type as DatabaseType),
  );
}

/** Values stored by the shared connection file are machine-bound (AES key file). */
function isEncryptedValue(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('enc:');
}

function generateConnectionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
