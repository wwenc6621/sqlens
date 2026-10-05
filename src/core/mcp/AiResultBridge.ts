import type { ColumnHeader } from '../types';

/** A read query executed by an AI assistant, captured so the UI can show it. */
export interface AiResultPayload {
  activityId: string;
  clientName: string;
  connectionId: string;
  connectionName: string;
  sql: string;
  columns: ColumnHeader[];
  rows: unknown[][];
  totalRows: number;
  truncated: boolean;
  executionTime: number;
}

export interface AiResultRecord {
  tabId: string;
  payload: AiResultPayload;
}

/** Collapse whitespace and drop a trailing semicolon so equal queries merge. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
}

/** Stable short id from a string (djb2). */
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Keeps AI query results addressable from the AI Activity panel.
 *
 * The same connection + normalized SQL maps to one tab id, so a repeated query
 * refreshes the existing tab instead of piling up new ones. Records are kept
 * (LRU-bounded) so a closed result tab can still be reopened from the activity
 * list, and so `getByTab` can serve a rebuilt tab.
 */
export class AiResultBridge {
  /** tabId -> latest record (used to reopen a closed tab). */
  private byTab = new Map<string, AiResultRecord>();
  /** activityId -> tabId (used by the "open in grid" jump). */
  private byActivity = new Map<string, string>();
  /** tab ids, least-recently-touched first. */
  private order: string[] = [];

  constructor(
    private readonly openTab: (record: AiResultRecord) => void,
    private readonly maxEntries = 200,
  ) {}

  /** Capture a result and open/refresh its tab. Returns the tab id. */
  present(payload: AiResultPayload): string {
    const tabId = `ai-result-${hash(`${payload.connectionId}\u0000${normalizeSql(payload.sql)}`)}`;
    const record: AiResultRecord = { tabId, payload };
    this.byTab.set(tabId, record);
    this.byActivity.set(payload.activityId, tabId);
    this.touch(tabId);
    this.evict();
    this.openTab(record);
    return tabId;
  }

  /** Resolve the tab that shows a given AI activity's result. */
  getByActivity(activityId: string): AiResultRecord | undefined {
    const tabId = this.byActivity.get(activityId);
    return tabId ? this.byTab.get(tabId) : undefined;
  }

  getByTab(tabId: string): AiResultRecord | undefined {
    return this.byTab.get(tabId);
  }

  /** Drop a tab's record and its activity links. */
  removeTab(tabId: string): void {
    if (!this.byTab.delete(tabId)) { return; }
    for (const [activityId, id] of [...this.byActivity]) {
      if (id === tabId) { this.byActivity.delete(activityId); }
    }
    this.order = this.order.filter(id => id !== tabId);
  }

  private touch(tabId: string): void {
    this.order = this.order.filter(id => id !== tabId);
    this.order.push(tabId);
  }

  private evict(): void {
    while (this.order.length > this.maxEntries) {
      const oldest = this.order.shift();
      if (oldest) { this.removeTab(oldest); }
    }
  }
}
