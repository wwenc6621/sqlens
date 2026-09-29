/**
 * Shared types for the connection import parser pipeline.
 *
 * Parsers are pure functions over text (no `vscode` dependency) so they can
 * be unit-tested without the VS Code test harness.
 */

import { ConnectionConfig } from '../../types';

export type ImportFormat =
  | 'sqlens-json'
  | 'json-array'
  | 'connection-uri'
  | 'csv'
  | 'tsv'
  | 'dotenv'
  | 'dbeaver'
  | 'datagrip'
  | 'navicat'
  | 'tableplus'
  | 'spring'
  | 'unknown';

export type ParseIssueSeverity = 'warning' | 'error';

export interface ParseIssue {
  severity: ParseIssueSeverity;
  message: string;
  /** 1-based line in the source text, when known */
  line?: number;
}

export interface ParsedConnection {
  /** Normalized draft — a complete ConnectionConfig except `id` (assigned at save time). */
  draft: ConnectionConfig;
  source: {
    format: ImportFormat;
    /** 1-based line of the entry in the source text */
    line?: number;
    raw?: string;
  };
  issues: ParseIssue[];
}

export interface ParseResult {
  format: ImportFormat;
  connections: ParsedConnection[];
  /** Global error, when the whole text could not be interpreted */
  error?: string;
}

export interface Parser {
  format: ImportFormat;
  /** Confidence 0..1; the sniffer dispatches to the highest scorer. */
  probe(text: string): number;
  parse(text: string): ParsedConnection[];
}
