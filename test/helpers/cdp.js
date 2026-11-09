// @ts-check
// A small Chrome DevTools Protocol client over the `ws` package (design doc 19.5), no Puppeteer.
// launchChrome() starts headless Chrome on a throwaway profile and reads its port from DevToolsActivePort;
// newPage() opens a tab with PUT /json/new and returns { send, on, waitFor, evaluate, waitUntil, close }.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** @returns {string | null} the Chrome binary: $CHROME, else the macOS default, else null */
export function findChrome() {
  for (const p of [process.env.CHROME, MAC_CHROME]) if (p && existsSync(p)) return p;
  return null;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ chrome?: string, args?: string[], timeoutMs?: number }} [opts]
 */
export async function launchChrome({ chrome = findChrome(), args = [], timeoutMs = 15000 } = {}) {
  if (!chrome) throw new Error('Chrome not found; set CHROME');
  const dir = mkdtempSync(join(tmpdir(), 'ftl-chrome-'));
  const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', ...args, 'about:blank'], { stdio: 'ignore' });
  const exited = new Promise((r) => proc.once('exit', r));
  const portFile = join(dir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(portFile) || !readFileSync(portFile, 'utf8').includes('\n')) {
    if (Date.now() > deadline || proc.exitCode !== null) throw new Error('Chrome did not start');
    await sleep(50);
  }
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    /** @param {string} [url] */
    async newPage(url = 'about:blank') {
      const info = await (await fetch(`${base}/json/new?${url}`, { method: 'PUT' })).json();
      const page = await connect(info.webSocketDebuggerUrl);
      return { ...page, async close() { page.socket.close(); await fetch(`${base}/json/close/${info.id}`).catch(() => {}); } };
    },
    async close() {
      proc.kill();
      await Promise.race([exited, sleep(3000)]);
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** @param {string} wsUrl */
async function connect(wsUrl) {
  const Socket = /** @type {any} */ (WebSocket);   // the ws package ships no types
  const socket = new Socket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let id = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const calls = new Map();
  /** @type {Map<string, Set<(params: any) => void>>} */
  const listeners = new Map();
  socket.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined) {
      const call = calls.get(msg.id);
      calls.delete(msg.id);
      if (msg.error) call?.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else call?.resolve(msg.result);
    } else {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  });

  /** @param {string} method @param {object} [params] @returns {Promise<any>} */
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    calls.set(n, { resolve, reject });
    socket.send(JSON.stringify({ id: n, method, params }));
  });
  /** @param {string} method @param {(params: any) => void} fn @returns {() => void} */
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method).delete(fn);
  };
  /** @param {string} method @param {(params: any) => boolean} [pred] @param {number} [timeoutMs] */
  const waitFor = (method, pred = () => true, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    const off = on(method, (p) => {
      if (!pred(p)) return;
      clearTimeout(timer);
      off();
      resolve(p);
    });
  });
  /** Evaluate an expression in the page (promises awaited) and return its JSON value. @param {string} expression */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  /** Poll an expression until it is truthy; returns its value. @param {string} expression @param {number} [timeoutMs] */
  const waitUntil = async (expression, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await evaluate(expression).catch(() => undefined);
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
      await sleep(100);
    }
  };
  return { socket, send, on, waitFor, evaluate, waitUntil };
}
