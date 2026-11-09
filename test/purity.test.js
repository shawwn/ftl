// @ts-check
// Static checks of the zone rules (design doc section 5). Comments and quoted strings are stripped before
// token checks, so prose and user-facing text may mention forbidden names; import specifiers are checked
// in raw text (JSDoc imports included), which also rules out 'node:' imports in shared/ and client/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} dir @returns {string[]} absolute .js paths */
function jsFiles(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const p = join(abs, name);
    if (statSync(p).isDirectory()) return jsFiles(relative(ROOT, p));
    return name.endsWith('.js') ? [p] : [];
  });
}

/** @param {string} src code without comments and quoted strings */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");

/** @param {string} src @returns {string[]} */
const specifiers = (src) => [
  ...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
  ...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
].map((m) => m[1]);

const PURE = ['shared/sim', 'shared/ai', 'shared/content'];
const FORBIDDEN = [/\bMath\.random\b/, /\bDate\b/, /\bperformance\b/, /\bset(Timeout|Interval|Immediate)\b/, /\bwindow\b/, /\bdocument\b/, /\bprocess\b/, /\brequire\s*\(/];
const INTEGER_MATH = new Set(['min', 'max', 'floor', 'trunc', 'abs', 'sign', 'imul']);

test('pure zones use no clocks, randomness, I/O or DOM', () => {
  const bad = [];
  for (const file of PURE.flatMap(jsFiles)) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    for (const re of FORBIDDEN) if (re.test(code)) bad.push(`${relative(ROOT, file)}: ${re}`);
    if (/\bclass\s+[A-Za-z_$]/.test(code)) bad.push(`${relative(ROOT, file)}: class (plain functions over plain data)`);
  }
  assert.deepEqual(bad, []);
});

test('shared/sim uses only integer Math', () => {
  const bad = [];
  for (const file of jsFiles('shared/sim')) {
    for (const [, fn] of codeOnly(readFileSync(file, 'utf8')).matchAll(/\bMath\.(\w+)/g)) {
      if (!INTEGER_MATH.has(fn)) bad.push(`${relative(ROOT, file)}: Math.${fn}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('every .js file starts with // @ts-check', () => {
  const bad = ['shared', 'client', 'server', 'test', 'tools'].flatMap(jsFiles)
    .filter((file) => !readFileSync(file, 'utf8').startsWith('// @ts-check'))
    .map((file) => relative(ROOT, file));
  assert.deepEqual(bad, []);
});

test('every import in shared/ and client/ is relative with a .js extension', () => {
  const bad = [];
  for (const file of ['shared', 'client'].flatMap(jsFiles)) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (!/^\.\.?\//.test(spec) || !spec.endsWith('.js')) bad.push(`${relative(ROOT, file)}: ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('sim and ai never import content', () => {
  const bad = [];
  for (const file of ['shared/sim', 'shared/ai'].flatMap(jsFiles)) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      const target = relative(ROOT, resolve(dirname(file), spec));
      if (target.startsWith('shared/content')) bad.push(`${relative(ROOT, file)} -> ${target}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the checks see the sim and content files', () => {
  assert.ok(jsFiles('shared/sim').length >= 19);
  assert.ok(jsFiles('shared/content').length >= 8);
});
