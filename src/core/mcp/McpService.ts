import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DatabaseDriver } from '../drivers/DatabaseDriver';
import { ConnectionManager } from '../connection/ConnectionManager';
import { QueryHistory } from '../query/QueryHistory';
import { SecurityGuard } from './SecurityGuard';
import { isSqlFamily } from './StatementClassifiers';
import { ActivityBridge } from './ActivityBridge';
import { Logger } from '../utils/Logger';

const DEFAULT_PORT = 37421;

/** Escape a string for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Title-case a raw client identifier (e.g. `codebuddy` → `CodeBuddy`). */
function displayClientName(raw: string): string {
  const cleaned = raw.replace(/[\s_-]+/g, ' ').trim();
  if (!cleaned) { return ''; }
  // Known products keep their own casing.
  const known: Record<string, string> = {
    codebuddy: 'CodeBuddy',
    'claude code': 'Claude Code',
    claude: 'Claude',
    cursor: 'Cursor',
    copilot: 'GitHub Copilot',
    'github copilot': 'GitHub Copilot',
    trae: 'Trae',
    'trae cn': 'Trae CN',
    continue: 'Continue',
    cline: 'Cline',
    windsurf: 'Windsurf',
    zed: 'Zed',
  };
  const key = cleaned.toLowerCase();
  if (known[key]) { return known[key]; }
  return cleaned.length <= 3
    ? cleaned.toUpperCase()
    : cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Best-effort product name from a User-Agent header, skipping HTTP/library
 * agents that say nothing about the assistant.
 */
function clientNameFromUserAgent(userAgent?: string): string {
  if (!userAgent) { return ''; }
  const first = userAgent.split(/[\s(]/)[0] || '';
  const product = first.split('/')[0];
  if (!product) { return ''; }
  const generic = /^(node|undici|axios|fetch|got|curl|wget|python|python-requests|okhttp|java|go-http-client|mcp|modelcontextprotocol|mcp-sdk|vscode)/i;
  if (generic.test(product)) { return ''; }
  // Ignore a bare version-ish token.
  if (/^[\d.]+$/.test(product)) { return ''; }
  return displayClientName(product);
}

function textResult(data: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

interface ResolvedConnection {
  id: string;
  name: string;
  driver: DatabaseDriver;
}

/**
 * Local MCP server exposing Sqlens connections and query capabilities to
 * AI assistants. Stateless Streamable HTTP transport, bearer-token auth,
 * bound to 127.0.0.1 only. Credentials never leave the extension process.
 */
export class McpService {
  private server: http.Server | null = null;
  private guard = new SecurityGuard();
  private port = 0;
  private token = '';
  /** Most recently seen assistant name (from initialize / User-Agent). */
  private lastClientName = '';
  private lastClientAt = 0;

  constructor(
    private connectionManager: ConnectionManager,
    private queryHistory: QueryHistory,
    private activity: ActivityBridge,
    /** Optional callback to highlight a table in the Schema tree when AI touches it. */
    private revealTable?: (table: string, connectionId: string) => void,
  ) {}

  get endpoint(): string { return `http://127.0.0.1:${this.port}/mcp`; }
  get running(): boolean { return this.server !== null; }

  private statusSubs = new Set<() => void>();

  /** Subscribe to server start/stop/token changes (used to refresh the MCP panel). */
  onDidChangeStatus(cb: () => void): vscode.Disposable {
    this.statusSubs.add(cb);
    return new vscode.Disposable(() => { this.statusSubs.delete(cb); });
  }

  private emitStatusChange(): void {
    for (const cb of this.statusSubs) { cb(); }
  }

  /** Generate/return the stored bearer token. */
  getAuthToken(context: vscode.ExtensionContext): string {
    let token = context.globalState.get<string>('sqlens.mcp.token');
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      void context.globalState.update('sqlens.mcp.token', token);
    }
    return token;
  }

  /** Serialisable server status for the MCP panel. */
  getStatus(context: vscode.ExtensionContext): { running: boolean; endpoint: string; port: number; token: string } {
    return { running: this.running, endpoint: this.endpoint, port: this.port, token: this.getAuthToken(context) };
  }

  async regenerateToken(context: vscode.ExtensionContext): Promise<string> {
    const token = crypto.randomBytes(24).toString('hex');
    await context.globalState.update('sqlens.mcp.token', token);
    this.token = token;
    this.emitStatusChange();
    return token;
  }

  async start(context: vscode.ExtensionContext): Promise<void> {
    if (this.server) { return; }

    const configuredPort = vscode.workspace.getConfiguration('sqlens.mcp').get<number>('port', DEFAULT_PORT);
    this.token = this.getAuthToken(context);

    for (let attempt = 0; attempt < 10; attempt++) {
      const port = configuredPort === 0 ? 0 : configuredPort + attempt;
      try {
        await this.listen(port);
        vscode.commands.executeCommand('setContext', 'sqlens.mcpRunning', true);
        Logger.getInstance().logInfo(`MCP server listening at ${this.endpoint}`);
        this.emitStatusChange();
        return;
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== 'EADDRINUSE' || configuredPort === 0) {
          Logger.getInstance().logError(`MCP server failed to start: ${(err as Error)?.message ?? err}`, err as Error);
          return;
        }
      }
    }
    Logger.getInstance().logError(`MCP server failed to start: no free port near ${configuredPort}`, undefined);
  }

  async stop(): Promise<void> {
    if (!this.server) { return; }
    const server = this.server;
    this.server = null;
    await new Promise<void>(resolve => server.close(() => resolve()));
    vscode.commands.executeCommand('setContext', 'sqlens.mcpRunning', false);
    this.emitStatusChange();
  }

  dispose(): Promise<void> { return this.stop(); }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res).catch(err => {
          Logger.getInstance().logError(`MCP request error: ${(err as Error)?.message ?? err}`, err as Error);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal error' }));
          }
        });
      });
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : port;
        this.server = server;
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'sqlens-mcp' }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404);
      res.end();
      return;
    }

    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${this.token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid bearer token' }));
      return;
    }

    if (req.method !== 'POST') {
      // Stateless mode: no SSE streams (GET) or session termination (DELETE)
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) { chunks.push(chunk as Buffer); }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const clientName = this.resolveClientName(req, body);

    // Stateless: one transport + server instance per request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    const mcp = this.createMcpServer(clientName);
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });

    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private extractClientName(body: unknown): string {
    try {
      const info = (body as { params?: { clientInfo?: { name?: string } } }).params?.clientInfo;
      const name = info?.name?.trim();
      return name ? displayClientName(name) : '';
    } catch {
      return '';
    }
  }

  /**
   * Who is calling? `clientInfo` only arrives with the `initialize` request —
   * later `tools/call` requests carry nothing — so the name is remembered for
   * the session (and a usable User-Agent is used as a fallback).
   */
  private resolveClientName(req: http.IncomingMessage, body: unknown): string {
    const fromBody = this.extractClientName(body);
    if (fromBody) {
      this.lastClientName = fromBody;
      this.lastClientAt = Date.now();
      return fromBody;
    }

    const fromAgent = clientNameFromUserAgent(req.headers['user-agent']);
    if (fromAgent) {
      this.lastClientName = fromAgent;
      this.lastClientAt = Date.now();
      return fromAgent;
    }

    // Fall back to the most recent initialize while it is plausibly the same
    // client (a single assistant usually drives the endpoint at a time).
    if (this.lastClientName && Date.now() - this.lastClientAt < 30 * 60_000) {
      return this.lastClientName;
    }
    return 'ai-assistant';
  }

  // ── Shared helpers ──

  private async listConnections() {
    const configs = await this.connectionManager.getSavedConnections();
    return configs.map(c => ({
      id: c.id,
      name: c.name || c.host,
      type: c.type,
      database: c.database || '',
      connected: this.connectionManager.isConnected(c.id),
    }));
  }

  private async getDriver(connectionId?: string): Promise<ResolvedConnection> {
    const configs = await this.connectionManager.getSavedConnections();
    let config;
    if (connectionId && connectionId !== 'current') {
      config = configs.find(c => c.id === connectionId);
    } else {
      const activeId = this.connectionManager.activeConnectionId;
      config = configs.find(c => c.id === activeId);
    }
    if (!config) {
      throw new Error(`Connection not found: ${connectionId ?? '(current)'}. Use list_connections to get valid ids.`);
    }
    const driver = this.connectionManager.getDriver(config.id);
    if (!driver || !driver.isConnected) {
      throw new Error(`Connection "${config.name || config.host}" is not connected. Connect it in Sqlens first.`);
    }

    // Connection allow-list: an empty list means "all connections".
    const allowed = vscode.workspace.getConfiguration('sqlens.mcp').get<string[]>('allowedConnections', []) || [];
    if (allowed.length > 0) {
      const name = config.name || config.host;
      const permitted = allowed.some(entry => entry === config!.id || entry.toLowerCase() === name.toLowerCase());
      if (!permitted) {
        this.activity.recordBlocked('access', 'mcp', `connection ${name}`, 'not in sqlens.mcp.allowedConnections');
        throw new Error(`Connection "${name}" is not in the allowed list (sqlens.mcp.allowedConnections).`);
      }
    }

    return { id: config.id, name: config.name || config.host, driver };
  }

  /**
   * Refuse statements touching a table/collection listed in
   * `sqlens.mcp.blockedTables` (matched case-insensitively on the name).
   */
  private assertTableAllowed(text: string, driver: DatabaseDriver): void {
    const blocked = (vscode.workspace.getConfiguration('sqlens.mcp').get<string[]>('blockedTables', []) || [])
      .map(entry => entry.trim().toLowerCase())
      .filter(Boolean);
    if (blocked.length === 0) { return; }

    const table = this.guard.extractTable(text)?.toLowerCase();
    const haystack = text.toLowerCase();
    const hit = blocked.find(name => (table && (table === name || table.endsWith(`.${name}`))) || new RegExp(`[\\s.[\`"']${escapeRegExp(name)}[\\s.\`"'(]`).test(haystack));
    if (hit) {
      this.activity.recordBlocked('access', 'mcp', hit, 'listed in sqlens.mcp.blockedTables');
      throw new Error(`Table "${hit}" is blocked by sqlens.mcp.blockedTables.`);
    }

    void driver;
  }

  private recordAiHistory(sql: string, connectionId: string, executionTime: number, rowCount: number, success: boolean, error?: string): void {
    this.queryHistory.add({
      sql,
      connectionId,
      connectionName: '',
      database: '',
      executionTime,
      rowCount,
      success,
      error,
      source: 'ai',
    });
  }

  /** Append LIMIT if the statement has none (best effort, skip if already present). */
  private ensureLimit(sql: string, maxRows: number): string {
    if (/\blimit\b|\bfetch\s+(first|next)\b|\btop\s+\d+/i.test(sql)) { return sql; }
    return `${sql.replace(/;\s*$/, '')} LIMIT ${maxRows}`;
  }

  /**
   * Enforce the row cap per driver: LIMIT for SQL dialects that support it,
   * `size` for Elasticsearch search bodies, `.limit()` for mongosh find calls.
   * MSSQL has no LIMIT syntax — its results are truncated after fetching.
   */
  private applyRowLimit(driverType: string | undefined, text: string, maxRows: number): string {
    switch (driverType) {
      case 'redis':
        // maxRows maps to SCAN COUNT / collection command truncation.
        return text;
      case 'mongodb': {
        if (!/\.\s*(find|findone)\s*\(/.test(text) || /\.\s*limit\s*\(/i.test(text)) { return text; }
        return `${text.trim().replace(/\s*;?\s*$/, '')}.limit(${maxRows})`;
      }
      case 'elasticsearch': {
        // Only search bodies are capped; other endpoints ignore size.
        if (!/_search\b/.test(text)) { return text; }
        const existing = /"size"\s*:\s*(\d+)/.exec(text);
        if (existing) {
          const capped = Math.min(Number(existing[1]) || maxRows, maxRows);
          return text.replace(/"size"\s*:\s*\d+/, `"size": ${capped}`);
        }
        const bodyStart = text.indexOf('{');
        if (bodyStart === -1) {
          return `${text.trim()}\n{"size": ${maxRows}}`;
        }
        const header = text.slice(0, bodyStart);
        const body = text.slice(bodyStart);
        const injected = body.replace(/\{/, `{\n  "size": ${maxRows},`);
        return `${header}${injected}`;
      }
      case 'mssql':
        // No LIMIT in T-SQL; the caller truncates fetched rows.
        return text;
      default:
        return this.ensureLimit(text, maxRows);
    }
  }

  /** Best-effort DDL string built from introspection data. */
  private buildDdl(driver: DatabaseDriver, table: string, columns: { name: string; type: string; nullable: boolean; default?: unknown }[], pk: string[]): string {
    const q = (n: string) => driver.escapeIdentifier(n);
    const cols = columns.map(c => {
      const parts = [`  ${q(c.name)}`, c.type];
      if (pk.includes(c.name)) { parts.push('PRIMARY KEY'); }
      else if (!c.nullable) { parts.push('NOT NULL'); }
      if (c.default != null && c.default !== '') {
        parts.push(`DEFAULT ${typeof c.default === 'string' ? `'${c.default}'` : c.default}`);
      }
      return parts.join(' ');
    });
    return `CREATE TABLE ${q(table)} (\n${cols.join(',\n')}\n);`;
  }

  // ── Server + tool registration ──

  private createMcpServer(clientName: string): McpServer {
    const mcp = new McpServer({ name: 'sqlens', version: '0.1.0' });
    const activity = this.activity;

    const cfg = vscode.workspace.getConfiguration('sqlens.mcp');
    const readOnly = cfg.get<boolean>('readOnly', true);
    const writeMode = cfg.get<string>('writeMode', 'confirm');
    const maxRowsDefault = cfg.get<number>('maxRows', 100);
    const maskSensitive = cfg.get<boolean>('maskSensitiveColumns', true);

    /** Wrap a handler so the call shows up in the AI Activity log. */
    const withActivity = async <A extends Record<string, unknown>, R>(
      tool: string,
      args: A,
      fn: () => Promise<R>,
      extra?: { sql?: string; connectionId?: string; rowCountFrom?: (r: R) => number | undefined },
    ): Promise<R> => {
      return activity.record(tool, clientName, JSON.stringify(args), fn, {
        sql: extra?.sql,
        connectionName: extra?.connectionId,
        rowCountFrom: extra?.rowCountFrom,
      });
    };

    // ── list_connections ──
    mcp.tool(
      'list_connections',
      'List all database connections configured in Sqlens. Returns id, name, type, database and connected status. Never returns credentials.',
      {},
      async () => {
        const connections = await withActivity('list_connections', {}, () => this.listConnections());
        return textResult({ connections });
      },
    );

    // ── list_databases ──
    mcp.tool(
      'list_databases',
      'List databases available on a connection.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections. Omit or "current" for the active connection.'),
      },
      async (args) => {
        const databases = await withActivity('list_databases', args, async () => {
          const conn = await this.getDriver(args.connectionId);
          return conn.driver.getDatabases();
        }, { connectionId: args?.connectionId });
        return textResult({ databases });
      },
    );

    // ── list_tables ──
    mcp.tool(
      'list_tables',
      'List tables and views with comments. Optionally filter by keyword.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections.'),
        keyword: z.string().optional().describe('Filter tables whose name contains this keyword (case-insensitive).'),
      },
      async (args) => {
        const tables = await withActivity('list_tables', args, async () => {
          const conn = await this.getDriver(args.connectionId);
          const all = await conn.driver.getTables();
          const filtered = args.keyword
            ? all.filter(t => t.name.toLowerCase().includes(args.keyword!.toLowerCase()))
            : all;
          return filtered.map(t => ({ name: t.name, type: t.type, comment: t.comment ?? '', rowCount: t.rowCount }));
        }, { connectionId: args?.connectionId });
        return textResult({ tables });
      },
    );

    // ── describe_table ──
    mcp.tool(
      'describe_table',
      'Get full table structure: columns, types, nullable, defaults, primary key, indexes, foreign keys and a CREATE TABLE DDL.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections.'),
        table: z.string().describe('Table name.'),
      },
      async (args) => {
        const result = await withActivity('describe_table', args, async () => {
          const conn = await this.getDriver(args.connectionId);
          const [columns, indexes, foreignKeys, pk] = await Promise.all([
            conn.driver.getColumns(args.table),
            conn.driver.getIndexes(args.table).catch(() => []),
            conn.driver.getForeignKeys(args.table).catch(() => []),
            conn.driver.getPrimaryKey(args.table).catch(() => []),
          ]);
          this.revealTable?.(args.table, conn.id);
          return {
            table: args.table,
            columns,
            primaryKey: pk,
            indexes,
            foreignKeys,
            ddl: this.buildDdl(conn.driver, args.table, columns, pk),
          };
        }, { connectionId: args?.connectionId });
        return textResult(result);
      },
    );

    // ── run_query ──
    mcp.tool(
      'run_query',
      'Execute a single read-only request. The accepted text depends on the connection type (see list_connections): '
      + 'SQL connections (mysql/mariadb/postgresql/sqlite/clickhouse/mssql) take a SELECT/SHOW/DESCRIBE/EXPLAIN (a row cap is enforced automatically); '
      + 'redis takes one read command (GET/HGETALL/SCAN/TYPE/TTL/...); '
      + 'elasticsearch takes a REST request which may be written as "GET /index/_search\\n{json body}" (a bare JSON body means a search); '
      + 'mongodb takes a mongosh-style call such as db.collection.find({...}).limit(10). '
      + 'Only one statement per call.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections.'),
        sql: z.string().describe('A single read statement in the connection type\'s input syntax.'),
        maxRows: z.number().int().min(1).max(1000).optional().describe(`Max rows to return (default ${maxRowsDefault}).`),
      },
      async (args) => {
        const result = await withActivity('run_query', args, async () => {
          const conn = await this.getDriver(args.connectionId);
          const driverType = conn.driver.driverType;
          if (driverType === 'redis') {
            // maxRows maps to SCAN/collection COUNT for Redis reads.
            (conn.driver as any).setScanCount?.(Math.min(args.maxRows ?? maxRowsDefault, 1000));
          }
          if (driverType === 'mongodb') {
            // maxRows maps to the aggregation $limit stage / find limit.
            (conn.driver as any).setRowLimit?.(Math.min(args.maxRows ?? maxRowsDefault, 1000));
          }
          const guard = this.guard.validate(args.sql, { readOnly: true, allowWrite: false, driverType });
          if (!guard.ok) { throw new Error(guard.reason); }
          const sql = isSqlFamily(driverType) ? guard.statements![0] : args.sql;
          this.assertTableAllowed(sql, conn.driver);
          const touchedTable = this.guard.extractTable(sql);
          if (touchedTable) { this.revealTable?.(touchedTable, conn.id); }
          const maxRows = Math.min(args.maxRows ?? maxRowsDefault, 1000);
          const limitSql = this.applyRowLimit(driverType, sql, maxRows);

          const start = performance.now();
          try {
            const queryResult = await conn.driver.query(limitSql);
            const executionTime = Math.round(performance.now() - start);

            const columns = queryResult.columns.map(c => c.name);
            let rows = queryResult.rows as unknown[][];
            let maskedColumns = 0;
            if (maskSensitive) {
              const masked = this.guard.maskRows(columns, rows);
              maskedColumns = masked.maskedCount;
              rows = masked.rows;
            }
            const totalRows = rows.length;
            const truncated = totalRows > maxRows;
            if (truncated) { rows = rows.slice(0, maxRows); }

            this.recordAiHistory(sql, conn.id, executionTime, totalRows, true);

            return { columns, rows, totalRows, truncated, executionTime, maskedColumns };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.recordAiHistory(sql, conn.id, 0, 0, false, msg);
            throw err;
          }
        }, {
          sql: args.sql,
          connectionId: args?.connectionId,
          rowCountFrom: r => r?.totalRows,
        });
        return textResult(result);
      },
    );

    // ── explain_query ──
    mcp.tool(
      'explain_query',
      'Get the execution plan of a read query WITHOUT executing it. '
      + 'SQL connections use EXPLAIN (SQLite: EXPLAIN QUERY PLAN); ClickHouse uses EXPLAIN; '
      + 'SQL Server runs SET STATISTICS PROFILE; MongoDB explains a find/aggregate call; '
      + 'Elasticsearch profiles a search request.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections.'),
        sql: z.string().describe('The read statement/request to explain (not executed).'),
      },
      async (args) => {
        const result = await withActivity('explain_query', args, async () => {
          const conn = await this.getDriver(args.connectionId);
          const driverType = conn.driver.driverType;
          const guard = this.guard.validate(args.sql, { readOnly: true, allowWrite: false, driverType });
          if (!guard.ok) { throw new Error(guard.reason); }
          const text = driverType === 'elasticsearch' || driverType === 'mongodb'
            ? args.sql
            : guard.statements![0];
          this.assertTableAllowed(text, conn.driver);

          const driverObj = conn.driver as unknown as Record<string, (...a: unknown[]) => Promise<any>>;

          switch (driverType) {
            case 'mssql': {
              const res = await driverObj.explainQuery(text);
              return { plan: (res.rows as unknown[][]).map(row => row.map(String).join(' | ')).join('\n') };
            }
            case 'mongodb': {
              const res = await driverObj.explainQuery(text);
              return { plan: res.rows[0]?.[0], note: 'Use db.<coll>.find(...) or .aggregate(...).' };
            }
            case 'elasticsearch': {
              const index = text.match(/^\s*(?:GET|POST)\s+\/?([^/\s?]+)\/_search/i)?.[1] || '_all';
              const body = text.match(/\{[\s\S]*\}\s*$/)?.[0] || '';
              const res = await driverObj.explainSearch(index, body);
              return { plan: res.rows[0]?.[0], columns: res.columns.map((c: { name: string }) => c.name) };
            }
            default: {
              const prefix = driverType === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
              const res = await conn.driver.query(`${prefix}${text}`);
              return { columns: res.columns.map(c => c.name), rows: res.rows };
            }
          }
        }, { sql: args.sql, connectionId: args?.connectionId });
        return textResult(result);
      },
    );

    // ── write_query ──
    mcp.tool(
      'write_query',
      'Execute a single write statement. Accepted per connection type: '
      + 'SQL (mysql/mariadb/postgresql/sqlite/mssql) INSERT/UPDATE/DELETE with a WHERE clause; '
      + 'clickhouse INSERT, or a bounded mutation `ALTER TABLE t UPDATE|DELETE ... WHERE ...` (asynchronous); '
      + 'redis one write command (SET/HSET/LPUSH/EXPIRE/DEL/...); '
      + 'elasticsearch PUT/POST to _doc/_update/_bulk/_index; '
      + 'mongodb insertOne/insertMany/updateOne/updateMany/replaceOne/deleteOne/deleteMany. '
      + 'DDL/DROP/TRUNCATE and destructive admin commands are never allowed. May require user confirmation.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections.'),
        sql: z.string().describe('A single write statement in the connection type\'s input syntax.'),
      },
      async (args) => {
        if (readOnly) {
          activity.recordBlocked('write_query', clientName, JSON.stringify(args), 'read-only mode enabled');
          return textResult({ ok: false, error: 'Read-only mode is enabled (sqlens.mcp.readOnly = true).' }, true);
        }
        if (writeMode === 'deny') {
          activity.recordBlocked('write_query', clientName, JSON.stringify(args), 'writeMode = deny');
          return textResult({ ok: false, error: 'Write operations are disabled (sqlens.mcp.writeMode = "deny").' }, true);
        }

        const guardConn = await this.getDriver(args.connectionId);
        const driverType = guardConn.driver.driverType;
        const guard = this.guard.validate(args.sql, { readOnly: false, allowWrite: true, driverType });
        if (!guard.ok) {
          activity.recordBlocked('write_query', clientName, JSON.stringify(args), guard.reason!);
          return textResult({ ok: false, error: guard.reason }, true);
        }
        const sql = isSqlFamily(driverType) ? guard.statements![0] : args.sql;
        this.assertTableAllowed(sql, guardConn.driver);

        if (writeMode === 'confirm') {
          const conn = await this.connectionManager.getSavedConnections().then(cs => cs.find(c => c.id === args.connectionId));
          const allowed = await activity.requestWriteConfirmation(
            sql,
            clientName,
            conn ? (conn.name || conn.host) : undefined,
          );
          if (!allowed) {
            return textResult({ ok: false, error: 'Execution denied by user or confirmation timed out.' }, true);
          }
        }

        const result = await withActivity('write_query', args, async () => {
          const conn = await this.getDriver(args.connectionId);
          const start = performance.now();
          try {
            const queryResult = await conn.driver.query(sql);
            const executionTime = Math.round(performance.now() - start);
            this.recordAiHistory(sql, conn.id, executionTime, queryResult.affectedRows ?? 0, true);
            return { ok: true, rowsAffected: queryResult.affectedRows ?? 0, executionTime };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.recordAiHistory(sql, conn.id, 0, 0, false, msg);
            throw err;
          }
        }, {
          sql: args.sql,
          connectionId: args?.connectionId,
          rowCountFrom: r => r?.rowsAffected,
        });
        return textResult(result);
      },
    );

    // ── search_schema ──
    mcp.tool(
      'search_schema',
      'Search across table names and column names by keyword. Faster and broader than list_tables when looking for where data lives.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections.'),
        keyword: z.string().describe('Keyword to search in table/column names (case-insensitive).'),
        limit: z.number().int().min(1).max(100).optional().describe('Max matches to return (default 30).'),
      },
      async (args) => {
        const matches = await withActivity('search_schema', args, async () => {
          const conn = await this.getDriver(args.connectionId);
          const limit = Math.min(args.limit ?? 30, 100);
          const kw = args.keyword.toLowerCase();
          const tables = await conn.driver.getTables();
          const results: { type: string; table: string; column?: string; dataType?: string; comment?: string }[] = [];

          for (const t of tables) {
            if (results.length >= limit) { break; }
            const nameHit = t.name.toLowerCase().includes(kw);
            if (nameHit) {
              results.push({ type: t.type, table: t.name, comment: t.comment });
            }
            // Look for matching columns in every table (capped to keep this cheap)
            try {
              const cols = await conn.driver.getColumns(t.name);
              for (const c of cols) {
                if (results.length >= limit) { break; }
                if (c.name.toLowerCase().includes(kw)) {
                  results.push({ type: 'column', table: t.name, column: c.name, dataType: c.type });
                }
              }
            } catch { /* skip columns for this table */ }
          }
          return results;
        }, { connectionId: args?.connectionId });
        return textResult({ matches });
      },
    );

    // ── table_stats ──
    mcp.tool(
      'table_stats',
      'Get row count and metadata for a table. Helps judge data volume before writing queries.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections.'),
        table: z.string().describe('Table name.'),
      },
      async (args) => {
        const result = await withActivity('table_stats', args, async () => {
          const conn = await this.getDriver(args.connectionId);
          let rowCount: number | undefined;
          try {
            const tables = await conn.driver.getTables();
            rowCount = tables.find(t => t.name === args.table)?.rowCount;
          } catch { /* fall through to COUNT(*) */ }
          if (rowCount == null) {
            const r = await conn.driver.query(`SELECT COUNT(*) FROM ${conn.driver.escapeIdentifier(args.table)}`);
            const first = (r.rows as unknown[][])[0];
            rowCount = typeof first?.[0] === 'number' ? first[0] : Number(first?.[0]);
          }
          const indexes = await conn.driver.getIndexes(args.table).catch(() => []);
          this.revealTable?.(args.table, conn.id);
          return { table: args.table, rowCount, indexCount: indexes.length, indexes };
        }, { connectionId: args?.connectionId });
        return textResult(result);
      },
    );

    return mcp;
  }
}
