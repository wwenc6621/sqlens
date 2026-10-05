/**
 * MCP server smoke tests: boot the real HTTP server (with a stubbed host) and
 * drive it the way an AI client does. Guards against the class of bug where a
 * duplicated tool registration makes every request fail with 500.
 *
 * Requests use the raw `http` module instead of `fetch`: undici pools sockets
 * per origin, so a later test would reuse a connection belonging to a server
 * instance an earlier test already shut down (ECONNRESET).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import { McpService } from '../src/core/mcp/McpService';

function stubContext() {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
      update: async (key: string, value: unknown) => { store.set(key, value); },
    },
  } as never;
}

function stubService(): McpService {
  return new McpService(
    { getSavedConnections: async () => [], activeConnectionId: undefined, getDriver: () => undefined } as never,
    { add() { /* noop */ } } as never,
    { recordBlocked() { /* noop */ } } as never,
  );
}

interface JsonResponse { status: number; body: Record<string, unknown> }

function postJson(endpoint: string, headers: Record<string, string>, payload: unknown): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const port = Number(new URL(endpoint).port);
    const request = http.request(
      // `agent: false` opens a fresh socket per request so one test can never
      // reuse a connection belonging to a server another test shut down.
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers, agent: false },
      response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => {
          let body: Record<string, unknown> = {};
          try { body = data ? JSON.parse(data) : {}; } catch { body = { raw: data }; }
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(payload));
  });
}

const INITIALIZE = (clientName: string) => ({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: clientName, version: '1.0.0' } },
});

test('MCP server answers initialize and registers every tool exactly once', async () => {
  const context = stubContext();
  const service = stubService();
  await service.start(context);
  try {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${service.getAuthToken(context)}`,
    };

    const init = await postJson(service.endpoint, headers, INITIALIZE('unit-test'));
    assert.equal(init.status, 200, `initialize failed: ${JSON.stringify(init.body)}`);
    assert.equal(init.body.error, undefined, `initialize error: ${JSON.stringify(init.body.error)}`);

    const list = await postJson(service.endpoint, headers, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.status, 200, `tools/list failed: ${JSON.stringify(list.body)}`);

    const tools = (list.body.result as { tools: Array<{ name: string }> }).tools.map(t => t.name);
    assert.ok(tools.length >= 6, `expected the full tool set, got: ${tools.join(', ')}`);
    assert.ok(tools.includes('explain_query'), 'explain_query must be exposed');
    assert.equal(new Set(tools).size, tools.length, `duplicate tool names: ${tools.join(', ')}`);
  } finally {
    await service.stop();
  }
});

test('the assistant name from initialize is reused for later tool calls', async () => {
  const context = stubContext();
  const service = stubService();
  await service.start(context);
  try {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${service.getAuthToken(context)}`,
    };

    const init = await postJson(service.endpoint, headers, INITIALIZE('codebuddy'));
    assert.equal(init.status, 200);

    const internals = service as unknown as {
      lastClientName: string;
      resolveClientName: (req: unknown, body: unknown) => string;
    };
    assert.equal(internals.lastClientName, 'CodeBuddy');

    // Later requests carry no clientInfo — the remembered name is reused.
    assert.equal(internals.resolveClientName({ headers: {} }, { method: 'tools/call' }), 'CodeBuddy');
  } finally {
    await service.stop();
  }
});

test('client names fall back to the User-Agent, ignoring HTTP libraries', () => {
  // Each case gets its own instance: a resolved name is remembered for later
  // requests, so sharing one service would leak between assertions.
  const resolve = (userAgent?: string) => (stubService() as unknown as {
    resolveClientName: (req: unknown, body: unknown) => string;
  }).resolveClientName({ headers: userAgent ? { 'user-agent': userAgent } : {} }, {});

  assert.equal(resolve('windsurf/1.2.3'), 'Windsurf');
  assert.equal(resolve('claude-code/0.9'), 'Claude Code');
  assert.equal(resolve('undici'), 'ai-assistant');
  assert.equal(resolve(), 'ai-assistant');
});

test('MCP server rejects requests without the bearer token', async () => {
  const context = stubContext();
  const service = stubService();
  await service.start(context);
  try {
    const res = await postJson(
      service.endpoint,
      { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    );
    assert.equal(res.status, 401);
  } finally {
    await service.stop();
  }
});

// ── Catalog comments reach the AI ───────────────────────────────────────────

/** A service wired to one connected MySQL-ish driver that reports comments. */
function stubServiceWithDriver(): McpService {
  const driver = {
    driverType: 'mysql',
    isConnected: true,
    escapeIdentifier: (n: string) => `\`${n}\``,
    getTables: async () => [
      { name: 'users', type: 'table', comment: 'User accounts' },
    ],
    getColumns: async () => [
      { name: 'id', type: 'int', comment: 'Primary key' },
      { name: 'email', type: 'varchar(255)', comment: 'login email' },
    ],
    getIndexes: async () => [],
    getForeignKeys: async () => [],
    getPrimaryKey: async () => ['id'],
  };
  const conn = { id: 'c1', name: 'Test DB', host: 'localhost', type: 'mysql' };
  return new McpService(
    {
      getSavedConnections: async () => [conn],
      activeConnectionId: 'c1',
      getDriver: () => driver,
    } as never,
    { add() { /* noop */ } } as never,
    {
      record: async (_tool: string, _client: string, _args: string, fn: () => Promise<unknown>) => fn(),
      recordBlocked() { /* noop */ },
    } as never,
  );
}

const AUTH_HEADERS = (token: string) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${token}`,
});

async function callTool(
  endpoint: string,
  headers: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const res = await postJson(endpoint, headers, {
    jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args },
  });
  assert.equal(res.status, 200, `tools/call ${name} failed: ${JSON.stringify(res.body)}`);
  const content = (res.body.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, any>;
}

test('describe_table exposes table and column comments from the catalog', async () => {
  const context = stubContext();
  const service = stubServiceWithDriver();
  await service.start(context);
  try {
    const headers = AUTH_HEADERS(service.getAuthToken(context));
    const desc = await callTool(service.endpoint, headers, 'describe_table', { connectionId: 'c1', table: 'users' });
    assert.equal(desc.tableComment, 'User accounts');
    const byName = Object.fromEntries(desc.columns.map((c: any) => [c.name, c.comment]));
    assert.equal(byName.id, 'Primary key');
    assert.equal(byName.email, 'login email');
  } finally {
    await service.stop();
  }
});

test('search_schema matches table and column comments', async () => {
  const context = stubContext();
  const service = stubServiceWithDriver();
  await service.start(context);
  try {
    const headers = AUTH_HEADERS(service.getAuthToken(context));

    // "login" appears only in the email column comment.
    const byColumn = await callTool(service.endpoint, headers, 'search_schema', { connectionId: 'c1', keyword: 'login' });
    assert.ok(
      byColumn.matches.some((m: any) => m.type === 'column' && m.table === 'users' && m.column === 'email'),
      `expected the email column via its comment, got: ${JSON.stringify(byColumn.matches)}`,
    );

    // "accounts" appears only in the table comment.
    const byTable = await callTool(service.endpoint, headers, 'search_schema', { connectionId: 'c1', keyword: 'accounts' });
    assert.ok(
      byTable.matches.some((m: any) => m.type === 'table' && m.table === 'users'),
      `expected the users table via its comment, got: ${JSON.stringify(byTable.matches)}`,
    );
  } finally {
    await service.stop();
  }
});
