/**
 * Parser for sqlens JSON payloads and bare `ConnectionConfig[]` arrays.
 *
 * This is the original `extractConnections` logic from ConnectionTransfer,
 * extracted so all formats share one pipeline. Behavior is unchanged.
 */

import { ConnectionConfig, DatabaseType } from '../../types';
import { normalizeBatch } from './normalizer';
import { ImportFormat, ParsedConnection, Parser } from './types';

export class JsonParser implements Parser {
  get format(): ImportFormat { return 'sqlens-json'; }

  probe(text: string): number {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) { return 0; }
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return this.looksLikeConnectionArray(parsed) ? 0.9 : 0;
      }
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray((parsed as { connections?: unknown }).connections)) { return 1; }
        if (typeof (parsed as { dataSources?: unknown }).dataSources !== 'undefined') { return 0; } // DBeaver
        return 0;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  parse(text: string): ParsedConnection[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      return [];
    }
    const entries = this.extractEntries(parsed);
    const { connections } = normalizeBatch(
      entries.map((entry, i) => ({
        partial: { ...entry, type: entry.type },
        format: Array.isArray(parsed) ? ('json-array' as ImportFormat) : ('sqlens-json' as ImportFormat),
        raw: JSON.stringify(entry),
        line: Array.isArray(parsed) ? i + 1 : undefined,
      })),
    );
    return connections;
  }

  private extractEntries(parsed: unknown): ConnectionConfig[] {
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

  private looksLikeConnectionArray(arr: unknown[]): boolean {
    return arr.some(entry =>
      !!entry && typeof entry === 'object'
      && typeof (entry as { type?: unknown }).type === 'string'
      && Object.values(DatabaseType).includes((entry as { type: string }).type as DatabaseType),
    );
  }
}
