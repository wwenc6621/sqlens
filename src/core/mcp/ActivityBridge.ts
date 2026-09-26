import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface AiActivityEntry {
  id: string;
  timestamp: number;
  tool: string;
  client: string;
  argsSummary: string;
  sql?: string;
  connectionName?: string;
  durationMs: number;
  rowCount?: number;
  success: boolean;
  error?: string;
  blocked?: boolean;
}

/** A write statement waiting for the user to allow/deny it in the AI Activity panel. */
export interface PendingWrite {
  id: string;
  timestamp: number;
  client: string;
  tool: string;
  sql: string;
  connectionName?: string;
  timeoutMs: number;
}

const MAX_ACTIVITY = 200;

/**
 * Records every AI (MCP) tool call: OutputChannel for live view,
 * JSON file in globalStorage for persistence, status bar feedback.
 */
export class ActivityBridge {
  private channel: vscode.OutputChannel;
  private entries: AiActivityEntry[] = [];
  private filePath: string;
  private statusBarItem: vscode.StatusBarItem;
  private activeCount = 0;
  private pending = new Map<string, { request: PendingWrite; resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }>();
  private _onDidChange = new vscode.EventEmitter<void>();
  /** Fired whenever entries or pending confirmations change. */
  readonly onDidChange = this._onDidChange.event;

  constructor(private context: vscode.ExtensionContext) {
    this.channel = vscode.window.createOutputChannel('Sqlens AI Activity');
    this.filePath = path.join(context.globalStorageUri.fsPath, 'ai-activity.json');
    this.load();
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusBarItem.name = 'Sqlens AI';
  }

  get outputChannel(): vscode.OutputChannel { return this.channel; }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.entries = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    if (!vscode.workspace.getConfiguration('sqlens.mcp').get<boolean>('activityPersist', true)) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
    } catch {
      // best effort
    }
  }

  private updateStatusBar(): void {
    if (this.activeCount > 0) {
      this.statusBarItem.text = `$(sync~spin) AI`;
      this.statusBarItem.tooltip = `Sqlens: ${this.activeCount} AI tool call(s) running`;
      this.statusBarItem.show();
    } else if (this.entries.length > 0 && this.entries[0].blocked) {
      this.statusBarItem.text = `$(sparkle) AI`;
      this.statusBarItem.tooltip = 'Sqlens: last AI call was blocked';
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  /** Run a tool call with full activity recording. */
  async record<T>(
    tool: string,
    client: string,
    argsSummary: string,
    fn: () => Promise<T>,
    extra?: { sql?: string; connectionName?: string; rowCountFrom?: (r: T) => number | undefined; blocked?: boolean },
  ): Promise<T> {
    const entry: AiActivityEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      tool,
      client,
      argsSummary,
      sql: extra?.sql,
      connectionName: extra?.connectionName,
      durationMs: 0,
      success: false,
      blocked: extra?.blocked,
    };

    this.activeCount++;
    this.updateStatusBar();
    this.channel.appendLine(`[AI] ${new Date(entry.timestamp).toLocaleTimeString()} ${client} -> ${tool} ${argsSummary}`);

    const start = performance.now();
    try {
      const result = await fn();
      entry.durationMs = Math.round(performance.now() - start);
      entry.success = true;
      entry.rowCount = extra?.rowCountFrom?.(result);
      this.channel.appendLine(`[AI]   -> ok in ${entry.durationMs}ms${entry.rowCount != null ? `, ${entry.rowCount} rows` : ''}`);
      return result;
    } catch (err) {
      entry.durationMs = Math.round(performance.now() - start);
      entry.error = err instanceof Error ? err.message : String(err);
      this.channel.appendLine(`[AI]   -> FAILED: ${entry.error}`);
      throw err;
    } finally {
      this.activeCount--;
      this.unshiftAndPersist(entry);
      this.updateStatusBar();
      this._onDidChange.fire();
    }
  }

  /** Record a blocked call (rejected by SecurityGuard before execution). */
  recordBlocked(tool: string, client: string, argsSummary: string, reason: string): void {
    this.entries.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      tool,
      client,
      argsSummary,
      durationMs: 0,
      success: false,
      error: reason,
      blocked: true,
    });
    this.entries = this.entries.slice(0, MAX_ACTIVITY);
    this.channel.appendLine(`[AI] BLOCKED ${client} -> ${tool} ${argsSummary}: ${reason}`);
    this.persist();
    this.updateStatusBar();
    this._onDidChange.fire();
  }

  private unshiftAndPersist(entry: AiActivityEntry): void {
    this.entries.unshift(entry);
    const retention = vscode.workspace.getConfiguration('sqlens.mcp').get<number>('activityRetention', 200);
    if (retention > 0 && this.entries.length > retention) {
      this.entries = this.entries.slice(0, retention);
    }
    this.persist();
  }

  getEntries(): AiActivityEntry[] { return this.entries; }

  getPendingWrites(): PendingWrite[] {
    return [...this.pending.values()].map(p => p.request).sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Ask the user to confirm a write statement via the AI Activity panel
   * (inline card). Resolves true if allowed, false on deny/timeout.
   */
  async requestWriteConfirmation(sql: string, client: string, connectionName?: string): Promise<boolean> {
    const timeoutMs = vscode.workspace.getConfiguration('sqlens.mcp').get<number>('autoConfirmTimeout', 120) * 1000;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const request: PendingWrite = { id, timestamp: Date.now(), client, tool: 'write_query', sql, connectionName, timeoutMs };

    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => this.resolvePending(id, false, 'timeout'), timeoutMs);
      this.pending.set(id, { request, resolve, timer });
      this._onDidChange.fire();
    });
  }

  /** Resolve a pending write confirmation. */
  resolvePending(id: string, allowed: boolean, reason?: 'timeout'): boolean {
    const entry = this.pending.get(id);
    if (!entry) { return false; }
    clearTimeout(entry.timer);
    this.pending.delete(id);

    this.entries.unshift({
      id,
      timestamp: Date.now(),
      tool: entry.request.tool,
      client: entry.request.client,
      argsSummary: JSON.stringify({ sql: entry.request.sql }),
      sql: entry.request.sql,
      connectionName: entry.request.connectionName,
      durationMs: 0,
      success: allowed,
      error: reason === 'timeout' ? 'Confirmation timed out' : (allowed ? undefined : 'Denied by user'),
      blocked: !allowed,
    });
    this.entries = this.entries.slice(0, MAX_ACTIVITY);
    this.channel.appendLine(`[AI] write_query ${allowed ? 'ALLOWED' : 'DENIED'}${reason === 'timeout' ? ' (timeout)' : ''}: ${entry.request.sql}`);
    this.persist();
    this._onDidChange.fire();
    entry.resolve(allowed);
    return true;
  }

  hasPending(id: string): boolean { return this.pending.has(id); }

  clear(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(false);
      this.pending.delete(id);
    }
    this.entries = [];
    this.channel.clear();
    this.persist();
    this._onDidChange.fire();
  }

  show(): void { this.channel.show(); }

  dispose(): void {
    this.clear();
    this._onDidChange.dispose();
    this.statusBarItem.dispose();
    this.channel.dispose();
  }
}
