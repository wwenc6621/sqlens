/**
 * SQL security validation for MCP tool calls.
 * All AI-originated SQL must pass through here before execution.
 */

export type SqlCategory = 'read' | 'write' | 'ddl' | 'other';

const READ_KEYWORDS = /^(select|show|describe|desc|explain|with|use)\b/i;
const WRITE_KEYWORDS = /^(insert|update|delete)\b/i;
const DDL_KEYWORDS = /^(create|alter|drop|truncate|rename|grant|revoke|comment|vacuum|analyze|call|set|lock)\b/i;

/** SQL features that are always forbidden for AI calls */
const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\binto\s+(outfile|dumpfile)\b/i, reason: 'INTO OUTFILE/DUMPFILE is not allowed' },
  { pattern: /\bload_file\s*\(/i, reason: 'LOAD_FILE is not allowed' },
  { pattern: /\bload_data\b/i, reason: 'LOAD DATA is not allowed' },
  { pattern: /\bpg_read_file\b|\bpg_ls_dir\b|\bcopy\s+.*\bfrom\s+program\b/i, reason: 'Server file access functions are not allowed' },
  { pattern: /\bsleep\s*\(|\bbenchmark\s*\(/i, reason: 'Sleep/benchmark functions are not allowed' },
  { pattern: /\binformation_schema\.processlist\b/i, reason: 'Process inspection is not allowed' },
];

/** Split SQL into statements, respecting quotes and comments (lightweight). */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inDollarQuote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') { inLineComment = false; }
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') { current += '/'; i++; inBlockComment = false; }
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'" && next === "'") { current += "'"; i++; }
      else if (ch === '\\') { current += next ?? ''; i++; }
      else if (ch === "'") { inSingle = false; }
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"' && next === '"') { current += '"'; i++; }
      else if (ch === '"') { inDouble = false; }
      continue;
    }
    if (inBacktick) {
      current += ch;
      if (ch === '`') { inBacktick = false; }
      continue;
    }
    if (inDollarQuote) {
      current += ch;
      if (sql.startsWith(inDollarQuote, i)) { current += inDollarQuote.slice(1); i += inDollarQuote.length - 1; inDollarQuote = null; }
      continue;
    }

    if (ch === '-' && next === '-') { current += '--'; i++; inLineComment = true; continue; }
    if (ch === '/' && next === '*') { current += '/*'; i++; inBlockComment = true; continue; }
    if (ch === "'") { inSingle = true; current += ch; continue; }
    if (ch === '"') { inDouble = true; current += ch; continue; }
    if (ch === '`') { inBacktick = true; current += ch; continue; }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { inDollarQuote = m[0]; current += m[0]; i += m[0].length - 1; continue; }
    }
    if (ch === ';') {
      if (current.trim()) { statements.push(current.trim()); }
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) { statements.push(current.trim()); }
  return statements;
}

/** Strip comments so keyword detection sees actual SQL structure. */
export function stripComments(sql: string): string {
  return splitStatements(sql).join('; ');
}

/** Classify a single statement. */
export function classifyStatement(sql: string): SqlCategory {
  const clean = sql.trim();
  if (READ_KEYWORDS.test(clean)) {
    // WITH ... INSERT/UPDATE/DELETE (CTE write) counts as write
    if (/^with\b/i.test(clean) && /\b(insert|update|delete)\b/i.test(clean.replace(/^with\b[\s\S]*?\bselect\b[\s\S]*?\)\s*/i, ''))) {
      return 'write';
    }
    return 'read';
  }
  if (WRITE_KEYWORDS.test(clean)) { return 'write'; }
  if (DDL_KEYWORDS.test(clean)) { return 'ddl'; }
  return 'other';
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
  statements?: string[];
}

export class SecurityGuard {
  /**
   * Validate SQL before execution.
   * @param readOnly when true, only read statements pass.
   * @param allowWrite when true (write mode), INSERT/UPDATE/DELETE pass but DDL does not.
   */
  validate(sql: string, opts: { readOnly: boolean; allowWrite: boolean }): GuardResult {
    const statements = splitStatements(sql);

    if (statements.length === 0) {
      return { ok: false, reason: 'Empty SQL statement' };
    }
    if (statements.length > 1) {
      return { ok: false, reason: 'Multiple statements are not allowed. Execute one statement at a time.' };
    }

    const stmt = statements[0];

    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(stmt)) {
        return { ok: false, reason };
      }
    }

    const category = classifyStatement(stmt);

    if (category === 'read') {
      return { ok: true, statements: [stmt] };
    }

    if (opts.readOnly) {
      return { ok: false, reason: `Read-only mode: "${category}" statements are not allowed. Only SELECT/SHOW/DESCRIBE/EXPLAIN are permitted.` };
    }

    if (category === 'write' && opts.allowWrite) {
      // UPDATE/DELETE must have a WHERE clause
      if (/^(update|delete)\b/i.test(stmt) && !/\bwhere\b/i.test(stmt)) {
        return { ok: false, reason: 'UPDATE/DELETE without a WHERE clause is not allowed.' };
      }
      return { ok: true, statements: [stmt] };
    }

    if (category === 'ddl') {
      return { ok: false, reason: 'DDL statements (CREATE/ALTER/DROP/TRUNCATE...) are not allowed via AI tools. Use the Sqlens UI instead.' };
    }

    return { ok: false, reason: `Statement type "${category}" is not allowed.` };
  }

  /** Mask values of columns that look sensitive. */
  maskRows(columns: string[], rows: unknown[][]): { columns: string[]; rows: unknown[][]; maskedCount: number } {
    const sensitive = /pass|pwd|secret|token|salt|api[_-]?key|private[_-]?key|credential/i;
    const maskIdx = new Set<number>();
    columns.forEach((c, i) => { if (sensitive.test(c)) { maskIdx.add(i); } });
    if (maskIdx.size === 0) { return { columns, rows, maskedCount: 0 }; }

    const masked = rows.map(row => row.map((v, i) => (maskIdx.has(i) && v != null && v !== '' ? '***' : v)));
    return { columns, rows: masked, maskedCount: maskIdx.size };
  }

  /** Extract a leading table name for activity display (best effort). */
  extractTable(sql: string): string | undefined {
    const m = /(?:from|into|update|join|table)\s+([`"[]?[\w$]+[`"\]]?(?:\s*\.\s*[`"[]?[\w$]+[`"\]]?)?)/i.exec(stripComments(sql));
    return m ? m[1].replace(/[`"[\]]/g, '') : undefined;
  }
}
