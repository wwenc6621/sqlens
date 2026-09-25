import Redis, { type RedisOptions } from 'ioredis';
import { BaseDriver } from './DatabaseDriver';
import { Logger } from '../utils/Logger';
import {
  ConnectionConfig,
  QueryResult,
  ColumnHeader,
  NormalizedColumnType,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  SchemaInfo,
  DatabaseInfo,
  ServerInfo,
} from '../types';
import {
  classifyRedisCommand,
  splitRedisCommands,
} from '../redisCommands';
import {
  isRedisGroup,
  redisTypeFromGroup,
  encodeRedisKeyTable,
  decodeRedisKeyTable,
} from './redisTableEncoding';

/**
 * Redis driver (ioredis).
 *
 * Redis has no SQL / schema / tables, so the relational interface is mapped
 * onto Redis concepts (see docs/REDIS_SUPPORT_DESIGN.md §2-§3):
 *   - database  → db index (SELECT 0..15)
 *   - table     → a key-type group (Strings / Hashes / ...)
 *   - row       → a key, or an entry inside a key
 *   - column    → fixed fields (key / value / field / score / TTL / encoding)
 *   - query     → a Redis command line (the editor is the CLI)
 */
export class RedisDriver extends BaseDriver {
  readonly driverType = 'redis';

  private client: Redis | null = null;
  private currentDbIndex = 0;

  // ── Connection lifecycle ──

  async connect(config: ConnectionConfig): Promise<void> {
    const client = this.createClient(config);
    this.client = client;

    // SELECT the configured db index (config.database reuses the db index).
    // Cluster mode has a single db0 and disallows SELECT.
    const dbIndex = this.parseDbIndex(config.database);
    this.currentDbIndex = dbIndex;
    const mode = (config.options as any)?.redisMode as string | undefined;
    if (mode !== 'cluster') {
      await this.client.select(dbIndex);
    }

    this._config = config;
    this._isConnected = true;
    Logger.getInstance().logInfo(`[redis] connected to ${config.host}:${config.port} db${dbIndex} (${mode || 'standalone'})`);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      const client = this.client;
      this.client = null;
      try {
        await client.quit();
      } catch {
        try { await client.disconnect(); } catch { /* already down */ }
      }
    }
    this._isConnected = false;
    this._config = null;
  }

  async testConnection(config: ConnectionConfig): Promise<{ success: boolean; message: string; serverInfo?: ServerInfo }> {
    const probe = this.createClient(config, true);
    try {
      const pong = await probe.ping();
      if (pong !== 'PONG') {
        return { success: false, message: `Unexpected PING response: ${pong}` };
      }
      const info = await probe.info('server');
      const version = this.parseInfoField(info, 'redis_version') || 'unknown';
      return {
        success: true,
        message: `Connected: Redis ${version}`,
        serverInfo: { version: `Redis ${version}` },
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      try {
        await probe.quit();
      } catch {
        try { await probe.disconnect(); } catch { /* already down */ }
      }
    }
  }

  // ── Query execution ──

  async query(sql: string, _params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();
    const start = performance.now();
    const lines = splitRedisCommands(sql);
    if (lines.length === 0) {
      throw new Error('Empty command');
    }

    let last: QueryResult | null = null;
    const messages: string[] = [];
    for (const line of lines) {
      const res = await this.execLine(line);
      last = res;
      if (res.messages.length) {
        messages.push(...res.messages);
      }
    }

    const result = last!;
    result.executionTime = Math.round(performance.now() - start);
    if (messages.length && result.messages.length === 0) {
      result.messages = messages;
    }
    Logger.getInstance().logSQL(`[redis] ${lines.join(' | ')}`, result.executionTime);
    return result;
  }

  /** Redis scripts split by line, not by semicolon. */
  async queryMultiple(sql: string): Promise<QueryResult[]> {
    this.ensureConnected();
    const lines = splitRedisCommands(sql);
    const results: QueryResult[] = [];
    for (const line of lines) {
      results.push(await this.execLine(line));
    }
    return results;
  }

  async cancelQuery(): Promise<void> {
    // ioredis has no server-side cancellation; the UI disables cancel for Redis.
  }

  // ── Schema introspection ──

  async getDatabases(): Promise<DatabaseInfo[]> {
    this.ensureConnected();
    const info = await this.client!.config('GET', 'databases');
    // config GET returns [key, value] pairs or an object map.
    const raw = Array.isArray(info) ? (info as unknown as any[])[1] : (info as any)?.databases;
    const count = parseInt(String(raw ?? '16'), 10) || 16;
    const databases: DatabaseInfo[] = [];
    for (let i = 0; i < count; i++) {
      databases.push({ name: `db${i}` });
    }
    return databases;
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    // Redis has no schemas.
    return [];
  }

  async getTables(_schema?: string): Promise<TableInfo[]> {
    this.ensureConnected();
    const counts = await this.scanTypeCounts();
    const order: Array<{ name: string; key: string }> = [
      { name: 'Strings', key: 'string' },
      { name: 'Hashes', key: 'hash' },
      { name: 'Lists', key: 'list' },
      { name: 'Sets', key: 'set' },
      { name: 'ZSets', key: 'zset' },
      { name: 'Streams', key: 'stream' },
      { name: 'Other', key: 'other' },
    ];
    return order.map(g => ({
      name: g.name,
      type: 'table',
      rowCount: counts.get(g.key) ?? 0,
      comment: `Redis ${g.key} keys (approximate, SCAN-based)`,
    }));
  }

  /** Columns for a key-type group (the "table"). */
  async getColumns(table: string, _schema?: string): Promise<ColumnInfo[]> {
    const fixed: Record<string, ColumnInfo[]> = {
      Strings: [this.keyCol(), this.col('value', NormalizedColumnType.String, false), this.col('ttl', NormalizedColumnType.Integer, true), this.col('bytes', NormalizedColumnType.Integer, true)],
      Hashes: [this.keyCol(), this.col('field', NormalizedColumnType.String, false), this.col('value', NormalizedColumnType.String, false), this.col('ttl', NormalizedColumnType.Integer, true)],
      Lists: [this.keyCol(), this.col('index', NormalizedColumnType.Integer, false), this.col('value', NormalizedColumnType.String, false), this.col('ttl', NormalizedColumnType.Integer, true)],
      Sets: [this.keyCol(), this.col('member', NormalizedColumnType.String, false), this.col('ttl', NormalizedColumnType.Integer, true)],
      ZSets: [this.keyCol(), this.col('member', NormalizedColumnType.String, false), this.col('score', NormalizedColumnType.Float, false), this.col('ttl', NormalizedColumnType.Integer, true)],
      Streams: [this.keyCol(), this.col('id', NormalizedColumnType.String, false), this.col('fields', NormalizedColumnType.JSON, false), this.col('ttl', NormalizedColumnType.Integer, true)],
      Other: [this.keyCol(), this.col('type', NormalizedColumnType.String, false), this.col('value', NormalizedColumnType.String, false), this.col('ttl', NormalizedColumnType.Integer, true)],
    };
    return fixed[table] ?? [this.keyCol(), this.col('value', NormalizedColumnType.String, false)];
  }

  async getIndexes(): Promise<IndexInfo[]> { return []; }
  async getForeignKeys(): Promise<ForeignKeyInfo[]> { return []; }
  async getPrimaryKey(): Promise<string[]> { return []; }

  // ── Database operations ──

  async switchDatabase(database: string): Promise<void> {
    this.ensureConnected();
    const idx = this.parseDbIndex(database);
    await this.client!.select(idx);
    this.currentDbIndex = idx;
  }

  async getServerInfo(): Promise<ServerInfo> {
    this.ensureConnected();
    const info = await this.client!.info();
    const version = this.parseInfoField(info, 'redis_version') || 'unknown';
    const usedMemory = this.parseInfoField(info, 'used_memory');
    return {
      version: `Redis ${version}`,
      uptime: this.parseInfoField(info, 'uptime_in_seconds') ? parseInt(this.parseInfoField(info, 'uptime_in_seconds')!, 10) : undefined,
      maxConnections: undefined,
      currentConnections: this.parseInfoField(info, 'connected_clients') ? parseInt(this.parseInfoField(info, 'connected_clients')!, 10) : undefined,
    };
  }

  async getCurrentDatabase(): Promise<string> {
    return `db${this.currentDbIndex}`;
  }

  async getCurrentSchema(): Promise<string | undefined> {
    return undefined;
  }

  // ── Utilities ──

  escapeIdentifier(name: string): string {
    return name;
  }

  escapeValue(value: unknown): string {
    return value === null || value === undefined ? '' : String(value);
  }

  paginationSQL(): string {
    // Redis pagination uses SCAN cursors, not LIMIT/OFFSET.
    return '';
  }

  // ── Redis grid data APIs (SchemaTree + DataGrid) ──

  /** Columns for the key-list grid (group view). */
  getKeyListColumns(): { columns: ColumnHeader[]; primaryKey: string } {
    const columns: ColumnHeader[] = [
      this.header('key', NormalizedColumnType.String),
      this.header('type', NormalizedColumnType.String),
      this.header('ttl', NormalizedColumnType.Integer),
      this.header('size', NormalizedColumnType.Integer),
    ];
    columns[0].isPrimaryKey = true;
    columns[0].nullable = false;
    return { columns, primaryKey: 'key' };
  }

  /** Columns for the entry grid of a single key. */
  getEntryColumns(type: string): ColumnHeader[] {
    const ttlCol = () => this.header('ttl', NormalizedColumnType.Integer);
    switch (type) {
      case 'string':
        return [this.header('key', NormalizedColumnType.String), this.header('value', NormalizedColumnType.String), ttlCol()];
      case 'hash':
        return [this.header('field', NormalizedColumnType.String), this.header('value', NormalizedColumnType.String), ttlCol()];
      case 'list':
        return [this.header('index', NormalizedColumnType.Integer), this.header('value', NormalizedColumnType.String), ttlCol()];
      case 'set':
        return [this.header('member', NormalizedColumnType.String), ttlCol()];
      case 'zset':
        return [this.header('member', NormalizedColumnType.String), this.header('score', NormalizedColumnType.Float), ttlCol()];
      case 'stream':
        return [this.header('id', NormalizedColumnType.String), this.header('fields', NormalizedColumnType.JSON), ttlCol()];
      default:
        return [this.header('key', NormalizedColumnType.String), this.header('value', NormalizedColumnType.String), ttlCol()];
    }
  }

  /** PK column name for the entry grid of a given type. */
  private entryPkColumn(type: string): string {
    switch (type) {
      case 'string': return 'key';
      case 'hash': return 'field';
      case 'list': return 'index';
      case 'set': case 'zset': return 'member';
      case 'stream': return 'id';
      default: return 'key';
    }
  }

  /**
   * List keys of a type group (SCAN TYPE, paginated). Returns a QueryResult
   * whose rows are [key, type, ttl, size].
   */
  async getKeyList(group: string, page = 0, pageSize = 100, filter?: string): Promise<{ result: QueryResult; hasMore: boolean }> {
    this.ensureConnected();
    const redisType = redisTypeFromGroup(group);
    const match = filter && filter.trim() ? filter.trim() : '*';
    const need = page * pageSize + pageSize + 1;
    const seen = new Set<string>();
    const keys: string[] = [];
    let cursor = '0';
    let guard = 0;
    do {
      const res = (redisType && redisType !== 'other')
        ? await this.client!.scan(cursor, 'MATCH', match, 'COUNT', pageSize + 1, 'TYPE', redisType)
        : await this.client!.scan(cursor, 'MATCH', match, 'COUNT', pageSize + 1);
      cursor = res[0];
      for (const k of res[1]) {
        if (!seen.has(k)) { seen.add(k); keys.push(k); }
      }
      guard++;
    } while (cursor !== '0' && keys.length < need && guard < 1000);

    let filtered = keys;
    if (group === 'Other') {
      const pipe = this.client!.pipeline();
      for (const k of keys) { pipe.type(k); }
      const types = (await pipe.exec()) ?? [];
      const MAIN = new Set(['string', 'hash', 'list', 'set', 'zset', 'stream']);
      filtered = keys.filter((k, i) => {
        const t = types[i]?.[1];
        return !!t && !MAIN.has(String(t));
      });
    }

    const start = page * pageSize;
    const pageKeys = filtered.slice(start, start + pageSize + 1);
    const hasMore = filtered.length > start + pageSize;

    const pipe = this.client!.pipeline();
    for (const k of pageKeys) { pipe.ttl(k); pipe.type(k); pipe.strlen(k); }
    const out = (await pipe.exec()) ?? [];

    const rows: unknown[][] = pageKeys.map((k, i) => {
      const ttl = out[i * 3]?.[1];
      const type = out[i * 3 + 1]?.[1] ?? redisType ?? 'unknown';
      const size = out[i * 3 + 2]?.[1];
      return [k, String(type), typeof ttl === 'number' ? ttl : -1, typeof size === 'number' ? size : 0];
    });

    const { columns } = this.getKeyListColumns();
    return {
      hasMore,
      result: { columns, rows, affectedRows: 0, executionTime: 0, truncated: false, messages: hasMore ? ['SCAN-based approximate pagination'] : [] },
    };
  }

  /** List entries of a single key (entry grid). */
  async getEntryList(type: string, key: string, page = 0, pageSize = 100): Promise<{ result: QueryResult; hasMore: boolean }> {
    this.ensureConnected();
    const columns = this.getEntryColumns(type);
    const ttl = await this.client!.ttl(key).catch(() => -1);
    const count = pageSize + 1;

    if (type === 'string') {
      const raw = await this.client!.get(key);
      const preview = raw == null ? '' : this.truncate(String(raw));
      const size = raw == null ? 0 : Buffer.byteLength(raw);
      return {
        hasMore: false,
        result: { columns, rows: raw == null ? [] : [[key, preview, ttl, size]], affectedRows: 0, executionTime: 0, truncated: !!raw && raw.length > this.previewBytes(), messages: [] },
      };
    }

    if (type === 'hash') {
      const len = await this.client!.hlen(key);
      const capped = len > 1000 ? 1000 : len;
      const res = await this.client!.hscan(key, 0, 'COUNT', Math.max(count, capped));
      const pairs = this.pairsFromFlat(res[1]).slice(0, count);
      const rows = pairs.map(([f, v]) => [f, this.truncate(v), ttl]);
      return { hasMore: res[0] !== '0' || len > count, result: { columns, rows, affectedRows: 0, executionTime: 0, truncated: len > count, messages: len > count ? [`HASH truncated to ${count} of ${len} fields`] : [] } };
    }

    if (type === 'list') {
      const start = page * pageSize;
      const arr = await this.client!.lrange(key, start, start + pageSize);
      const rows = arr.map((v: string, i: number) => [start + i, this.truncate(v), ttl]);
      return { hasMore: arr.length > pageSize, result: { columns, rows, affectedRows: 0, executionTime: 0, truncated: false, messages: [] } };
    }

    if (type === 'set') {
      const members = await this.client!.smembers(key);
      const slice = members.slice(page * pageSize, page * pageSize + count);
      const rows = slice.map((m: string) => [m, ttl]);
      return { hasMore: members.length > page * pageSize + pageSize, result: { columns, rows, affectedRows: 0, executionTime: 0, truncated: false, messages: [] } };
    }

    if (type === 'zset') {
      const start = page * pageSize;
      const flat = await this.client!.zrange(key, start, start + pageSize, 'WITHSCORES');
      const rows: unknown[][] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        rows.push([flat[i], flat[i + 1], ttl]);
      }
      return { hasMore: flat.length > pageSize * 2, result: { columns, rows, affectedRows: 0, executionTime: 0, truncated: false, messages: [] } };
    }

    if (type === 'stream') {
      const entries = await this.client!.xrange(key, '-', '+', 'COUNT', count);
      const rows = entries.slice(0, count).map((e: any) => {
        const fields = this.streamFields(e);
        return [e.id, JSON.stringify(fields), ttl];
      });
      return { hasMore: entries.length > pageSize, result: { columns, rows, affectedRows: 0, executionTime: 0, truncated: false, messages: [] } };
    }

    return { hasMore: false, result: { columns, rows: [], affectedRows: 0, executionTime: 0, truncated: false, messages: [] } };
  }

  /** Translate grid edits into Redis commands. Mirrors the SQL saveChanges flow. */
  async applyRedisEdits(table: string, changedRows: any[], columns: string[]): Promise<void> {
    this.ensureConnected();
    const decoded = decodeRedisKeyTable(table);

    if (!decoded) {
      // Key-list view edits: only UNLINK (delete) and EXPIRE (ttl change).
      const keyIdx = columns.indexOf('key');
      const ttlIdx = columns.indexOf('ttl');
      for (const row of changedRows) {
        const k = row.original?.[keyIdx] ?? row.data?.[keyIdx];
        if (!k) { continue; }
        if (row.status === 'deleted') {
          await this.client!.unlink(k);
        } else if (row.status === 'modified' && ttlIdx >= 0 && (row.changedCols ?? []).includes(ttlIdx)) {
          const newTtl = Number(row.data[ttlIdx]);
          if (newTtl === -1 || newTtl <= 0) { await this.client!.persist(k); }
          else { await this.client!.expire(k, newTtl); }
        }
      }
      return;
    }

    const { type, key } = decoded;
    const pkCol = this.entryPkColumn(type);
    const pkIdx = columns.indexOf(pkCol);
    const valueIdx = columns.indexOf('value');
    const scoreIdx = columns.indexOf('score');

    for (const row of changedRows) {
      const pkVal = row.data?.[pkIdx] ?? row.original?.[pkIdx];
      if (pkVal == null) { continue; }
      if (row.status === 'deleted') {
        const orig = row.original?.[pkIdx];
        if (type === 'hash') { await this.client!.hdel(key, orig); }
        else if (type === 'list') { await this.client!.lrem(key, 1, row.original?.[valueIdx] ?? orig); }
        else if (type === 'set') { await this.client!.srem(key, orig); }
        else if (type === 'zset') { await this.client!.zrem(key, orig); }
        else if (type === 'string') { await this.client!.unlink(key); }
        continue;
      }
      if (type === 'hash') { await this.client!.hset(key, pkVal, String(row.data?.[valueIdx] ?? '')); }
      else if (type === 'list') { await this.client!.lset(key, Number(pkVal), String(row.data?.[valueIdx] ?? '')); }
      else if (type === 'set') { await this.client!.sadd(key, pkVal); }
      else if (type === 'zset') { await this.client!.zadd(key, Number(row.data?.[scoreIdx] ?? 0), pkVal); }
      else if (type === 'string') { await this.client!.set(key, String(row.data?.[valueIdx] ?? ''), 'KEEPTTL'); }
    }
  }

  /** Export all keys (matching filter) as a plain JSON object for dump. */
  async exportKeys(filter?: string, scanCount = 500): Promise<Record<string, unknown>> {
    this.ensureConnected();
    const match = filter && filter.trim() ? filter.trim() : '*';
    const out: Record<string, any> = {};
    let cursor = '0';
    let guard = 0;
    do {
      const res = await this.client!.scan(cursor, 'MATCH', match, 'COUNT', scanCount);
      cursor = res[0];
      const keys = res[1];
      const pipe = this.client!.pipeline();
      for (const k of keys) { pipe.type(k); }
      const types = (await pipe.exec()) ?? [];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const type = String(types[i]?.[1] ?? 'string');
        const ttl = await this.client!.ttl(k);
        const entry: any = { type, ttl };
        if (type === 'string') { entry.value = await this.client!.get(k); }
        else if (type === 'hash') { entry.value = await this.client!.hgetall(k); }
        else if (type === 'list') { entry.value = await this.client!.lrange(k, 0, -1); }
        else if (type === 'set') { entry.value = await this.client!.smembers(k); }
        else if (type === 'zset') { entry.value = await this.client!.zrange(k, 0, -1, 'WITHSCORES'); }
        else if (type === 'stream') { entry.value = (await this.client!.xrange(k, '-', '+')).map(e => ({ id: e[0], fields: this.streamFields(e) })); }
        else { entry.value = await this.client!.get(k); }
        out[k] = entry;
      }
      guard++;
    } while (cursor !== '0' && guard < 5000);
    return out;
  }

  /** Import keys from an export object produced by exportKeys(). */
  async importKeys(data: Record<string, any>): Promise<number> {
    this.ensureConnected();
    let n = 0;
    for (const [key, entry] of Object.entries(data)) {
      const type = entry.type ?? 'string';
      const value = entry.value;
      const ttl = entry.ttl;
      switch (type) {
        case 'string': await this.client!.set(key, value ?? ''); break;
        case 'hash': await this.client!.del(key); if (value) { await this.client!.hset(key, value); } break;
        case 'list': await this.client!.del(key); if (Array.isArray(value)) { for (const v of value) { await this.client!.rpush(key, v); } } break;
        case 'set': await this.client!.del(key); if (Array.isArray(value)) { for (const v of value) { await this.client!.sadd(key, v); } } break;
        case 'zset': await this.client!.del(key); if (Array.isArray(value)) { for (let i = 0; i + 1 < value.length; i += 2) { await this.client!.zadd(key, Number(value[i + 1]), value[i]); } } break;
        case 'stream': await this.client!.del(key); if (Array.isArray(value)) { for (const e of value) { await this.client!.xadd(key, e.id, ...this.flattenFields(e.fields)); } } break;
        default: await this.client!.set(key, String(value ?? ''));
      }
      if (typeof ttl === 'number' && ttl > 0) { await this.client!.expire(key, ttl); }
      n++;
    }
    return n;
  }

  setScanCount(n: number): void {
    if (n > 0) { this.overrideScanCount = n; }
  }

  private overrideScanCount?: number;

  private previewBytes(): number {
    return vscode_Setting('redis.maxValuePreview', 512);
  }

  private truncate(v: string): string {
    const max = this.previewBytes();
    return v.length > max ? `${v.slice(0, max)}…` : v;
  }

  private pairsFromFlat(flat: unknown[]): [string, string][] {
    const pairs: [string, string][] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      pairs.push([String(flat[i]), String(flat[i + 1])]);
    }
    return pairs;
  }

  private streamFields(e: any): Record<string, string> {
    if (e && typeof e === 'object' && e.message && typeof e.message === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.message as Record<string, unknown>)) { out[k] = String(v); }
      return out;
    }
    if (Array.isArray(e) && e.length >= 2 && Array.isArray(e[1])) {
      const out: Record<string, string> = {};
      const flat = e[1] as unknown[];
      for (let i = 0; i + 1 < flat.length; i += 2) { out[String(flat[i])] = String(flat[i + 1]); }
      return out;
    }
    return {};
  }

  private flattenFields(fields: Record<string, unknown>): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(fields ?? {})) { out.push(k, String(v)); }
    return out;
  }

  // ── Private helpers ──

  private async execLine(line: string): Promise<QueryResult> {
    const tokens = this.tokenize(line);
    if (tokens.length === 0) {
      throw new Error('Empty command');
    }
    const cmd = tokens[0];
    const upper = cmd.toUpperCase();
    const category = classifyRedisCommand(cmd);
    if (category === 'danger') {
      throw new Error(`Command ${cmd} is blocked for safety.`);
    }
    const blocked = this.blockedCommands();
    if (blocked.has(upper)) {
      throw new Error(`Command ${cmd} is blocked by sqlens.redis.blockedCommands.`);
    }
    const args = tokens.slice(1);
    const raw = await (this.client as any).call(upper, ...args);
    return this.formatReply(upper, args, raw);
  }

  private formatReply(cmd: string, args: string[], raw: unknown): QueryResult {
    const empty = (msg: string): QueryResult => ({
      columns: [], rows: [], affectedRows: 0, executionTime: 0, truncated: false, messages: [msg],
    });

    if (raw === null || raw === undefined) {
      return empty('(nil)');
    }

    // Status replies (e.g. "OK", "QUEUED") → report as message.
    if (typeof raw === 'string') {
      const numeric = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
      if (!isNaN(numeric)) {
        return {
          columns: [{ ...this.header('value', NormalizedColumnType.Integer) }],
          rows: [[numeric]], affectedRows: 0, executionTime: 0, truncated: false, messages: [],
        };
      }
      return empty(raw);
    }

    if (typeof raw === 'number' || typeof raw === 'boolean') {
      return {
        columns: [{ ...this.header('value', NormalizedColumnType.Integer) }],
        rows: [[raw === true ? 1 : raw === false ? 0 : raw]], affectedRows: 0, executionTime: 0, truncated: false, messages: [],
      };
    }

    if (Buffer.isBuffer(raw)) {
      return {
        columns: [{ ...this.header('value', NormalizedColumnType.String) }],
        rows: [[raw.toString('utf8')]], affectedRows: 0, executionTime: 0, truncated: false, messages: [],
      };
    }

    if (Array.isArray(raw)) {
      // HGETALL → field/value pairs.
      if (cmd === 'HGETALL') {
        const rows: unknown[][] = [];
        for (let i = 0; i + 1 < raw.length; i += 2) {
          rows.push([raw[i], this.decode(raw[i + 1])]);
        }
        return {
          columns: [this.header('field', NormalizedColumnType.String), this.header('value', NormalizedColumnType.String)],
          rows, affectedRows: 0, executionTime: 0, truncated: false, messages: [],
        };
      }
      // ZRANGE ... WITHSCORES → member/score pairs.
      if (cmd === 'ZRANGE' && args.includes('WITHSCORES')) {
        const rows: unknown[][] = [];
        for (let i = 0; i + 1 < raw.length; i += 2) {
          rows.push([raw[i], this.decode(raw[i + 1])]);
        }
        return {
          columns: [this.header('member', NormalizedColumnType.String), this.header('score', NormalizedColumnType.Float)],
          rows, affectedRows: 0, executionTime: 0, truncated: false, messages: [],
        };
      }
      // Generic list/set → one value column.
      const rows = raw.map(r => [this.decode(r)]);
      return {
        columns: [this.header('value', NormalizedColumnType.String)],
        rows, affectedRows: 0, executionTime: 0, truncated: false, messages: [],
      };
    }

    // Object replies (e.g. XINFO) → key/value rows.
    if (typeof raw === 'object') {
      const entries = Object.entries(raw as Record<string, unknown>);
      const rows = entries.map(([k, v]) => [k, this.decode(v)]);
      return {
        columns: [this.header('field', NormalizedColumnType.String), this.header('value', NormalizedColumnType.String)],
        rows, affectedRows: 0, executionTime: 0, truncated: false, messages: [],
      };
    }

    return empty(String(raw));
  }

  private decode(v: unknown): unknown {
    if (Buffer.isBuffer(v)) { return v.toString('utf8'); }
    return v;
  }

  private header(name: string, normalizedType: NormalizedColumnType): ColumnHeader {
    return {
      name,
      type: name,
      normalizedType,
      nullable: true,
      isPrimaryKey: false,
      isAutoIncrement: false,
      defaultValue: null,
      rawType: name,
    };
  }

  private keyCol(): ColumnInfo {
    return {
      name: 'key', type: 'key', normalizedType: NormalizedColumnType.String, nullable: false,
      defaultValue: null, isPrimaryKey: true, isAutoIncrement: false, isUnique: true,
      ordinalPosition: 1,
    };
  }

  private col(name: string, normalizedType: NormalizedColumnType, nullable: boolean): ColumnInfo {
    return {
      name, type: name, normalizedType, nullable,
      defaultValue: null, isPrimaryKey: false, isAutoIncrement: false, isUnique: false,
      ordinalPosition: 1,
    };
  }

  /** Scan the whole db, counting keys per type. Bounded to avoid runaway scans. */
  private async scanTypeCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>([
      ['string', 0], ['hash', 0], ['list', 0], ['set', 0], ['zset', 0], ['stream', 0], ['other', 0],
    ]);
    const scanCount = this.overrideScanCount ?? vscode_Setting('redis.scanCount', 100);
    const cap = 500_000; // safety cap on keys examined for the count
    let cursor = '0';
    let examined = 0;
    try {
      do {
        const res = await this.client!.scan(cursor, 'COUNT', scanCount);
        cursor = res[0];
        const keys: string[] = res[1];
        if (keys.length === 0) { continue; }
        // Batch TYPE lookups via pipeline.
        const pipeline = this.client!.pipeline();
        for (const k of keys) { pipeline.type(k); }
        const results = await pipeline.exec();
        for (const r of results ?? []) {
          const type = (Array.isArray(r) ? r[1] : undefined) as string | undefined;
          const bucket = type && counts.has(type) ? type : 'other';
          counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
        }
        examined += keys.length;
      } while (cursor !== '0' && examined < cap);
    } catch (err) {
      Logger.getInstance().logError(`[redis] scanTypeCounts failed: ${err}`);
    }
    return counts;
  }

  private createClient(config: ConnectionConfig, lazy = false): Redis {
    const dbIndex = this.parseDbIndex(config.database);
    const useTls = config.options?.tls === true || config.options?.scheme === 'rediss';
    const maxReconnect = vscode_Setting('mcp.maxReconnectAttempts', 3);
    const base: RedisOptions = {
      host: config.host,
      port: config.port || 6379,
      db: dbIndex,
      password: config.password || undefined,
      username: config.username || undefined,
      lazyConnect: lazy,
      // Stop silent reconnect loops: give up after maxReconnectAttempts.
      retryStrategy: (times: number) => {
        if (times > maxReconnect) { return null; }
        return Math.min(times * 200, 2000);
      },
    };
    if (useTls) {
      base.tls = {};
    }

    const mode = (config.options as any)?.redisMode as string | undefined;
    const nodes = (config.options as any)?.redisNodes as string[] | undefined;
    const sentinelName = (config.options as any)?.redisSentinelName as string | undefined;

    if (mode === 'cluster' && Array.isArray(nodes) && nodes.length > 0) {
      return new Redis.Cluster(
        nodes.map(n => this.parseHostPort(n)),
        { redisOptions: { ...base, lazyConnect: lazy }, lazyConnect: lazy },
      ) as unknown as Redis;
    }
    if (mode === 'sentinel' && Array.isArray(nodes) && nodes.length > 0 && sentinelName) {
      return new Redis({ ...base, sentinels: nodes.map(n => this.parseHostPort(n)), name: sentinelName });
    }
    return new Redis(base);
  }

  private parseHostPort(s: string): { host: string; port: number } {
    const [h, p] = s.split(':');
    return { host: h, port: p ? parseInt(p, 10) || 6379 : 6379 };
  }

  private parseDbIndex(database: string | undefined): number {
    const n = parseInt(database ?? '0', 10);
    if (isNaN(n) || n < 0) { return 0; }
    return n;
  }

  private blockedCommands(): Set<string> {
    const list = vscode_Setting<string[]>('redis.blockedCommands', []);
    return new Set(list.map(c => c.toUpperCase()));
  }

  private parseInfoField(info: string, field: string): string | undefined {
    const m = new RegExp(`(?:^|\\r?\\n)${field}:(.+)(?:\\r?\\n|$)`).exec(info);
    return m ? m[1].trim() : undefined;
  }

  /** Tokenize a single command line, respecting single/double quotes. */
  private tokenize(line: string): string[] {
    const tokens: string[] = [];
    let cur = '';
    let quote: '"' | "'" | null = null;
    let hasToken = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) {
          quote = null;
        } else if (ch === '\\' && quote === '"' && i + 1 < line.length) {
          cur += line[++i];
        } else {
          cur += ch;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        hasToken = true;
        continue;
      }
      if (ch === ' ' || ch === '\t') {
        if (hasToken) {
          tokens.push(cur);
          cur = '';
          hasToken = false;
        }
        continue;
      }
      cur += ch;
      hasToken = true;
    }
    if (hasToken && cur.length > 0) {
      tokens.push(cur);
    }
    return tokens;
  }
}

/**
 * Read a sqlens.redis.* / sqlens.mcp.* setting without importing vscode at the
 * top level (kept lazy so the module loads in tests / non-VS Code contexts).
 */
function vscode_Setting<T>(name: string, fallback: T): T {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    const val = vscode.workspace.getConfiguration('sqlens').get(name, fallback);
    return val as T;
  } catch {
    return fallback;
  }
}
