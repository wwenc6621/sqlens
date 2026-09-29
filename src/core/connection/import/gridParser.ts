/**
 * Grid parser — CSV/TSV where each row is a connection and the header row
 * maps columns to fields. Designed for pasting a block of rows straight out
 * of Excel / 飞书表格 or copying from the DataGrid.
 *
 * Header aliases are case-insensitive and cover common Chinese/English names.
 */

import { ConnectionConfig } from '../../types';
import { mapSslMode, normalizeBatch } from './normalizer';
import { ImportFormat, ParsedConnection, Parser } from './types';

type FieldSetter = (partial: Record<string, unknown>, value: string) => void;

const HEADER_ALIASES: Array<{ keys: string[]; set: FieldSetter }> = [
  {
    keys: ['name', '名称', '连接名', '连接名称'],
    set: (p, v) => { p.name = v; },
  },
  {
    keys: ['type', '类型', 'db', '数据库类型'],
    set: (p, v) => { p.type = v; },
  },
  {
    keys: ['host', '主机', '地址', '服务器', 'server', 'ip'],
    set: (p, v) => { p.host = v; },
  },
  {
    keys: ['port', '端口'],
    set: (p, v) => { const n = Number(v); if (v && Number.isFinite(n)) { p.port = n; } },
  },
  {
    keys: ['user', 'username', '用户名', '用户', '账号'],
    set: (p, v) => { p.username = v; },
  },
  {
    keys: ['password', '密码', 'pwd'],
    set: (p, v) => { p.password = v || undefined; },
  },
  {
    keys: ['database', 'db', '数据库', '库名'],
    set: (p, v) => { p.database = v || undefined; },
  },
  {
    keys: ['filepath', 'path', '文件', '文件路径', 'file'],
    set: (p, v) => { p.filepath = v || undefined; },
  },
  {
    keys: ['group', '分组', '组'],
    set: (p, v) => { p.group = v || undefined; },
  },
  {
    keys: ['tags', '标签'],
    set: (p, v) => { p.tags = v ? v.split(/[;|,，、]/).map(t => t.trim()).filter(Boolean) : []; },
  },
  {
    keys: ['ssl', 'sslmode', 'ssl模式'],
    set: (p, v) => {
      const mode = mapSslMode(v);
      if (mode) { p.ssl = { ...(p.ssl as object || {}), mode }; }
    },
  },
  {
    keys: ['ssh_host', 'ssh主机', '跳板机', '跳板主机'],
    set: (p, v) => { p.ssh = { ...(p.ssh as object || {}), enabled: true, host: v }; },
  },
  {
    keys: ['ssh_user', 'ssh用户'],
    set: (p, v) => { p.ssh = { ...(p.ssh as object || {}), username: v }; },
  },
  {
    keys: ['ssh_port'],
    set: (p, v) => { const n = Number(v); if (Number.isFinite(n)) { p.ssh = { ...(p.ssh as object || {}), port: n }; } },
  },
  {
    keys: ['ssh_password', 'ssh密码', 'ssh_pass'],
    set: (p, v) => { p.ssh = { ...(p.ssh as object || {}), password: v || undefined }; },
  },
  {
    keys: ['ssh_key', 'ssh私钥'],
    set: (p, v) => { p.ssh = { ...(p.ssh as object || {}), privateKeyPath: v || undefined, authMethod: 'privateKey' }; },
  },
  {
    keys: ['color', '颜色'],
    set: (p, v) => { p.color = v || undefined; },
  },
  {
    keys: ['comment', '备注', '说明'],
    set: (p, v) => { p.options = { ...(p.options as object || {}), comment: v }; },
  },
];

const HEADER_LOOKUP: Map<string, FieldSetter> = (() => {
  const map = new Map<string, FieldSetter>();
  for (const alias of HEADER_ALIASES) {
    for (const key of alias.keys) {
      map.set(key.toLowerCase(), alias.set);
    }
  }
  return map;
})();

export interface GridParseOptions {
  /** Column headers as already-split cells */
  headers: string[];
  /** Delimiter used between cells */
  delimiter: '\t' | ',' | ';';
  /** Whether the first row of the source text is a header (default: true) */
  hasHeader?: boolean;
}

export class GridParser implements Parser {
  get format(): ImportFormat { return 'csv'; }

  probe(text: string): number {
    const firstLine = text.split(/\r?\n/, 1)[0];
    if (!firstLine) { return 0; }

    // TSV: any tab in the first line.
    if (firstLine.includes('\t')) {
      return this.headerScore(firstLine.split('\t')) > 0 ? 0.8 : 0.35;
    }
    // CSV: multiple lines of comma-separated cells whose header scores.
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length >= 2 && firstLine.includes(',')) {
      const score = this.headerScore(this.splitCsvLine(firstLine));
      return score > 0 ? 0.8 : 0;
    }
    return 0;
  }

  parse(text: string): ParsedConnection[] {
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const isTsv = firstLine.includes('\t');
    const delimiter: '\t' | ',' = isTsv ? '\t' : ',';
    const rows = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (rows.length === 0) { return []; }

    const split = (line: string) => isTsv ? line.split('\t') : this.splitCsvLine(line);
    const headers = split(rows[0]).map(h => h.trim());
    const matched = headers.filter(h => HEADER_LOOKUP.has(h.toLowerCase())).length;
    if (matched === 0) {
      // Without a recognizable header we must not guess column order silently.
      return [];
    }

    const items: Parameters<typeof normalizeBatch>[0] = [];
    for (let i = 1; i < rows.length; i++) {
      const cells = split(rows[i]);
      const partial: Record<string, unknown> = {};
      headers.forEach((header, col) => {
        const setter = HEADER_LOOKUP.get(header.toLowerCase());
        const value = (cells[col] ?? '').trim();
        if (setter && value) { setter(partial, value); }
      });
      items.push({ partial, format: isTsv ? 'tsv' : 'csv', line: i + 1, raw: rows[i] });
    }
    return normalizeBatch(items).connections;
  }

  private headerScore(cells: string[]): number {
    return cells.filter(c => HEADER_LOOKUP.has(c.trim().toLowerCase())).length;
  }

  /** RFC-4180-ish CSV line splitter handling quotes and embedded delimiters. */
  private splitCsvLine(line: string): string[] {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = false; }
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cells.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells;
  }
}

/** Helper reused by tests and the sniffer to decide csv vs tsv labels. */
export function gridFormatOf(text: string): 'csv' | 'tsv' {
  return (text.split(/\r?\n/, 1)[0] || '').includes('\t') ? 'tsv' : 'csv';
}

/** Build a partial config from explicit headers + cells (used when no header row exists). */
export function buildPartialFromCells(headers: string[], cells: string[]): Partial<ConnectionConfig> {
  const partial: Record<string, unknown> = {};
  headers.forEach((header, col) => {
    const setter = HEADER_LOOKUP.get(header.toLowerCase());
    const value = (cells[col] ?? '').trim();
    if (setter && value) { setter(partial, value); }
  });
  return partial as Partial<ConnectionConfig>;
}
