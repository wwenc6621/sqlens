// Standalone smoke test for Sqlens Redis support.
// Exercises the same ioredis commands the RedisDriver relies on, against a live
// server. Run from the extension root:  node scripts/redis-smoke.mjs
import Redis from 'ioredis';

const HOST = process.env.REDIS_HOST || '127.0.0.1';
const PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const PREFIX = 'sqlens:smoke:';

const client = new Redis({
  host: HOST,
  port: PORT,
  lazyConnect: false,
  connectTimeout: 4000,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null, // fail fast, no silent reconnect loop
});

let failures = 0;
async function step(name, fn) {
  try {
    const r = await fn();
    console.log(`  PASS  ${name}${r !== undefined ? ` -> ${JSON.stringify(r)}` : ''}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name} -> ${err.message}`);
  }
}

(async () => {
  console.log(`\nRedis smoke test @ ${HOST}:${PORT}\n`);
  try {
    await client.ping();
  } catch (err) {
    console.log(`Cannot reach Redis at ${HOST}:${PORT}: ${err.message}`);
    console.log('Make sure your Docker Redis container publishes 6379 to the host.');
    process.exit(2);
  }

  await step('PING', async () => (await client.ping()));
  await step('INFO server', async () => {
    const info = await client.info('server');
    return info.split('\n')[0].trim();
  });
  await step('SELECT 0', async () => { await client.select(0); return 'ok'; });
  await step('SET/GET', async () => {
    await client.set(PREFIX + 'str', 'hello');
    return client.get(PREFIX + 'str');
  });
  await step('EXPIRE/TTL', async () => {
    await client.expire(PREFIX + 'str', 100);
    return client.ttl(PREFIX + 'str');
  });
  await step('TYPE', async () => client.type(PREFIX + 'str'));
  await step('HSET/HGETALL', async () => {
    await client.hset(PREFIX + 'hash', 'f1', 'v1', 'f2', 'v2');
    return client.hgetall(PREFIX + 'hash');
  });
  await step('LPUSH/LRANGE', async () => {
    await client.del(PREFIX + 'list');
    await client.rpush(PREFIX + 'list', 'a', 'b', 'c');
    return client.lrange(PREFIX + 'list', 0, -1);
  });
  await step('SADD/SMEMBERS', async () => {
    await client.del(PREFIX + 'set');
    await client.sadd(PREFIX + 'set', 'x', 'y');
    return client.smembers(PREFIX + 'set');
  });
  await step('ZADD/ZRANGE WITHSCORES', async () => {
    await client.del(PREFIX + 'zset');
    await client.zadd(PREFIX + 'zset', 1, 'one', 2, 'two');
    return client.zrange(PREFIX + 'zset', 0, -1, 'WITHSCORES');
  });
  await step('XADD/XRANGE', async () => {
    await client.del(PREFIX + 'stream');
    const id = await client.xadd(PREFIX + 'stream', '*', 'field', 'val');
    const entries = await client.xrange(PREFIX + 'stream', '-', '+');
    return { id, entries: entries.length };
  });
  await step('SCAN TYPE string', async () => {
    const res = await client.scan('0', 'MATCH', PREFIX + '*', 'COUNT', 50, 'TYPE', 'string');
    return `cursor=${res[0]} matched=${res[1].length}`;
  });
  await step('SCAN TYPE hash', async () => {
    const res = await client.scan('0', 'MATCH', PREFIX + '*', 'COUNT', 50, 'TYPE', 'hash');
    return `cursor=${res[0]} matched=${res[1].length}`;
  });

  // Cleanup
  try {
    const keys = await client.keys(PREFIX + '*');
    if (keys.length) { await client.unlink(...keys); }
    console.log(`\nCleaned up ${keys.length} test keys.`);
  } catch (err) {
    console.log(`Cleanup warning: ${err.message}`);
  }

  await client.quit();
  console.log(`\nSmoke test ${failures === 0 ? 'PASSED' : `FAILED (${failures} step(s))`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
