import * as assert from 'assert';
import * as vscode from 'vscode';
import { DriverFactory } from '../../core/drivers';
import { DatabaseType } from '../../core/types';

suite('Extension Integration Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  const extensionId = 'wwenc6621.sqlens-vscode';

  test('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension(extensionId));
  });

  test('Extension should activate', async () => {
    const ext = vscode.extensions.getExtension(extensionId);
    if (ext) {
      await ext.activate();
      assert.strictEqual(ext.isActive, true);
    } else {
      assert.fail('Extension not found');
    }
  });

  test('Extension commands should be registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    const expectedCommands = [
      'sqlens.newConnection',
      'sqlens.openTerminal',
      'sqlens.runQuery',
      'sqlens.runAllQueries',
      'sqlens.cancelQuery',
    ];

    for (const cmd of expectedCommands) {
      assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
    }
  });

  test('DriverFactory should resolve basic drivers', () => {
    const sqliteDriver = DriverFactory.createDriver(DatabaseType.SQLite);
    assert.strictEqual(sqliteDriver.driverType, 'sqlite');

    const mysqlDriver = DriverFactory.createDriver(DatabaseType.MySQL);
    assert.strictEqual(mysqlDriver.driverType, 'mysql');

    const pgDriver = DriverFactory.createDriver(DatabaseType.PostgreSQL);
    assert.strictEqual(pgDriver.driverType, 'postgresql');
  });
});
