/**
 * Offline unit tests (node:test) for the pure, driver-independent logic:
 * statement classification, request parsing, type normalization, and i18n
 * coverage. Run with `npm run test:unit` (esbuild bundles, then node --test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getClassifier, isSqlFamily } from '../src/core/mcp/StatementClassifiers';
import { normalizeClickHouseType } from '../src/core/drivers/ClickHouseDriver';
import { normalizeEsType, parseRequestText } from '../src/core/drivers/ElasticsearchDriver';
import { normalizeSqlType } from '../src/core/drivers/MSSQLDriver';
import { parseMongoCall } from '../src/core/drivers/MongoDBDriver';
import { SecurityGuard } from '../src/core/mcp/SecurityGuard';
import { matchTableFilter } from '../webview-ui/src/panels/Schema/schemaTableFilter';
import { NormalizedColumnType } from '../src/core/types';

const ROOT = path.resolve(__dirname, '..');

// ── Statement classification ────────────────────────────────────────────────

const classify = (driver: string, text: string) => getClassifier(driver).classify(text).category;

test('sql family: reads, writes, ddl and forbidden patterns', () => {
  assert.equal(isSqlFamily('mysql'), true);
  assert.equal(classify('mysql', 'SELECT 1'), 'read');
  assert.equal(classify('mysql', 'WITH x AS (SELECT 1) SELECT * FROM x'), 'read');
  assert.equal(classify('mysql', 'UPDATE t SET a = 1 WHERE id = 2'), 'write');
  assert.equal(classify('mysql', 'UPDATE t SET a = 1'), 'write');
  assert.equal(classify('mysql', 'CREATE TABLE t (id INT)'), 'ddl');
  assert.equal(classify('mysql', "SELECT * FROM t INTO OUTFILE '/tmp/x'"), 'danger');
  assert.equal(classify('postgresql', 'SELECT pg_read_file(\'/etc/passwd\')'), 'danger');
});

test('clickhouse: mutations are writes, destructive statements are danger', () => {
  assert.equal(classify('clickhouse', 'SELECT * FROM events'), 'read');
  assert.equal(classify('clickhouse', 'SYSTEM RELOAD CONFIG'), 'ddl');
  const mutation = getClassifier('clickhouse').classify('ALTER TABLE events UPDATE n = 1 WHERE id = 2');
  assert.equal(mutation.category, 'write');
  assert.match(mutation.reason ?? '', /mutation/i);
  assert.equal(classify('clickhouse', 'ALTER TABLE events DELETE WHERE 1'), 'danger');
  assert.equal(classify('clickhouse', 'DROP TABLE events'), 'danger');
  assert.equal(classify('clickhouse', 'TRUNCATE TABLE events'), 'danger');
});

test('mssql: TRUNCATE and admin commands are danger', () => {
  assert.equal(classify('mssql', 'SELECT * FROM dbo.t'), 'read');
  assert.equal(classify('mssql', 'SET STATISTICS PROFILE ON'), 'read');
  assert.equal(classify('mssql', 'TRUNCATE TABLE dbo.t'), 'danger');
  assert.equal(classify('mssql', 'EXEC xp_cmdshell "whoami"'), 'danger');
  assert.equal(classify('mssql', 'DROP DATABASE x'), 'danger');
  assert.equal(classify('mssql', 'BULK INSERT t FROM \'f\''), 'danger');
  assert.equal(classify('mssql', 'MERGE INTO t USING s ON 1=1'), 'write');
});

test('redis: read/write/danger command tables', () => {
  assert.equal(classify('redis', 'GET foo'), 'read');
  assert.equal(classify('redis', 'HGETALL h'), 'read');
  assert.equal(classify('redis', 'SET foo bar'), 'write');
  assert.equal(classify('redis', 'UNLINK foo'), 'write');
  assert.equal(classify('redis', 'FLUSHALL'), 'danger');
  assert.equal(classify('redis', 'KEYS *'), 'danger');
  assert.equal(getClassifier('redis').split('GET a\nSET b 1').length, 2);
});

test('elasticsearch: HTTP method + path rules', () => {
  assert.equal(classify('elasticsearch', 'GET /idx/_search'), 'read');
  assert.equal(classify('elasticsearch', 'POST /idx/_search\n{"query":{"match_all":{}}}'), 'read');
  assert.equal(classify('elasticsearch', 'GET /_cat/indices'), 'read');
  assert.equal(classify('elasticsearch', 'POST /idx/_doc\n{"a":1}'), 'write');
  assert.equal(classify('elasticsearch', 'DELETE /idx/_doc/1'), 'write');
  assert.equal(classify('elasticsearch', 'DELETE /idx'), 'danger');
  assert.equal(classify('elasticsearch', 'POST /idx/_delete_by_query\n{"query":{"match_all":{}}}'), 'danger');
  assert.equal(classify('elasticsearch', 'POST /idx/_close'), 'danger');
});

test('mongodb: method tables, $out/$merge and empty filters', () => {
  assert.equal(classify('mongodb', 'db.orders.find({ status: "PAID" })'), 'read');
  assert.equal(classify('mongodb', 'db.orders.countDocuments({})'), 'read');
  assert.equal(classify('mongodb', 'db.orders.aggregate([{ $group: { _id: "$s" } }])'), 'read');
  assert.equal(classify('mongodb', 'db.orders.insertOne({ a: 1 })'), 'write');
  assert.equal(classify('mongodb', 'db.orders.aggregate([{ $out: "copy" }])'), 'write');
  assert.equal(classify('mongodb', 'db.orders.deleteMany({})'), 'danger');
  assert.equal(classify('mongodb', 'db.orders.drop()'), 'danger');
  assert.equal(classify('mongodb', 'use analytics'), 'read');
});

// ── Type normalization ─────────────────────────────────────────────────────

test('clickhouse type normalization', () => {
  const cases: Array<[string, NormalizedColumnType]> = [
    ['UInt64', NormalizedColumnType.Integer],
    ['Nullable(Int32)', NormalizedColumnType.Integer],
    ['LowCardinality(String)', NormalizedColumnType.String],
    ['Array(Map(String, UInt64))', NormalizedColumnType.Array],
    ['Map(String, UInt64)', NormalizedColumnType.JSON],
    ['DateTime64(3)', NormalizedColumnType.DateTime],
    ['Decimal(10, 2)', NormalizedColumnType.Decimal],
    ['Enum8(\'a\' = 1)', NormalizedColumnType.Enum],
    ['UUID', NormalizedColumnType.UUID],
    ['IPv4', NormalizedColumnType.String],
    ['Bool', NormalizedColumnType.Boolean],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(normalizeClickHouseType(raw), expected, `type ${raw}`);
  }
});

test('elasticsearch and T-SQL type normalization', () => {
  assert.equal(normalizeEsType('keyword'), NormalizedColumnType.String);
  assert.equal(normalizeEsType('date'), NormalizedColumnType.DateTime);
  assert.equal(normalizeEsType('boolean'), NormalizedColumnType.Boolean);
  assert.equal(normalizeEsType('nested'), NormalizedColumnType.JSON);
  assert.equal(normalizeEsType(undefined), NormalizedColumnType.Unknown);

  assert.equal(normalizeSqlType('int'), NormalizedColumnType.Integer);
  assert.equal(normalizeSqlType('nvarchar'), NormalizedColumnType.String);
  assert.equal(normalizeSqlType('datetime2'), NormalizedColumnType.DateTime);
  assert.equal(normalizeSqlType('uniqueidentifier'), NormalizedColumnType.UUID);
  assert.equal(normalizeSqlType('varbinary'), NormalizedColumnType.Binary);
  assert.equal(normalizeSqlType('decimal'), NormalizedColumnType.Decimal);
});

// ── Editor text parsing ────────────────────────────────────────────────────

test('elasticsearch request parsing', () => {
  const get = parseRequestText('GET /idx/_search\n{"query":{"match_all":{}}}');
  assert.equal(get.method, 'GET');
  assert.equal(get.path, 'idx/_search');
  assert.deepEqual(get.body, { query: { match_all: {} } });

  // A bare JSON body defaults to POST /_search.
  const bare = parseRequestText('{ "query": { "match_all": {} } }');
  assert.equal(bare.method, 'POST');
  assert.equal(bare.path, '_search');

  // NDJSON bodies (bulk) must survive as raw strings.
  const bulk = parseRequestText('POST /idx/_bulk\n{"index":{}}\n{"a":1}');
  assert.equal(typeof bulk.body, 'string');
  assert.match(String(bulk.body), /\{"index":\{\}\}/);
});

test('mongosh call parsing: literals, chains and rejects', () => {
  const find = parseMongoCall('db.orders.find({ status: \'PAID\' }).sort({ createdAt: -1 }).limit(100)');
  assert.equal(find.kind, 'call');
  assert.equal(find.collection, 'orders');
  assert.equal(find.method, 'find');
  assert.deepEqual(find.args[0], { status: 'PAID' });
  assert.equal(find.chain.limit, 100);

  const use = parseMongoCall('use analytics');
  assert.equal(use.kind, 'use');
  assert.equal(use.database, 'analytics');

  // Bare keys / trailing commas / ISODate() literals are accepted.
  const loose = parseMongoCall("db.t.insertMany([\n  { a: 1, when: ISODate('2026-09-26T00:00:00Z') },\n])");
  assert.equal(loose.method, 'insertMany');

  assert.throws(() => parseMongoCall('db.orders.drop()'), /Unsupported method/);
  assert.throws(() => parseMongoCall('orders.find()'), /Cannot parse command/);
  assert.throws(
    () => parseMongoCall('db.orders.find({}).forEach(f)'),
    /Unsupported chained helper/,
  );
});

// ── i18n coverage (regression guard) ───────────────────────────────────────

test('every t() key used in the webview has a Chinese translation', () => {
  const i18nFile = path.join(ROOT, 'webview-ui/src/i18n/index.ts');
  const i18nSource = fs.readFileSync(i18nFile, 'utf8');
  const translated = new Set<string>();
  for (const m of i18nSource.matchAll(/^\s*(['"])(.+?)\1\s*:/gm)) {
    translated.add(m[2]);
  }

  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) { continue; }
      if (full.endsWith(path.join('i18n', 'index.ts'))) { continue; }
      const source = fs.readFileSync(full, 'utf8');
      for (const m of source.matchAll(/\bt\(\s*(['"])(.+?)\1/g)) {
        used.add(m[2]);
      }
    }
  };
  walk(path.join(ROOT, 'webview-ui/src'));

  const missing = [...used].filter(key => !translated.has(key)).sort();
  assert.deepEqual(
    missing,
    [],
    `Missing Chinese translations for:\n  ${missing.join('\n  ')}`,
  );
});

// ── Schema filter ───────────────────────────────────────────────────────────

test('schema filter: substring, wildcard and qualified matching', () => {
  // Empty pattern shows everything.
  assert.equal(matchTableFilter('users', 'public', ''), true);
  assert.equal(matchTableFilter('users', 'public', '   '), true);

  // Plain text is a case-insensitive substring match.
  assert.equal(matchTableFilter('UserEvents', 'public', 'events'), true);
  assert.equal(matchTableFilter('users', 'public', 'users'), true);
  assert.equal(matchTableFilter('users', 'public', 'orders'), false);

  // The qualified schema.table form matches too.
  assert.equal(matchTableFilter('users', 'public', 'public.users'), true);
  assert.equal(matchTableFilter('users', 'public', 'analytics.users'), false);

  // Wildcards.
  assert.equal(matchTableFilter('users', 'public', 'user*'), true);
  assert.equal(matchTableFilter('users', 'public', '*s'), true);
  assert.equal(matchTableFilter('users', 'public', 'u?ers'), true);
  assert.equal(matchTableFilter('users', 'public', 'u?ser'), false);
  assert.equal(matchTableFilter('users', 'public', 'public.*'), true);
  assert.equal(matchTableFilter('users', 'public', 'audit_*'), false);
});

// ── MCP write guard ─────────────────────────────────────────────────────────

test('guard: DDL passes only with auto-approve, destructive statements never do', () => {
  const guard = new SecurityGuard();
  const write = { readOnly: false, allowWrite: true, driverType: 'mysql' };

  // Write mode without auto-approve: plain writes pass, DDL stays refused.
  assert.equal(guard.validate('INSERT INTO t VALUES (1)', write).ok, true);
  assert.equal(guard.validate('CREATE TABLE t (id INT)', write).ok, false);
  assert.equal(guard.validate('ALTER TABLE t ADD COLUMN n INT', write).ok, false);

  // Auto-approve writes: CREATE/ALTER become allowed...
  const auto = { ...write, allowDdl: true };
  assert.equal(guard.validate('INSERT INTO t VALUES (1)', auto).ok, true);
  assert.equal(guard.validate('CREATE TABLE t (id INT)', auto).ok, true);
  assert.equal(guard.validate('ALTER TABLE t ADD COLUMN n INT', auto).ok, true);
  assert.equal(guard.validate('CREATE INDEX i ON t (id)', auto).ok, true);

  // ...but destructive and unbounded statements are still refused.
  assert.equal(guard.validate('DROP TABLE t', auto).ok, false);
  assert.equal(guard.validate('TRUNCATE TABLE t', auto).ok, false);
  assert.equal(guard.validate('DELETE FROM t', auto).ok, false);
  assert.equal(guard.validate('UPDATE t SET a = 1', auto).ok, false);
  assert.equal(guard.validate('ALTER TABLE t ADD n INT', { ...auto, readOnly: true, allowWrite: false }).ok, false);

  // Multiple statements stay refused for the SQL family.
  assert.equal(guard.validate('SELECT 1; SELECT 2', auto).ok, false);
});
