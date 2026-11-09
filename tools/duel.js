// @ts-check
// Headless AI-vs-AI batches (design doc 19.6): runs Match directly (Lobby.createFromSpec on a manual
// clock, ticking in a loop) and prints win rates, average duration and average remaining hull.
//   node tools/duel.js candlewick lampblack --ai captain --games 200 [--seed 1]
// Also --ai-a / --ai-b for unequal difficulty, --max-ticks (default 6000, five simulated minutes) and
// --threads (default: every core).
// runDuel is exported for tests; a game is one aiVsAi match from seed, seed + 1, ... Choices: content
// can be injected (for tuning experiments); runDuelParallel splits the seed range over worker threads,
// each running runDuel on its slice, so results are identical to one thread, only sooner.

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { CONTENT } from '../shared/content/index.js';
import { Lobby } from '../shared/host/lobby.js';
import { buildSpec } from '../shared/host/presets.js';
import { manualClock } from '../shared/host/clock.js';
import { TICK_MS, hashWorld } from '../shared/sim/index.js';

/** @typedef {import('../shared/host/match.js').Match} Match */
/**
 * @typedef {{ seed: number, winner: string | null, ticks: number, hull: Record<string, number>,
 *             hash: string, commands: Record<string, number> }} Game
 *   winner: the winning side, or null for a draw or no outcome within maxTicks; commands per ship id
 */

/**
 * @typedef {{ a?: string, b?: string, aiA?: string, aiB?: string, games?: number, seed?: number,
 *             maxTicks?: number, content?: import('../shared/sim/types.js').Content }} DuelOpts
 * @typedef {{ spec: import('../shared/host/presets.js').MatchSpec, games: Game[] }} Duel
 */

/**
 * @param {DuelOpts & { onTick?: (match: Match) => void }} [opts]
 * @returns {Duel}
 */
export function runDuel({ a, b, aiA, aiB, games = 1, seed = 1, maxTicks = 6000, content = CONTENT, onTick = () => {} } = {}) {
  const spec = buildSpec('aiVsAi', { a, b, aiA, aiB }, content);
  if ('error' in spec) throw new Error(`${spec.error}: ${JSON.stringify({ a, b, aiA, aiB })}`);
  const lobby = new Lobby({ content, clock: manualClock() });
  /** @type {Game[]} */
  const results = [];
  for (let i = 0; i < games; i++) {
    const match = lobby.createFromSpec(spec, seed + i);
    while (match.phase !== 'ended' && match.world.tick < maxTicks) {
      match.tick();
      onTick(match);
    }
    results.push(gameOf(match));
    lobby.dispose(match, 'done');
  }
  lobby.close();
  return { spec, games: results };
}

/** @param {Match} match @returns {Game} */
function gameOf(match) {
  const { world } = match;
  /** @type {Record<string, number>} */
  const commands = {};
  for (const s of match.spec.ships) commands[s.id] = 0;
  for (const [, , cmd] of match.log) commands[/** @type {any} */ (cmd).ship] += 1;
  return {
    seed: match.seed,
    winner: world.outcome?.winner ?? null,
    ticks: world.tick,
    hull: Object.fromEntries(Object.values(world.ships).map((s) => [s.id, s.pools.hull.v])),
    hash: hashWorld(world),
    commands,
  };
}

/**
 * runDuel over contiguous seed slices in worker threads; the same games as one runDuel call.
 * @param {DuelOpts} opts @param {number} [threads]
 * @returns {Promise<Duel>}
 */
export async function runDuelParallel(opts, threads = availableParallelism()) {
  const { games = 1, seed = 1 } = opts;
  const per = Math.ceil(games / Math.max(1, threads));
  const slices = [];
  for (let i = 0; i < games; i += per) slices.push({ ...opts, seed: seed + i, games: Math.min(per, games - i) });
  const parts = await Promise.all(slices.map((slice) => new Promise((done, fail) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { duel: slice } });
    worker.once('message', done);
    worker.once('error', fail);
  })));
  return { spec: parts[0]?.spec ?? runDuel({ ...opts, games: 0 }).spec, games: parts.flatMap((p) => p.games) };
}

/** @param {Duel} duel @param {number} wallMs @returns {string} */
export function report({ spec, games }, wallMs) {
  const n = games.length;
  const pct = (k) => (n ? (100 * k / n).toFixed(1) : '0.0').padStart(5);
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const lines = [`${spec.ships.map((s) => `${s.bp} (${s.side}, ${s.ai})`).join(' vs ')}: ${n} games from seed ${games[0]?.seed ?? '-'}`];
  for (const s of spec.ships) {
    const won = games.filter((g) => g.winner === s.side);
    lines.push(`  ${s.bp.padEnd(12)} ${String(won.length).padStart(4)} wins ${pct(won.length)}%   hull left ${avg(won.map((g) => g.hull[s.id])).toFixed(1)} avg when winning`);
  }
  const undecided = games.filter((g) => g.winner === null).length;
  lines.push(`  ${'undecided'.padEnd(12)} ${String(undecided).padStart(4)}      ${pct(undecided)}%   (draw, or no outcome in the tick limit)`);
  const ticks = games.map((g) => g.ticks);
  const secs = (t) => (t * TICK_MS / 1000).toFixed(1);
  lines.push(`  duration     ${avg(ticks).toFixed(0)} ticks avg (${secs(avg(ticks))} s simulated, ${secs(Math.min(...ticks))} to ${secs(Math.max(...ticks))} s)`);
  lines.push(`  wall time    ${(wallMs / 1000).toFixed(1)} s (${n ? (wallMs / n).toFixed(0) : 0} ms per game)`);
  return lines.join('\n');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ai: { type: 'string', default: 'captain' },
      'ai-a': { type: 'string' },
      'ai-b': { type: 'string' },
      games: { type: 'string', default: '200' },
      seed: { type: 'string', default: '1' },
      'max-ticks': { type: 'string', default: '6000' },
      threads: { type: 'string', default: String(availableParallelism()) },
    },
  });
  const [a = 'candlewick', b = 'lampblack'] = positionals;
  const t0 = performance.now();
  const duel = await runDuelParallel({
    a, b, aiA: values['ai-a'] ?? values.ai, aiB: values['ai-b'] ?? values.ai,
    games: Number(values.games), seed: Number(values.seed), maxTicks: Number(values['max-ticks']),
  }, Number(values.threads));
  console.log(report(duel, performance.now() - t0));
}

if (!isMainThread && workerData?.duel) parentPort.postMessage(runDuel(workerData.duel));
else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
