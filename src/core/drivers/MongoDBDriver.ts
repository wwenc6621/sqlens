import { MongoClient, Db, ObjectId } from 'mongodb';
import { BaseDriver, RowEdit } from './DatabaseDriver';
import { Logger } from '../utils/Logger';
import { driverSetting, driverSettingOrOption } from '../utils/settings';
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

/**
 * MongoDB driver (official `mongodb` Node client).
 *
 * See docs/MONGODB_SUPPORT_DESIGN.md. Key points:
 *  - The tree has a real database layer (listDatabases → collections).
 *  - The editor accepts mongosh-style method calls, e.g.
 *      db.orders.find({ status: 'PAID' }).sort({ createdAt: -1 }).limit(100)
 *    parsed structurally — user JS is never evaluated (security red line).
 *    `ObjectId('...')` / `ISODate('...')` / `new Date('...')` literals are
 *    substituted before JSON.parse and converted to BSON values.
 *  - Document rows are dot-flattened with `_id` as the first column
 *    (ObjectId rendered as hex); nested objects/arrays arrive as JSON cells.
 */
export class MongoDBDriver extends BaseDriver {
  readonly driverType = 'mongodb';

  private client: MongoClient | null = null;
  private currentDb: string = '';
  /** Row cap applied by MCP (find without .limit(), aggregate gets a $limit). */
  private rowLimit?: number;
  /** `_id` range cursor per collection, advanced as the grid pages forward. */
  private cursorCache = new Map<string, { lastId?: unknown; nextOffset: number }>();
  /** Test/diagnostic override for the deep-skip threshold. */
  private deepSkipOverride?: number;

  /** Override the deep-skip threshold (0 keeps the default). */
  setDeepSkipThreshold(n: number): void {
    if (n > 0) { this.deepSkipOverride = n; }
  }

  // ── In-grid document editing (RowEditCapable) ──

  /**
   * Load one grid page. Shallow pages use skip/limit; beyond the deep-skip
   * threshold the `_id` range cursor is used instead (fast and stable) when
   * the previous page was loaded in order.
   */
  pageQuery(table: string, limit: number, _schema?: string, offset = 0): string {
    const DEEP_SKIP = this.deepSkipOverride ?? 10_000;
    if (offset > DEEP_SKIP) {
      const cursor = this.cursorCache.get(table);
      if (cursor && cursor.nextOffset === offset && cursor.lastId !== undefined) {
        // ObjectId hexes must go back to ObjectId — a string never compares
        // greater-than an ObjectId, which would silently return nothing.
        const id = typeof cursor.lastId === 'string' && /^[0-9a-fA-F]{24}$/.test(cursor.lastId)
          ? `ObjectId('${cursor.lastId}')`
          : JSON.stringify(cursor.lastId);
        return `db.${table}.find({ _id: { $gt: ${id} } }).limit(${limit})`;
      }
      // Fall through to skip (the driver warns about the cost in messages).
    }
    const skip = offset > 0 ? `.skip(${offset})` : '';
    return `db.${table}.find({})${skip}.limit(${limit})`;
  }

  /**
   * Apply grid changes with $set (never whole-document replace, so concurrent
   * edits to other fields survive), insertOne and deleteOne.
   */
  async applyRowEdits(table: string, rows: RowEdit[], columns: string[], pkColumns: string[]): Promise<number> {
    this.ensureConnected();
    const coll = this.db().collection(table);
    const idCol = pkColumns.includes('_id') ? columns.indexOf('_id') : 0;
    let applied = 0;

    for (const row of rows) {
      if (row.status === 'modified') {
        const idValue = row.original[idCol];
        const set: Record<string, unknown> = {};
        for (const ci of row.changedCols) {
          if (columns[ci] === '_id') { continue; }
          set[columns[ci]] = row.data[ci];
        }
        if (Object.keys(set).length === 0) { continue; }
        await coll.updateOne({ _id: toMongoId(idValue) } as never, { $set: set });
        applied++;
      } else if (row.status === 'deleted') {
        await coll.deleteOne({ _id: toMongoId(row.original[idCol]) } as never);
        applied++;
      } else if (row.status === 'added') {
        const doc: Record<string, unknown> = {};
        columns.forEach((name, ci) => {
          if (name !== '_id' && row.data[ci] !== null && row.data[ci] !== undefined) {
            doc[name] = row.data[ci];
          }
        });
        await coll.insertOne(doc as never);
        applied++;
      }
    }
    return applied;
  }

  /** MCP maxRows → query limit for reads. */
  setRowLimit(n: number): void {
    if (n > 0) { this.rowLimit = n; }
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.client = new MongoClient(this.buildUri(config), { serverSelectionTimeoutMS: 10_000 });
    try {
      await this.client.connect();
      await this.client.db('admin').command({ ping: 1 });
    } catch (err) {
      await this.client.close().catch(() => {});
      this.client = null;
      throw err;
    }

    this.currentDb = config.database || 'test';
    this._config = config;
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    this._isConnected = false;
    this._config = null;
  }

  async testConnection(config: ConnectionConfig): Promise<{ success: boolean; message: string; serverInfo?: ServerInfo }> {
    let testClient: MongoClient | null = null;
    try {
      testClient = new MongoClient(this.buildUri(config), { serverSelectionTimeoutMS: 10_000 });
      await testClient.connect();
      const build = await testClient.db('admin').command({ buildInfo: 1 });
      const version = (build as { version?: string }).version || 'unknown';
      return {
        success: true,
        message: `Connected to MongoDB ${version}`,
        serverInfo: { version },
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (testClient) {
        await testClient.close().catch(() => {});
      }
    }
  }

  /**
   * Execute a mongosh-style method call text, parsed structurally (no eval).
   */
  async query(text: string, _params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();
    const start = performance.now();

    const parsed = parseMongoCall(text);
    const executionTime = () => Math.round(performance.now() - start);

    try {
      if (parsed.kind === 'use') {
        await this.switchDatabase(parsed.database ?? '');
        Logger.getInstance().logSQL(text, executionTime());
        return {
          columns: [{ name: 'result', type: 'string', normalizedType: NormalizedColumnType.String, nullable: false, isPrimaryKey: false, isAutoIncrement: false, defaultValue: null, rawType: 'string' }],
          rows: [[`Switched to db ${parsed.database}`]],
          affectedRows: 0, executionTime: executionTime(), truncated: false, messages: [],
        };
      }

      const db = parsed.database ? this.client!.db(parsed.database) : this.db();
      const coll = db.collection(parsed.collection!);
      let result: QueryResult;

      switch (parsed.method) {
        case 'find': {
          let cursor = coll.find((parsed.args[0] ?? {}) as never, parsed.args[1] ? { projection: parsed.args[1] as never } : undefined);
          const opts = parsed.chain;
          if (opts.sort) { cursor = cursor.sort(opts.sort as Record<string, 1 | -1>); }
          if (opts.skip !== undefined) { cursor = cursor.skip(opts.skip); }
          const limit = opts.limit ?? this.rowLimit;
          if (limit !== undefined) { cursor = cursor.limit(limit); }
          const docs = await cursor.toArray();
          result = docsToResult(docs);
          // Track the _id range cursor for the next deep page.
          const lastDoc = docs[docs.length - 1] as { _id?: unknown } | undefined;
          if (lastDoc?._id !== undefined) {
            this.cursorCache.set(parsed.collection!, {
              lastId: lastDoc._id instanceof ObjectId ? lastDoc._id.toHexString() : lastDoc._id,
              nextOffset: (opts.skip ?? 0) + docs.length,
            });
          }
          // Deep skip is O(n) on the server; the cursor above avoids it when
          // paging in order, so only warn for the unordered fallback.
          if ((opts.skip ?? 0) > 10_000) {
            result.messages.push('Deep pagination: skip becomes slow — paging forward in order switches to a fast _id range cursor automatically.');
          }
          break;
        }
        case 'findOne': {
          const doc = await coll.findOne(parsed.args[0] as never);
          result = docsToResult(doc ? [doc] : []);
          break;
        }
        case 'countDocuments': {
          const n = await coll.countDocuments(parsed.args[0] ?? {});
          result = {
            columns: [{ name: 'count', type: 'number', normalizedType: NormalizedColumnType.Integer, nullable: false, isPrimaryKey: false, isAutoIncrement: false, defaultValue: null, rawType: 'number' }],
            rows: [[n]], affectedRows: 0, executionTime: 0, truncated: false, messages: [],
          };
          break;
        }
        case 'distinct': {
          const values = await coll.distinct(parsed.args[0] as string, parsed.args[1] as never);
          result = {
            columns: [{ name: `distinct ${parsed.args[0]}`, type: 'string', normalizedType: NormalizedColumnType.String, nullable: true, isPrimaryKey: false, isAutoIncrement: false, defaultValue: null, rawType: 'array' }],
            rows: [values.map(v => bsonToGrid(v))], affectedRows: 0, executionTime: 0, truncated: false, messages: [],
          };
          break;
        }
        case 'aggregate': {
          const pipeline = [...(parsed.args[0] as unknown[] ?? [])];
          // MCP row cap → append a $limit stage when none is present.
          if (this.rowLimit && !pipeline.some(stage => stage && typeof stage === 'object' && '$limit' in (stage as object))) {
            pipeline.push({ $limit: this.rowLimit });
          }
          const docs = await coll.aggregate(pipeline as never).toArray();
          result = docsToResult(docs);
          break;
        }
        case 'insertOne': {
          const r = await coll.insertOne(parsed.args[0] as never);
          result = ackToResult(`Inserted ${r.acknowledged ? '1' : '0'} document`, [{ insertedId: r.insertedId.toString() }]);
          break;
        }
        case 'insertMany': {
          const r = await coll.insertMany(parsed.args[0] as never);
          result = ackToResult(`Inserted ${r.insertedCount} documents`, [{ insertedCount: r.insertedCount }]);
          break;
        }
        case 'updateOne':
        case 'updateMany': {
          const r = await (parsed.method === 'updateOne'
            ? coll.updateOne(parsed.args[0] as never, parsed.args[1] as never)
            : coll.updateMany(parsed.args[0] as never, parsed.args[1] as never));
          result = ackToResult(`Matched ${r.matchedCount}, modified ${r.modifiedCount}`, [
            { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount },
          ]);
          break;
        }
        case 'replaceOne': {
          const r = await coll.replaceOne(parsed.args[0] as never, parsed.args[1] as never);
          result = ackToResult(`Matched ${r.matchedCount}, modified ${r.modifiedCount}`, [
            { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount },
          ]);
          break;
        }
        case 'deleteOne':
        case 'deleteMany': {
          const r = parsed.method === 'deleteOne' ? await coll.deleteOne(parsed.args[0] as never) : await coll.deleteMany(parsed.args[0] as never);
          result = ackToResult(`Deleted ${r.deletedCount} document(s)`, [{ deletedCount: r.deletedCount }]);
          break;
        }
        default:
          throw new Error(`Unsupported method: ${parsed.method}. Supported: find, findOne, countDocuments, distinct, aggregate, insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, deleteMany, use <db>`);
      }

      result.executionTime = executionTime();
      Logger.getInstance().logSQL(text, result.executionTime);
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      Logger.getInstance().logSQL(text, undefined, errMsg);
      throw err;
    }
  }

  /** Split multiple mongosh calls — semicolons are valid inside JSON, so a
   *  line-boundary based split on `db.` / `use ` statements is used. */
  async queryMultiple(text: string): Promise<QueryResult[]> {
    const blocks = splitMongoStatements(text);
    const results: QueryResult[] = [];
    for (const block of blocks) {
      if (block.trim()) {
        results.push(await this.query(block));
      }
    }
    return results;
  }

  /**
   * MongoDB cancellation needs the server-side operation id (killOp), which
   * the driver only exposes via currentOp lookups; the query is left to time
   * out server-side instead.
   */
  async cancelQuery(): Promise<void> {
    // no-op (see above)
  }

  // ── Collection management, transfer, explain (P4) ──

  async createCollection(name: string): Promise<void> {
    this.ensureConnected();
    await this.db().createCollection(name);
  }

  /** Create an index from a JSON key spec, e.g. `{ "status": 1 }`. */
  async createIndex(collection: string, keyJson: string, unique = false): Promise<string> {
    this.ensureConnected();
    let keys: Record<string, unknown>;
    try {
      keys = JSON.parse(keyJson);
    } catch {
      throw new Error(`Index key must be JSON, e.g. { "field": 1 }. Got: ${keyJson.slice(0, 60)}`);
    }
    return this.db().collection(collection).createIndex(keys as never, unique ? { unique: true } : {});
  }

  /** Export documents (optionally filtered) as plain JSON documents. */
  async exportJson(collection: string, filterJson?: string, limit = 1000): Promise<unknown[]> {
    this.ensureConnected();
    let filter: Record<string, unknown> = {};
    if (filterJson?.trim()) {
      try {
        filter = JSON.parse(filterJson);
      } catch {
        throw new Error(`Filter must be JSON, e.g. { "status": "PAID" }. Got: ${filterJson.slice(0, 60)}`);
      }
    }
    return this.db().collection(collection).find(filter as never).limit(limit).toArray();
  }

  async importJson(collection: string, docs: unknown[]): Promise<number> {
    this.ensureConnected();
    if (!Array.isArray(docs) || docs.length === 0) { return 0; }
    const result = await this.db().collection(collection).insertMany(docs as never);
    return result.insertedCount;
  }

  /** Explain a mongosh read call — `db.<coll>.find({...})` etc. */
  async explainQuery(text: string): Promise<QueryResult> {
    this.ensureConnected();
    const parsed = parseMongoCall(text);
    if (parsed.kind !== 'call' || !parsed.collection || !parsed.method) {
      throw new Error('EXPLAIN needs a mongosh call, e.g. db.orders.find({ status: "PAID" }).');
    }
    const coll = this.db(parsed.database || undefined).collection(parsed.collection);

    let cursor: unknown;
    switch (parsed.method) {
      case 'find':
      case 'countDocuments':
        cursor = coll.find((parsed.args[0] ?? {}) as never);
        break;
      case 'aggregate':
        cursor = coll.aggregate(parsed.args[0] as never);
        break;
      default:
        throw new Error(`EXPLAIN is not supported for ${parsed.method}. Use find/aggregate.`);
    }

    const plan = await (cursor as { explain: () => Promise<unknown> }).explain();
    return {
      columns: [{
        name: 'plan',
        type: 'json',
        normalizedType: NormalizedColumnType.JSON,
        nullable: false,
        isPrimaryKey: false,
        isAutoIncrement: false,
        defaultValue: null,
        rawType: 'json',
      }],
      rows: [[JSON.stringify(plan, null, 2)]],
      affectedRows: 0,
      executionTime: 0,
      truncated: false,
      messages: [],
    };
  }

  /**
   * Extra mongosh methods beyond the structured subset, gated by
   * `sqlens.mongo.allowShellEval` (never an arbitrary JS evaluator — only the
   * whitelist below is translated to driver calls).
   */
  async evalShell(text: string): Promise<QueryResult> {
    this.ensureConnected();
    if (!driverSetting('mongo.allowShellEval', false)) {
      throw new Error('Full mongosh passthrough is disabled. Set "sqlens.mongo.allowShellEval" to true to enable the extended method whitelist.');
    }

    const match = text.trim().match(/^db\.([\w$.-]+)\.(\w+)\(([\s\S]*)\)$/);
    if (!match) {
      throw new Error('Passthrough expects `db.<collection>.<method>(...)`.');
    }
    const [, collection, method, rawArgs] = match;
    const coll = this.db().collection(collection);
    const rows: unknown[][] = [];
    let columns: string[] = ['result'];

    switch (method.toLowerCase()) {
      case 'stats': {
        const stats = await coll.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
        columns = ['stats'];
        rows.push([JSON.stringify(stats[0] ?? {}, null, 2)]);
        break;
      }
      case 'listindexes':
      case 'indexes': {
        const indexes = await coll.listIndexes().toArray();
        columns = ['indexes'];
        rows.push([JSON.stringify(indexes, null, 2)]);
        break;
      }
      case 'validate': {
        const validated = await this.db().command({ validate: collection });
        columns = ['validate'];
        rows.push([JSON.stringify(validated, null, 2)]);
        break;
      }
      case 'drop': {
        await coll.drop();
        rows.push(['collection dropped']);
        break;
      }
      case 'renamecollection': {
        const target = JSON.parse(rawArgs.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3').replace(/'/g, '"') || '{}');
        await this.db().renameCollection(collection, String((target as { to?: string }).to ?? ''), { dropTarget: false });
        rows.push([`renamed to ${(target as { to?: string }).to ?? '?'}`]);
        break;
      }
      default:
        throw new Error(`Method "${method}" is not in the passthrough whitelist (stats, listIndexes, validate, drop, renameCollection).`);
    }

    const columnHeaders: ColumnHeader[] = columns.map(name => ({
      name,
      type: 'json',
      normalizedType: NormalizedColumnType.JSON,
      nullable: false,
      isPrimaryKey: false,
      isAutoIncrement: false,
      defaultValue: null,
      rawType: 'json',
    }));

    return {
      columns: columnHeaders,
      rows,
      affectedRows: 0,
      executionTime: 0,
      truncated: false,
      messages: [],
    };
  }

  // ── Schema introspection ──

  async getDatabases(): Promise<DatabaseInfo[]> {
    this.ensureConnected();
    const res = await this.client!.db('admin').command({ listDatabases: 1 });
    return ((res as { databases?: Array<{ name: string }> }).databases || [])
      .map(d => ({ name: d.name }));
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    return [];
  }

  /** Fast collection name listing for progressive tree loading. */
  async getTableNames(schema?: string): Promise<{ name: string; type: 'table' | 'view' }[]> {
    this.ensureConnected();
    const collections = await this.db(schema || undefined).listCollections().toArray();
    return collections.map(coll => ({
      name: coll.name,
      type: coll.type === 'view' ? 'view' as const : 'table' as const,
    }));
  }

  async getTables(schema?: string): Promise<TableInfo[]> {
    this.ensureConnected();
    const db = this.db(schema || undefined);
    const collections = await db.listCollections().toArray();

    return Promise.all(collections.map(async coll => {
      // Fast, accurate doc count via the $collStats aggregation; fall back to
      // 0 when the collection is a view or stats are unavailable.
      let rowCount: number | undefined;
      if (coll.type !== 'view') {
        try {
          const stats = await db.collection(coll.name).aggregate([{ $collStats: { count: {} } }]).toArray();
          rowCount = (stats[0] as { count?: number })?.count;
        } catch { rowCount = undefined; }
      }
      return {
        name: coll.name,
        schema: schema || this.currentDb,
        type: coll.type === 'view' ? 'view' as const : 'table' as const,
        engine: coll.type === 'view' ? 'view' : 'collection',
        rowCount,
      };
    }));
  }

  /**
   * Sample documents and derive the field union (dot paths) with types —
   * MongoDB has no fixed schema.
   */
  async getColumns(collection: string, schema?: string): Promise<ColumnInfo[]> {
    this.ensureConnected();
    const sampleSize = driverSettingOrOption('mongo.sampleSize', this._config?.options?.sampleSize, 100);
    const docs = await this.db(schema || undefined).collection(collection)
      .find({}).limit(sampleSize).toArray();

    // fieldName → dominant BSON type name.
    const fieldTypes = new Map<string, string>();
    for (const doc of docs) {
      collectFieldTypes(doc, '', fieldTypes);
    }

    return [...fieldTypes.entries()].map(([name, type], i) => ({
      name,
      type,
      normalizedType: bsonTypeNameToNormalized(type),
      nullable: true,
      defaultValue: null,
      isPrimaryKey: name === '_id',
      isAutoIncrement: false,
      isUnique: false,
      ordinalPosition: i + 1,
    }));
  }

  async getIndexes(collection: string, schema?: string): Promise<IndexInfo[]> {
    this.ensureConnected();
    const indexes = await this.db(schema || undefined).collection(collection).listIndexes().toArray();
    return indexes.map(idx => ({
      name: (idx as { name?: string }).name || '',
      columns: Object.keys((idx as { key?: Record<string, unknown> }).key || {}),
      unique: !!(idx as { unique?: boolean }).unique,
      type: 'index',
    }));
  }

  async getForeignKeys(_table: string, _schema?: string): Promise<ForeignKeyInfo[]> {
    return [];
  }

  async getPrimaryKey(_table: string, _schema?: string): Promise<string[]> {
    return ['_id'];
  }

  // ── Database operations ──

  async switchDatabase(database: string): Promise<void> {
    this.ensureConnected();
    this.currentDb = database;
  }

  async getServerInfo(): Promise<ServerInfo> {
    this.ensureConnected();
    const build = await this.client!.db('admin').command({ buildInfo: 1 });
    const host = await this.client!.db('admin').command({ hostInfo: 1 }).catch(() => null);
    return {
      version: (build as { version?: string }).version || 'unknown',
      platform: host ? String((host as { system?: { osName?: string } }).system?.osName ?? '') || undefined : undefined,
    };
  }

  async getCurrentDatabase(): Promise<string> {
    return this.currentDb;
  }

  async getCurrentSchema(): Promise<string | undefined> {
    return undefined;
  }

  escapeIdentifier(name: string): string {
    return name;
  }

  escapeValue(value: unknown): string {
    return JSON.stringify(value);
  }

  // ── Private helpers ──

  private buildUri(config: ConnectionConfig): string {
    // An explicit connection string (form field or Atlas SRV) wins over fields.
    const explicit = typeof config.options?.connectionString === 'string' ? config.options.connectionString.trim() : '';
    if (explicit) { return explicit; }
    // Whole connection string in the host field (mongodb:// or mongodb+srv://).
    if (config.host.startsWith('mongodb://') || config.host.startsWith('mongodb+srv://')) {
      return config.host;
    }
    const auth = config.username
      ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password || '')}@`
      : '';
    const authSource = config.options?.authSource ? `/?authSource=${config.options.authSource}` : '/?authSource=admin';
    return `mongodb://${auth}${config.host}:${config.port}${authSource}`;
  }

  private db(name?: string): Db {
    return this.client!.db(name || this.currentDb);
  }
}

// ── Grid conversion ──

/** Grid values arrive as strings; ObjectId hexes must go back to ObjectId. */
function toMongoId(value: unknown): unknown {
  if (typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value)) {
    try { return new ObjectId(value); } catch { return value; }
  }
  return value;
}

/** Convert BSON documents into grid rows: `_id` first, dot-flattened. */
function docsToResult(docs: unknown[]): QueryResult {
  const rows: Array<Record<string, unknown>> = docs.map(doc => {
    const flat = flattenDoc(doc as Record<string, unknown>);
    return { _id: (doc as { _id?: { toString(): string } })?._id?.toString(), ...flat } as Record<string, unknown>;
  });

  const names: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!names.includes(key)) { names.push(key); }
    }
  }

  const columns: ColumnHeader[] = names.map(name => {
    const sample = rows.find(row => row[name] !== null && row[name] !== undefined)?.[name];
    const t = typeof sample;
    return {
      name,
      type: name === '_id' ? 'objectId' : t,
      normalizedType: inferNormalizedType(sample),
      nullable: true,
      isPrimaryKey: name === '_id',
      isAutoIncrement: false,
      defaultValue: null,
      rawType: t,
    };
  });

  return {
    columns,
    rows: rows.map(row => names.map(name => row[name] ?? null)),
    affectedRows: 0,
    executionTime: 0,
    truncated: false,
    messages: [],
  };
}

function ackToResult(message: string, row: Array<Record<string, unknown>>): QueryResult {
  const names = Object.keys(row[0] || {});
  return {
    columns: [
      { name: 'result', type: 'string', normalizedType: NormalizedColumnType.String, nullable: false, isPrimaryKey: false, isAutoIncrement: false, defaultValue: null, rawType: 'string' },
      ...names.map(name => ({
        name, type: 'number', normalizedType: NormalizedColumnType.Integer,
        nullable: true, isPrimaryKey: false, isAutoIncrement: false, defaultValue: null, rawType: 'number',
      })),
    ],
    rows: row.map(r => [message, ...names.map(n => r[n])]),
    affectedRows: 0,
    executionTime: 0,
    truncated: false,
    messages: [message],
  };
}

/** Dot-flatten a document; nested objects/arrays become JSON cells. */
function flattenDoc(obj: Record<string, unknown>, prefix = '', depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (key === '_id') { out[path] = bsonToGrid(value); continue; }
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !isBsonValue(value) && depth < 5) {
      Object.assign(out, flattenDoc(value as Record<string, unknown>, path, depth + 1));
    } else {
      out[path] = bsonToGrid(value);
    }
  }
  return out;
}

/** BSON values the grid renders as scalars (hex ObjectId, ISO date, ...). */
function isBsonValue(value: object): boolean {
  return value instanceof ObjectId
    || value instanceof Date
    || 'toHexString' in value;
}

/** Convert a BSON value into a grid-renderable scalar. */
function bsonToGrid(value: unknown): unknown {
  if (value === null || value === undefined) { return null; }
  if (value instanceof ObjectId) { return value.toHexString(); }
  if (value instanceof Date) { return value.toISOString(); }
  if (typeof value === 'object') {
    if (Array.isArray(value)) { return capPreview(JSON.stringify(value.map(bsonToGrid))); }
    if (typeof (value as { toString: () => string }).toString === 'function' && value.constructor?.name !== 'Object') {
      // Decimal128, Binary, etc. — keep the BSON string form.
      const s = value.toString();
      return s === '[object Object]' ? capPreview(JSON.stringify(value)) : s;
    }
    return capPreview(JSON.stringify(value));
  }
  if (typeof value === 'string') { return capPreview(value); }
  return value;
}

/** Truncate a preview string to `sqlens.mongo.maxValuePreview` bytes. */
function capPreview(text: string): string {
  const max = driverSetting('mongo.maxValuePreview', 512);
  if (Buffer.byteLength(text, 'utf8') <= max) { return text; }
  const buf = Buffer.from(text, 'utf8').subarray(0, max);
  // Back off to a character boundary.
  let end = buf.length;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) { end--; }
  return `${buf.subarray(0, end).toString('utf8')}… [truncated]`;
}

/** Walk a document recording the dot-path → BSON type name of each field. */
function collectFieldTypes(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || typeof value !== 'object') {
    if (prefix) { out.set(prefix, typeof value === 'object' ? 'null' : typeof value); }
    return;
  }
  if (value instanceof ObjectId) { out.set(prefix, 'objectId'); return; }
  if (value instanceof Date) { out.set(prefix, 'date'); return; }
  if (Array.isArray(value)) { out.set(prefix, 'array'); return; }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectFieldTypes(child, prefix ? `${prefix}.${key}` : key, out);
  }
}

function bsonTypeNameToNormalized(type: string): NormalizedColumnType {
  switch (type) {
    case 'objectId': return NormalizedColumnType.UUID;
    case 'date': return NormalizedColumnType.DateTime;
    case 'number': return NormalizedColumnType.Integer;
    case 'boolean': return NormalizedColumnType.Boolean;
    case 'array': return NormalizedColumnType.Array;
    case 'object': return NormalizedColumnType.JSON;
    default: return NormalizedColumnType.String;
  }
}

function inferNormalizedType(value: unknown): NormalizedColumnType {
  if (typeof value === 'number') { return Number.isInteger(value) ? NormalizedColumnType.Integer : NormalizedColumnType.Float; }
  if (typeof value === 'boolean') { return NormalizedColumnType.Boolean; }
  return NormalizedColumnType.String;
}

// ── mongosh-style query text parsing (structural, no eval) ──

export interface ParsedMongoCall {
  kind: 'use' | 'call';
  database?: string;
  collection?: string;
  method?: string;
  args: unknown[];
  chain: { sort?: unknown; skip?: number; limit?: number };
}

const SUPPORTED_CHAIN = new Set(['sort', 'skip', 'limit']);
const SUPPORTED_METHODS = new Set([
  'find', 'findOne', 'countDocuments', 'distinct', 'aggregate',
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
]);

/** Parse `use <db>` or `db.<coll>.<method>(args).chain(...)` — no eval. */
export function parseMongoCall(text: string): ParsedMongoCall {
  const trimmed = text.trim().replace(/;\s*$/, '');

  const useMatch = trimmed.match(/^use\s+(\S+)$/i);
  if (useMatch) {
    return { kind: 'use', database: useMatch[1], args: [], chain: {} };
  }

  const callMatch = trimmed.match(/^db\s*\.\s*([A-Za-z0-9_$-]+)\s*\.\s*([A-Za-z0-9_$]+)\s*\(/);
  if (!callMatch) {
    throw new Error('Cannot parse command. Expected `db.<collection>.<method>(...)` or `use <db>`.');
  }
  const collection = callMatch[1];
  const method = callMatch[2];
  if (!SUPPORTED_METHODS.has(method)) {
    throw new Error(`Unsupported method: ${method}. Supported: ${[...SUPPORTED_METHODS].join(', ')}`);
  }

  // Extract the balanced argument list after the method's opening paren.
  const argsStart = callMatch.index! + callMatch[0].length - 1;
  const { content: argsText, end } = extractBalanced(trimmed, argsStart);

  const args = splitTopLevel(argsText).map(parseArg).filter((a): a is unknown => a !== undefined);
  const chain: { sort?: unknown; skip?: number; limit?: number } = {};

  // Walk chained helpers: .sort({...}) .skip(n) .limit(n)
  let pos = end;
  while (pos < trimmed.length) {
    const chainMatch = trimmed.slice(pos).match(/^\s*\.\s*([A-Za-z0-9_$]+)\s*\(/);
    if (!chainMatch) { break; }
    const helper = chainMatch[1];
    if (!SUPPORTED_CHAIN.has(helper)) {
      throw new Error(`Unsupported chained helper: .${helper}(). Supported: ${[...SUPPORTED_CHAIN].join(', ')}`);
    }
    const helperStart = pos + chainMatch.index! + chainMatch[0].length - 1;
    const helperBody = extractBalanced(trimmed, helperStart);
    const helperArgs = splitTopLevel(helperBody.content).map(parseArg);
    if (helper === 'sort') { chain.sort = helperArgs[0]; }
    if (helper === 'skip') { chain.skip = Number(helperArgs[0]) || 0; }
    if (helper === 'limit') { chain.limit = Number(helperArgs[0]) || 0; }
    pos = helperBody.end;
  }

  return { kind: 'call', collection, method, args, chain };
}

/** Extract the content of the balanced-paren group opening at `openIndex`. */
function extractBalanced(text: string, openIndex: number): { content: string; end: number } {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) { inString = null; }
      continue;
    }
    if (ch === "'" || ch === '"') { inString = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth++; }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return { content: text.slice(openIndex + 1, i), end: i + 1 };
      }
    }
  }
  throw new Error('Unbalanced parentheses in command.');
}

/** Split an argument list on top-level commas (respecting brackets/strings). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === '\\') { current += text[++i] ?? ''; continue; }
      if (ch === inString) { inString = null; }
      continue;
    }
    if (ch === "'" || ch === '"') { inString = ch; current += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth++; }
    if (ch === ')' || ch === '}' || ch === ']') { depth--; }
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) { parts.push(current); }
  return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Parse a single argument: JSON with mongosh literal extensions
 * (`ObjectId('..')`, `ISODate('..')`, `new Date('..')`) substituted before
 * JSON.parse and restored as BSON values afterwards.
 */
function parseArg(text: string): unknown {
  if (!text) { return undefined; }
  const bson: Array<ObjectId | Date> = [];

  // mongosh arguments are JavaScript object literals (single quotes, bare
  // keys, trailing commas, comments) — normalize into strict JSON first.
  let normalized = normalizeJsLiteral(text);

  normalized = normalized.replace(
    /ObjectId\(\s*(['"])([^'"]*)\1\s*\)|ISODate\(\s*(['"])([^'"]*)\3\s*\)|new Date\(\s*(['"])([^'"]*)\5\s*\)/g,
    (_m, _q1, oid, _q2, iso1, _q3, iso2) => {
      const index = bson.length;
      if (oid !== undefined) { bson.push(new ObjectId(oid)); }
      else { bson.push(new Date(iso1 ?? iso2)); }
      return `"__BSON_${index}__"`;
    },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error(`Cannot parse argument as JSON: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
  }
  return restoreBson(parsed, bson);
}

/** Convert a mongosh-style JS literal into strict JSON. */
function normalizeJsLiteral(text: string): string {
  let out = '';
  let inString: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      if (ch === '\\') { out += ch + (next ?? ''); i++; continue; }
      if (ch === inString) { inString = null; out += '"'; continue; }
      // Single-quoted string content → escape embedded double quotes.
      if (inString === "'" && ch === '"') { out += '\\"'; continue; }
      out += ch;
      continue;
    }

    if (ch === "'" ) { inString = "'"; out += '"'; continue; }
    if (ch === '"') { inString = '"'; out += ch; continue; }

    // Strip comments.
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') { i++; } continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { i++; } i++; continue; }

    out += ch;
  }

  // Quote bare keys: { status: → { "status": (outside of strings by now).
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
  // Drop trailing commas before } or ].
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return out;
}

function restoreBson(value: unknown, bson: Array<ObjectId | Date>): unknown {
  if (typeof value === 'string') {
    const m = value.match(/^__BSON_(\d+)__$/);
    if (m) { return bson[Number(m[1])]; }
    return value;
  }
  if (Array.isArray(value)) { return value.map(v => restoreBson(v, bson)); }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = restoreBson(v, bson);
    }
    return out;
  }
  return value;
}

/** Split statements at line boundaries starting with `db.` or `use `. */
function splitMongoStatements(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let depth = 0;

  for (const line of text.split('\n')) {
    const startsStatement = depth === 0 && /^\s*(db\s*\.|use\s)/.test(line) && current.length > 0;
    if (startsStatement) {
      blocks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
    for (const ch of line) {
      if (ch === '{' || ch === '[') { depth++; }
      if (ch === '}' || ch === ']') { depth = Math.max(0, depth - 1); }
    }
  }
  if (current.length > 0) { blocks.push(current.join('\n')); }
  return blocks;
}
