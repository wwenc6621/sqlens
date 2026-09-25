import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { t } from '../i18n';

interface AssistantTarget {
  id: string;
  label: string;
  /** Returns candidate config file paths (global first, then project-level). */
  getPaths: (workspaceFolders: readonly vscode.WorkspaceFolder[]) => string[];
}

const ASSISTANTS: AssistantTarget[] = [
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    // Global user-level config is the assistant's default location.
    getPaths: () => [path.join(os.homedir(), '.codebuddy', 'mcp.json')],
  },
  {
    id: 'trae',
    label: 'Trae',
    getPaths: () => {
      const home = os.homedir();
      const candidates = [
        // International Trae stores MCP configs under ~/.marscode.
        path.join(home, '.marscode', 'vscode.mcp.config.json'),
        path.join(home, '.trae', 'mcp.json'),
        process.platform === 'darwin'
          ? path.join(home, 'Library', 'Application Support', 'Trae', 'mcp.json')
          : process.platform === 'win32'
            ? path.join(home, 'AppData', 'Roaming', 'Trae', 'mcp.json')
            : path.join(home, '.config', 'Trae', 'mcp.json'),
      ];
      return candidates;
    },
  },
  {
    id: 'trae-cn',
    label: 'Trae CN',
    getPaths: () => {
      const home = os.homedir();
      return [
        process.platform === 'darwin'
          ? path.join(home, 'Library', 'Application Support', 'Trae CN', 'User', 'mcp.json')
          : process.platform === 'win32'
            ? path.join(home, 'AppData', 'Roaming', 'Trae CN', 'User', 'mcp.json')
            : path.join(home, '.config', 'Trae CN', 'User', 'mcp.json'),
      ];
    },
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot (VS Code)',
    // User-scope MCP config (VS Code: File > Preferences > Manage MCP Servers)
    // plus the workspace-level .vscode/mcp.json.
    getPaths: (folders) => {
      const home = os.homedir();
      const userScope = process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
        : process.platform === 'win32'
          ? path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json')
          : path.join(home, '.config', 'Code', 'User', 'mcp.json');
      return [userScope, ...folders.map(f => path.join(f.uri.fsPath, '.vscode', 'mcp.json'))];
    },
  },
];

/**
 * Writes the Sqlens MCP entry into AI assistants' MCP config files.
 * Only upserts the "sqlens" key; other entries are preserved.
 */
export class AssistantRegistrar {
  constructor(
    private getEndpoint: () => string,
    private getToken: () => string,
  ) {}

  /**
   * Resolve the primary config file for a target: the first candidate that
   * already exists on disk, otherwise the first candidate (the default path).
   */
  private primaryPath(target: AssistantTarget): string {
    const paths = target.getPaths(vscode.workspace.workspaceFolders || []);
    return paths.find(p => fs.existsSync(p)) || paths[0];
  }

  /** Show a QuickPick and register into the selected assistants' configs. */
  async registerInteractive(): Promise<void> {
    const picks = await vscode.window.showQuickPick(
      ASSISTANTS.map(a => {
        const primary = this.primaryPath(a);
        let existing = false;
        try {
          existing = fs.existsSync(primary) && !!JSON.parse(fs.readFileSync(primary, 'utf8')).mcpServers?.sqlens;
        } catch { /* treat as not registered */ }
        return {
          label: `${existing ? '$(check) ' : ''}${a.label}`,
          id: a.id,
          description: existing ? 'already registered' : primary,
        };
      }),
      { canPickMany: true, placeHolder: t('Register Sqlens MCP server into which AI assistants?') },
    );
    if (!picks || picks.length === 0) { return; }

    const results: string[] = [];
    for (const pick of picks) {
      const target = ASSISTANTS.find(a => a.id === pick.id)!;
      const filePath = this.primaryPath(target);
      try {
        if (this.upsertConfig(filePath)) {
          results.push(filePath);
        } else {
          results.push(filePath); // already up to date, still show the file
        }
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to write {0}: {1}', filePath, (err as Error).message));
      }
    }

    if (results.length === 0) {
      vscode.window.showWarningMessage(t('No MCP config file was written.'));
      return;
    }
    const open = await vscode.window.showInformationMessage(
      t('Sqlens MCP registered to {0} config file(s). Restart the AI assistant chat to take effect.', results.length),
      t('Show Files'),
    );
    if (open === t('Show Files')) {
      for (const file of results) {
        try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file)); } catch { /* ignore */ }
      }
    }
  }

  /** List every known assistant and whether it currently points at Sqlens. */
  getRegisteredAssistants(): { id: string; name: string; registered: boolean; configPath: string }[] {
    const folders = vscode.workspace.workspaceFolders || [];
    return ASSISTANTS.map(a => {
      const primary = this.primaryPath(a);
      let registered = false;
      try {
        const raw = fs.existsSync(primary) ? fs.readFileSync(primary, 'utf8') : '';
        registered = !!raw && !!JSON.parse(raw).mcpServers?.sqlens;
      } catch { /* treat as not registered */ }
      return { id: a.id, name: a.label, registered, configPath: primary };
    });
  }

  /** Returns true if the file was created or modified. */
  private upsertConfig(filePath: string): boolean {
    let json: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      try {
        json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        throw new Error('existing file is not valid JSON — please fix it manually');
      }
    }

    const servers = (json.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : {}) as Record<string, unknown>;
    const before = JSON.stringify(servers.sqlens);

    servers.sqlens = {
      type: 'http',
      url: this.getEndpoint(),
      headers: { Authorization: `Bearer ${this.getToken()}` },
    };
    json.mcpServers = servers;

    if (before === JSON.stringify(servers.sqlens)) {
      return false; // already up to date
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.sqlens-bak`);
    }
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
    return true;
  }

  /** MCP config snippet for manual paste into any assistant. */
  configSnippet(): string {
    return JSON.stringify({
      mcpServers: {
        sqlens: {
          type: 'http',
          url: this.getEndpoint(),
          headers: { Authorization: `Bearer ${this.getToken()}` },
        },
      },
    }, null, 2);
  }
}
