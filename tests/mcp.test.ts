/**
 * MCP server smoke test: boots the real HTTP server (with a stubbed host) and
 * drives it the way an AI client does. Guards against the class of bug where a
 * duplicated tool registration makes every request fail with 500.
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

test('MCP server answers initialize and registers every tool exactly once', async () => {
  const context = stubContext();
  const service = new McpService(
    { getSavedConnections: async () => [], activeConnectionId: undefined, getDriver: () => undefined } as never,
    { add() { /* noop */ } } as never,
    { recordBlocked() { /* noop */ } } as never,
  );

  await service.start(context);
  try {
    const token = service.getAuthToken(context);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    };

    const post = async (payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(service.endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };

    const init = await post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'unit-test', version: '1.0.0' } },
    });
    assert.equal(init.status, 200, `initialize failed: ${JSON.stringify(init.body)}`);
    assert.equal(init.body.error, undefined, `initialize error: ${JSON.stringify(init.body.error)}`);

    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.status, 200, `tools/list failed: ${JSON.stringify(list.body)}`);

    const tools = (list.body.result as { tools: Array<{ name: string }> }).tools.map(t => t.name);
    assert.ok(tools.length >= 6, `expected the full tool set, got: ${tools.join(', ')}`);
    assert.ok(tools.includes('explain_query'), 'explain_query must be exposed');
    assert.equal(new Set(tools).size, tools.length, `duplicate tool names: ${tools.join(', ')}`);
  } finally {
    await service.stop();
  }
});

test('MCP server rejects requests without the bearer token', async () => {
  const context = stubContext();
  const service = new McpService(
    { getSavedConnections: async () => [], activeConnectionId: undefined, getDriver: () => undefined } as never,
    { add() { /* noop */ } } as never,
    { recordBlocked() { /* noop */ } } as never,
  );

  await service.start(context);
  try {
    // Use the raw http client: fetch (undici) pools sockets by origin and
    // would reuse a connection belonging to a server instance this suite has
    // already shut down.
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: Number(new URL(service.endpoint).port),
          path: '/mcp',
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        },
        response => { response.resume(); resolve(response.statusCode ?? 0); },
      );
      request.on('error', reject);
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    });
    assert.equal(status, 401);
  } finally {
    await service.stop();
  }
});
