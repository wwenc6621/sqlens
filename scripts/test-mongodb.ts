/* Temporary integration test for MongoDBDriver (needs a local mongo on 27017). */
import { MongoDBDriver } from '../src/core/drivers/MongoDBDriver';
import type { ConnectionConfig } from '../src/core/types';

async function main() {
  const config: ConnectionConfig = {
    id: 'test', name: 'test', type: 'mongodb' as never,
    host: '127.0.0.1', port: 27017, username: '', password: '',
    database: 'sqlens_test',
    ssl: { mode: 'disabled' } as never,
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password', privateKeyPath: '' },
    options: {}, tags: [], createdAt: 0, updatedAt: 0,
  };

  const d = new MongoDBDriver();

  const t = await d.testConnection(config);
  console.log('testConnection:', t.success, t.message, JSON.stringify(t.serverInfo));
  if (!t.success) { process.exit(1); }

  await d.connect(config);
  console.log('connected:', d.isConnected, 'db:', await d.getCurrentDatabase());

  // cleanup + seed (drop is intentionally rejected in P1 — use deleteMany)
  await d.query('db.orders.deleteMany({})').catch(() => {});
  await d.query(`db.orders.insertMany([
    { status: 'PAID', total: 120, items: ['a', 'b'], buyer: { name: 'alice', level: 2 }, createdAt: ISODate('2026-09-01T10:00:00Z') },
    { status: 'OPEN', total: 55, items: [], buyer: { name: 'bob', level: 1 }, createdAt: ISODate('2026-09-02T11:30:00Z') }
  ])`);
  console.log('insertMany ok');

  const find = await d.query(`db.orders.find({ status: 'PAID' }).sort({ createdAt: -1 }).limit(10)`);
  console.log('find columns:', find.columns.map(c => c.name).join(', '));
  console.log('find rows:', JSON.stringify(find.rows));

  const count = await d.query(`db.orders.countDocuments({ status: 'PAID' })`);
  console.log('count:', JSON.stringify(count.rows));

  const agg = await d.query(`db.orders.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])`);
  console.log('aggregate rows:', JSON.stringify(agg.rows));

  const upd = await d.query(`db.orders.updateOne({ status: 'OPEN' }, { $set: { status: 'PAID' } })`);
  console.log('updateOne:', upd.messages[0]);

  const oid = (find.rows[0][0] as string);
  const del = await d.query(`db.orders.deleteOne({ _id: ObjectId('${oid}') })`);
  console.log('deleteOne:', del.messages[0]);

  const dbs = await d.getDatabases();
  console.log('databases:', dbs.map(x => x.name).join(','));
  const tables = await d.getTables();
  console.log('tables:', JSON.stringify(tables));
  const cols = await d.getColumns('orders');
  console.log('columns (sampled):', cols.map(c => `${c.name}:${c.type}`).join(', '));
  console.log('primaryKey:', (await d.getPrimaryKey('orders')).join(','));
  console.log('indexes:', JSON.stringify(await d.getIndexes('orders')));
  console.log('serverInfo:', JSON.stringify(await d.getServerInfo()));

  // multi-statement text
  await d.query('use sqlens_test');
  const multi = await d.queryMultiple('db.orders.countDocuments({})\ndb.orders.find({}).limit(1)');
  console.log('queryMultiple blocks:', multi.length);

  await d.query('db.orders.deleteMany({})');
  await d.disconnect();
  console.log('ALL OK');
}

main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
