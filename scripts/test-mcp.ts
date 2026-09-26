/* Diagnostic: drive the local MCP server over HTTP the way a client does. */
import { McpService } from '../src/core/mcp/McpService';
import { Logger } from '../src/core/utils/Logger';

async function main() {
  // Surface server-side errors (the logger writes to a VS Code channel).
  const logger = Logger.getInstance() as unknown as Record<string, (...a: unknown[]) => void>;
  logger.logError = (...args: unknown[]) => console.error('[server]', ...args);
  logger.logInfo = (...args: unknown[]) => console.log('[server]', ...args);

  const store = new Map<string, unknown>();
  const context = {
    globalState: {
      get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
      update: async (key: string, value: unknown) => { store.set(key, value); },
    },
  } as never;

  const connectionManager = {
    getSavedConnections: async () => [],
    activeConnectionId: undefined,
    getDriver: () => undefined,
  } as never;
  const history = { add() {} } as never;
  const activity = { recordBlocked() {} } as never;

  const service = new McpService(connectionManager, history, activity);
  await service.start(context);
  console.log('endpoint:', service.endpoint);

  const token = service.getAuthToken(context);
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  };

  const post = async (payload: unknown) => {
    const res = await fetch(service.endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await res.text();
    return { status: res.status, text: text.slice(0, 400) };
  };

  const init = await post({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'diag' } },
  });
  console.log('initialize ->', init.status, init.text);

  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  console.log('tools/list ->', list.status, list.text);

  // A GET (SSE probe) is expected to answer 405 in stateless mode.
  const get = await fetch(service.endpoint, { headers });
  console.log('GET probe ->', get.status);

  await service.stop();
}

main().catch(err => { console.error('FAIL:', err?.message ?? err); process.exit(1); });
