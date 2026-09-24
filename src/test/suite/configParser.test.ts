import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { parseSSHConfig, parseDatabaseUrl, detectDatabaseConfigsInFile } from '../../extension';
import { DatabaseType } from '../../core/types';

suite('Config Parser Test Suite', () => {
  const tempDir = path.join(os.tmpdir(), `sqlens-tests-${Date.now()}`);

  suiteSetup(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  suiteTeardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('parseDatabaseUrl should parse MySQL, PostgreSQL, and SQLite URLs', () => {
    const env = {};
    
    // MySQL
    const mysqlRes = parseDatabaseUrl('mysql://user:pass@localhost:3306/dbname', env);
    assert.ok(mysqlRes);
    assert.strictEqual(mysqlRes.type, DatabaseType.MySQL);
    assert.strictEqual(mysqlRes.host, 'localhost');
    assert.strictEqual(mysqlRes.port, 3306);
    assert.strictEqual(mysqlRes.username, 'user');
    assert.strictEqual(mysqlRes.password, 'pass');
    assert.strictEqual(mysqlRes.database, 'dbname');

    // PostgreSQL
    const pgRes = parseDatabaseUrl('postgresql://pguser:pgpass@127.0.0.1:5432/pgdb', env);
    assert.ok(pgRes);
    assert.strictEqual(pgRes.type, DatabaseType.PostgreSQL);
    assert.strictEqual(pgRes.host, '127.0.0.1');
    assert.strictEqual(pgRes.port, 5432);
    assert.strictEqual(pgRes.username, 'pguser');
    assert.strictEqual(pgRes.password, 'pgpass');
    assert.strictEqual(pgRes.database, 'pgdb');

    // SQLite
    const sqliteRes = parseDatabaseUrl('sqlite://path/to/my.db', env);
    assert.ok(sqliteRes);
    assert.strictEqual(sqliteRes.type, DatabaseType.SQLite);
    assert.strictEqual(sqliteRes.database, 'path/to/my.db');
  });

  test('detectDatabaseConfigsInFile should detect Laravel, Django and URL configurations', async () => {
    const envContent = `
# Laravel style config
DB_CONNECTION=pgsql
DB_HOST=10.0.0.5
DB_PORT=5432
DB_DATABASE=laravel_db
DB_USERNAME=laravel_user
DB_PASSWORD=laravel_pass
`;
    const envFilePath = path.join(tempDir, '.env');
    fs.writeFileSync(envFilePath, envContent, 'utf8');

    const configs = await detectDatabaseConfigsInFile(envFilePath, 'TestWorkspace');
    assert.strictEqual(configs.length, 1);
    assert.strictEqual(configs[0].type, DatabaseType.PostgreSQL);
    assert.strictEqual(configs[0].host, '10.0.0.5');
    assert.strictEqual(configs[0].port, 5432);
    assert.strictEqual(configs[0].username, 'laravel_user');
    assert.strictEqual(configs[0].password, 'laravel_pass');
    assert.strictEqual(configs[0].database, 'laravel_db');
  });

  test('parseSSHConfig should parse alias, HostName, User, Port and IdentityFile', () => {
    const configPath = path.join(tempDir, 'ssh_config');
    const sshConfigContent = `
Host myserver
  HostName 192.168.1.100
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
`;
    fs.writeFileSync(configPath, sshConfigContent, 'utf8');

    const hosts = parseSSHConfig(configPath);
    assert.strictEqual(hosts.length, 1);
    assert.strictEqual(hosts[0].host, 'myserver');
    assert.strictEqual(hosts[0].hostName, '192.168.1.100');
    assert.strictEqual(hosts[0].user, 'deploy');
    assert.strictEqual(hosts[0].port, 2222);
    assert.ok(hosts[0].identityFile?.endsWith('.ssh/id_ed25519'));
  });
});
