// @ts-check
// Static files (design doc 18): `/` is client/index.html; /client/* and /shared/* come from disk, so URL
// paths mirror repo paths and relative imports mean the same thing in Node and the browser.
// Doc choices: only GET and HEAD; only files with a listed MIME type are served (anything else is 404);
// a path is resolved (after URL normalization and decoding) and must stay inside client/ or shared/;
// ETag is weak, from size and mtime, with 304 on If-None-Match.

import { stat, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

/** @typedef {import('node:http').IncomingMessage} Req */
/** @typedef {import('node:http').ServerResponse} Res */

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const SERVED_DIRS = ['client', 'shared'];
const ALIASES = { '/': '/client/index.html' };

/**
 * @param {Req} req @param {Res} res @param {string} root   repo root
 * @returns {boolean} true if handled (the response is then answered asynchronously)
 */
export function serveStatic(req, res, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const file = resolveFile(req.url ?? '/', root);
  if (!file) return false;
  send(req, res, file).catch(() => notFound(res));
  return true;
}

/** @param {string} url @param {string} root @returns {string | null} absolute path inside a served dir */
export function resolveFile(url, root) {
  let path;
  try {
    path = decodeURIComponent(new URL(url, 'http://x').pathname);
  } catch {
    return null;
  }
  path = Object.hasOwn(ALIASES, path) ? ALIASES[path] : path;
  if (path.includes('\0') || !Object.hasOwn(MIME, extname(path))) return null;
  const file = resolve(root, '.' + path);
  return SERVED_DIRS.some((d) => file.startsWith(resolve(root, d) + sep)) ? file : null;
}

/** @param {Req} req @param {Res} res @param {string} file */
async function send(req, res, file) {
  const info = await stat(file);
  if (!info.isFile()) return notFound(res);
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': MIME[extname(file)], 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  const body = req.method === 'HEAD' ? null : await readFile(file);
  res.writeHead(200, { ...headers, 'Content-Length': info.size }).end(body);
}

/** @param {Res} res */
export function notFound(res) {
  if (res.headersSent) return res.destroy();
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
}
