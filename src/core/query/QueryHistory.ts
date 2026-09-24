import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { t } from '../i18n';

export interface QueryHistoryEntry {
  id: string;
  sql: string;
  connectionId: string;
  connectionName: string;
  database: string;
  executionTime: number;
  rowCount: number;
  timestamp: number;
  success: boolean;
  error?: string;
  /** Origin of the query: manual (UI) or ai (MCP tool call). Absent on legacy entries. */
  source?: 'manual' | 'ai';
}

const MAX_HISTORY = 500;
const MAX_SQL_LENGTH = 10_000;

/**
 * Persistent query history storage.
 * Stores recent queries in a JSON file within the extension's global storage.
 */
export class QueryHistory {
  private history: QueryHistoryEntry[] = [];
  private filePath: string;
  private dirty = false;

  constructor(private context: vscode.ExtensionContext) {
    this.filePath = path.join(context.globalStorageUri.fsPath, 'query-history.json');
    this.load();
  }

  /** Add a query to history */
  add(entry: Omit<QueryHistoryEntry, 'id' | 'timestamp'>): void {
    const fullEntry: QueryHistoryEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      sql: entry.sql.length > MAX_SQL_LENGTH ? entry.sql.substring(0, MAX_SQL_LENGTH) + '...' : entry.sql,
    };

    // Skip duplicate consecutive queries
    if (this.history.length > 0 && this.history[0].sql === fullEntry.sql) {
      this.history[0] = fullEntry; // Update timestamp and stats
    } else {
      this.history.unshift(fullEntry);
    }

    // Trim to max size
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(0, MAX_HISTORY);
    }

    this.dirty = true;
    this.saveLazy();
  }

  /** Get all history entries */
  getAll(): QueryHistoryEntry[] {
    return this.history;
  }

  /** Search history by SQL text */
  search(query: string): QueryHistoryEntry[] {
    const lower = query.toLowerCase();
    return this.history.filter(entry =>
      entry.sql.toLowerCase().includes(lower) ||
      entry.connectionName.toLowerCase().includes(lower) ||
      entry.database.toLowerCase().includes(lower)
    );
  }

  /** Get history for a specific connection */
  getByConnection(connectionId: string): QueryHistoryEntry[] {
    return this.history.filter(entry => entry.connectionId === connectionId);
  }

  /** Get recent successful queries */
  getRecent(count: number = 20): QueryHistoryEntry[] {
    return this.history.filter(e => e.success).slice(0, count);
  }

  /** Clear all history */
  clear(): void {
    this.history = [];
    this.dirty = true;
    this.save();
  }

  /** Delete a specific entry */
  delete(id: string): void {
    this.history = this.history.filter(e => e.id !== id);
    this.dirty = true;
    this.saveLazy();
  }

  /** Show history as a Quick Pick for the user to select and re-run */
  async showQuickPick(): Promise<QueryHistoryEntry | undefined> {
    const items = this.history.slice(0, 100).map(entry => ({
      label: this.truncateSQL(entry.sql),
      description: (t('{0} • {1}', entry.connectionName, entry.database)),
      detail: `${entry.success ? 'Success' : 'Failed'} • ${new Date(entry.timestamp).toLocaleString()} • ${entry.executionTime}ms • ${entry.rowCount} rows`,
      entry,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: t('Search query history...'),
      matchOnDescription: true,
      matchOnDetail: true,
    });

    return selected?.entry;
  }

  private truncateSQL(sql: string): string {
    const oneLine = sql.replace(/\s+/g, ' ').trim();
    return oneLine.length > 120 ? oneLine.substring(0, 120) + '...' : oneLine;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        this.history = JSON.parse(data);
      }
    } catch {
      this.history = [];
    }
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private saveLazy(): void {
    if (this.saveTimer) { return; }
    this.saveTimer = setTimeout(() => {
      this.save();
      this.saveTimer = null;
    }, 2000);
  }

  private save(): void {
    if (!this.dirty) { return; }
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.history, null, 2));
      this.dirty = false;
    } catch (err) {
      console.error('Failed to save query history:', err);
    }
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.save();
  }
}
