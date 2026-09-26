/* P4 capability checks: driver paging, index/collection management, transfer, EXPLAIN. */
import { ElasticsearchDriver } from '../src/core/drivers/ElasticsearchDriver';
import { MongoDBDriver } from '../src/core/drivers/MongoDBDriver';
import { ClickHouseDriver } from '../src/core/drivers/ClickHouseDriver';
import { MSSQLDriver } from '../src/core/drivers/MSSQLDriver';
import type { ConnectionConfig } from '../src/core/types';

function cfg(type: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 't', name: 't', type: type as never,
    host: '127.0.0.1', port: 0, username: '', password: '', database: '',
    ssl: { mode: 'disabled' } as never,
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password', privateKeyPath: '' },
    options: {}, tags: [], createdAt: 0, updatedAt: 0,
    ...over,
  };
}

async function es() {
  const d = new ElasticsearchDriver();
  await d.connect(cfg('elasticsearch', { port: 9200 }));

  await d.deleteIndex('p4_test').catch(() => {});
  await d.createIndex('p4_test', '{"mappings":{"properties":{"n":{"type":"integer"}}}}');
  await d.importNdjson('p4_test', '{"n":1}\n{"n":2}\n{"n":3}');
  const page0 = await d.query(d.pageQuery('p4_test', 2, undefined, 0));
  const page1 = await d.query(d.pageQuery('p4_test', 2, undefined, 2));
  console.log('ES page0 rows:', page0.rows.length, 'page1 rows:', page1.rows.length);
  const ndjson = await d.exportNdjson('p4_test');
  console.log('ES exportNdjson lines:', ndjson.trim().split('\n').length);
  const agg = await d.query('GET /p4_test/_search\n{"size":0,"aggs":{"by_n":{"terms":{"field":"n"}}}}');
  console.log('ES agg rows:', JSON.stringify(agg.rows));
  const plan = await d.explainSearch('p4_test', '{"query":{"match_all":{}}}');
  console.log('ES profile rows:', plan.rows.length, 'cols:', plan.columns.map(c => c.name).join(','));

  // Deep paging: force a tiny window so page 3 must continue with search_after.
  d.setMaxResultWindow(3);
  await d.deleteIndex('p4_cursor').catch(() => {});
  await d.createIndex('p4_cursor');
  await d.importNdjson('p4_cursor', Array.from({ length: 7 }, (_, i) => JSON.stringify({ n: i + 1 })).join('\n'));
  const pages = [
    await d.query(d.pageQuery('p4_cursor', 3, undefined, 0)),
    await d.query(d.pageQuery('p4_cursor', 3, undefined, 3)),
    await d.query(d.pageQuery('p4_cursor', 3, undefined, 6)),
  ];
  console.log('ES cursor pages rows:', pages.map(p => p.rows.length).join('/'),
    'page3:', JSON.stringify(pages[2].rows));
  let jumped: string;
  try {
    await d.query(d.pageQuery('p4_cursor', 3, undefined, 60));
    jumped = 'ALLOWED';
  } catch (e) {
    jumped = `guided: ${(e as Error).message.slice(0, 60)}`;
  }
  console.log('ES deep jump:', jumped);
  await d.deleteIndex('p4_cursor').catch(() => {});

  await d.deleteIndex('p4_test');
  await d.disconnect();
}

async function mongo() {
  const d = new MongoDBDriver();
  await d.connect(cfg('mongodb', { port: 27017, database: 'sqlens_test' }));

  await d.query('db.p4.deleteMany({})').catch(() => {});
  await d.importJson('p4', [{ n: 1 }, { n: 2 }, { n: 3 }]);
  const page1 = await d.query(d.pageQuery('p4', 2, undefined, 2));
  console.log('Mongo page1 rows:', page1.rows.length);
  const idxName = await d.createIndex('p4', '{"n": 1}');
  console.log('Mongo index created:', idxName);
  const exported = await d.exportJson('p4', '{"n":{"$gte":2}}');
  console.log('Mongo exportJson docs:', exported.length);
  const plan = await d.explainQuery('db.p4.find({ n: 1 })');
  console.log('Mongo explain chars:', String(plan.rows[0][0]).length);
  const shellBlocked = await d.evalShell('db.p4.stats()').then(() => 'ALLOWED').catch(e => `blocked: ${(e as Error).message.slice(0, 40)}`);
  console.log('Mongo passthrough (default off):', shellBlocked);

  // Deep paging via the _id range cursor (threshold lowered for the test).
  d.setDeepSkipThreshold(2);
  await d.importJson('p4c', Array.from({ length: 7 }, (_, i) => ({ n: i + 1 })));
  const cursorPages = [
    await d.query(d.pageQuery('p4c', 3, undefined, 0)),
    await d.query(d.pageQuery('p4c', 3, undefined, 3)),
    await d.query(d.pageQuery('p4c', 3, undefined, 6)),
  ];
  console.log('Mongo cursor pages rows:', cursorPages.map(p => p.rows.length).join('/'),
    'page3 n:', JSON.stringify(cursorPages[2].rows.map(r => r[1])));
  await d.query('db.p4c.deleteMany({})');

  await d.query('db.p4.deleteMany({})');
  await d.disconnect();
}

async function clickhouse() {
  const d = new ClickHouseDriver();
  await d.connect(cfg('clickhouse', { port: 8123, username: 'default', password: 'voice123', database: 'default' }));
  await d.query('CREATE DATABASE IF NOT EXISTS sqlens_test');
  await d.switchDatabase('sqlens_test');

  await d.query('DROP TABLE IF EXISTS p4');
  await d.query('CREATE TABLE p4 (id UInt32, name String) ENGINE = MergeTree ORDER BY id');
  await d.query("INSERT INTO p4 VALUES (1,'a'),(2,'b'),(3,'c')");
  await d.getPrimaryKey('p4'); // warms the sorting-key cache
  const page1 = await d.query(d.pageQuery('p4', 2, 'sqlens_test', 2));
  console.log('CH page1 rows:', page1.rows.length, '(ORDER BY applied)');
  const csv = await d.exportTable('p4', 'CSV', 'sqlens_test');
  console.log('CH CSV export:', JSON.stringify(csv.trim().split('\n').slice(0, 2)));
  const json = await d.exportTable('p4', 'JSONEachRow', 'sqlens_test');
  console.log('CH JSONEachRow lines:', json.trim().split('\n').length);
  const plan = await d.query('EXPLAIN SELECT * FROM p4');
  console.log('CH explain rows:', plan.rows.length);
  await d.query('DROP TABLE p4');
  await d.disconnect();
}

async function mssql() {
  const d = new MSSQLDriver();
  await d.connect(cfg('mssql', {
    port: 1433, username: 'sa', password: 'YourStrong!Passw0rd', database: 'master',
    options: { trustServerCertificate: true },
  }));

  await d.query(`IF OBJECT_ID('dbo.p4') IS NOT NULL DROP TABLE dbo.p4`);
  await d.query('CREATE TABLE dbo.p4 (id INT IDENTITY(1,1) PRIMARY KEY, v INT)');
  await d.query('INSERT INTO dbo.p4 (v) VALUES (1),(2),(3)');
  await d.getPrimaryKey('p4'); // warms the PK cache used by pageQuery
  const page1 = await d.query(d.pageQuery('p4', 2, 'dbo', 2));
  console.log('MSSQL page1 rows:', page1.rows.length, 'cols:', page1.columns.map(c => c.name).join(','));

  const multi = await d.query('SELECT 1 AS a; SELECT 2 AS b, 3 AS c');
  console.log('MSSQL resultSets:', multi.resultSets?.length ?? 0,
    'main:', JSON.stringify(multi.rows),
    'set2 cols:', (multi.resultSets?.[0]?.columns ?? []).map(c => c.name).join(','),
    'set2 rows:', JSON.stringify(multi.resultSets?.[0]?.rows ?? []));
  // High-speed export: expect a friendly message when bcp is not installed.
  const bcp = await (d as unknown as { exportBcp: (t: string, f: string, s?: string) => Promise<void> })
    .exportBcp('p4', '/tmp/p4-bcp.txt', 'dbo')
    .then(() => 'exported')
    .catch((e: Error) => `note: ${e.message.slice(0, 70)}`);
  console.log('MSSQL bcp:', bcp);

  await d.query(`IF OBJECT_ID('dbo.p4') IS NOT NULL DROP TABLE dbo.p4`);
  await d.disconnect();
}

async function main() {
  await es();
  await mongo();
  await clickhouse();
  await mssql();
  console.log('ALL OK');
}

main().catch(err => { console.error('FAIL:', err?.message ?? err); process.exit(1); });
