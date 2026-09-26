/**
 * Wait until every `host:port` argument accepts a TCP connection.
 * Used by CI before the integration suite runs (service containers start
 * asynchronously and report "ready" before the database is actually serving).
 *
 *   node scripts/wait-for-ports.mjs 127.0.0.1:9200 127.0.0.1:1433
 */
import net from 'node:net';

const targets = process.argv.slice(2).map(spec => {
  const [host, port] = spec.split(':');
  return { host, port: Number(port), raw: spec };
});
if (targets.length === 0) {
  console.error('usage: wait-for-ports.mjs host:port [host:port ...]');
  process.exit(2);
}

const TIMEOUT_MS = 180_000;
const deadline = Date.now() + TIMEOUT_MS;

const probe = ({ host, port }) => new Promise(resolve => {
  const socket = net.createConnection({ host, port });
  const done = (ok) => { socket.destroy(); resolve(ok); };
  socket.setTimeout(3_000);
  socket.once('connect', () => done(true));
  socket.once('timeout', () => done(false));
  socket.once('error', () => done(false));
});

for (const target of targets) {
  let ready = false;
  while (!ready && Date.now() < deadline) {
    ready = await probe(target);
    if (!ready) { await new Promise(r => setTimeout(r, 2_000)); }
  }
  if (!ready) {
    console.error(`timeout waiting for ${target.raw}`);
    process.exit(1);
  }
  console.log(`${target.raw} is up`);
}
