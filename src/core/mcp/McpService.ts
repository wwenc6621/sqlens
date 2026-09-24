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
import { ActivityBridge } from './ActivityBridge';
import { Logger } from '../utils/Logger';

const DEFAULT_PORT = 37421;

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

  constructor(
    private connectionManager: ConnectionManager,
    private queryHistory: QueryHistory,
    private activity: ActivityBridge,
    /** Optional callback to highlight a table in the Schema tree when AI touches it. */
    private revealTable?: (table: string, connectionId: string) => void,
  ) {}

  get endpoint(): string { return `http://127.0.0.1:${this.port}/mcp`; }
  get running(): boolean { return this.server !== null; }

  /** Generate/return the stored bearer token. */
  getAuthToken(context: vscode.ExtensionContext): string {
    let token = context.globalState.get<string>('sqlens.mcp.token');
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      void context.globalState.update('sqlens.mcp.token', token);
    }
    return token;
  }

  async regenerateToken(context: vscode.ExtensionContext): Promise<string> {
    const token = crypto.randomBytes(24).toString('hex');
    await context.globalState.update('sqlens.mcp.token', token);
    this.token = token;
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

    const clientName = this.extractClientName(body);

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
      return info?.name || 'ai-assistant';
    } catch {
      return 'ai-assistant';
    }
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
    return { id: config.id, name: config.name || config.host, driver };
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
      'Execute a single read-only SQL statement (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH...SELECT). One statement only; a LIMIT is enforced automatically.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections.'),
        sql: z.string().describe('A single read SQL statement.'),
        maxRows: z.number().int().min(1).max(1000).optional().describe(`Max rows to return (default ${maxRowsDefault}).`),
      },
      async (args) => {
        const result = await withActivity('run_query', args, async () => {
          const conn = await this.getDriver(args.connectionId);
          const guard = this.guard.validate(args.sql, { readOnly: true, allowWrite: false });
          if (!guard.ok) { throw new Error(guard.reason); }
          const sql = guard.statements![0];
          const touchedTable = this.guard.extractTable(sql);
          if (touchedTable) { this.revealTable?.(touchedTable, conn.id); }
          const maxRows = Math.min(args.maxRows ?? maxRowsDefault, 1000);
          const limitSql = this.ensureLimit(sql, maxRows);

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

    // ── write_query ──
    mcp.tool(
      'write_query',
      'Execute a single write statement (INSERT/UPDATE/DELETE). DDL/DROP/TRUNCATE are never allowed. UPDATE/DELETE must include a WHERE clause. May require user confirmation.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections.'),
        sql: z.string().describe('A single write SQL statement.'),
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

        const guard = this.guard.validate(args.sql, { readOnly: false, allowWrite: true });
        if (!guard.ok) {
          activity.recordBlocked('write_query', clientName, JSON.stringify(args), guard.reason!);
          return textResult({ ok: false, error: guard.reason }, true);
        }
        const sql = guard.statements![0];

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

    // ── explain_query ──
    mcp.tool(
      'explain_query',
      'Get the execution plan (EXPLAIN) for a read-only SQL statement.',
      {
        connectionId: z.string().optional().describe('Connection id from list_connections.'),
        sql: z.string().describe('The SQL statement to explain.'),
      },
      async (args) => {
        const result = await withActivity('explain_query', args, async () => {
          const conn = await this.getDriver(args.connectionId);
          const guard = this.guard.validate(args.sql, { readOnly: true, allowWrite: false });
          if (!guard.ok) { throw new Error(guard.reason); }
          const plan = await conn.driver.query(`EXPLAIN ${guard.statements![0]}`);
          return { plan: plan.rows };
        }, { sql: args.sql, connectionId: args?.connectionId });
        return textResult(result);
      },
    );

    return mcp;
  }
}
