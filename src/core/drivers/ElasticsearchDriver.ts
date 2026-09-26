import type { Client } from '@elastic/elasticsearch';
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
 * Elasticsearch driver (official @elastic/elasticsearch client).
 *
 * See docs/ELASTICSEARCH_SUPPORT_DESIGN.md. Key points:
 *  - There is no database/schema layer: the tree root is the index list, so
 *    getDatabases() reports a single pseudo-entry (the cluster name) and
 *    getSchemas() returns [].
 *  - The editor text is a REST request in Kibana Dev Tools style:
 *      GET /my-index/_search
 *      { "query": { ... } }
 *    First line = `METHOD /path` (defaults to `GET /_search` when missing),
 *    everything after it is the JSON body. A bare JSON body is treated as a
 *    search request.
 *  - Responses are wrapped into QueryResult: `_search` hits become rows
 *    (`_id` first column, `_source` dot-flattened), `_cat/*` responses map
 *    their object keys to columns, and any other response body is rendered
 *    as one key/value row.
 */
export class ElasticsearchDriver extends BaseDriver {
  readonly driverType = 'elasticsearch';

  private client: Client | null = null;
  private clusterName: string = '';
  /** search_after cursor per index, advanced as the grid pages forward. */
  private cursorCache = new Map<string, { sort?: unknown[]; nextOffset: number }>();
  /** Test/diagnostic override for the from+size window. */
  private maxResultWindowOverride?: number;

  /** Override the deep-pagination window (0 keeps the setting). */
  setMaxResultWindow(n: number): void {
    if (n > 0) { this.maxResultWindowOverride = n; }
  }

  // ── In-grid document editing (RowEditCapable) ──

  /**
   * Load one grid page. Pages inside the `from + size` window use plain
   * paging; a page beyond it continues from the cached `search_after` cursor
   * (kept per index while the user pages forward in order).
   */
  pageQuery(table: string, limit: number, _schema?: string, offset = 0): string {
    const window = this.maxResultWindowOverride ?? driverSetting('es.maxResultWindow', 10_000);
    // Use plain paging while this whole page fits inside the window.
    if (offset + limit <= window) {
      return `GET /${table}/_search\n{"from": ${offset}, "size": ${limit}, "sort": [{"_doc": "asc"}]}`;
    }

    const cursor = this.cursorCache.get(table);
    if (cursor && cursor.nextOffset === offset && cursor.sort) {
      // Deep paging: continue after the last hit of the previous page.
      return `POST /${table}/_search\n${JSON.stringify({
        size: limit,
        query: { match_all: {} },
        sort: [{ _doc: 'asc' }],
        search_after: cursor.sort,
      })}`;
    }

    throw new Error(
      `Page ${Math.floor(offset / limit) + 1} is beyond the ${window} result window and no cursor is available. `
      + 'Page forward in order (a search_after cursor is kept automatically), or narrow the query.',
    );
  }

  /**
   * Apply grid changes as document operations: PUT _doc/<_id> replaces a
   * document, DELETE _doc/<_id> removes it, POST _doc inserts a new one.
   */
  async applyRowEdits(table: string, rows: RowEdit[], columns: string[], pkColumns: string[]): Promise<number> {
    this.ensureConnected();
    const idCol = pkColumns.includes('_id') ? columns.indexOf('_id') : 0;
    let applied = 0;

    for (const row of rows) {
      if (row.status === 'modified') {
        const id = row.original[idCol];
        const doc: Record<string, unknown> = {};
        for (const ci of row.changedCols) {
          setNested(doc, columns[ci], row.data[ci]);
        }
        await this.query(`POST /${table}/_update/${encodeURIComponent(String(id))}\n${JSON.stringify({ doc })}`);
        applied++;
      } else if (row.status === 'deleted') {
        const id = row.original[idCol];
        await this.query(`DELETE /${table}/_doc/${encodeURIComponent(String(id))}`);
        applied++;
      } else if (row.status === 'added') {
        const doc: Record<string, unknown> = {};
        columns.forEach((name, ci) => {
          if (name !== '_id' && row.data[ci] !== null && row.data[ci] !== undefined) {
            setNested(doc, name, row.data[ci]);
          }
        });
        await this.query(`POST /${table}/_doc\n${JSON.stringify(doc)}`);
        applied++;
      }
    }
    return applied;
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.client = createEsClient(this.buildClientOptions(config));
    try {
      const info = await this.client.info() as unknown as { cluster_name?: string };
      this.clusterName = info.cluster_name || 'elasticsearch';
    } catch (err) {
      await this.client.close().catch(() => {});
      this.client = null;
      throw err;
    }
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
    let testClient: Client | null = null;
    try {
      testClient = createEsClient(this.buildClientOptions(config));
      const info = await testClient.info();
      const version = (info as unknown as { version?: { number?: string } }).version?.number || 'unknown';
      let clusterStatus = '';
      try {
        const health = await testClient.cluster.health();
        clusterStatus = (health as unknown as { status?: string }).status || '';
      } catch { /* health is optional for the message */ }
      return {
        success: true,
        message: `Connected to Elasticsearch ${version}${clusterStatus ? ` (${clusterStatus})` : ''}`,
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
   * Execute a REST request text (or a bare JSON search body) and wrap the
   * response into a QueryResult.
   */
  async query(text: string, _params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();
    const start = performance.now();

    const parsedRequest = parseRequestText(text);
    const method = parsedRequest.method;
    const path = parsedRequest.path;
    let body = parsedRequest.body;

    // Deep-pagination guard: from + size above the window must use search_after.
    if (/_search\b/.test(path) && body && typeof body === 'object') {
      const limit = driverSetting('es.maxResultWindow', 10_000);
      const from = Number((body as { from?: number }).from ?? 0) || 0;
      const size = Number((body as { size?: number }).size ?? 10) || 10;
      if (from + size > limit) {
        throw new Error(
          `from + size (${from + size}) exceeds the ${limit} result window. Use "search_after" with a "sort" for deep pagination.`,
        );
      }
    }

    try {
      // NDJSON bodies (_bulk) must carry the x-ndjson content type — string
      // bodies default to text/plain which the server rejects.
      const options = typeof body === 'string'
        ? { headers: { 'content-type': 'application/x-ndjson' } }
        : {};
      // NDJSON requires a trailing newline; be forgiving with user input.
      if (typeof body === 'string' && !body.endsWith('\n')) {
        body = `${body}\n`;
      }
      const response = await this.client!.transport.request(
        { method, path, body } as Parameters<Client['transport']['request']>[0],
        options,
      );
      const executionTime = Math.round(performance.now() - start);
      const result = this.wrapResponse(path, response as Record<string, unknown>);
      result.executionTime = executionTime;

      // Remember where this page ended so the next deep page can continue with
      // search_after instead of hitting the window limit.
      this.updateCursor(path, body, response as Record<string, unknown>);

      Logger.getInstance().logSQL(`${method} ${path}`, executionTime);
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      Logger.getInstance().logSQL(`${method} ${path}`, undefined, errMsg);
      // Surface the ES error body (meta.body) when available — it carries the
      // actual reason instead of a generic message.
      const meta = (err as { meta?: { body?: { error?: { reason?: string } } } }).meta;
      const reason = meta?.body?.error?.reason;
      throw new Error(reason ? `${errMsg} — ${reason}` : errMsg);
    }
  }

  /**
   * Split a request text into blocks at `METHOD /path` line boundaries
   * (semicolons are valid JSON content, so BaseDriver's SQL splitter cannot
   * be reused here).
   */
  async queryMultiple(text: string): Promise<QueryResult[]> {
    const blocks = splitRequestBlocks(text);
    const results: QueryResult[] = [];
    for (const block of blocks) {
      if (block.trim()) {
        results.push(await this.query(block));
      }
    }
    return results;
  }

  /**
   * Elasticsearch searches are cancellable through the tasks API, but only
   * when the request is sent with `wait_for_completion=false`; plain
   * requests are left to the server timeout.
   */
  async cancelQuery(): Promise<void> {
    // no-op (see above)
  }

  // ── Schema introspection ──

  async getDatabases(): Promise<DatabaseInfo[]> {
    this.ensureConnected();
    // No database layer; a single pseudo-entry keeps the existing
    // connection → database → table tree rendering intact.
    return [{ name: this.clusterName || 'elasticsearch' }];
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    return [];
  }

  // ── Index management + bulk transfer (P4) ──

  /** Create an index; `mappingJson` is an optional JSON mappings body. */
  async createIndex(name: string, mappingJson?: string): Promise<void> {
    this.ensureConnected();
    const body = mappingJson?.trim() ? `\n${mappingJson.trim()}` : '';
    await this.query(`PUT /${name}${body}`);
  }

  async deleteIndex(name: string): Promise<void> {
    this.ensureConnected();
    await this.query(`DELETE /${name}`);
  }

  /** Export documents as NDJSON so the file can be fed back into `_bulk`. */
  async exportNdjson(index: string, limit = 10_000): Promise<string> {
    this.ensureConnected();
    const res = await this.client!.search({
      index,
      size: Math.min(limit, 10_000),
      body: { query: { match_all: {} } },
    });
    const hits = ((res as unknown as { hits?: { hits?: Array<Record<string, unknown>> } }).hits?.hits) || [];
    return hits.length ? `${hits.map(hit => JSON.stringify(hit._source ?? {})).join('\n')}\n` : '';
  }

  /** Bulk-index NDJSON lines (plain documents or `_bulk` action pairs). */
  async importNdjson(index: string, ndjson: string): Promise<number> {
    this.ensureConnected();
    const lines = ndjson.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { return 0; }
    const hasActionLines = /^\{"(index|create|update|delete)"/.test(lines[0]);
    const body = hasActionLines
      ? lines.join('\n')
      : lines.flatMap(doc => [`{"index":{}}`, doc]).join('\n');
    await this.query(`POST /${index}/_bulk?refresh=true\n${body}`);
    return hasActionLines ? body.split('\n').length / 2 : lines.length;
  }

  /** Run a search body with `profile: true` in the body (P4 EXPLAIN). */
  async explainSearch(index: string, bodyJson: string): Promise<QueryResult> {
    this.ensureConnected();
    let body: Record<string, unknown> = { query: { match_all: {} } };
    if (bodyJson?.trim()) {
      try { body = JSON.parse(bodyJson); } catch { body = { query: { match_all: {} } }; }
    }
    body.profile = true;
    return this.query(`POST /${index}/_search\n${JSON.stringify(body)}`);
  }

  /** Fast index name listing for progressive tree loading. */
  async getTableNames(): Promise<{ name: string; type: 'table' | 'view' }[]> {
    this.ensureConnected();
    const showSystem = driverSettingOrOption('es.showSystemIndices', this._config?.options?.showSystemIndices, false);
    const res = await this.client!.cat.indices({ format: 'json' }) as unknown as Array<{ index?: string }>;
    return (res || [])
      .filter(idx => idx.index && (showSystem || !idx.index.startsWith('.')))
      .map(idx => ({ name: idx.index!, type: 'table' as const }));
  }

  async getTables(_schema?: string): Promise<TableInfo[]> {
    this.ensureConnected();
    const showSystem = driverSettingOrOption('es.showSystemIndices', this._config?.options?.showSystemIndices, false);

    const res = await this.client!.cat.indices({ format: 'json' });
    const indices = res as unknown as Array<{
      index?: string;
      health?: string;
      status?: string;
      'docs.count'?: string;
      'store.size'?: string;
    }>;

    return (indices || [])
      .filter(idx => idx.index && (showSystem || !idx.index.startsWith('.')))
      .map(idx => ({
        name: idx.index!,
        type: 'table' as const,
        engine: idx.health || undefined,
        rowCount: toNumber(idx['docs.count']),
        dataSize: parseByteSize(idx['store.size']),
        comment: idx.status || undefined,
      }));
  }

  async getColumns(index: string, _schema?: string): Promise<ColumnInfo[]> {
    this.ensureConnected();

    const res = await this.client!.indices.getMapping({ index }) as Record<string, {
      mappings?: { properties?: Record<string, MappingField> };
    }>;
    // Response: { <index>: { mappings: { properties: { field: {...} } } } }
    const mappings = Object.values(res)[0]?.mappings?.properties || {};

    const columns: ColumnInfo[] = [];
    let position = 0;
    const walk = (props: Record<string, MappingField>, prefix: string) => {
      for (const [name, field] of Object.entries(props)) {
        const path = prefix ? `${prefix}.${name}` : name;
        position++;
        columns.push({
          name: path,
          type: field.type || 'object',
          normalizedType: normalizeEsType(field.type),
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
          isUnique: false,
          ordinalPosition: position,
        });
        // object/nested fields carry nested properties — flatten as dot paths.
        if (field.properties) {
          walk(field.properties, path);
        }
      }
    };
    walk(mappings, '');
    return columns;
  }

  async getIndexes(_table: string, _schema?: string): Promise<IndexInfo[]> {
    return [];
  }

  async getForeignKeys(_table: string, _schema?: string): Promise<ForeignKeyInfo[]> {
    return [];
  }

  async getPrimaryKey(_table: string, _schema?: string): Promise<string[]> {
    // Documents are addressed by their `_id` metadata field.
    return ['_id'];
  }

  // ── Database operations ──

  async switchDatabase(): Promise<void> {
    // Single cluster; nothing to switch.
  }

  async getServerInfo(): Promise<ServerInfo> {
    this.ensureConnected();
    const info = await this.client!.info();
    const version = (info as unknown as { version?: { number?: string } }).version?.number || 'unknown';
    let currentConnections: number | undefined;
    try {
      const health = await this.client!.cluster.health();
      currentConnections = undefined;
      void health;
    } catch { /* optional */ }
    return { version, currentConnections };
  }

  async getCurrentDatabase(): Promise<string> {
    return this.clusterName || 'elasticsearch';
  }

  async getCurrentSchema(): Promise<string | undefined> {
    return undefined;
  }

  escapeIdentifier(name: string): string {
    // Index names go into URLs; nothing to quote.
    return name;
  }

  escapeValue(value: unknown): string {
    if (value === null || value === undefined) { return 'null'; }
    if (typeof value === 'string') { return JSON.stringify(value); }
    return String(value);
  }

  // ── Private helpers ──

  private buildClientOptions(config: ConnectionConfig) {
    const node = config.host.startsWith('http')
      ? `${config.host.replace(/\/$/, '')}:${config.port}`
      : `http://${config.host}:${config.port}`;

    const options: Record<string, unknown> = {
      node,
      requestTimeout: driverSettingOrOption('es.requestTimeout', config.options?.requestTimeout, 30_000),
    };

    // Elastic Cloud: a cloud id replaces host/port entirely.
    const cloudId = typeof config.options?.cloudId === 'string' ? config.options.cloudId.trim() : '';
    if (cloudId) { options.cloud = { id: cloudId }; }
    if (config.options?.apiKey) {
      options.auth = { apiKey: String(config.options.apiKey) };
    } else if (config.username) {
      options.auth = { username: config.username, password: config.password || '' };
    }
    if (config.options?.tlsVerify === false) {
      options.tls = { rejectUnauthorized: false };
    }
    return options;
  }

  /** Track the search_after cursor for a search response. */
  private updateCursor(path: string, body: unknown, response: Record<string, unknown>): void {
    // `path` comes from the editor text, so it may omit the leading slash.
    const index = path.match(/^\/?([^/?]+)\/_search/)?.[1];
    if (!index) { return; }
    const hitsWrapper = response.hits as { hits?: Array<Record<string, unknown>> } | undefined;
    const hits = hitsWrapper?.hits || [];
    if (hits.length === 0) { return; }

    const bodyObj = body && typeof body === 'object' ? body as { from?: number; search_after?: unknown[] } : {};
    const lastHit = hits[hits.length - 1];
    const sort = Array.isArray(lastHit.sort) ? lastHit.sort : undefined;
    // The next offset is the current page start plus what came back. Using
    // search_after means we no longer know `from`, so track it cumulatively.
    const previous = this.cursorCache.get(index);
    const start = typeof bodyObj.from === 'number'
      ? bodyObj.from
      : (bodyObj.search_after ? (previous?.nextOffset ?? 0) : 0);
    this.cursorCache.set(index, { sort: sort ?? previous?.sort, nextOffset: start + hits.length });
  }

  /** Wrap an ES response body into a QueryResult (§3.5 of the design doc). */
  private wrapResponse(path: string, body: Record<string, unknown>): QueryResult {
    // _search / _msearch: hits become rows with `_id` first.
    if (path.includes('_search') && body && typeof body === 'object' && 'hits' in body) {
      const hits = ((body.hits as { hits?: Array<Record<string, unknown>> })?.hits) || [];
      const rows = hits.map(hit => {
        const source = flatten((hit._source as Record<string, unknown>) || {});
        return { _id: hit._id, ...source };
      });

      // Aggregation-only searches (no hits) render one row per bucket so the
      // numbers are readable instead of a single nested object.
      const aggs = (body.aggregations ?? body.aggs) as Record<string, unknown> | undefined;
      if (rows.length === 0 && aggs && Object.keys(aggs).length > 0) {
        const aggRows = aggregationRows(aggs);
        if (aggRows.length > 0) { return objectRowsToResult(aggRows); }
      }

      return objectRowsToResult(rows);
    }

    // _cat/* responses come back as arrays of flat objects.
    if (Array.isArray(body)) {
      return objectRowsToResult(body as Array<Record<string, unknown>>);
    }

    // Everything else (write acks, _count, aggs, health...): one key/value row.
    if (body && typeof body === 'object') {
      return objectRowsToResult([flatten(body)]);
    }
    return {
      columns: [],
      rows: [],
      affectedRows: 0,
      executionTime: 0,
      truncated: false,
      messages: [JSON.stringify(body)],
    };
  }
}

interface MappingField {
  type?: string;
  properties?: Record<string, MappingField>;
}

/** Statements whose first line is `METHOD /path`. */
const REQUEST_LINE_RE = /^\s*(GET|POST|PUT|DELETE|HEAD)\s+\/(\S*)\s*$/im;

/**
 * Parse the editor request text: first line `METHOD /path` (defaults to
 * `GET /_search`), blank-line-separated JSON body afterwards. A bare JSON
 * body is treated as a search request body.
 */
export function parseRequestText(text: string): { method: string; path: string; body?: unknown } {
  const match = text.match(REQUEST_LINE_RE);
  if (!match) {
    // Bare JSON → POST /_search.
    const bodyText = text.trim();
    let body: unknown;
    if (bodyText) {
      try { body = JSON.parse(bodyText); } catch { body = bodyText; }
    }
    return { method: 'POST', path: '_search', body };
  }

  const method = match[1].toUpperCase();
  const path = match[2];
  const bodyText = text.slice(match[0].length).trim();
  // JSON bodies are parsed; anything else (e.g. NDJSON for _bulk) is sent
  // through as the raw string — the client passes string bodies verbatim.
  let body: unknown;
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch { body = bodyText; }
  }
  return { method, path, body };
}

/** Split a request text into blocks at `METHOD /path` line boundaries. */
function splitRequestBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of text.split('\n')) {
    if (REQUEST_LINE_RE.test(line) && current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }
  return blocks;
}

/** Dot-flatten a nested object; arrays and long values become JSON strings. */
function flatten(obj: Record<string, unknown>, prefix = '', depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && depth < 5) {
      Object.assign(out, flatten(value as Record<string, unknown>, path, depth + 1));
    } else if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
      out[path] = JSON.stringify(value);
    } else {
      out[path] = value;
    }
  }
  return out;
}

/** Build a QueryResult from an array of flat objects (keys → columns). */
function objectRowsToResult(rows: Array<Record<string, unknown>>): QueryResult {
  const names: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!names.includes(key)) { names.push(key); }
    }
  }

  const columns: ColumnHeader[] = names.map(name => {
    const value = rows.find(row => row[name] !== null && row[name] !== undefined)?.[name];
    return {
      name,
      type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
      normalizedType: inferNormalizedType(value),
      nullable: true,
      isPrimaryKey: name === '_id',
      isAutoIncrement: false,
      defaultValue: null,
      rawType: typeof value,
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

function inferNormalizedType(value: unknown): NormalizedColumnType {
  switch (typeof value) {
    case 'number': return Number.isInteger(value) ? NormalizedColumnType.Integer : NormalizedColumnType.Float;
    case 'boolean': return NormalizedColumnType.Boolean;
    default: return NormalizedColumnType.String;
  }
}

/** Map an ES mapping field type to the normalized column type. */
export function normalizeEsType(type?: string): NormalizedColumnType {
  switch (type) {
    case 'long': case 'integer': case 'short': case 'byte':
      return NormalizedColumnType.Integer;
    case 'double': case 'float': case 'half_float': case 'scaled_float':
      return NormalizedColumnType.Float;
    case 'boolean':
      return NormalizedColumnType.Boolean;
    case 'date': case 'date_nanos':
      return NormalizedColumnType.DateTime;
    case 'keyword': case 'text': case 'wildcard': case 'search_as_you_type': case 'ip':
      return NormalizedColumnType.String;
    case 'object': case 'nested': case 'flattened': case 'join':
      return NormalizedColumnType.JSON;
    default:
      return type ? NormalizedColumnType.String : NormalizedColumnType.Unknown;
  }
}

/**
 * Create the ES client lazily: the client (and its optional Arrow/ES|QL
 * helpers) is only touched when a connection is actually opened, so it can
 * never break extension startup.
 */
function createEsClient(options: Record<string, unknown>): Client {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client: EsClient } = require('@elastic/elasticsearch') as typeof import('@elastic/elasticsearch');
  return new EsClient(options as never);
}

/**
 * Turn an ES aggregations object into flat rows: one row per bucket with the
 * aggregation name, bucket key/doc_count and any metric values.
 */
function aggregationRows(aggs: Record<string, unknown>, prefix = ''): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [name, value] of Object.entries(aggs)) {
    const label = prefix ? `${prefix}.${name}` : name;
    if (value === null || typeof value !== 'object') { continue; }
    const node = value as { buckets?: unknown; value?: unknown; doc_count?: unknown };

    if (Array.isArray(node.buckets)) {
      // Scale a text bar per bucket so distributions are visible in the grid.
      const counts = (node.buckets as Array<Record<string, unknown>>)
        .map(b => Number(b.doc_count) || 0);
      const maxCount = Math.max(1, ...counts);

      for (const bucket of node.buckets as Array<Record<string, unknown>>) {
        const count = Number(bucket.doc_count) || 0;
        const bars = Math.max(1, Math.round((count / maxCount) * 30));
        const row: Record<string, unknown> = {
          aggregation: label,
          key: bucket.key_as_string ?? bucket.key,
          doc_count: count,
          bar: '█'.repeat(bars),
        };
        for (const [k, v] of Object.entries(bucket)) {
          if (['key', 'key_as_string', 'doc_count'].includes(k)) { continue; }
          if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
            row[k] = (v as { value: unknown }).value;
          } else if (v && typeof v === 'object' && Array.isArray((v as { buckets?: unknown[] }).buckets)) {
            // Nested aggregations are flattened with a dotted name.
            for (const nested of aggregationRows({ [k]: v }, label)) { rows.push(nested); }
            row[k] = `(${(v as { buckets: unknown[] }).buckets.length} buckets)`;
          } else {
            row[k] = v;
          }
        }
        rows.push(row);
      }
      continue;
    }

    if ('value' in node) {
      rows.push({ aggregation: label, value: node.value, doc_count: node.doc_count });
    }
  }
  return rows;
}

/** Write a dot-path value into a nested object (inverse of flatten). */
function setNested(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof node[key] !== 'object' || node[key] === null) { node[key] = {}; }
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) { return undefined; }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a human byte size like `1.2gb` / `812kb` into bytes. */
function parseByteSize(v?: string): number | undefined {
  if (!v) { return undefined; }
  const match = v.match(/^([\d.]+)\s*(b|kb|mb|gb|tb|pb)?$/i);
  if (!match) { return undefined; }
  const units: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5 };
  return Math.round(parseFloat(match[1]) * (units[(match[2] || 'b').toLowerCase()] || 1));
}
