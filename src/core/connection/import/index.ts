/**
 * Unified connection import entry point.
 *
 * `parseConnections(text)` sniffs the format and dispatches to the highest
 * confidence parser. All formats produce `ParsedConnection[]` that go through
 * the shared normalizer, so downstream saving behaves identically for every
 * format.
 */

import { DBeaverParser } from './dbeaverParser';
import { DataGripParser } from './dataGripParser';
import { EnvParser } from './envParser';
import { GridParser, gridFormatOf } from './gridParser';
import { JsonParser } from './jsonParser';
import { NavicatParser } from './navicatParser';
import { TablePlusParser } from './tablePlusParser';
import { SpringConfigParser } from './springConfigParser';
import { UriParser } from './uriParser';
import { ImportFormat, ParseIssue, ParsedConnection, Parser } from './types';

export * from './types';
export { buildConnectionUri, schemeToType, typeToScheme, URI_SCHEMES } from './uriUtils';
export { gridParseOptionsFromText } from './sniffer';

const PARSERS: Parser[] = [
  new JsonParser(),
  new DBeaverParser(),
  new DataGripParser(),
  new NavicatParser(),
  new TablePlusParser(),
  new SpringConfigParser(),
  new EnvParser(),
  new GridParser(),
  new UriParser(),
];

export interface SniffResult {
  format: ImportFormat;
  connections: ParsedConnection[];
  droppedIssues: ParseIssue[];
  error?: string;
}

/**
 * Parse arbitrary text into connection drafts. Returns an empty result with
 * an `error` when nothing recognizable is found.
 */
export function parseConnections(text: string): SniffResult {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { format: 'unknown', connections: [], droppedIssues: [], error: 'Empty input' };
  }

  // Pick the parser with the highest confidence (stable order breaks ties).
  let best: { parser: Parser; score: number } | undefined;
  for (const parser of PARSERS) {
    const score = parser.probe(trimmed);
    if (score > 0 && (!best || score > best.score)) {
      best = { parser, score };
    }
  }
  if (!best) {
    return { format: 'unknown', connections: [], droppedIssues: [], error: 'Unrecognized format — expected sqlens JSON, connection URIs, CSV/TSV or .env content' };
  }

  const connections = best.parser.parse(trimmed);
  // Reflect the concrete shape (e.g. sqlens payload vs bare array, csv vs tsv)
  // as recorded on the entries themselves.
  const format = connections[0]?.source.format ?? best.parser.format;
  if (connections.length === 0) {
    const hint = format === 'csv' || format === 'tsv'
      ? ' — the first row must be a header (e.g. name, host, port, username, password, database, type)'
      : '';
    return { format, connections, droppedIssues: [], error: `No valid connections found in ${format} input${hint}` };
  }
  return { format, connections, droppedIssues: [] };
}

/** Human-readable format label for messages/UI. */
export function formatLabel(format: ImportFormat): string {
  switch (format) {
    case 'sqlens-json': return 'sqlens JSON';
    case 'json-array': return 'JSON array';
    case 'connection-uri': return 'connection URI';
    case 'csv': return 'CSV';
    case 'tsv': return 'TSV';
    case 'dotenv': return '.env';
    case 'dbeaver': return 'DBeaver';
    case 'datagrip': return 'DataGrip';
    case 'navicat': return 'Navicat';
    case 'tableplus': return 'TablePlus';
    case 'spring': return 'Spring config';
    default: return 'unknown';
  }
}

export { gridFormatOf };
