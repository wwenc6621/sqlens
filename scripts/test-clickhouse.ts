/* Temporary integration test for ClickHouseDriver against local docker. */
import { ClickHouseDriver } from '../src/core/drivers/ClickHouseDriver';
import type { ConnectionConfig } from '../src/core/types';

async function main() {
  const config: ConnectionConfig = {
    id: 'test', name: 'test', type: 'clickhouse' as never,
    host: '127.0.0.1', port: 8123, username: 'default', password: 'voice123',
    database: '',
    ssl: { mode: 'disabled' } as never,
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password', privateKeyPath: '' },
    options: {}, tags: [], createdAt: 0, updatedAt: 0,
  };

  const d = new ClickHouseDriver();
  const step = async (label: string, sql: string) => {
    try {
      return await d.query(sql);
    } catch (err) {
      console.error(`STEP FAILED [${label}]: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  };

  // 1. testConnection (no connect needed)
  const t = await d.testConnection(config);
  console.log('testConnection:', t.success, t.message, JSON.stringify(t.serverInfo));
  if (!t.success) { process.exit(1); }

  // 2. connect
  await d.connect(config);
  console.log('connected:', d.isConnected, 'db:', await d.getCurrentDatabase());

  // 3. create test db/table with rich types
  await step('drop-db', 'DROP DATABASE IF EXISTS sqlens_test');
  await step('create-db', 'CREATE DATABASE sqlens_test');
  await d.switchDatabase('sqlens_test');
  console.log('switched db:', await d.getCurrentDatabase());

  await step('create-table', `
    CREATE TABLE events (
      id UInt32,
      name String,
      tags Array(String),
      props Map(String, UInt64),
      score Nullable(Float64),
      created DateTime64(3),
      active Bool,
      host IPv4
    ) ENGINE = MergeTree ORDER BY (id, created)
  `);

  await step('insert', `
    INSERT INTO events FORMAT JSONEachRow
    {"id":1,"name":"a","tags":["x","y"],"props":{"k":"1"},"score":1.5,"created":"2026-09-25 10:00:00.123","active":true,"host":"10.0.0.1"}
    {"id":2,"name":"b","tags":[],"props":{},"score":null,"created":"2026-09-25 11:30:00.000","active":false,"host":"10.0.0.2"}
  `);

  // 4. result-set query with rich types
  const r = await step('select-all', 'SELECT * FROM events ORDER BY id');
  console.log('columns:', r.columns.map(c => `${c.name}:${c.type}:${c.normalizedType}${c.nullable ? '?' : ''}`).join(', '));
  console.log('rows:', JSON.stringify(r.rows));
  console.log('execTime:', r.executionTime, 'ms');

  // 5. introspection
  const dbs = await d.getDatabases();
  console.log('databases:', dbs.map(x => x.name).join(','));
  const tables = await d.getTables();
  console.log('tables:', JSON.stringify(tables));
  const cols = await d.getColumns('events');
  console.log('cols:', cols.map(c => `${c.name}${c.isPrimaryKey ? '[pk]' : ''}${c.nullable ? '[null]' : ''}`).join(','));
  console.log('primaryKey (sort key):', (await d.getPrimaryKey('events')).join(','));
  console.log('schemas:', JSON.stringify(await d.getSchemas()));
  console.log('foreignKeys:', JSON.stringify(await d.getForeignKeys('events')));
  const si = await d.getServerInfo();
  console.log('serverInfo:', JSON.stringify(si));

  // 6. pagination + user FORMAT clause + SHOW
  const p = await d.query(`SELECT id, name FROM events ${d.paginationSQL(1, 0)}`);
  console.log('page1:', JSON.stringify(p.rows));
  const f = await d.query('SELECT id, name FROM events ORDER BY id FORMAT JSONEachRow');
  console.log('userFormat rows:', JSON.stringify(f.rows));
  const s = await d.query('SHOW TABLES');
  console.log('show tables:', JSON.stringify(s.rows));

  // 7. mutation (async) via command path
  const m = await d.query('ALTER TABLE events DELETE WHERE id = 2');
  console.log('mutation:', m.messages[0], 'affected:', m.affectedRows);

  await d.query('DROP DATABASE IF EXISTS sqlens_test');
  await d.disconnect();
  console.log('ALL OK');
}

main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
