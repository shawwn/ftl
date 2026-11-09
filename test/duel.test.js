// @ts-check
// AI-vs-AI through the real host (design doc 19.3): captain vs captain always finishes within 6000 ticks
// with both AIs commanding, in both ship orders; a seed reproduces its winner and final hash (also across
// the duel tool's worker threads); captain beats drifter. The AI-vs-AI invariants check of 19.2 is in
// determinism.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDuel, runDuelParallel } from '../tools/duel.js';

const SEEDS = 20;
const LIMIT = 6000;
const captains = await runDuelParallel({ aiA: 'captain', aiB: 'captain', games: SEEDS, seed: 1, maxTicks: LIMIT });

/** @param {import('../tools/duel.js').Game[]} games */
function allEnd(games) {
  for (const g of games) {
    assert.ok(g.winner !== null || g.ticks < LIMIT, `seed ${g.seed} reached an outcome (${g.ticks} ticks)`);
    assert.ok(g.commands.s1 > 0 && g.commands.s2 > 0, `seed ${g.seed}: both AIs issued commands ${JSON.stringify(g.commands)}`);
  }
}

test('captain vs captain, seeds 1 to 20: every match ends within 6000 ticks and both AIs command', () => {
  assert.equal(captains.games.length, SEEDS);
  assert.deepEqual(captains.games.map((g) => g.seed), Array.from({ length: SEEDS }, (_, i) => i + 1));
  allEnd(captains.games);
});

test('the reverse ship order ends too', () => {
  allEnd(runDuel({ a: 'lampblack', b: 'candlewick', games: 3, seed: 1, maxTicks: LIMIT }).games);
});

test('the same seed twice gives the same winner and final hash, on one thread or several', () => {
  const again = runDuel({ aiA: 'captain', aiB: 'captain', games: 3, seed: 1, maxTicks: LIMIT });
  assert.deepEqual(again.games, captains.games.slice(0, 3));
});

test('captain beats drifter in at least 19 of 20 seeds', async () => {
  const { games } = await runDuelParallel({ aiA: 'captain', aiB: 'drifter', games: SEEDS, seed: 1, maxTicks: LIMIT });
  const wins = games.filter((g) => g.winner === 'blue').length;
  assert.ok(wins >= 19, `captain won ${wins} of ${SEEDS}`);
  assert.ok(games.every((g) => g.commands.s2 === 0), 'drifter never commands');
});
