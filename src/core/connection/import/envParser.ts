/**
 * Parser for `.env` / dotenv snippets.
 *
 * Two shapes are recognized:
 *  1. URL style:   DATABASE_URL=mysql://user:pass@host:3306/orders
 *  2. Split style: MYSQL_HOST=… / MYSQL_PORT=… / MYSQL_USER=… / MYSQL_PASSWORD=… / MYSQL_DB=…
 *
 * Prefixes (MYSQL, POSTGRES, REDIS, MONGO, DB, ...) decide the database type
 * when the URL itself does not.
 */

import { DatabaseType } from '../../types';
import { normalizeType } from './normalizer';
import { UriParser } from './uriParser';
import { ImportFormat, ParsedConnection, Parser } from './types';
import { normalizeBatch } from './normalizer';

/** Prefix → type, ordered longest-first so POSTGRES beats PG. */
const PREFIX_TYPES: Array<[string, DatabaseType]> = [
  ['MYSQL', DatabaseType.MySQL],
  ['MARIA', DatabaseType.MariaDB],
  ['POSTGRES', DatabaseType.PostgreSQL],
  ['PG', DatabaseType.PostgreSQL],
  ['SQLITE', DatabaseType.SQLite],
  ['REDIS', DatabaseType.Redis],
  ['MONGO', DatabaseType.MongoDB],
  ['MSSQL', DatabaseType.MSSQL],
  ['SQLSERVER', DatabaseType.MSSQL],
  ['CLICKHOUSE', DatabaseType.ClickHouse],
  ['ELASTIC', DatabaseType.Elasticsearch],
  ['ES', DatabaseType.Elasticsearch],
];

const SUFFIX_FIELDS: Array<[string, string]> = [
  ['HOST', 'host'],
  ['PORT', 'port'],
  ['USER', 'username'],
  ['USERNAME', 'username'],
  ['PASSWORD', 'password'],
  ['PASS', 'password'],
  ['DB', 'database'],
  ['DATABASE', 'database'],
  ['NAME', 'database'],
  ['FILE', 'filepath'],
  ['PATH', 'filepath'],
];

interface EnvEntry {
  key: string;
  value: string;
  line: number;
}

export class EnvParser implements Parser {
  get format(): ImportFormat { return 'dotenv'; }

  probe(text: string): number {
    const entries = this.entries(text);
    if (entries.length === 0) { return 0; }
    const interesting = entries.filter(e => this.isConnectionKey(e.key));
    const ratio = interesting.length / entries.length;
    return ratio >= 0.5 ? 0.5 + 0.5 * ratio : ratio * 0.4;
  }

  parse(text: string): ParsedConnection[] {
    const entries = this.entries(text);
    if (entries.length === 0) { return []; }

    const items: Parameters<typeof normalizeBatch>[0] = [];

    // 1) URL-style keys first: DATABASE_URL, MYSQL_URL, *_DSN …
    const urlEntries = entries.filter(e => /(_URL|_DSN|_URI)$/.test(e.key) || e.key === 'DATABASE_URL');
    const consumed = new Set(urlEntries.map(e => e.line));
    for (const entry of urlEntries) {
      const parsed = new UriParser().parse(entry.value);
      if (parsed.length > 0) {
        const first = parsed[0];
        items.push({ partial: first.draft, format: 'dotenv', line: entry.line, raw: entry.value });
      }
    }

    // 2) Group remaining keys by their prefix (MYSQL_HOST / MYSQL_PORT …).
    const groups = new Map<string, EnvEntry[]>();
    for (const entry of entries) {
      if (consumed.has(entry.line)) { continue; }
      const prefix = this.prefixOf(entry.key);
      if (!prefix) { continue; }
      const bucket = groups.get(prefix) || [];
      bucket.push(entry);
      groups.set(prefix, bucket);
    }

    for (const [prefix, bucket] of groups) {
      const partial: Record<string, unknown> = {};
      // A bare prefix without a recognized suffix (e.g. DB=mysql) hints the type.
      const hintType = normalizeType(prefix.toLowerCase());
      for (const entry of bucket) {
        const field = this.fieldOf(entry.key);
        if (field === 'port') {
          const n = Number(entry.value);
          if (Number.isFinite(n)) { partial.port = n; }
        } else if (field) {
          partial[field] = entry.value;
        }
        if (hintType) { partial.type = hintType; }
      }
      if (Object.keys(partial).length > 0) {
        items.push({ partial, format: 'dotenv', line: bucket[0].line });
      }
    }

    return normalizeBatch(items).connections;
  }

  private entries(text: string): EnvEntry[] {
    const out: EnvEntry[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line || line.startsWith('#')) { continue; }
      line = line.replace(/^export\s+/, '');
      const eq = line.indexOf('=');
      if (eq <= 0) { continue; }
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Strip surrounding quotes.
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out.push({ key, value, line: i + 1 });
    }
    return out;
  }

  private isConnectionKey(key: string): boolean {
    return /(_URL|_DSN|_URI)$/.test(key) || this.fieldOf(key) !== undefined;
  }

  /** MYSQL_HOST → MYSQL; DB_HOST → DB; HOST → '' (no group). */
  private prefixOf(key: string): string {
    const upper = key.toUpperCase();
    for (const [prefix] of PREFIX_TYPES) {
      if (upper === prefix) { return prefix; }
      if (upper.startsWith(`${prefix}_`)) { return prefix; }
    }
    // Generic prefixes like DB_ / DATABASE_ still group.
    if (/^(DB|DATABASE)_/.test(upper)) { return upper.split('_')[0]; }
    return '';
  }

  /** MYSQL_HOST → 'host'; unknown suffix → undefined. */
  private fieldOf(key: string): string | undefined {
    const upper = key.toUpperCase();
    const prefix = this.prefixOf(upper);
    const tail = prefix && upper.startsWith(`${prefix}_`) ? upper.slice(prefix.length + 1) : upper;
    for (const [suffix, field] of SUFFIX_FIELDS) {
      if (tail === suffix) { return field; }
    }
    return undefined;
  }
}
