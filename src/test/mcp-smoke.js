/**
 * Standalone smoke test for the stateless Streamable HTTP MCP pattern
 * used in McpService. Run: node dist/test/mcp-smoke.js
 */
const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const TOKEN = 'test-token';
let toolsListed = null;
let echoResult = null;

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401); res.end(); return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const mcp = new McpServer({ name: 'sqlens-test', version: '0.0.1' });
  res.on('close', () => { transport.close(); mcp.close(); });

  mcp.tool('echo', 'echoes input', { message: z.string() }, async ({ message }) => ({
    content: [{ type: 'text', text: JSON.stringify({ echo: message }) }],
  }));
  mcp.tool('fail_tool', 'always fails', {}, async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }));

  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
});

async function post(payload) {
  const res = await fetch('http://127.0.0.1:39999/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!text.trim()) { return { status: res.status, body: {} }; }
  // enableJsonResponse may return SSE-framed data
  const sse = /^data: (.*)$/m.exec(text);
  return { status: res.status, body: JSON.parse(sse ? sse[1] : text) };
}

(async () => {
  await new Promise(r => server.listen(39999, '127.0.0.1', r));

  // 1. no token -> 401
  const noAuth = await fetch('http://127.0.0.1:39999/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' });
  console.log('401 check:', noAuth.status === 401 ? 'PASS' : `FAIL(${noAuth.status})`);

  // 2. initialize
  const init = await post({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  });
  console.log('initialize:', init.status === 200 && init.body.result?.serverInfo?.name === 'sqlens-test' ? 'PASS' : `FAIL ${JSON.stringify(init.body).slice(0, 200)}`);

  // 3. initialized notification + tools/list
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  toolsListed = list.body.result?.tools?.map(t => t.name);
  console.log('tools/list:', JSON.stringify(toolsListed) === JSON.stringify(['echo', 'fail_tool']) ? 'PASS' : `FAIL ${JSON.stringify(list.body).slice(0, 200)}`);

  // 4. tools/call
  const call = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { message: 'hello-ai' } } });
  echoResult = call.body.result?.content?.[0]?.text;
  console.log('tools/call:', echoResult === JSON.stringify({ echo: 'hello-ai' }) ? 'PASS' : `FAIL ${JSON.stringify(call.body).slice(0, 200)}`);

  server.close();
  const allPass = noAuth.status === 401;
  console.log(allPass ? 'DONE' : 'DONE-WITH-FAILURES');
})().catch(e => { console.error('SMOKE ERROR', e); process.exit(1); });
