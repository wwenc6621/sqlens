/* Temporary integration test for ElasticsearchDriver (local ES on 9200, security off). */
import { ElasticsearchDriver } from '../src/core/drivers/ElasticsearchDriver';
import type { ConnectionConfig } from '../src/core/types';

async function main() {
  const config: ConnectionConfig = {
    id: 'test', name: 'test', type: 'elasticsearch' as never,
    host: '127.0.0.1', port: 9200, username: '', password: '',
    database: '',
    ssl: { mode: 'disabled' } as never,
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password', privateKeyPath: '' },
    options: {}, tags: [], createdAt: 0, updatedAt: 0,
  };

  const d = new ElasticsearchDriver();
  const step = async (label: string, text: string) => {
    try { return await d.query(text); }
    catch (err) { console.error(`STEP FAILED [${label}]: ${err instanceof Error ? err.message : err}`); throw err; }
  };

  const t = await d.testConnection(config);
  console.log('testConnection:', t.success, t.message, JSON.stringify(t.serverInfo));
  if (!t.success) { process.exit(1); }

  await d.connect(config);
  console.log('connected:', d.isConnected, 'cluster:', await d.getCurrentDatabase());

  // cleanup + seed
  await step('delete-index', 'DELETE /sqlens_test').catch(() => {});
  await step('create-index', `PUT /sqlens_test
{
  "mappings": {
    "properties": {
      "title": { "type": "text" },
      "status": { "type": "keyword" },
      "amount": { "type": "double" },
      "paid": { "type": "boolean" },
      "created": { "type": "date" },
      "buyer": { "properties": { "name": { "type": "keyword" }, "level": { "type": "integer" } } }
    }
  }
}`);

  await step('bulk', `POST /sqlens_test/_bulk?refresh=wait_for
{"index":{}}
{"title":"error disk full","status":"ALERT","amount":1.5,"paid":true,"created":"2026-09-01T10:00:00Z","buyer":{"name":"alice","level":2}}
{"index":{}}
{"title":"ok request","status":"INFO","amount":55,"paid":false,"created":"2026-09-02T11:30:00Z","buyer":{"name":"bob","level":1}}`);
  console.log('bulk ok');

  const search = await d.query(`GET /sqlens_test/_search
{"query": {"match": {"title": "error"}}, "sort": [{"created": "desc"}]}`);
  console.log('search columns:', search.columns.map(c => `${c.name}:${c.normalizedType}`).join(', '));
  console.log('search rows:', JSON.stringify(search.rows));

  const count = await d.query(`GET /sqlens_test/_count`);
  console.log('count rows:', JSON.stringify(count.rows));

  const cat = await d.query(`GET /_cat/indices/sqlens_test?format=json&h=index,health,docs.count,store.size`);
  console.log('cat rows:', JSON.stringify(cat.rows));

  const bare = await d.query('{ "query": { "match_all": {} } }');
  console.log('bare json hits:', bare.rows.length);

  const dbs = await d.getDatabases();
  console.log('databases (pseudo):', dbs.map(x => x.name).join(','));
  const tables = await d.getTables();
  console.log('tables (indices):', JSON.stringify(tables));
  const cols = await d.getColumns('sqlens_test');
  console.log('mapping columns:', cols.map(c => `${c.name}:${c.type}`).join(', '));
  console.log('primaryKey:', (await d.getPrimaryKey('sqlens_test')).join(','));
  console.log('serverInfo:', JSON.stringify(await d.getServerInfo()));

  await d.query('DELETE /sqlens_test');
  await d.disconnect();
  console.log('ALL OK');
}

main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
