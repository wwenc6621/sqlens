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

/**
 * Fixed tab id shared by every MCP/AI-triggered result. A busy assistant that
 * runs many queries refreshes this one tab instead of piling up new ones.
 */
export const AI_LIVE_TAB_ID = 'ai-result-live';

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
 * Two distinct behaviours:
 * - `present()` — the MCP path. Every AI query refreshes the single shared
 *   {@link AI_LIVE_TAB_ID} tab, so an assistant running many statements never
 *   opens more than one result tab.
 * - `recordForActivity()` — the user path. Opening a record from the AI
 *   Activity panel builds a per-activity tab, so the user opens exactly as many
 *   tabs as they choose.
 *
 * Payloads are retained (LRU-bounded) so a closed result tab can still be
 * reopened from the activity list, and so `getByTab` can serve a rebuilt tab.
 */
export class AiResultBridge {
  /** activityId -> payload (lets the activity list reopen an old result). */
  private byActivity = new Map<string, AiResultPayload>();
  /** tabId -> payload for addressable tabs (the live tab + opened activity tabs). */
  private byTab = new Map<string, AiResultPayload>();
  /** tab ids, least-recently-touched first. */
  private tabOrder: string[] = [];
  /** activity ids, least-recently-touched first. */
  private activityOrder: string[] = [];

  constructor(
    private readonly openTab: (record: AiResultRecord) => void,
    private readonly maxEntries = 200,
  ) {}

  /**
   * MCP path: capture a result and refresh the single shared AI tab.
   * Returns the tab id (always {@link AI_LIVE_TAB_ID}).
   */
  present(payload: AiResultPayload): string {
    this.rememberActivity(payload.activityId, payload);
    this.rememberTab(AI_LIVE_TAB_ID, payload);
    this.openTab({ tabId: AI_LIVE_TAB_ID, payload });
    return AI_LIVE_TAB_ID;
  }

  /**
   * User path: build a record for an AI activity opened from the Activity
   * panel. Each activity gets its own tab id, so opening several records opens
   * several tabs. Returns undefined for an unknown activity.
   */
  recordForActivity(activityId: string): AiResultRecord | undefined {
    const payload = this.byActivity.get(activityId);
    if (!payload) { return undefined; }
    const tabId = `ai-result-${hash(activityId)}`;
    this.rememberTab(tabId, payload);
    return { tabId, payload };
  }

  /** Resolve the record behind a tab id (used to rebuild / save a tab). */
  getByTab(tabId: string): AiResultRecord | undefined {
    const payload = this.byTab.get(tabId);
    return payload ? { tabId, payload } : undefined;
  }

  /** Drop a tab's record. The activity link is kept so it can be reopened. */
  removeTab(tabId: string): void {
    if (!this.byTab.delete(tabId)) { return; }
    this.tabOrder = this.tabOrder.filter(id => id !== tabId);
  }

  /** Remember an activity payload, evicting the oldest beyond the bound. */
  private rememberActivity(activityId: string, payload: AiResultPayload): void {
    this.byActivity.set(activityId, payload);
    this.activityOrder = this.activityOrder.filter(id => id !== activityId);
    this.activityOrder.push(activityId);
    while (this.activityOrder.length > this.maxEntries) {
      const oldest = this.activityOrder.shift();
      if (oldest) { this.byActivity.delete(oldest); }
    }
  }

  /** Remember a tab payload, evicting the oldest beyond the bound. */
  private rememberTab(tabId: string, payload: AiResultPayload): void {
    this.byTab.set(tabId, payload);
    this.tabOrder = this.tabOrder.filter(id => id !== tabId);
    this.tabOrder.push(tabId);
    while (this.tabOrder.length > this.maxEntries) {
      const oldest = this.tabOrder.shift();
      if (oldest) { this.byTab.delete(oldest); }
    }
  }
}
