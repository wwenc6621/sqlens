import * as vscode from 'vscode';
import { ConnectionConfig } from '../types';
import { ConnectionStorage } from './ConnectionStorage';
import { formatLabel, parseConnections } from './import';
import { buildConnectionUri } from './import/uriUtils';

/** Sanitized single-row preview for the import wizard (never carries secrets). */
export interface ImportPreviewItem {
  index: number;
  name: string;
  type: string;
  host?: string;
  port?: number;
  username?: string;
  hasPassword: boolean;
  database?: string;
  filepath?: string;
  group?: string;
  issues: string[];
}

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

  /** Read the clipboard and import whatever format it contains. */
  async importFromClipboard(): Promise<number> {
    const text = await vscode.env.clipboard.readText();
    if (!text || !text.trim()) {
      vscode.window.showInformationMessage('Clipboard is empty — nothing to import.');
      return 0;
    }
    return this.importFromText(text);
  }

  /**
   * Format-agnostic import: sniffs JSON / URI / CSV-TSV / .env, lets the user
   * pick which parsed entries to keep, then saves through the existing chain
   * (enc: dropping, id regeneration, name de-duplication).
   */
  async importFromText(text: string): Promise<number> {
    const result = parseConnections(text);
    if (result.error) {
      vscode.window.showErrorMessage(
        `Import failed (${formatLabel(result.format)}): ${result.error}`,
      );
      return 0;
    }

    const incoming = result.connections;
    // Non-fatal problems surface once, before the pick list.
    const warnings = incoming.flatMap(c => c.issues.filter(i => i.severity === 'warning').map(i => i.message));
    for (const message of [...new Set(warnings)].slice(0, 3)) {
      console.warn(`[sqlens] import warning: ${message}`);
    }

    // Let the user pick which entries to import.
    const picked = await vscode.window.showQuickPick(
      incoming.map(c => ({
        label: `${c.draft.name || 'Untitled'} (${c.draft.type})`,
        description: [c.draft.host, c.draft.port, c.draft.filepath].filter(Boolean).join(':') + (c.issues.length > 0 ? '  ⚠' : ''),
        detail: c.issues.map(i => i.message).join(' · ') || undefined,
        picked: true,
        config: c.draft,
      })),
      {
        canPickMany: true,
        placeHolder: `Select connections to import (${incoming.length} found, ${formatLabel(result.format)}${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ''})`,
        title: 'Import Connections',
      },
    );
    if (!picked || picked.length === 0) { return 0; }

    return this.savePicked(picked.map(p => p.config));
  }

  /** Persist picked configs: enc: secrets dropped, ids regenerated, names de-duplicated. */
  private async savePicked(pickedConfigs: ConnectionConfig[]): Promise<number> {
    const existing = await this.storage.getAll();
    const existingIds = new Set(existing.map(c => c.id));
    const existingNames = new Set(existing.map(c => (c.name || '').toLowerCase()));

    let imported = 0;
    const renamed: string[] = [];
    for (const pick of pickedConfigs) {
      const config: ConnectionConfig = {
        ...pick,
        // Parser drafts carry no id; always ensure a fresh, unique one.
        id: !pick.id || existingIds.has(pick.id) ? generateConnectionId() : pick.id,
        // Encrypted values from another machine are unreadable here — drop them.
        password: isEncryptedValue(pick.password) ? undefined : pick.password,
        ssh: {
          ...pick.ssh,
          password: isEncryptedValue(pick.ssh.password) ? undefined : pick.ssh.password,
          passphrase: isEncryptedValue(pick.ssh.passphrase) ? undefined : pick.ssh.passphrase,
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

  /** Copy a connection as a standard URI (no secrets by default). */
  async copyAsUri(): Promise<string | undefined> {
    const all = await this.storage.getAll();
    if (all.length === 0) {
      vscode.window.showInformationMessage('No connections to copy.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      all.map(c => ({
        label: `${c.name || 'Untitled'} (${c.type})`,
        description: c.host || c.filepath || '',
        config: c,
      })),
      { placeHolder: 'Copy which connection as a URI?', title: 'Copy Connection URI' },
    );
    if (!picked) { return undefined; }

    const uri = buildConnectionUri(picked.config, { includePassword: false });
    await vscode.env.clipboard.writeText(uri);
    vscode.window.showInformationMessage(`Connection URI copied (without password).`);
    return uri;
  }

  /**
   * Parse text for the import wizard preview. Passwords are never included —
   * only a `hasPassword` flag. Deterministic order (index-stable) so
   * `commitImport` can address entries by index.
   */
  getImportPreview(text: string): { format: string; error?: string; items: ImportPreviewItem[] } {
    const result = parseConnections(text);
    if (result.error) {
      return { format: result.format, error: result.error, items: [] };
    }
    return {
      format: result.format,
      items: result.connections.map((c, index) => ({
        index,
        name: c.draft.name,
        type: c.draft.type,
        host: c.draft.host || undefined,
        port: c.draft.port || undefined,
        username: c.draft.username || undefined,
        hasPassword: !!c.draft.password,
        database: c.draft.database || undefined,
        filepath: c.draft.filepath || undefined,
        group: c.draft.group,
        issues: c.issues.filter(i => i.severity === 'warning').map(i => i.message),
      })),
    };
  }

  /**
   * Re-parse `text`, keep the entries addressed by `picks` (index + optional
   * name/group overrides from the wizard), and save them through the
   * standard chain. Returns the number imported.
   */
  async commitImport(
    text: string,
    picks: Array<{ index: number; name?: string; group?: string }>,
  ): Promise<number> {
    const result = parseConnections(text);
    if (result.error || result.connections.length === 0) { return 0; }

    const configs: ConnectionConfig[] = [];
    for (const pick of picks) {
      const parsed = result.connections[pick.index];
      if (!parsed) { continue; }
      configs.push({
        ...parsed.draft,
        name: pick.name?.trim() || parsed.draft.name,
        group: pick.group?.trim() || parsed.draft.group,
      });
    }
    if (configs.length === 0) { return 0; }
    return this.savePicked(configs);
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

/** Values stored by the shared connection file are machine-bound (AES key file). */
function isEncryptedValue(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('enc:');
}

function generateConnectionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
