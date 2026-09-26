/**
 * Driver-aware security validation for MCP tool calls.
 * All AI-originated statements must pass through here before execution.
 *
 * Classification is delegated to a per-driver `StatementClassifier` registry
 * (SQL for MySQL/PG/SQLite/ClickHouse/MSSQL, command tables for Redis, REST
 * paths for Elasticsearch, method names for MongoDB) — see
 * docs/REDIS_SUPPORT_DESIGN.md §11.1.
 */

import {
  getClassifier,
  splitSqlStatements,
  type StatementCategory,
} from './StatementClassifiers';

export type SqlCategory = 'read' | 'write' | 'ddl' | 'other';

/** Split SQL into statements, respecting quotes and comments (lightweight). */
export function splitStatements(sql: string): string[] {
  return splitSqlStatements(sql);
}

/** Strip comments so keyword detection sees actual SQL structure. */
export function stripComments(sql: string): string {
  return splitSqlStatements(sql).join('; ');
}

/** Classify a single SQL statement (SQL-family view, kept for compatibility). */
export function classifyStatement(sql: string): SqlCategory {
  const category: StatementCategory = getClassifier('mysql').classify(sql.trim()).category;
  return category === 'danger' ? 'ddl' : category;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
  statements?: string[];
}

export class SecurityGuard {
  /**
   * Validate a statement before execution.
   * @param readOnly when true, only read statements pass.
   * @param allowWrite when true (write mode), INSERT/UPDATE/DELETE pass but DDL does not.
   * @param driverType driver-aware classification (SQL / redis / es / mongo / ...).
   */
  validate(text: string, opts: { readOnly: boolean; allowWrite: boolean; driverType?: string }): GuardResult {
    const classifier = getClassifier(opts.driverType);
    const statements = classifier.split(text);

    if (statements.length === 0) {
      return { ok: false, reason: 'Empty statement' };
    }
    // The SQL family executes one statement per call; other drivers accept
    // their own multi-statement forms (Redis lines, mongosh calls).
    if (classifier.driverType === 'sql' && statements.length > 1) {
      return { ok: false, reason: 'Multiple statements are not allowed. Execute one statement at a time.' };
    }

    const classified = statements.map(stmt => classifier.classify(stmt));

    // Danger is refused unconditionally.
    const danger = classified.find(c => c.category === 'danger');
    if (danger) {
      return { ok: false, reason: danger.reason ?? 'Blocked statement.' };
    }

    if (opts.readOnly) {
      const offending = classified.find(c => c.category !== 'read');
      if (offending) {
        const label = firstToken(offending.text);
        return { ok: false, reason: `Read-only mode: "${label}" (${offending.category}) is not allowed.` };
      }
      return { ok: true, statements };
    }

    // DDL is never allowed through AI tools, even in write mode.
    const ddl = classified.find(c => c.category === 'ddl');
    if (ddl) {
      return { ok: false, reason: ddl.reason ?? 'DDL statements (CREATE/ALTER/DROP/TRUNCATE...) are not allowed via AI tools. Use the Sqlens UI instead.' };
    }

    const hasWrite = classified.some(c => c.category === 'write');
    if (!hasWrite) {
      return { ok: false, reason: 'Statement is not allowed.' };
    }
    if (!opts.allowWrite) {
      return { ok: false, reason: 'Write statements are not allowed (sqlens.mcp.writeMode = "deny").' };
    }

    // Scope guards: writes must be bounded.
    if (classifier.driverType === 'sql') {
      const unbounded = statements.find(s => /^(update|delete)\b/i.test(s.trim()) && !/\bwhere\b/i.test(s));
      if (unbounded) {
        return { ok: false, reason: 'UPDATE/DELETE without a WHERE clause is not allowed.' };
      }
    }
    if (classifier.driverType === 'clickhouse') {
      const unbounded = statements.find(s => /^ALTER\s+TABLE[\s\S]*\b(UPDATE|DELETE)\b/i.test(s.trim()) && !/\bwhere\b/i.test(s));
      if (unbounded) {
        return { ok: false, reason: 'ClickHouse mutations require a WHERE clause.' };
      }
    }
    if (classifier.driverType === 'mssql') {
      const unbounded = statements.find(s => /^(update|delete)\b/i.test(s.trim()) && !/\bwhere\b/i.test(s));
      if (unbounded) {
        return { ok: false, reason: 'UPDATE/DELETE without a WHERE clause is not allowed.' };
      }
    }

    return { ok: true, statements };
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

function firstToken(text: string): string {
  return text.trim().split(/[\s(]/)[0]?.slice(0, 40) ?? text.slice(0, 40);
}
