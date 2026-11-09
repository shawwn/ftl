// @ts-check
// The server (design doc 18): node:http for static files and /healthz, a WebSocket upgrade on /ws whose
// sockets become Links into one Lobby. Run directly with `node server/main.js` (PORT overrides 8080).
// Doc choices: close() also terminates open sockets and idle keep-alive connections so it resolves
// promptly; the heartbeat timer is unref'd so it never keeps a process alive by itself.

import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { CONTENT } from '../shared/content/index.js';
import { LIMITS } from '../shared/net/protocol.js';
import { Lobby } from '../shared/host/lobby.js';
import { realClock } from '../shared/host/clock.js';
import { serveStatic, notFound } from './static.js';
import { wsLink } from './ws-link.js';

/** @typedef {import('../shared/host/clock.js').Clock} Clock */

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEARTBEAT_MS = 15000;

/**
 * @param {{ port?: number, host?: string, clock?: Clock }} [opts]
 * @returns {Promise<{ port: number, lobby: Lobby, close(): Promise<void> }>}
 */
export async function startServer({ port = 8080, host = '0.0.0.0', clock = realClock() } = {}) {
  const lobby = new Lobby({ content: CONTENT, clock });
  const server = createServer((req, res) => {
    if (req.url === '/healthz') res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    else if (!serveStatic(req, res, ROOT)) notFound(res);
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.maxBytes, perMessageDeflate: { threshold: 1024 } });
  const alive = new WeakSet();
  wss.on('connection', (socket) => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    lobby.connect(wsLink(socket));
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) socket.terminate();
      else {
        alive.delete(socket);
        socket.ping();
      }
    }
  }, HEARTBEAT_MS);
  /** @type {any} */ (heartbeat).unref();   // a Node Timeout (DOM lib types say number)

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => done(undefined));
  });
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : port,
    lobby,
    async close() {
      clearInterval(heartbeat);
      lobby.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => wss.close(() => done(undefined)));
      server.closeAllConnections();
      await new Promise((done) => server.close(() => done(undefined)));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { port } = await startServer({ port: Number(process.env.PORT) || 8080 });
  console.log(`Faster than Lumos is listening on http://localhost:${port}`);
}
