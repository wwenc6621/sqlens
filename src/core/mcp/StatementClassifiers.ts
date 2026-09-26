/**
 * Driver-aware statement classification for MCP security.
 *
 * The editor text is driver-specific (SQL for MySQL/PG/SQLite/ClickHouse/MSSQL,
 * commands for Redis, REST requests for Elasticsearch, mongosh calls for
 * MongoDB), so the SecurityGuard cannot rely on SQL keyword regexes alone.
 * Every driver contributes a classifier here and the guard dispatches by
 * `driverType` (see docs/REDIS_SUPPORT_DESIGN.md §11.1).
 */
import { classifyRedisCommand, splitRedisCommands } from '../redisCommands';

export type StatementCategory = 'read' | 'write' | 'ddl' | 'danger';

export interface ClassifiedStatement {
  text: string;
  category: StatementCategory;
  /** Why it was classified this way (shown to the AI / in confirm dialogs). */
  reason?: string;
}

export interface StatementClassifier {
  readonly driverType: string;
  /** Split a multi-statement text into individual statements. */
  split(text: string): string[];
  /** Classify one statement. */
  classify(stmt: string): ClassifiedStatement;
}

// ── SQL family ───────────────────────────────────────────────────────────────

const SQL_READ = /^(select|show|describe|desc|explain|with|use|exists|check|values|table)\b/i;
const SQL_WRITE = /^(insert|update|delete|merge|replace|upsert|load)\b/i;
const SQL_DDL = /^(create|alter|drop|truncate|rename|grant|revoke|comment|vacuum|analyze|call|lock|set|optimize|attach|detach|kill|backup|restore)\b/i;

/** Statements that are always refused, regardless of mode. */
const SQL_DANGER: { pattern: RegExp; reason: string }[] = [
  { pattern: /\binto\s+(outfile|dumpfile)\b/i, reason: 'INTO OUTFILE/DUMPFILE is not allowed' },
  { pattern: /\bload_file\s*\(/i, reason: 'LOAD_FILE is not allowed' },
  { pattern: /\bload_data\b/i, reason: 'LOAD DATA is not allowed' },
  { pattern: /\bpg_read_file\b|\bpg_ls_dir\b|\bcopy\s+.*\bfrom\s+program\b/i, reason: 'Server file access functions are not allowed' },
  { pattern: /\bsleep\s*\(|\bbenchmark\s*\(/i, reason: 'Sleep/benchmark functions are not allowed' },
];

/** MySQL / MariaDB / PostgreSQL / SQLite shared SQL classifier. */
export const sqlClassifier: StatementClassifier = {
  driverType: 'sql',
  split: splitSqlStatements,
  classify(stmt) {
    const clean = stmt.trim();
    for (const { pattern, reason } of SQL_DANGER) {
      if (pattern.test(clean)) { return { text: stmt, category: 'danger', reason }; }
    }
    if (SQL_READ.test(clean)) {
      // WITH ... INSERT/UPDATE/DELETE (CTE write) counts as write.
      if (/^with\b/i.test(clean) && /\b(insert|update|delete)\b/i.test(
        clean.replace(/^with\b[\s\S]*?\bselect\b[\s\S]*?\)\s*/i, ''))) {
        return { text: stmt, category: 'write' };
      }
      return { text: stmt, category: 'read' };
    }
    if (SQL_WRITE.test(clean)) { return { text: stmt, category: 'write' }; }
    if (SQL_DDL.test(clean)) { return { text: stmt, category: 'ddl' }; }
    return { text: stmt, category: 'ddl', reason: 'Unrecognised statement — treated as DDL and refused.' };
  },
};

// ── ClickHouse ───────────────────────────────────────────────────────────────

/**
 * ClickHouse is SQL, but: `ALTER TABLE ... UPDATE/DELETE` are write mutations,
 * and DROP TABLE/DATABASE, TRUNCATE and ATTACH (overwrite) are refused.
 */
export const clickHouseClassifier: StatementClassifier = {
  driverType: 'clickhouse',
  split: splitSqlStatements,
  classify(stmt) {
    const clean = stmt.trim();
    const upper = clean.toUpperCase();

    if (/^DROP\s+(DATABASE|TABLE|DICTIONARY)\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'DROP DATABASE/TABLE is refused for AI calls.' };
    }
    if (/^TRUNCATE\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'TRUNCATE is refused for AI calls.' };
    }
    if (/^ATTACH\b/i.test(clean) || /^DETACH\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'ATTACH/DETACH is refused for AI calls.' };
    }
    // ALTER TABLE ... DELETE WHERE 1 (whole-table delete)
    if (/^ALTER\s+TABLE[\s\S]*\bDELETE\s+WHERE\s+(1|true)\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'ALTER ... DELETE WHERE 1 removes the whole table.' };
    }
    if (/^ALTER\s+TABLE[\s\S]*\b(UPDATE|DELETE)\b/i.test(clean)) {
      return { text: stmt, category: 'write', reason: 'ClickHouse mutation (asynchronous, cannot be rolled back).' };
    }
    if (/^(SYSTEM|OPTIMIZE|KILL)\b/i.test(clean)) {
      return { text: stmt, category: 'ddl', reason: 'Administrative ClickHouse commands are refused for AI calls.' };
    }
    void upper;
    return sqlClassifier.classify(stmt);
  },
};

// ── Microsoft SQL Server ─────────────────────────────────────────────────────

/** T-SQL: TRUNCATE is destructive (no WHERE), plus server-admin commands. */
export const mssqlClassifier: StatementClassifier = {
  driverType: 'mssql',
  split: splitSqlStatements,
  classify(stmt) {
    const clean = stmt.trim();

    if (/\bxp_cmdshell\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'xp_cmdshell is refused.' };
    }
    if (/^SHUTDOWN\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'SHUTDOWN is refused.' };
    }
    if (/\bsp_configure\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'sp_configure is refused.' };
    }
    if (/^TRUNCATE\s+TABLE\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'TRUNCATE TABLE (no WHERE) is refused for AI calls.' };
    }
    if (/^BULK\s+INSERT\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'BULK INSERT is refused.' };
    }
    if (/^DROP\s+(DATABASE|TABLE)\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'DROP DATABASE/TABLE is refused for AI calls.' };
    }
    if (/^(BACKUP|RESTORE)\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'BACKUP/RESTORE is refused.' };
    }
    if (/^KILL\b/i.test(clean)) {
      return { text: stmt, category: 'danger', reason: 'KILL is refused.' };
    }
    // SET STATISTICS ... is a read-side profiling prefix.
    if (/^SET\s+STATISTICS\b/i.test(clean)) {
      return { text: stmt, category: 'read' };
    }
    return sqlClassifier.classify(stmt);
  },
};

// ── Redis ────────────────────────────────────────────────────────────────────

export const redisClassifier: StatementClassifier = {
  driverType: 'redis',
  split: splitRedisCommands,
  classify(stmt) {
    const category = classifyRedisCommand(stmt);
    const command = stmt.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    if (category === 'danger') {
      return { text: stmt, category: 'danger', reason: `Command "${command}" is blocked (destructive / administrative).` };
    }
    return { text: stmt, category: category === 'write' ? 'write' : 'read' };
  },
};

// ── Elasticsearch ────────────────────────────────────────────────────────────

// Matches anywhere after the index name (e.g. `POST /idx/_search`).
const ES_READ_PATHS = /\/(_search|_count|_msearch|_mget|_explain|_field_caps|_cat\/|_analyze|_validate)(\/|\?|$)/;
const ES_DANGER_PATHS = /\/(_delete_by_query|_close|_flush|_cache\/clear|_cluster\/|_reindex|_forcemerge|_shrink|_snapshot\/)/;

/**
 * Elasticsearch request text: `METHOD /path` (+ optional JSON body).
 * Unknown METHOD/path combinations are treated as write (conservative).
 */
export const elasticsearchClassifier: StatementClassifier = {
  driverType: 'elasticsearch',
  split: splitEsRequests,
  classify(stmt) {
    const { method, path } = parseEsRequest(stmt);

    if (ES_DANGER_PATHS.test(path)) {
      return { text: stmt, category: 'danger', reason: `Endpoint "${path}" is refused for AI calls.` };
    }
    if (method === 'DELETE') {
      // Deleting an index is destructive; deleting a document is a write.
      if (/_doc\//.test(path)) { return { text: stmt, category: 'write' }; }
      return { text: stmt, category: 'danger', reason: `DELETE ${path} is refused for AI calls.` };
    }
    if (method === 'GET' || method === 'HEAD') {
      return { text: stmt, category: 'read' };
    }
    if (method === 'POST' && ES_READ_PATHS.test(path)) {
      return { text: stmt, category: 'read' };
    }
    if ((method === 'POST' || method === 'PUT') && /(_doc|_update|_bulk|_index|_create)\b/.test(path)) {
      return { text: stmt, category: 'write' };
    }
    if (method === 'PUT') {
      // Index creation / settings update.
      return { text: stmt, category: 'write', reason: 'Index creation/update.' };
    }
    return { text: stmt, category: 'write', reason: 'Unrecognised request — treated as write.' };
  },
};

// ── MongoDB ──────────────────────────────────────────────────────────────────

const MONGO_READ_METHODS = new Set(['find', 'findone', 'countdocuments', 'estimateddocumentcount', 'distinct', 'aggregate', 'explain']);
const MONGO_DANGER_METHODS = new Set(['dropdatabase', 'drop', 'eval', 'shutdownserver', 'mapreduce']);

/**
 * mongosh-style call text: `db.<collection>.<method>(...)`.
 * `aggregate` pipelines containing $out/$merge write; delete/update with an
 * empty filter is treated as danger (whole-collection operation).
 */
export const mongodbClassifier: StatementClassifier = {
  driverType: 'mongodb',
  split: splitMongoStatements,
  classify(stmt) {
    const clean = stmt.trim();
    const match = clean.match(/^db\s*\.\s*([A-Za-z0-9_$-]+)\s*\.\s*([A-Za-z0-9_$]+)\s*\(([\s\S]*)\)\s*$/);
    if (!match) {
      if (/^use\s+\S+$/i.test(clean)) {
        return { text: stmt, category: 'read', reason: 'Database context switch.' };
      }
      return { text: stmt, category: 'write', reason: 'Unrecognised command — treated as write.' };
    }

    const method = match[2].toLowerCase();
    const args = match[3];

    if (MONGO_DANGER_METHODS.has(method)) {
      return { text: stmt, category: 'danger', reason: `Method "${match[2]}" is refused for AI calls.` };
    }
    if (method === 'aggregate' && /\$(out|merge)\b/.test(args)) {
      return { text: stmt, category: 'write', reason: 'Aggregation pipeline writes via $out/$merge.' };
    }
    if ((method === 'deletemany' || method === 'updatemany') && /^\s*\{\s*\}\s*(,|\)|$)/.test(args)) {
      return { text: stmt, category: 'danger', reason: `"${match[2]}" with an empty filter affects the whole collection.` };
    }
    if (MONGO_READ_METHODS.has(method)) {
      return { text: stmt, category: 'read' };
    }
    return { text: stmt, category: 'write' };
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, StatementClassifier>();

function register(classifier: StatementClassifier, ...types: string[]): void {
  for (const type of types) {
    REGISTRY.set(type, classifier);
  }
}

register(sqlClassifier, 'mysql', 'mariadb', 'postgresql', 'sqlite');
register(clickHouseClassifier, 'clickhouse');
register(mssqlClassifier, 'mssql');
register(redisClassifier, 'redis');
register(elasticsearchClassifier, 'elasticsearch');
register(mongodbClassifier, 'mongodb');

/** Look up the classifier for a driver type (falls back to plain SQL). */
export function getClassifier(driverType?: string): StatementClassifier {
  if (driverType && REGISTRY.has(driverType)) {
    return REGISTRY.get(driverType)!;
  }
  return sqlClassifier;
}

export function isSqlFamily(driverType?: string): boolean {
  const classifier = getClassifier(driverType);
  return classifier.driverType === 'sql';
}

// ── Shared splitters ─────────────────────────────────────────────────────────

/** SQL splitter — quotes/comments aware (same rules as the MCP guard). */
export function splitSqlStatements(sql: string): string[] {
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
    if (ch === ';') {
      if (current.trim()) { statements.push(current.trim()); }
      current = '';
      continue;
    }
    if (ch === "'") { inSingle = true; current += ch; continue; }
    if (ch === '"') { inDouble = true; current += ch; continue; }
    if (ch === '`') { inBacktick = true; current += ch; continue; }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { inDollarQuote = m[0]; current += m[0]; i += m[0].length - 1; continue; }
    }
    current += ch;
  }
  if (current.trim()) { statements.push(current.trim()); }
  return statements;
}

/** Split ES request texts at `METHOD /path` line boundaries. */
function splitEsRequests(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*(GET|POST|PUT|DELETE|HEAD)\s+\//i.test(line) && current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) { blocks.push(current.join('\n')); }
  return blocks.map(b => b.trim()).filter(Boolean);
}

function parseEsRequest(text: string): { method: string; path: string } {
  const match = text.match(/^\s*(GET|POST|PUT|DELETE|HEAD)\s+(\/\S*)/i);
  if (!match) {
    // Bare JSON body → POST /_search.
    return { method: 'POST', path: '/_search' };
  }
  return { method: match[1].toUpperCase(), path: match[2] };
}

/** Split mongosh calls at line boundaries starting with `db.` / `use `. */
function splitMongoStatements(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let depth = 0;
  for (const line of text.split('\n')) {
    const starts = depth === 0 && /^\s*(db\s*\.|use\s)/.test(line) && current.length > 0;
    if (starts) {
      blocks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
    for (const ch of line) {
      if (ch === '{' || ch === '[') { depth++; }
      if (ch === '}' || ch === ']') { depth = Math.max(0, depth - 1); }
    }
  }
  if (current.length > 0) { blocks.push(current.join('\n')); }
  return blocks.map(b => b.trim()).filter(Boolean);
}
