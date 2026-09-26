/* Temporary integration test for MSSQLDriver (needs local SQL Server on 1433). */
import { MSSQLDriver } from '../src/core/drivers/MSSQLDriver';
import type { ConnectionConfig } from '../src/core/types';

async function main() {
  const config: ConnectionConfig = {
    id: 'test', name: 'test', type: 'mssql' as never,
    host: '127.0.0.1', port: 1433, username: 'sa', password: 'YourStrong!Passw0rd',
    database: 'master',
    ssl: { mode: 'disabled' } as never,
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password', privateKeyPath: '' },
    options: { trustServerCertificate: true }, tags: [], createdAt: 0, updatedAt: 0,
  };

  const d = new MSSQLDriver();

  const t = await d.testConnection(config);
  console.log('testConnection:', t.success, t.message, JSON.stringify(t.serverInfo));
  if (!t.success) { process.exit(1); }

  await d.connect(config);
  console.log('connected:', d.isConnected, 'db:', await d.getCurrentDatabase(), 'schema:', await d.getCurrentSchema());

  // cleanup + seed
  await d.query(`IF OBJECT_ID('dbo.orders') IS NOT NULL DROP TABLE dbo.orders`);
  await d.query(`
    CREATE TABLE dbo.orders (
      id INT IDENTITY(1,1) PRIMARY KEY,
      title NVARCHAR(200),
      amount DECIMAL(10,2),
      paid BIT,
      created DATETIME2,
      buyer NVARCHAR(100)
    )
  `);
  await d.query(`INSERT INTO dbo.orders (title, amount, paid, created, buyer) VALUES
    (N'订单A', 120.50, 1, '2026-09-01T10:00:00', N'张三'),
    (N'订单B', 55.00, 0, '2026-09-02T11:30:00', N'Bob')`);
  console.log('seed ok');

  const sel = await d.query(`SELECT * FROM dbo.orders ORDER BY id`);
  console.log('columns:', sel.columns.map(c => `${c.name}:${c.type}:${c.normalizedType}`).join(', '));
  console.log('rows:', JSON.stringify(sel.rows));

  const page = await d.query(`SELECT * FROM dbo.orders ORDER BY id ${d.paginationSQL(1, 0)}`);
  console.log('page1:', JSON.stringify(page.rows));

  const dbs = await d.getDatabases();
  console.log('databases:', dbs.map(x => x.name).join(','));
  const schemas = await d.getSchemas();
  console.log('schemas:', JSON.stringify(schemas));
  const tables = await d.getTables();
  console.log('tables:', JSON.stringify(tables));
  const cols = await d.getColumns('orders');
  console.log('cols:', cols.map(c => `${c.name}:${c.type}${c.isAutoIncrement ? '[identity]' : ''}${c.nullable ? '' : '[notnull]'}`).join(', '));
  console.log('pk:', (await d.getPrimaryKey('orders')).join(','));
  console.log('indexes:', JSON.stringify(await d.getIndexes('orders')));
  console.log('fks:', JSON.stringify(await d.getForeignKeys('orders')));
  console.log('serverInfo:', JSON.stringify(await d.getServerInfo()));

  // multi-batch GO + multi-statement
  const multi = await d.queryMultiple('SELECT 1 AS a\nGO\nSELECT 2 AS b');
  console.log('GO batches:', multi.length, JSON.stringify(multi.map(r => r.rows)));

  await d.query(`DROP TABLE dbo.orders`);
  await d.disconnect();
  console.log('ALL OK');
}

main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
