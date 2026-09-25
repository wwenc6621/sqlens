/**
 * Redis command classification for safe-mode and MCP security.
 *
 * Redis has no SQL, so the SQL keyword regexes used elsewhere are useless.
 * Instead we classify each command by its first token against curated tables:
 *   - read:  return data, no mutation
 *   - write: mutate keys / values
 *   - danger: administrative / destructive, always blocked for AI and the UI
 *
 * See docs/REDIS_SUPPORT_DESIGN.md §11.2.
 */

export type RedisCategory = 'read' | 'write' | 'danger' | 'other';

export const REDIS_READ = new Set<string>([
  'GET', 'MGET', 'STRLEN', 'HGET', 'HGETALL', 'HMGET', 'HLEN', 'HKEYS', 'HVALS',
  'LRANGE', 'LLEN', 'LINDEX', 'SMEMBERS', 'SSCAN', 'SCARD', 'SISMEMBER',
  'ZRANGE', 'ZRANGEBYSCORE', 'ZSCORE', 'ZCARD', 'ZCOUNT', 'ZRANK', 'ZREVRANK',
  'SCAN', 'TYPE', 'TTL', 'PTTL', 'EXISTS', 'DBSIZE', 'INFO', 'PING', 'MEMORY',
  'RANDOMKEY', 'OBJECT', 'GETBIT', 'BITCOUNT', 'BITFIELD', 'HSCAN', 'LSCAN',
  'ZSCAN', 'HSTRLEN', 'GEOHASH', 'GEOPOS', 'GEODIST', 'GEORADIUS', 'GEORADIUSBYMEMBER',
  'XINFO', 'XLEN', 'XRANGE', 'XREVRANGE',
]);

export const REDIS_WRITE = new Set<string>([
  'SET', 'MSET', 'SETNX', 'GETSET', 'SETEX', 'PSETEX', 'APPEND', 'INCR', 'INCRBY',
  'DECR', 'DECRBY', 'INCRBYFLOAT', 'HSET', 'HMSET', 'HDEL', 'HINCRBY', 'HINCRBYFLOAT',
  'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LSET', 'LREM', 'LTRIM', 'LINSERT', 'RPOPLPUSH',
  'SADD', 'SREM', 'SMOVE', 'ZADD', 'ZINCRBY', 'ZREM', 'ZREMRANGEBYRANK',
  'ZREMRANGEBYSCORE', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'PERSIST',
  'RENAME', 'RENAMENX', 'UNLINK', 'DEL', 'SETBIT', 'BITOP', 'GEOADD',
  'XADD', 'XTRIM', 'XDEL', 'XACK', 'XGROUP', 'XREADGROUP',
]);

export const REDIS_DANGER = new Set<string>([
  'FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'CONFIG', 'DEBUG', 'KEYS', 'MIGRATE',
  'SLAVEOF', 'REPLICAOF', 'MONITOR', 'SUBSCRIBE', 'PUBLISH', 'MODULE',
  'SWAPDB', 'FAILOVER', 'RESET',
]);

/** Classify a single Redis command line by its leading token. */
export function classifyRedisCommand(line: string): RedisCategory {
  const trimmed = line.trim();
  if (!trimmed) { return 'other'; }
  const cmd = trimmed.split(/\s+/)[0].toUpperCase();
  if (REDIS_DANGER.has(cmd)) { return 'danger'; }
  if (REDIS_WRITE.has(cmd)) { return 'write'; }
  if (REDIS_READ.has(cmd)) { return 'read'; }
  // Unknown commands: treat as write to be safe (most mutate something).
  return 'write';
}

/** Split a Redis script into non-empty command lines. */
export function splitRedisCommands(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}
