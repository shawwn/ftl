// @ts-check
// WebSocket smoke test (design doc 19.4): the real server on port 0 with plain `ws` clients, then static
// serving, including traversal attempts sent as raw request paths (fetch would normalize them away).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { startServer } from '../server/main.js';
import { serveStatic, notFound } from '../server/static.js';
import { CONTENT_HASH } from '../shared/content/index.js';
import { parseServer } from '../shared/net/protocol.js';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
let base = '';

before(async () => {
  server = await startServer({ port: 0 });
  base = `127.0.0.1:${server.port}`;
});
after(() => server.close());

/** A ws client that queues parsed messages; next(pred) takes the first unread match. */
async function connect() {
  const ws = new WebSocket(`ws://${base}/ws`);
  /** @type {any[]} */
  const got = [];
  /** @type {((v?: unknown) => void)[]} */
  let waiters = [];
  const wake = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };
  ws.on('message', (data) => {
    const text = data.toString();
    assert.equal(parseServer(text).ok, true, `invalid server message: ${text.slice(0, 200)}`);
    got.push(JSON.parse(text));
    wake();
  });
  ws.on('close', wake);
  await new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
  let cursor = 0;
  return {
    ws,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    /** @param {(m: any) => boolean} [pred] */
    async next(pred = () => true, ms = 5000) {
      const deadline = Date.now() + ms;
      for (;;) {
        while (cursor < got.length) if (pred(got[cursor++])) return got[cursor - 1];
        if (ws.readyState === ws.CLOSED) throw new Error('socket closed');
        if (Date.now() > deadline) throw new Error('timed out waiting for a message');
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
    },
    close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
  };
}

/** @param {string} path @returns {Promise<{ status: number, type: string, body: string, etag: string }>} */
function get(path, headers = {}, port = server.port) {
  return new Promise((ok, fail) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body, etag: String(res.headers.etag) }));
    }).on('error', fail).end();
  });
}

test('websocket session: welcome, create, snaps, commands, co-op, spectator, resume, bad input', async () => {
  // 1. hello -> welcome
  const a = await connect();
  a.send({ t: 'hello', v: 1, name: 'A' });
  const welcome = await a.next();
  assert.equal(welcome.t, 'welcome');
  assert.match(welcome.token, /^[0-9a-f]{32}$/);
  assert.equal(welcome.content, CONTENT_HASH);

  // 2. create vsAi -> joined on s1, then snaps with increasing ticks and a redacted view
  a.send({ t: 'create', rid: 1, preset: 'vsAi', opts: { ai: 'drifter', seed: 1 } });
  const joined = await a.next((m) => m.t === 'joined');
  assert.equal(joined.re, 1);
  assert.equal(joined.you.ship, 's1');
  const s1 = await a.next((m) => m.t === 'snap');
  const s2 = await a.next((m) => m.t === 'snap' && m.tick > s1.tick);
  assert.ok(s2.tick > s1.tick);
  assert.ok(s2.view.ships.s1 && s2.view.ships.s2);
  assert.equal(s2.view.ships.s2.systems.shields.want, undefined);
  assert.equal(s2.view.rng, undefined);

  // 3. commands are acked with the sim's verdict
  const ember = s2.view.ships.s1.devices.find((d) => d.bp === 'ember');
  a.send({ t: 'cmd', rid: 2, c: { type: 'setTarget', device: ember.id, target: { ship: 's2', room: 'S' } } });
  assert.deepEqual(await a.next((m) => m.t === 'ack' && m.re === 2).then((m) => m.ok), true);
  a.send({ t: 'cmd', rid: 3, c: { type: 'setPower', system: 'nope' } });
  const bad = await a.next((m) => m.t === 'ack' && m.re === 3);
  assert.deepEqual([bad.ok, bad.why], [false, 'no-system']);

  // 4. B joins as co-op crew; C spectates and is refused commands
  const b = await connect();
  b.send({ t: 'hello', v: 1, name: 'B' });
  b.send({ t: 'join', rid: 1, code: joined.code });
  assert.equal((await b.next((m) => m.t === 'joined')).you.ship, 's1');
  const c = await connect();
  c.send({ t: 'hello', v: 1, name: 'C' });
  c.send({ t: 'join', rid: 1, code: joined.code, spectate: true });
  assert.equal((await c.next((m) => m.t === 'joined')).you.role, 'spectator');
  c.send({ t: 'cmd', rid: 2, c: { type: 'setAuto', device: ember.id, on: true } });
  const refused = await c.next((m) => m.t === 'ack');
  assert.deepEqual([refused.ok, refused.why], [false, 'spectator']);

  // 5. A closes; a new socket resumes with the token
  await a.close();
  const a2 = await connect();
  a2.send({ t: 'hello', v: 1, token: welcome.token });
  assert.equal((await a2.next()).t, 'welcome');
  const rejoined = await a2.next();
  assert.deepEqual([rejoined.t, rejoined.code, rejoined.you.member], ['joined', joined.code, joined.you.member]);
  assert.equal((await a2.next()).t, 'snap');

  // 6. malformed JSON -> bad-message, and the socket stays open
  a2.send('{nope');
  assert.equal((await a2.next((m) => m.t === 'error')).code, 'bad-message');
  a2.send({ t: 'ping', ct: 42 });
  assert.equal((await a2.next((m) => m.t === 'pong')).ct, 42);

  await Promise.all([a2.close(), b.close(), c.close()]);
});

test('static files: client and shared with MIME types; traversal and other paths are 404', async () => {
  const health = await get('/healthz');
  assert.deepEqual([health.status, health.body], [200, 'ok']);
  for (const [path, type] of [['/', 'text/html'], ['/client/main.js', 'text/javascript'], ['/shared/sim/index.js', 'text/javascript']]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.ok(res.type.startsWith(type), `${path}: ${res.type}`);
  }
  for (const path of ['/../package.json', '/server/main.js', '/package.json', '/client/../package.json',
    '/shared/%2e%2e/package.json', '/client/..%2fserver%2fmain.js', '/shared/..%5cpackage.json', '/client/%00.js',
    '/client/%E0%A4%A.js', '/node_modules/ws/index.js', '/client', '/shared/sim/', '/nope.html']) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test('serveStatic: ETag revalidation, HEAD, only listed MIME types, directories are 404', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ftl-static-'));
  await mkdir(join(root, 'client', 'sub.js'), { recursive: true });
  await mkdir(join(root, 'shared'));
  await writeFile(join(root, 'client', 'index.html'), '<!doctype html><title>t</title>');
  await writeFile(join(root, 'client', 'notes.md'), 'secret-ish');
  await writeFile(join(root, 'shared', 'data.json'), '{"a":1}');
  await writeFile(join(root, 'secret.js'), 'nope');
  const http = createServer((req, res) => { if (!serveStatic(req, res, root)) notFound(res); });
  await new Promise((r) => http.listen(0, '127.0.0.1', () => r(undefined)));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const page = await get('/', {}, port);
    assert.deepEqual([page.status, page.body], [200, '<!doctype html><title>t</title>']);
    assert.equal((await get('/', { 'if-none-match': page.etag }, port)).status, 304);
    assert.equal((await get('/', { 'if-none-match': 'W/"other"' }, port)).status, 200);
    const json = await get('/shared/data.json', {}, port);
    assert.deepEqual([json.status, json.type, json.body], [200, 'application/json; charset=utf-8', '{"a":1}']);
    assert.equal((await get('/client/notes.md', {}, port)).status, 404, 'unlisted types are not served');
    assert.equal((await get('/client/sub.js', {}, port)).status, 404, 'directories are not files');
    assert.equal((await get('/client/missing.js', {}, port)).status, 404);
    assert.equal((await get('/secret.js', {}, port)).status, 404);
    const head = await new Promise((ok) => request({ host: '127.0.0.1', port, path: '/', method: 'HEAD' }, (res) => {
      res.resume();
      res.on('end', () => ok(res.statusCode));
    }).end());
    assert.equal(head, 200);
  } finally {
    await new Promise((r) => http.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test('a frame over maxPayload closes only that socket (1009); the server keeps serving (host-1)', async () => {
  const a = await connect();
  a.send({ t: 'hello', v: 1 });
  await a.next((m) => m.t === 'welcome');
  const closed = new Promise((r) => a.ws.once('close', (code) => r(code)));
  a.ws.send('x'.repeat(20000));
  assert.equal(await closed, 1009);
  const b = await connect();
  b.send({ t: 'hello', v: 1 });
  assert.equal((await b.next()).t, 'welcome');
  b.send({ t: 'ping', ct: 7 });
  assert.deepEqual(await b.next((m) => m.t === 'pong'), { t: 'pong', ct: 7, tick: 0 });
  await b.close();
});
