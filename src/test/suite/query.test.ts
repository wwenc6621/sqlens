import * as assert from 'assert';
import { QueryEngine } from '../../core/query/QueryEngine';

suite('QueryEngine Test Suite', () => {
  let queryEngine: QueryEngine;

  suiteSetup(() => {
    const mockHistory: any = {
      add: () => {}
    };
    const mockConnManager: any = {
      activeConnectionId: undefined,
      getDriver: () => undefined
    };
    queryEngine = new QueryEngine(mockConnManager, mockHistory);
  });

  test('isWriteQuery detection heuristics', () => {
    const isWrite = (queryEngine as any).isWriteQuery.bind(queryEngine);

    // Simple SELECT read query
    assert.strictEqual(isWrite('SELECT * FROM users;'), false);
    assert.strictEqual(isWrite('select id, name from accounts where id = 1'), false);

    // Destructive write queries
    assert.strictEqual(isWrite('INSERT INTO users(name) VALUES("John");'), true);
    assert.strictEqual(isWrite('UPDATE accounts SET balance = 0;'), true);
    assert.strictEqual(isWrite('DELETE FROM users WHERE id = 10;'), true);
    assert.strictEqual(isWrite('DROP TABLE logs;'), true);
    assert.strictEqual(isWrite('TRUNCATE TABLE active_sessions;'), true);
    assert.strictEqual(isWrite('ALTER TABLE users ADD age INT;'), true);
    assert.strictEqual(isWrite('CREATE TABLE test(id INT);'), true);
    assert.strictEqual(isWrite('REPLACE INTO cache(key, val) VALUES("a", "b");'), true);
  });
});
