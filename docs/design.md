# Faster than Lumos: design for milestone 1 (and the shape of what follows)

Status: final design, synthesized from three proposals (simulation-first, multiplayer-first, minimalist).
Backbone: the simulation-first proposal (its sim core is kept almost whole). Grafted on: the
multiplayer proposal's host, protocol, perspectives, permissions and test harness; the minimalist
proposal's ASCII ship maps, derived manning, "pierce" shield rule, counterfactual AI and visual identity.
Scoring is in Appendix A.

This document is the contract. Engineers implementing different files in parallel should be able to
work from it alone. When a detail is not specified here, choose the simplest thing that keeps every
rule in section 5 true, and write it down in the file's header comment.

Reading guide:

- 1 to 3: principles, concepts, architecture.
- 4 to 5: file tree and conventions (read before writing any file).
- 6 to 13: the simulation (time, state, content, modules, tick order, commands, events, views).
- 14 to 15: the host (lobby, sessions, matches) and the wire protocol.
- 16: the AI. 17: the client. 18: the server. 19: tests. 20: build plan. 21: growth and scope. 22: risks.

---

## 1. Principles

The repository already has a `CLAUDE.md` with the guiding principle, originality and mobile sections.
Keep it, and append the following section verbatim when the code lands:

```md
## Architecture rules (see docs/design.md)

- The game is `step(world, commands) -> events`: pure, deterministic, integer-only, plain JSON data.
  No I/O, clocks, timers or Math.random in shared/sim, shared/ai or shared/content.
- Anything that progresses over time is a Meter {v, max, rate}. Clients extrapolate meters; they never
  re-implement rules.
- Content is pure JSON data with original names. Behavior lives in small registries referenced by name.
  Add a registry entry or a data field before adding a code path; add a registry only when a second
  entry exists or is imminent.
- All modifiers flow through computeStats(ship). Nothing else computes evasion, charge rate, etc.
- Commands are absolute, idempotent setters ("shields want 3", never "+1"). Humans, AI, replays and tests
  use exactly the same vocabulary and the same authorization.
- project(world, perspective) is the only way state leaves the host. The AI receives the same serialized
  snapshot string a human on its side receives. Never give AI code a back door into the world.
- Snapshots are truth; events are decoration. A client that misses every event is still correct.
- Never assume two ships, one player per ship, or a server (the host also runs in the browser).
- shared/ is isomorphic: relative imports with .js extensions only, no node: imports, no DOM.
- No build step: native ES modules, JSDoc types, // @ts-check.
- User-facing text never uses em dashes or en dashes.
- Run: npm start | npm run dev | npm test | npm run test:e2e | npm run duel
```

## 2. The concepts (twelve, each used everywhere)

1. **World.** One plain JSON tree, integers only. It is the snapshot, the replay start state, the test
   fixture and the AI's scratchpad. `structuredClone` copies it; `JSON.stringify` hashes it.
2. **Meter** `{v, max, rate}`. The only representation of progress over time: weapon charge, shield
   regeneration, repair, crew walking, projectile flight, status timers. One client function
   extrapolates all of them.
3. **Step** = `applyCommands` then `advance` (a fixed, ordered list of phases). Both end with `derive`,
   so any world anyone observes is "settled" (power, stats, crew tasks, pool maxima are consistent).
4. **Content is data.** Ships are ASCII maps plus tables; systems are tables indexed by power; weapons
   are parameter sets. Behavior is referenced by name (`delivery: 'projectile'`, effect keys like `ion`).
5. **The stats fold.** `computeStats(ship)` is the single place where power, manning, statuses (and
   later skills and augments) combine into numbers like `evasion` and `chargePct`.
6. **The power tree.** Reactor -> systems -> devices. Commands set intent (`want`, `on`). One function,
   `settlePower`, decides actual power. Damage and ion free bars; repair restores them when bars are free.
7. **Devices.** A powered, charging, targetable thing hosted by a system. Weapons in M1; drones, bombs,
   teleport pads later.
8. **The hit pipeline.** A shot arrives -> evasion roll -> shield check (`pierce`) -> an effect payload
   (`onBlock` or `onHit`) applied through the EFFECTS registry. Weapon types differ only by data.
9. **Commands.** `{type, ...args}` with `scope` (for permissions), `args` (declared argument shapes, from
   which the protocol rebuilds every client command), `check` (pure, also used by the UI) and `apply`
   (mutates its own ship; every command then ends with a derive of that ship). Absolute and idempotent,
   so co-op conflicts resolve as visible last-write-wins.
10. **Perspective projection.** `project(world, perspective)` strips secrets and redacts enemy intent.
    One string per perspective per snapshot is shared by every member with that perspective.
11. **Members and occupants.** A member is a seat in a match (crew of a ship, or spectator). Its occupant
    is a socket session or an AI. Both receive the same snapshot text and submit the same commands
    through the same authorization. The AI is a player without a socket.
12. **Link.** A text pipe `{send, onMessage, onClose, close}`: `ws` on the server, `WebSocket` in the
    browser, or an in-memory pair. Because of it the whole host (lobby, matches, AI) also runs inside the
    browser for offline play, and tests run the full stack without sockets.

## 3. Architecture

```
 Browser: client/                                      Host: shared/host (in Node, or in the browser)
 +-------------------------------+   Link (JSON text)  +------------------------------------------------+
 | menu.js, hud.js (DOM)         |                     | Lobby: players, tokens, matches, clock          |
 | render.js, fx.js (canvas)     |<-- ws or memory --> |   Session (one per Link; the human occupant)    |
 | ui-state.js (pure reducer)    |                     |   Match: spec, members, inbox, log, broadcast   |
 | scene.js (pure layout + pick) |                     |     applyCommands / advance / project --------> shared/sim
 | game-client.js (DOM-free)     |                     |     AI occupant (shared/ai) <- same snap text   |
 +-------------------------------+                     +------------------------------------------------+

 server/: node:http serves client/ and shared/ as static files; ws upgrade on /ws -> Link -> lobby.connect
```

Dependency direction (no cycles, enforced by review):
`content` (data only) ; `sim` <- `ai` <- `host` <- `server` ; `sim`, `net` <- `client`.
`sim` and `ai` never import `content`; content is always passed in as a parameter.

## 4. File tree (exact)

```
ftl/
  CLAUDE.md                  existing; append section 1
  package.json               "type":"module"; dependency: ws (the only one); no devDependencies
  jsconfig.json              checkJs true, strict false, target ES2022, module ESNext, maxNodeModuleJsDepth 0, include shared client server test tools
  .gitignore                 node_modules/  test/artifacts/
  docs/design.md             this file

  server/                    Node only
    main.js                  startServer(opts) and direct-run entry
    static.js                serveStatic(req, res, root): client/ and shared/ only
    ws-link.js               wsLink(socket) -> Link

  shared/                    isomorphic: Node and browser, unchanged
    sim/                     PURE: deterministic, integer state, no clocks or I/O
      index.js               re-exports the public API of every sim module
      types.js               JSDoc typedefs only (section 7.1)
      time.js                TICK_MS, meter helpers
      rng.js                 mulberry32 on world.rng; roll(); makeRng() for AI
      geometry.js            parse ASCII ship maps into rooms, doors, walk graph (memoized); deepFreeze
      world.js               createWorld, spawnShip, newId, ship queries
      power.js               takesWant, capacity, freeReactor, settlePower
      stats.js               computeStats, isManned
      pools.js               tickPools, drainPool, updatePoolMaxima, fillPools
      statuses.js            STATUSES, addStatus, tickStatuses, capacityPenalty
      effects.js             EFFECT_ORDER, EFFECTS, applyEffects
      combat.js              tickShots, resolveHit, blockRoom
      devices.js             DELIVERIES, tickDevices, validTarget, canPay, fireBlock
      crew.js                tickCrew, planMove, crewRoom, crewInRoom, claimOf, assignTasks
      derive.js              deriveShip, deriveAll
      commands.js            COMMANDS, applyCommands, commandScope
      step.js                PHASES, advance, step
      view.js                project, projectEvent, perspectiveKey
      hash.js                fnv1a, hashWorld, checkInvariants
    content/                 PURE JSON-compatible data (no functions)
      index.js               CONTENT (deep-frozen), CONTENT_HASH
      base.js                base stats, pool definitions, global durations
      systems.js             system tables + systemOrder
      devices.js             weapon blueprints
      ships.js               ship blueprints (ASCII maps)
      statuses.js            status tunables (ion decay)
      ai-profiles.js         AI difficulty profiles
      validate.js            validateContent(content) -> string[]
    ai/                      PURE (floats allowed; no Math.random)
      estimate.js            volley, dps, threatOf, utility, hitGains, imagine, imagineHit
      brain.js               think(snap, me, mem, profile, content) -> Command[]
      occupant.js            aiOccupant(opts) -> Occupant (think cadence, reaction delay)
    net/                     isomorphic
      protocol.js            PROTOCOL_VERSION, MESSAGES, LIMITS, ERROR_TEXT, parseClient, parseServer, encode
      link.js                Link typedef, memoryLinkPair()
    host/                    isomorphic (timers and crypto via globalThis are allowed)
      clock.js               realClock(), manualClock()
      presets.js             PRESETS, buildSpec(preset, opts, content)
      match.js               class Match
      session.js             class Session (protocol handler per Link; human occupant)
      lobby.js               class Lobby
      replay.js              replay({spec, seed, log}, content) -> World

  client/                    browser; files marked (pure) are DOM-free and unit-tested in Node
    index.html               shell: top bar, stage canvas, HUD, overlay
    style.css                responsive grid, safe areas, touch rules, theme variables
    main.js                  boot: URL params, connector, GameClient, menu, rAF loop, debug hook
    net.js                   wsConnector(url), localConnector()
    game-client.js           (pure) class GameClient: hello, requests, cmds, pending, reconnect
    ui-state.js              (pure) initialUi, reduceUi, REASON_TEXT
    scene.js                 (pure) layoutScene, pick, roomCenter, cellCenter, hullBox
    render.js                createRenderer(canvas): draws ships, shots, reticles
    fx.js                    FX registry, createFx(): event animations, shake, floating numbers
    hud.js                   createHud(root, dispatch): reactor, systems, weapons, crew, toasts
    input.js                 bindPointer(canvas, pick, dispatch): taps with slop
    menu.js                  createMenu(root, actions): start screen, outcome screen
    theme.js                 THEME palette and sizes

  test/
    helpers/fixtures.js      tiny injected content for unit tests; world builders
    helpers/cdp.js           ~100-line Chrome DevTools Protocol client over the ws package
    *.test.js                unit, sim, host, AI and websocket tests (section 19)
    e2e/browser.test.js      headless Chrome screenshots and a tap-to-fire test
    artifacts/               screenshots (gitignored)

  tools/
    duel.js                  headless AI-vs-AI batches -> win rates and durations
```

`package.json` scripts:

```json
{
  "name": "faster-than-lumos",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node server/main.js",
    "dev": "node --watch server/main.js",
    "test": "node --test \"test/*.test.js\"",
    "test:e2e": "node --test \"test/e2e/*.test.js\"",
    "duel": "node tools/duel.js",
    "check": "npx -y -p typescript@5 tsc -p jsconfig.json --noEmit"
  },
  "dependencies": { "ws": "^8.18.0" }
}
```

Explicit test globs matter: bare `node --test` also runs everything under any `test/` directory,
including helpers.

## 5. Conventions (binding on every file)

**Imports and zones.**

| Zone | May use | Must not use |
|---|---|---|
| `shared/sim`, `shared/content` | plain JS; `Math.min/max/floor/trunc/abs/sign/imul`; `structuredClone` | floats in state, `Math.random`, `Date`, `performance`, timers, `crypto`, DOM, `node:` |
| `shared/ai` | everything in sim, plus float math (`Math.exp` etc.) | `Math.random`, `Date`, `performance`, timers, DOM, `node:` |
| `shared/net`, `shared/host` | `setTimeout`, `clearTimeout`, `performance.now`, `queueMicrotask`, `crypto.getRandomValues`, `structuredClone`, `EventTarget` via `globalThis` | DOM, `node:` imports, bare specifiers |
| `client/` (pure files) | same as `shared/host` | DOM |
| `client/` (other files) | DOM, canvas, `localStorage` (wrapped in try/catch) | `node:` |
| `server/`, `test/`, `tools/` | Node APIs, `ws` | |

- Every relative import has a `.js` extension. `shared/` and `client/` contain no bare specifiers.
- URL paths mirror repo paths (`/client/main.js`, `/shared/sim/index.js`), so a relative import means the
  same thing in Node and in the browser. No import map, no bundler.
- Every file starts with `// @ts-check` and types its exports with JSDoc, importing typedefs from
  `shared/sim/types.js` (`/** @typedef {import('../sim/types.js').Ship} Ship */`).

**Determinism.**

- Every number in a World is a safe integer. Percentages are integers (`110` means 110 percent).
  Division is `Math.floor(a / b)`. Content values read by the sim are integers too.
- Iteration over ordered things uses arrays or explicit order arrays (`content.systemOrder`,
  `EFFECT_ORDER`). `Object.keys(world.ships)` is allowed: insertion order is spawn order.
- The sim mutates in place. Removal happens with `filter` at phase boundaries, never `splice` while
  iterating.
- Only the sim draws from `world.rng`. The AI has its own RNG (`makeRng(seed)`).

**Content passing.** No module in `shared/sim` or `shared/ai` imports `shared/content`. Content arrives as
a `content` parameter or as `ctx.content`. Tests inject tiny fixture content.

**Tolerant readers.** Sim helpers reused by the AI and UI on projected views must tolerate redacted
fields: read `sys.want ?? sys.power`, `dev.on ?? dev.powered`, `dev.target ?? null`.

**Ids.** Ship ids come from the match spec (`s1`, `s2`). Every other entity id comes from
`newId(world, prefix)` and is unique across the world (`w1`, `c3`, `p57`), so crew can later move
between ships. Room ids are the single characters of the ship map, unique within a ship.

**Style.** No classes in `shared/sim`, `shared/ai` or `shared/content` (plain functions over plain data).
Classes are fine in `shared/host` and `client/`. Absolute setters are named `setX`. Events are named in
the past tense (`fired`, `hit`, `crewDied`). Reasons are kebab-case strings (`no-reactor`).

## 6. Time: ticks and meters

- `TICK_MS = 50` (20 Hz). `world.tick` counts completed ticks. Pause and speed are host policy; the sim
  knows nothing about wall time.
- **Meter** `{ v, max, rate }`. `max = durationMs * 100`. Each tick the owner calls
  `tickMeter(m, ratePct)`, which stores `m.rate = ratePct` and adds `TICK_MS * ratePct` to `v`.
  A rate is a percent of normal speed, so durations live in content and speed-ups are stats.
  - Example: Ember Volley charges in 12000 ms, so `max = 1200000`. With manned weapons
    (`chargePct = 110`) it gains 5500 per tick and is full after 219 ticks (10.95 s). No floats, no drift.
  - `v` is clamped to `max` from above. If `rate < 0` (unpowered weapons drain) it is clamped at 0.
  - `v` may start negative to express delay: the second shot of a volley starts at `-gapMs * 100`.
  - `rate` is stored for clients: the displayed value is `v + rate * elapsedMs`, clamped. Every meter in
    the game animates smoothly from 10 Hz snapshots through this one formula.
- `rate` is always the rate the owner applies next tick, so it is never stale:
  - Every meter is ticked every tick by exactly one phase.
  - A restart keeps running: it sets only `v = 0` and keeps the rate (a weapon that just fired, a status
    timer that just shed a stack, a finished crew step, a repaired bar, a regenerated shield layer).
  - `resetMeter` means idle: `v = 0` and rate 0 (a full pool, an undamaged system).
  - A meter born between its owner's ticks starts at the rate its owner will apply: a shot's flight and a
    status timer at 100. So a just-fired shot, and a just-fired weapon's charge bar, move on screen from
    the first snapshot that shows them.

`shared/sim/time.js`:

```js
export const TICK_MS = 50;
/** @returns {Meter} */
export function meter(ms, v = 0, rate = 0)       // { v, max: ms * 100, rate }
/** @returns {boolean} true when the meter is full after this tick */
export function tickMeter(m, ratePct)
export function isFull(m)                        // m.v >= m.max
export function resetMeter(m)                    // idle: v = 0, rate = 0 (a restart sets only v = 0)
/** UI and AI only (float). */
export function meterAt(m, elapsedMs = 0)        // fraction 0..1 after extrapolating elapsedMs
export function msToFull(m)                      // float ms until full at current rate, Infinity if rate <= 0
```

## 7. State

### 7.1 Types (`shared/sim/types.js`)

```js
/** @typedef {{ v: number, max: number, rate: number }} Meter */

/** @typedef {{
 *   v: 1,                         // state schema version
 *   seed: number,                 // u32 used to create rng (hidden from players)
 *   tick: number,
 *   rng: number,                  // mulberry32 state, u32 (hidden from players)
 *   nextId: number,
 *   ships: Record<string, Ship>,  // insertion order = spawn order
 *   shots: Shot[],
 *   outcome: null | { winner: string | null, tick: number }   // winner is a side, null for a draw
 * }} World */

/** @typedef {{
 *   id: string, bp: string, name: string, side: string,
 *   out: null | 'hull' | 'crew',  // set once in cleanup; an out ship is a wreck
 *   reactor: number,
 *   stores: Record<string, number>,            // consumables: missiles now; scrap, fuel later
 *   pools: Record<string, Pool>,               // M1: hull, shield
 *   systems: Record<string, SystemState>,      // keyed by system type, at most one per type
 *   devices: Device[],                         // slot order matters (power shedding)
 *   crew: Crew[],
 *   stats: Stats                               // DERIVED every derive; never authoritative
 * }} Ship */

/** @typedef {{ v: number, max: number, regen?: Meter }} Pool */

/** @typedef {{
 *   level: number,                // installed bars
 *   want?: number,                // intent; only on reactor-drawing, non-host systems; redacted for enemies
 *   power: number,                // actual, written only by settlePower
 *   damage: number,               // damaged bars, 0..level
 *   repair: Meter,                // progress toward repairing one bar
 *   status: Record<string, Status>
 * }} SystemState */

/** @typedef {{ n: number, timer: Meter }} Status       // stacking timed status (ion) */

/** @typedef {{
 *   id: string, bp: string, host: string,     // host = system type that powers it
 *   on?: boolean,                 // intent; redacted for enemies
 *   powered: boolean,             // actual, written only by settlePower
 *   charge: Meter,
 *   target?: Target | null,       // redacted for enemies
 *   auto?: boolean                // keep target after firing; redacted for enemies
 * }} Device */

/** @typedef {{ ship: string, room: string }} Target */

/** @typedef {{
 *   id: string, name: string,
 *   cell: [number, number],       // current cell (ship grid coordinates)
 *   path: [number, number][],     // remaining cells; path[0] is the cell being stepped into
 *   walk: Meter,                  // progress of the current step
 *   hp: number, maxHp: number,
 *   task: 'walk' | 'repair' | 'man' | 'idle'   // DERIVED
 * }} Crew */

/** @typedef {{ id: string, bp: string, from: { ship: string, device: string }, to: Target, flight: Meter }} Shot */

/** @typedef {Record<string, number>} Stats
 *  M1 keys: evasion, shieldLayers, shieldRegenPct, chargePct, repairPct, walkPct, hullMax */

/** @typedef {{ type: string, ship: string } & Record<string, unknown>} Command   // ship stamped by host */
/** @typedef {{ type: string, tick: number } & Record<string, unknown>} SimEvent */
/** @typedef {{ kind: 'side', side: string } | { kind: 'all' }} Perspective */
/** @typedef {World} View          // same shape minus seed and rng, with redacted fields absent */
/** @typedef {{ content: Content, emit: (e: object) => void }} Ctx */

/** @typedef {{
 *   w: number, h: number,
 *   rooms: Record<string, { id: string, x: number, y: number, w: number, h: number, system: string | null }>,
 *   roomIds: string[],            // first appearance, row-major
 *   cellRoom: Record<string, string>,        // "x,y" -> room id
 *   doors: { id: string, a: string, b: string, x: number, y: number, dir: 'v' | 'h' }[],
 *   edges: Record<string, string[]>          // "x,y" -> walkable neighbor keys
 * }} Geometry
 *  dir 'v': the wall segment between (x,y) and (x+1,y). dir 'h': between (x,y) and (x,y+1). */

/** @typedef {{ base, systems, systemOrder: string[], statuses, devices, ships, ai }} Content  (section 8) */
```

### 7.2 Example world (mid-fight, tick 1342, authoritative, not projected)

```js
{
  v: 1, seed: 7, tick: 1342, rng: 2891336453, nextId: 58,
  ships: {
    s1: {
      id: 's1', bp: 'candlewick', name: 'Candlewick', side: 'blue', out: null,
      reactor: 7,
      stores: { missiles: 7 },
      pools: {
        hull:   { v: 17, max: 20 },
        shield: { v: 0, max: 1, regen: { v: 110000, max: 200000, rate: 110 } },
      },
      systems: {
        piloting: { level: 1, power: 1, damage: 0, repair: { v: 0, max: 600000, rate: 0 }, status: {} },
        shields:  { level: 4, want: 3, power: 2, damage: 0, repair: { v: 0, max: 600000, rate: 0 },
                    status: { ion: { n: 2, timer: { v: 290000, max: 500000, rate: 100 } } } },
        engines:  { level: 3, want: 2, power: 2, damage: 1, repair: { v: 0, max: 600000, rate: 0 }, status: {} },
        weapons:  { level: 3, power: 2, damage: 0, repair: { v: 0, max: 600000, rate: 0 }, status: {} },
      },
      // shields: want 3 but ion 2 leaves capacity 2, so power is 2 and 1 reactor bar is free.
      // When an ion stack decays, settlePower restores shields to 3 automatically (the bar is free).
      devices: [
        { id: 'w1', bp: 'ember',  host: 'weapons', on: true,  powered: true,
          charge: { v: 735000, max: 1200000, rate: 100 }, target: { ship: 's2', room: 'S' }, auto: false },
        { id: 'w2', bp: 'needle', host: 'weapons', on: false, powered: false,
          charge: { v: 0, max: 1100000, rate: -300 }, target: null, auto: false },
      ],
      crew: [
        { id: 'c3', name: 'Ines Calder', cell: [6, 1], path: [], walk: { v: 0, max: 35000, rate: 0 },
          hp: 100, maxHp: 100, task: 'man' },                       // helm
        { id: 'c4', name: 'Tomo Reyk', cell: [1, 1], path: [[0, 1]], walk: { v: 21000, max: 35000, rate: 100 },
          hp: 85, maxHp: 100, task: 'walk' },                       // weapons -> engines, to repair
        { id: 'c5', name: 'Wen Sato', cell: [4, 0], path: [], walk: { v: 0, max: 35000, rate: 0 },
          hp: 100, maxHp: 100, task: 'man' },                       // shields
      ],
      stats: { evasion: 15, shieldLayers: 1, shieldRegenPct: 110, chargePct: 100,
               repairPct: 100, walkPct: 100, hullMax: 20 },
    },
    s2: {
      id: 's2', bp: 'lampblack', name: 'Lampblack', side: 'red', out: null,
      reactor: 7,
      stores: {},
      pools: {
        hull:   { v: 12, max: 17 },
        shield: { v: 1, max: 1, regen: { v: 0, max: 200000, rate: 0 } },
      },
      systems: {
        piloting: { level: 1, power: 1, damage: 0, repair: { v: 0, max: 600000, rate: 0 }, status: {} },
        shields:  { level: 2, want: 2, power: 2, damage: 0, repair: { v: 0, max: 600000, rate: 0 }, status: {} },
        engines:  { level: 4, want: 2, power: 2, damage: 0, repair: { v: 0, max: 600000, rate: 0 }, status: {} },
        weapons:  { level: 3, power: 3, damage: 0, repair: { v: 0, max: 600000, rate: 0 }, status: {} },
      },
      devices: [
        { id: 'w6', bp: 'hush',  host: 'weapons', on: true, powered: true,
          charge: { v: 520000, max: 800000, rate: 110 }, target: { ship: 's1', room: 'S' }, auto: true },
        { id: 'w7', bp: 'flint', host: 'weapons', on: true, powered: true,
          charge: { v: 27500, max: 700000, rate: 110 }, target: null, auto: false },   // fired at tick 1336; a restart keeps its rate
        { id: 'w8', bp: 'flint', host: 'weapons', on: true, powered: true,
          charge: { v: 700000, max: 700000, rate: 110 }, target: null, auto: false },  // AI holding for a volley
      ],
      crew: [
        { id: 'c9',  name: 'Vashti Morrow', cell: [4, 1], path: [], walk: { v: 0, max: 35000, rate: 0 }, hp: 100, maxHp: 100, task: 'man' },
        { id: 'c10', name: 'Oduya Fenn',    cell: [2, 1], path: [], walk: { v: 0, max: 35000, rate: 0 }, hp: 70,  maxHp: 100, task: 'man' },
        { id: 'c11', name: 'Kell Ardent',   cell: [0, 1], path: [], walk: { v: 0, max: 35000, rate: 0 }, hp: 100, maxHp: 100, task: 'man' },
      ],
      stats: { evasion: 20, shieldLayers: 1, shieldRegenPct: 100, chargePct: 110,
               repairPct: 100, walkPct: 100, hullMax: 17 },
    },
  },
  shots: [
    { id: 'p56', bp: 'needle', from: { ship: 's1', device: 'w2' }, to: { ship: 's2', room: 'W' },
      flight: { v: 120000, max: 200000, rate: 100 } },
    { id: 'p57', bp: 'flint', from: { ship: 's2', device: 'w7' }, to: { ship: 's1', room: 'W' },
      flight: { v: 25000, max: 100000, rate: 100 } },
  ],
  outcome: null,
}
```

Notes:

- **Space is abstract.** Ships and shots have no coordinates; a shot has only flight progress. The
  client decides where things are (side by side on desktop, stacked on a phone).
- **Geometry is content, not state.** Room rectangles, doors and the walk graph come from the
  blueprint through `geometry(content, ship.bp)`, memoized, never serialized. Dynamic per-room state
  (oxygen, fire, breach) will go into a future `ship.rooms` map.
- **Derived fields** (`stats`, `crew[].task`, `power`, `powered`, pool `max`) are recomputed by `derive`
  and shipped in views so neither the UI nor the AI re-derives rules. They are deterministic, so they
  are safely part of the hash.

## 8. Content

All content is JSON-compatible data (no functions, integers wherever the sim reads them). `CONTENT` is
deep-frozen. `CONTENT_HASH = fnv1a(JSON.stringify(CONTENT))` is sent in `welcome` so a stale client can
detect a mismatch.

### 8.1 `content/index.js`

```js
import base from './base.js';
import systems, { systemOrder } from './systems.js';
import statuses from './statuses.js';
import devices from './devices.js';
import ships from './ships.js';
import ai from './ai-profiles.js';
import { fnv1a } from '../sim/hash.js';
import { deepFreeze } from '../sim/geometry.js';
export const CONTENT = deepFreeze({ base, systems, systemOrder, statuses, devices, ships, ai });
export const CONTENT_HASH = fnv1a(JSON.stringify(CONTENT));
```

(`content/index.js` importing `fnv1a` from `sim/hash.js` and `deepFreeze` from `sim/geometry.js` are allowed
content -> sim imports; both are pure, and the sim's geometry memo freezes with the same function. The
other is `content/validate.js`, which reads the sim registries `EFFECT_ORDER`, `DELIVERIES` and `STATUSES`
and calls `parseMap` and `takesWant` to validate names, maps and reactor draw. None creates a cycle: the
sim never imports content.)

### 8.2 `content/base.js`

```js
export default {
  stats: { evasion: 0, shieldLayers: 0, shieldRegenPct: 100, chargePct: 100,
           repairPct: 100, walkPct: 100, hullMax: 30 },
  pools: {
    hull:   { max: 'hullMax' },                                            // no regen; drained by effects
    shield: { max: 'shieldLayers', regenMs: 2000, ratePct: 'shieldRegenPct' },
  },
  poolOrder: ['hull', 'shield'],
  repairMs: 6000,     // one bar, one crew member, at 100 percent
  walkMs: 350,        // one cell
  drainPct: 300,      // unpowered devices lose charge at 3x normal speed
  crewHp: 100,
};
```

A pool's `max` names a stat; `regenMs` is the time to regain one unit at 100 percent; `ratePct` names
the stat that scales it. Later pools (FTL drive charge, cloak, per-room oxygen) are entries here.

### 8.3 `content/systems.js`

```js
export const systemOrder = ['piloting', 'shields', 'engines', 'weapons'];   // fold, settle and UI order
export default {
  piloting: { label: 'Helm', maxLevel: 3, reactor: false, mannable: true,
              byPower:  { mul: { evasion: [0, 100, 100, 100] } },
              unmanned: { mul: { evasion: [100, 0, 50, 80] } },     // autopilot
              manned:   { add: { evasion: 5 } } },
  shields:  { label: 'Shields', maxLevel: 8, reactor: true, mannable: true,
              byPower: { add: { shieldLayers: [0, 0, 1, 1, 2, 2, 3, 3, 4] } },
              manned:  { add: { shieldRegenPct: 10 } } },
  engines:  { label: 'Engines', maxLevel: 8, reactor: true, mannable: true,
              byPower: { add: { evasion: [0, 5, 10, 15, 20, 25, 28, 31, 35] },
                         mul: { evasion: [0, 100, 100, 100, 100, 100, 100, 100, 100] } },
              manned:  { add: { evasion: 5 } } },
  weapons:  { label: 'Weapons', maxLevel: 8, reactor: true, mannable: true, hosts: 'weapon',
              manned:  { add: { chargePct: 10 } } },
};
```

Field meanings:

- `reactor: false` marks a subsystem: its power is always its capacity, with no reactor draw.
- `hosts: '<kind>'` means the system powers devices of that kind. Its power is the sum of its
  powered devices, bounded by its capacity. Host systems have no `want`.
- `byPower.add[stat][power]` and `byPower.mul[stat][power]` are tables of length `maxLevel + 1`.
- `manned` modifiers apply when the system is manned and its power is above 0.
- `unmanned.add[stat][power]` and `unmanned.mul[stat][power]` are tables (length `maxLevel + 1`) that
  apply when the system is not manned. The helm is pure data: powered it keeps evasion (`mul 100`),
  manned it adds 5, and unmanned it flies on autopilot (0, 50, 80 percent of evasion by power); at power
  0 its `byPower` mul zeroes evasion. Engines at power 0 zero out evasion through their `mul` table, with
  no code. No system needs a code hook in M1 (`SYSTEM_HOOKS` returns with medbay's `tick` hook, 21.1).

### 8.4 `content/statuses.js`

```js
export default {
  ion: { decayMs: 5000 },   // each stack lasts 5 s; a new hit resets the timer; behavior in sim STATUSES
};
```

### 8.5 `content/devices.js` (original weapons)

```js
export default {
  flint: {
    kind: 'weapon', name: 'Flint Bolt', blurb: 'One honest spark. Cheap, quick, reliable.',
    power: 1, chargeMs: 7000, target: 'enemyRoom', cost: {},
    delivery: 'projectile', shots: 1, gapMs: 0, travelMs: 1000,
    accuracy: 0, pierce: 0, canMiss: true,
    onBlock: {}, onHit: { hull: 1, sysDamage: 1, crew: 15 },
    look: 'spark',
  },
  ember: {
    kind: 'weapon', name: 'Ember Volley', blurb: 'Three hot sparks in a row. Halos hate it.',
    power: 2, chargeMs: 12000, target: 'enemyRoom', cost: {},
    delivery: 'projectile', shots: 3, gapMs: 250, travelMs: 1100,
    accuracy: 0, pierce: 0, canMiss: true,
    onBlock: {}, onHit: { hull: 1, sysDamage: 1, crew: 15 },
    look: 'spark',
  },
  needle: {
    kind: 'weapon', name: 'Long Needle', blurb: 'A slow dart that slips through any halo. Spends a missile.',
    power: 1, chargeMs: 11000, target: 'enemyRoom', cost: { missiles: 1 },
    delivery: 'projectile', shots: 1, gapMs: 0, travelMs: 2000,
    accuracy: 0, pierce: 99, canMiss: true,
    onBlock: {}, onHit: { hull: 2, sysDamage: 1, crew: 30 },
    look: 'dart',
  },
  hush: {
    kind: 'weapon', name: 'Hush Pulse', blurb: 'Cold static that makes machines forget their power.',
    power: 1, chargeMs: 8000, target: 'enemyRoom', cost: {},
    delivery: 'projectile', shots: 1, gapMs: 0, travelMs: 1000,
    accuracy: 0, pierce: 0, canMiss: true,
    onBlock: { ion: 1 }, onHit: { ion: 2 },
    look: 'pulse',
  },
};
```

How the familiar behaviors fall out of parameters, with no special cases:

- Missile-like weapons ignore shields: `pierce: 99` means "blocked only if layers > 99".
- Volleys overwhelm shields: each shot is its own projectile and each block pops one layer.
- Ion strips a layer and locks power: `onBlock: { ion: 1 }` hits the shields system; the status lowers
  capacity; `settlePower` sheds bars.
- A later beam is `delivery: 'beam'` with `canMiss: false`; a later shield-piercing laser is `pierce: 1`.

### 8.6 `content/ships.js` (original ships)

Map format: an array of equal-length strings. Each distinct non-`.` character is one rectangular room;
`.` is empty space. Ships face right (bow at the highest x). `legend` maps room characters to system
types; unlisted rooms are corridors. Doors: one per pair of edge-adjacent rooms (auto), unless a
`doors` array of room-character pairs is given, in which case only those pairs get doors.

```js
export default {
  candlewick: {
    name: 'Candlewick', blurb: 'A steady flame. Balanced, forgiving, and one bar short of everything.',
    map: [
      '.WW.SS..',
      'EWWaSSHH',
      'EbbaccHH',
    ],
    legend: { W: 'weapons', S: 'shields', E: 'engines', H: 'piloting' },
    stats: { hullMax: 20 },                   // overrides base.stats for this hull
    reactor: 7,
    systems: {
      piloting: { level: 1 },
      shields:  { level: 4, power: 2 },
      engines:  { level: 3, power: 2 },
      weapons:  { level: 3 },
    },
    devices: [ { bp: 'ember', on: true }, { bp: 'needle', on: false } ],
    stores: { missiles: 8 },
    crew: [
      { name: 'Ines Calder', room: 'H' },
      { name: 'Tomo Reyk',   room: 'W' },
      { name: 'Wen Sato',    room: 'S' },
    ],
  },
  lampblack: {
    name: 'Lampblack', blurb: 'A soot-dark raider that smothers systems before it burns them.',
    map: [
      '.SSaa',
      'EEWWH',
      'EEWWH',
    ],
    legend: { S: 'shields', E: 'engines', W: 'weapons', H: 'piloting' },
    stats: { hullMax: 17 },
    reactor: 7,
    systems: {
      piloting: { level: 1 },
      shields:  { level: 2, power: 2 },
      engines:  { level: 4, power: 2 },
      weapons:  { level: 3 },
    },
    devices: [ { bp: 'hush', on: true }, { bp: 'flint', on: true }, { bp: 'flint', on: true } ],
    stores: {},
    crew: [
      { name: 'Vashti Morrow', room: 'H' },
      { name: 'Oduya Fenn',    room: 'W' },
      { name: 'Kell Ardent',   room: 'E' },
    ],
  },
};
```

Design intent: Candlewick starts with 6 of 7 bars used (shields 2, engines 2, Ember 2). A second shield
layer (4 bars) costs engines or the Needle, and shields 2 plus engines 2 plus Ember leaves Long Needle
dark, so every allocation is a real choice. Lampblack uses all 7 bars and relies on ion to open shields
for its two Flint Bolts. Balance is tuned with `tools/duel.js`, data only.

Tuning record (M1). The first numbers (Candlewick reactor 8, shields 4, hull 30; Lampblack hull 24; Flint
9000 ms) gave Candlewick 200 of 200 captain-vs-captain games in each ship order, with 27 of 30 hull left
on average, and the Candlewick mirror never ended: two shield layers stopped Lampblack's single shots and
a lone Ember Volley. Then: Candlewick shields 3, reactor 7 and hull 20; Lampblack hull 17; Flint 7000 ms
gave Candlewick 62 percent. That balance leaned on an AI flaw: the power plan valued a weapon only by its
hull damage against the foe's momentary shields, so Lampblack cut its Hush Pulse (ion, no hull damage)
whenever Candlewick showed no layer, and Hush fired about 3 times a fight instead of about 14. With the
AI valuing payloads by their counterfactual against `threatOf(foe)` (16.1), Lampblack won about 75
percent, so Candlewick got a fourth shield bar (a second layer at the cost of engines or the Needle).
Now `node tools/duel.js candlewick lampblack --ai captain --games 200` gives Candlewick 59 percent (60.5
percent with the ship order reversed), fights of about 118 s on average (61 to 176 s). Both mirrors end
and are about 50/50 (the Candlewick mirror leaves 2 of 200 games undecided at 6000 ticks); ace vs ace
is about 50/50 in both orders. Novice vs novice favors Candlewick heavily (about 97 percent): novices
never sync volleys (`patienceMs` 0) and aim almost at random, so Lampblack's single Flint Bolts rarely
get through two layers. Lampblack's hull 18, Flint 6500 ms, novice patience 1500 ms or novice crew
handling each leave that above 95 percent; it is a property of the novice profile, not of the ships.

### 8.7 `content/ai-profiles.js`

```js
export default {
  drifter: { label: 'Target practice', persona: 'Drifter', passive: true,
             thinkEveryTicks: 20, reactionTicks: 0, temperature: 1, patienceMs: 0, crew: false,
             weights: { offense: 1, defense: 1 } },
  novice:  { label: 'Novice',  persona: 'Gloam', passive: false,
             thinkEveryTicks: 30, reactionTicks: 20, temperature: 0.8, patienceMs: 0, crew: false,
             weights: { offense: 1, defense: 1 } },
  captain: { label: 'Captain', persona: 'Gloam', passive: false,
             thinkEveryTicks: 16, reactionTicks: 10, temperature: 0.3, patienceMs: 3000, crew: true,
             weights: { offense: 1, defense: 1 } },
  ace:     { label: 'Ace',     persona: 'Gloam', passive: false,
             thinkEveryTicks: 6,  reactionTicks: 4,  temperature: 0.05, patienceMs: 5000, crew: true,
             weights: { offense: 1.2, defense: 1 } },
};
```

The integer rule does not apply here: AI profiles are read only by `shared/ai`, which is not the sim.

### 8.8 Validation (`content/validate.js`)

`validateContent(content) -> string[]` (empty means valid). The Lobby throws at construction on any
error; a test asserts shipped content is valid and that crafted bad fixtures produce the expected errors.
Rules:

- Every map row has the same length; every room character forms a solid rectangle; the room graph
  (through doors) is connected; an explicit `doors` pair names two adjacent rooms.
- Every `legend` key is a room in the map; every value is a key of `content.systems`; a system type
  appears at most once per ship; every blueprint `systems` key is in the legend, and vice versa.
- `1 <= level <= maxLevel`; `power <= level`; the sum of starting reactor draw (`power` of systems that
  take a want, plus `on` device power) is `<= reactor`; starting device power on a host fits its level.
- Every device `bp` exists and some ship system `hosts` its `kind`.
- Crew rooms exist; crew per room do not exceed its cells.
- System tables (`byPower`, `unmanned`) have length `maxLevel + 1`; stat names in `byPower`, `manned` and
  `unmanned` exist in `base.stats`; `systemOrder` lists every system exactly once.
- Weapon fields are positive integers where required (`power`, `chargeMs`, `shots`, `travelMs`),
  `gapMs >= 0`; effect keys are in `EFFECT_ORDER`; `cost` keys are non-negative integers; `delivery`
  exists in `DELIVERIES`; `target` is `'enemyRoom'`.
- Status ids exist in `STATUSES`; base pool stat names exist in `base.stats`.
- AI profiles have every field with the right type.
- Every number the sim reads is a safe integer.

## 9. Simulation modules: exports and semantics

Signatures are binding. `ctx` is always `{ content, emit }`. Functions that take `world` may also be
given a view when the doc says "view-safe".

### 9.1 `rng.js`

```js
export function seedRng(seed)          // -> u32 initial state (seed >>> 0, or a fixed constant if 0)
export function rngNext(world)         // mulberry32 step on world.rng -> u32
export function roll(world, pct)       // draws exactly one value; true with probability clamp(pct,0,100)/100
export function makeRng(seed)          // -> () => float in [0,1); standalone, for AI only
```

`roll` always draws once, whatever `pct` is, so RNG consumption never depends on stats.

### 9.2 `geometry.js`

```js
export function parseMap(map, legend, doors = null)   // -> Geometry; throws Error with a message on bad maps
export function geometry(content, bpId)               // -> Geometry, memoized in a WeakMap keyed by content.ships[bpId]
export function cellKey(x, y)                         // -> "x,y"
export function roomAt(geo, x, y)                     // -> room id or null
export function roomCells(geo, roomId)                // -> [x, y][] in row-major order
export function systemAt(content, ship, roomId)       // -> system type in that room that the ship has, or null (view-safe)
export function roomOfSystem(content, ship, type)     // -> room id or null (view-safe)
export function findPath(geo, from, to)               // -> [x, y][] excluding from, including to; null if unreachable
```

Rules:

- `roomIds` is in order of first appearance, row-major.
- Doors: scan cells row-major; for each cell check the right neighbor (`dir 'v'`), then the lower
  neighbor (`dir 'h'`). Collect shared edges per room pair in discovery order. Each pair gets one door
  at the middle shared edge (index `floor((n - 1) / 2)`). Door ids are `d0, d1, ...` in pair-discovery
  order. `a` is the room of `(x, y)`, `b` the room of the neighbor.
- Walk graph: 4-neighbors within a room, plus the two cells on either side of each door.
- `findPath` is BFS with neighbor order right, down, left, up, so paths are deterministic.

Candlewick parses to rooms `W(1,0,2x2) S(4,0,2x2) E(0,1,1x2) a(3,1,1x2) H(6,1,2x2) b(1,2,2x1) c(4,2,2x1)`;
the W to E door is `{ a: 'E', b: 'W', x: 0, y: 1, dir: 'v' }`.

### 9.3 `world.js`

```js
export function createWorld(setup, content)   // setup: { seed, ships: [{ id, bp, side, name? }] } -> World (settled, pools full)
export function spawnShip(world, spec, content) // -> Ship, appended to world.ships
export function newId(world, prefix)          // -> prefix + world.nextId++
export function shipsInOrder(world)           // -> Ship[] (view-safe)
export function enemiesOf(world, ship)        // -> Ship[] with a different side and out === null (view-safe)
```

`spawnShip`: systems from the blueprint (`want = bp power ?? 0` for reactor non-host systems, `power: 0`,
`damage: 0`, `repair: meter(base.repairMs)`, `status: {}`); devices in blueprint order with
`newId('w')`, `charge: meter(bp.chargeMs)`, `on` from the blueprint, `powered: false`,
`target: null`, `auto: false`; crew with `newId('c')`, placed on the first free cell of their room
(row-major); pools per `base.pools` (with `regen: meter(regenMs)` when defined); `stores` copied;
`stats: {}`. `createWorld` spawns all ships, then `deriveAll`, then `fillPools` on every ship.

### 9.4 `power.js`

```js
export function takesWant(def)                 // def.reactor && !def.hosts: the system takes a `want` (setPower, AI, validation)
export function capacity(sys)                  // max(0, level - damage - capacityPenalty(sys)) (view-safe)
export function freeReactor(ship, content)     // reactor - sum(power of systems with def.reactor) (view-safe)
export function settlePower(ship, content, emit = () => {})   // the ONLY writer of sys.power and dev.powered
```

`settlePower` algorithm (deterministic, idempotent):

1. **Shed.** For each system type in `systemOrder` present on the ship:
   - subsystem (`!def.reactor`): `power = capacity`.
   - host: walk its devices in slot order keeping `used`; a device stays powered only if
     `powered && (on ?? powered) && used + bp.power <= capacity`; `power = used`.
   - other: `power = min(power, want ?? power, capacity)`.
2. **Grant.** `free = freeReactor`. For each system type in `systemOrder`:
   - host: for devices in slot order with `(on ?? powered) && !powered`, power it if
     `sys.power + bp.power <= capacity` and `bp.power <= free`.
   - other reactor system: `add = min(min(want ?? power, capacity) - power, free)`; if positive, apply.
3. Emit `depowered` for every system whose power dropped and every device that lost power.

Invariant after settle: every reactor system has `power === min(want, capacity)` or `free === 0`, and
every `on` device is powered or cannot fit. Consequences, all FTL-like: damage and ion free bars at once;
the player may reroute them; repaired or de-ionized systems climb back to `want` only from free bars,
never taking bars from another system.

### 9.5 `stats.js`

```js
export function isManned(ship, type, content)   // some crew with task 'man' stands in the system's room (view-safe)
export function computeStats(ship, content)     // -> Stats (view-safe, pure)
```

`computeStats`:

1. `add = { ...content.base.stats, ...bp.stats }` (blueprint base overrides), `muls = []`.
2. For each type in `systemOrder` present on the ship: `power = sys.power`, `manned = isManned(...)`.
   Add `byPower.add[stat][power]`; push `byPower.mul[stat][power]`; if `manned && power > 0`, add and push
   `def.manned`; if not manned, add and push row `power` of the `unmanned` tables.
3. For each status on the ship's systems, merge `STATUSES[id].shipMods?.(status)` (none in M1).
4. Finalize: `value = add[stat]`, then for each pushed mul in push order, `value = floor(value * m / 100)`.

Later crew skills and augments are more merge calls in steps 2 and 3, and no consumer changes.

Worked example (s1 above): engines power 2 adds evasion 10; engines are unmanned; piloting is manned
(+5; its byPower mul at power 1 is 100); engines mul at power 2 is 100. Evasion = 15.

### 9.6 `pools.js`

```js
export function updatePoolMaxima(ship, content)  // pool.max = stats[def.max]; pool.v = min(v, max)
export function fillPools(ship, content)         // v = max for every pool (spawn only)
export function tickPools(ship, content)         // regen phase (see below)
export function drainPool(ship, id, n)           // v = max(0, v - n); returns the amount drained
```

`tickPools`: for each pool id in `base.poolOrder` with `regenMs`: if `v < max`, then
`tickMeter(regen, stats[def.ratePct])`, and when full, `v += 1` and `regen.v = 0`; otherwise
`resetMeter(regen)`.

### 9.7 `statuses.js`

```js
export const STATUSES = {
  ion: { capacity: (st) => st.n },    // each stack removes one bar of capacity
};
export function addStatus(holder, id, n, content)  // st.n += n; st.timer = meter(decayMs, 0, 100) (timer restarted, born at its rate)
export function tickStatuses(holder)               // tick each timer at 100; when full: n -= 1, timer.v = 0; delete at n <= 0
export function capacityPenalty(holder)            // sum of STATUSES[id].capacity?.(st) over holder.status
```

`holder` is anything with a `status` map: systems now, rooms, crew and ships later (fire, breach, stun,
cloak). Iteration over `holder.status` keys is insertion order, which is deterministic.

### 9.8 `effects.js`

```js
export const EFFECT_ORDER = ['hull', 'sysDamage', 'ion', 'crew'];   // fixed application and RNG order
export const EFFECTS = {
  hull:      (ship, room, n, ctx) => { /* drainPool(ship, 'hull', n); emit hullDamaged */ },
  sysDamage: (ship, room, n, ctx) => { /* system in room: damage = min(level, damage + n); emit systemDamaged */ },
  ion:       (ship, room, n, ctx) => { /* system in room: addStatus(sys, 'ion', n); emit ionized */ },
  crew:      (ship, room, n, ctx) => { /* every crew whose cell is in room: hp = max(0, hp - n); emit crewHurt */ },
};
export function applyEffects(ship, room, payload, ctx)  // for k of EFFECT_ORDER: if payload[k] apply (view-safe on clones)
```

Effects never need `world`, which is what lets the AI apply them to cloned views. Later entries:
`fire`, `breach`, `stun`, `heal`.

### 9.9 `combat.js`

```js
export function tickShots(world, ctx)          // phase: tickMeter(flight, 100) per shot; arrivals resolve; filter out
export function resolveHit(world, shot, ctx)   // the hit pipeline
export function blockRoom(content, ship)       // where onBlock lands: the shields room (view-safe; the AI values blocks with it)
```

`resolveHit`:

1. `T = world.ships[shot.to.ship]`; if missing or `T.out`, emit `fizzled` and stop.
2. `bp = content.devices[shot.bp]`. If `bp.canMiss` and `roll(world, T.stats.evasion - bp.accuracy)`,
   emit `miss` and stop.
3. If `T.pools.shield.v > bp.pierce`: `drainPool(T, 'shield', 1)`; `applyEffects(T, blockRoom(content, T),
   bp.onBlock, ctx)`; emit `shieldHit`; stop.
4. Otherwise `applyEffects(T, shot.to.room, bp.onHit, ctx)`; emit `hit`.

Several shots arriving in one tick resolve in array (spawn) order, each seeing the shield left by the
previous one.

### 9.10 `devices.js`

```js
export const DELIVERIES = {
  projectile: { launch(world, ship, dev, bp, ctx) { /* push bp.shots shots; shot i has flight meter(travelMs, -i * gapMs * 100, 100) */ } },
};
export function validTarget(world, ship, bp, target, content)   // -> reason or null (view-safe)
export function canPay(ship, cost)                              // every store >= amount (view-safe)
export function fireBlock(world, ship, bp, target, content)     // validTarget ?? (canPay ? null : 'no-ammo') (view-safe)
export function tickDevices(world, ship, ctx)                    // phase body for one ship
```

`validTarget` for `'enemyRoom'`: `null` target -> `'no-target'`; target ship missing -> `'no-ship'`;
same side -> `'friendly'`; out -> `'ship-out'`; room not in its geometry -> `'no-room'`.

`tickDevices` (skipped for out ships), for each device in slot order:

1. `tickMeter(charge, powered ? stats.chargePct : -base.drainPct)`.
2. If full and `fireBlock` is null: pay the cost, restart the charge (`charge.v = 0`, keeping its rate),
   `DELIVERIES[bp.delivery].launch(...)` (which emits `fired` with the shot ids), and clear the target
   unless `auto`.

A charged weapon with no target simply stays charged. Firing is "set a target on a charged weapon".
`fireBlock` is the one fire rule: `tickDevices`, `setTarget.check` and the HUD's weapon card all ask it
(a charged device that cannot pay reads "Out of missiles", never "Firing" or "Ready").

### 9.11 `crew.js`

```js
export function crewRoom(content, ship, crew)              // -> room id of crew.cell (view-safe)
export function crewInRoom(content, ship, roomId)          // -> Crew[] standing in the room (view-safe)
export function claimOf(crew)                              // -> [x, y]: last path cell if walking, else cell (view-safe)
export function claimedCells(ship)                         // -> Set of "x,y" of every claimOf
export function planMove(ship, crewIds, roomId, content)   // -> number of crew now heading to or already in the room
export function assignTasks(ship, content)                 // derive: sets crew[].task
export function tickCrew(world, ship, ctx)                 // phase: walking, then repairing
```

- `planMove`: for each id in the given order: if its claim is already in the room, it counts and is
  skipped; otherwise take the first free cell of the room (row-major, not in `claimedCells`), and set
  `path`. If the crew member is mid-step, the new path starts with the cell it is stepping into
  (`[path[0], ...findPath(path[0], dest)]`) and `walk` keeps its progress, so motion never jumps.
- `assignTasks`: `'walk'` if `path.length`; else `'repair'` if the room's system has `damage > 0`;
  else `'man'` if the room holds a mannable system and no earlier crew member (array order) in the room
  already mans it; else `'idle'`.
- `tickCrew`: walkers tick `walk` at `stats.walkPct`; when full, `cell = path.shift()`, `walk.v = 0`;
  idle meters get rate 0. Then for each system: `n` = crew in its room with task `'repair'`; if
  `damage > 0`, `tickMeter(repair, n * stats.repairPct)` and, when full, `damage -= 1`,
  `repair.v = 0`, emit `systemRepaired`; if `damage === 0`, `resetMeter(repair)`.
- Crew may pass through each other; only destinations are exclusive.

### 9.12 `derive.js`

```js
export function deriveShip(ship, content, emit = () => {})   // settlePower; assignTasks; stats = computeStats; updatePoolMaxima
export function deriveAll(world, ctx)                        // deriveShip for every ship, in order
```

`deriveShip` is view-safe: the AI calls it on cloned, redacted ships.

### 9.13 `commands.js`: see section 11. `step.js`: see section 10.

### 9.14 `view.js`

```js
export function perspectiveKey(p)               // 'all' or 'side:<side>'
export function project(world, perspective)     // -> View (deep copy; never aliases the world)
export function projectEvent(event, perspective, world)   // -> event or null (identity in M1; the seam for fog)
```

`project`: `structuredClone(world)`, delete `seed` and `rng`; if `perspective.kind === 'side'`, for every
ship of another side delete `systems[*].want`, `devices[*].on`, `devices[*].target`, `devices[*].auto`.
Enemy crew, power, charge, stats and damage remain visible in M1 (the baseline "sensors"). A future
sensors system changes only this function.

### 9.15 `hash.js`

```js
export function fnv1a(str)                       // -> 8-char lowercase hex of FNV-1a 32-bit
export function hashWorld(world)                 // fnv1a(JSON.stringify(world))
export function checkInvariants(world, content)  // -> string[] of violations (empty is good)
```

Invariants: every number is a safe integer; `0 <= power <= capacity` per system; reactor draw `<=`
reactor; device power on a host `<=` its capacity; `0 <= damage <= level`; pools within `[0, max]`;
meter `v <= max`; targets (when set) pass `validTarget` or point at an out ship; each crew cell is inside
a room of its ship; no two non-walking crew share a cell; stats equal a fresh `computeStats`.

## 10. Tick ordering (`step.js`)

```js
export const PHASES = [
  ['statuses', (w, ctx) => forLiving(w, s => forSystems(s, tickStatuses))],  // ion stacks decay
  ['crew',     (w, ctx) => forLiving(w, s => tickCrew(w, s, ctx))],           // walk, then repair
  ['pools',    (w, ctx) => forLiving(w, s => tickPools(s, ctx.content))],     // shield regen
  ['shots',    tickShots],                                                    // fly; arrivals run the hit pipeline
  ['cleanup',  cleanup],                                                      // deaths, wrecks, stale targets, outcome
  ['devices',  (w, ctx) => forLiving(w, s => tickDevices(w, s, ctx))],        // charge; fire new shots
  ['derive',   deriveAll],                                                    // settle power, tasks, stats, pool maxima
];

/** @returns {SimEvent[]} */
export function advance(world, content) {
  if (world.outcome) return [];
  const events = [];
  const ctx = { content, emit: (e) => events.push({ tick: world.tick, ...e }) };
  for (const [, phase] of PHASES) phase(world, ctx);
  world.tick += 1;
  return events;
}

/** @returns {{ results: (string|null)[], events: SimEvent[] }} */
export function step(world, cmds, content) {
  const a = applyCommands(world, cmds, content);
  return { results: a.results, events: [...a.events, ...advance(world, content)] };
}
```

`cleanup`: remove crew with `hp <= 0` (emit `crewDied`); mark ships `out = 'hull'` when hull is 0 or
`out = 'crew'` when no crew remain (emit `shipOut`); clear device targets that fail `validTarget`;
if at most one side still has a ship with `out === null`, set `outcome = { winner, tick }` and emit
`outcome`.

Why this order:

- Commands are applied before the tick (in `applyCommands`, which ends with `deriveAll`), so an intent
  takes effect in the same tick and paused worlds still update.
- Pools regenerate before shots land: a layer that regenerates this tick blocks a shot arriving this tick.
- Shots fly before devices fire, so a shot launched in tick N first moves in tick N+1 (no same-tick puzzles).
- Cleanup runs before devices, so a ship destroyed this tick does not fire, and nobody fires at a wreck.
- Derive runs last, so every observed world is settled. Damage takes effect on power and stats at the end
  of the tick in which it lands; manning changes lag one tick. Both are invisible at 20 Hz.

## 11. Commands (`commands.js`)

**Envelope.** Clients send `{ type, ...args }`. The host stamps `ship` from the member's seat; a client
can never name the acting ship. The sim sees `{ type, ship, ...args }`.

**Two-layer authority.** The host authorizes (may this member issue this scope on this ship?). The sim
checks legality at apply time, because state may have changed since the message was sent. The client
imports the same `check` functions to gray out impossible controls.

```js
/** @typedef {{ scope: string,
 *    args: Record<string, ArgShape>,   // 'int' | 'str' | 'bool', [shape] (array of), { field: shape } (object or null)
 *    check(world: World|View, ship: Ship, cmd: Command, content: Content): string | null,
 *    apply(world: World, ship: Ship, cmd: Command, ctx: Ctx): string | null }} CommandDef */
export const COMMANDS = { setPower, setDevicePower, setTarget, setAuto, moveCrew };
export function commandScope(type)               // -> scope string, or null for unknown types
export function applyCommands(world, cmds, content)   // -> { results, events }
```

`applyCommands`: for each command in order: unknown type -> `'unknown-command'`; ship missing ->
`'no-ship'`; ship out -> `'ship-out'`; else `check`, and if it passes, `apply`; then, whether the command
succeeded or not, `deriveShip` of its ship. `results[i]` is the reason or `null`. Then `deriveAll` (which
settles a world a test edited by hand). `apply` only writes intent (`want`, `on`, `target`, `auto`,
paths) on its own ship; the derive settles power, tasks, stats and pool maxima. So every command leaves
the world settled, derive is idempotent, and a batch boundary carries no information: one merged batch
equals several small ones, and a replay is identical whether commands arrived in one tick or across a
pause. (Derive writes authoritative state too: `updatePoolMaxima` clamps a pool to its new maximum. So
lowering shields and raising them again loses the layer, in one batch or two, which is the game rule.)

| Command | Args | Scope | `check` (pure) | `apply` |
|---|---|---|---|---|
| `setPower` | `system: string, level: int` | `power` | system on ship, else `no-system`; `takesWant(def)`, else `not-powerable`; integer `0 <= level <= sys.level`, else `bad-level` | `granted = min(level, capacity, power + freeReactor)`; if `level > power` and `granted === power`, return `damaged` when `capacity <= power`, else `no-reactor`; otherwise `want = granted` |
| `setDevicePower` | `device: string, on: bool` | `weapons` | device on ship, else `no-device`; boolean `on`, else `bad-arg` | off: `on = false`. On and already on: no-op. On: if host `power + bp.power > capacity`, `no-capacity`; if `bp.power > freeReactor`, `no-reactor`; else `on = true` |
| `setTarget` | `device: string, target: {ship, room} \| null` | `weapons` | device exists, else `no-device`; target `null` is fine; else strings `ship` and `room`, else `bad-arg`; then `fireBlock` (`validTarget`, else `no-ammo`) | `target = target ? { ship, room } : null` |
| `setAuto` | `device: string, on: bool` | `weapons` | device exists, else `no-device`; boolean, else `bad-arg` | `auto = on` |
| `moveCrew` | `crew: string[], room: string` | `crew` | array of 1 to 16 strings, else `bad-arg`; all ids on ship, else `no-crew`; room in own geometry, else `no-room` | `planMove`; if it returns 0, `room-full` |

Absolute semantics make retries harmless and make co-op conflicts resolve as visible last-write-wins.
`setTarget` doubles as "fire": a charged device with a valid target fires that tick.

The Args column is each command's declared `args` (`setTarget`: `{ device: 'str', target: { ship: 'str',
room: 'str' } }`, `moveCrew`: `{ crew: ['str'], room: 'str' }`). The protocol rebuilds a client's command
from them (section 15), so `check` still answers a wrong type with its own reason, and what the host
clones and logs is small, flat, known data.

Match-level actions (`pause`, `rematch`, `leave`) are protocol messages handled by the host. They never
enter the sim and never enter the command log.

Later commands, same registry: `setDoor {door, open}` (scope `doors`), `activate {system, target?}`
(cloak, teleporter, hacking), `jump {}` (needs a full `ftl` pool).

## 12. Events

Every event has `type` and `tick`. Events are output only: never sim input, never needed for correctness.

| Type | Fields | Emitted by |
|---|---|---|
| `depowered` | `ship, system?, device?` | `settlePower` |
| `fired` | `ship, device, bp, shots: string[]` | `DELIVERIES.projectile.launch` |
| `miss` | `shot, bp, from, ship, room` | `resolveHit` |
| `shieldHit` | `shot, bp, from, ship` | `resolveHit` |
| `hit` | `shot, bp, from, ship, room` | `resolveHit` |
| `fizzled` | `shot, ship` | `resolveHit` (target already out) |
| `hullDamaged` | `ship, n, hull` | `EFFECTS.hull` |
| `systemDamaged` | `ship, system, damage` | `EFFECTS.sysDamage` |
| `ionized` | `ship, system, n` | `EFFECTS.ion` |
| `crewHurt` | `ship, crew, hp` | `EFFECTS.crew` |
| `systemRepaired` | `ship, system, damage` | `tickCrew` |
| `crewDied` | `ship, crew, name` | `cleanup` |
| `shipOut` | `ship, reason` | `cleanup` |
| `outcome` | `winner` | `cleanup` |

Example: `{ "type": "hit", "tick": 1341, "shot": "p55", "bp": "flint", "from": "s2", "ship": "s1", "room": "W" }`.

## 13. Views and perspectives

- Crew members get `{ kind: 'side', side }`. Spectators get `{ kind: 'all' }`.
- The view has the same shape as the world, so every view-safe helper (`capacity`, `computeStats`,
  `COMMANDS[t].check`, `validTarget`, `deriveShip`) works on it, for UI affordances and for the AI.
- The host computes one projection and one `JSON.stringify` per perspective key per snapshot, and every
  member with that key (humans and AI alike) receives the identical string.
- Example: the blue view of `s2` above lacks `want` on its systems and `on`, `target`, `auto` on its
  devices; the view lacks `seed` and `rng`. Everything else is as in 7.2.

## 14. Host: lobby, sessions, matches (`shared/host`)

### 14.1 Link and clock

```js
// shared/net/link.js
/** @typedef {{ send(text: string): void, onMessage(fn: (text: string) => void): void,
 *              onClose(fn: () => void): void, close(): void }} Link */
export function memoryLinkPair()   // -> [Link, Link]; ordered, async (queueMicrotask); close propagates

// shared/host/clock.js
/** @typedef {{ now(): number, every(ms: number, fn: () => void): () => void }} Clock */
export function realClock()        // setTimeout scheduler against performance.now; at most 4 catch-up runs per wake
export function manualClock()      // Clock & { advance(ms) }: runs due callbacks synchronously, in order
```

Links carry strings, not objects, so there is a real serialization boundary even in memory.

### 14.2 Specs and presets (`presets.js`)

```js
/** @typedef {{
 *   preset: string, name: string,
 *   rules: { pause: 'crew' | 'any' | 'none', pauseWhenEmpty: boolean, snapEvery: number, idleTtlMs: number },
 *   ships: { id: string, bp: string, side: string, seats: { min: number, max: number }, ai: string | null }[]
 * }} MatchSpec */
export const PRESETS = {
  vsAi:   (opts, content) => MatchSpec,   // opts: { ship = 'candlewick', foe = 'lampblack', ai = 'captain' }
  aiVsAi: (opts, content) => MatchSpec,   // opts: { a = 'candlewick', b = 'lampblack', aiA = 'captain', aiB = 'captain' }
  pvp:    (opts, content) => MatchSpec,   // opts: { a = 'candlewick', b = 'lampblack' }
};
export function buildSpec(preset, opts, content, presets = PRESETS)   // -> MatchSpec or { error: 'bad-preset' | 'bad-opts' }
```

| Preset | Ships | Rules |
|---|---|---|
| `vsAi` | `s1` blue, seats `{min 1, max 4}`, ai null; `s2` red, seats `{0, 0}`, ai profile | `pause 'crew'`, `pauseWhenEmpty true`, `snapEvery 2`, `idleTtlMs 600000` |
| `aiVsAi` | `s1` blue and `s2` red, seats `{0, 0}`, ai profiles | `pause 'any'`, `pauseWhenEmpty false`, `snapEvery 2`, `idleTtlMs 120000` |
| `pvp` | `s1` blue and `s2` red, seats `{min 1, max 3}`, ai null | `pause 'none'`, `pauseWhenEmpty false`, `snapEvery 2`, `idleTtlMs 600000` |

Co-op is not a preset: it is `vsAi` (or `pvp`) with more than one human on a ship. Opts are validated:
blueprint and profile names must exist in content; `seed`, when given, is an integer `>= 0`. Whether a
given seed is used is the Lobby's policy (14.6): the evasion roll is the only random draw, so whoever knows
the seed can predict every roll, and a seed is honored only where at most one side has human seats.

### 14.3 Members and occupants

```js
/** @typedef {{ kind: 'human' | 'ai', deliver(text: string): void }} Occupant */
/** @typedef {{
 *   id: string, name: string, kind: 'human' | 'ai',
 *   player: string | null,          // player id for humans
 *   ship: string | null, side: string | null,
 *   role: 'crew' | 'spectator',
 *   grants: string[],               // command scopes, or ['*']; spectators []
 *   perspective: Perspective,
 *   occupant: Occupant | null       // null while a human is disconnected; online = occupant !== null
 * }} Member */
```

M1 grants every crew member `['*']`. Later a captain can narrow grants (`['weapons']`,
`['crew:c3']`) with a `grant` match action and no protocol change. Until then, seating has no consent
step: whoever holds a match code can take a free seat (see 22.9).

### 14.4 `class Match` (`match.js`)

```js
export class Match {
  constructor({ code, spec, seed, content, nextSeed = rematchSeed })  // creates world via createWorld; creates AI members
  code; spec; seed; content; round; world; phase; manualPause; members; log; truncated
  get paused()                     // manualPause || (rules.pauseWhenEmpty && humansOnline('crew') === 0)
  join(player, want)               // want: { ship?: string, spectate?: boolean } -> Member | { error }
  attach(memberId, occupant)       // sends nothing; the caller sends joined, then calls sendSnapshot
  detach(memberId)                 // occupant = null (seat stays reserved)
  leave(memberId)                  // removes a human member
  submit(memberId, rid, cmd)       // queue for the next tick; rid null for AI
  control(memberId, action, arg)   // 'pause' | 'rematch' -> error code or null
  tick()                           // one fixed step (below)
  sendSnapshot(memberId)           // immediate snapshot to one member (join, reconnect)
  humansOnline(role?)              // online human members (only crew, or only spectators, with a role)
  summary()                        // lobby entry
  replayRecord()                   // { spec, seed, log, finalTick, truncated } for replay()
}
export const LOG_LIMIT = 20000;    // log entries kept per round
export const rematchSeed = (seed, round) => (seed + 0x9E3779B9 * round) >>> 0;
```

Rules:

- **AI members** are created in the constructor for every spec ship with `ai`: `kind 'ai'`, grants
  `['*']`, perspective of their side, occupant `aiOccupant({ profile, seed: aiSeed, content, ship,
  submit: (cmd) => this.submit(id, null, cmd) })` where `profile = content.ai[ship.ai]` and
  `aiSeed = parseInt(fnv1a(seed + ':' + memberId), 16)`. Member ids are `m1, m2, ...` per match, AI
  members first.
- **join**: the same player joining again gets the existing member back. `spectate: true` makes a
  spectator (perspective all). Otherwise the requested ship, or the first ship with a free human seat,
  or (only when no ship was requested and none is free, as in `aiVsAi`) a spectator. With no request,
  ships below `seats.min` fill first, so a friend joining a `pvp` code takes the empty enemy ship
  rather than a co-op seat. A requested ship is full when its human count equals `seats.max` ->
  `seat-full`; unknown ship -> `bad-ship`.
- **phase**: `'waiting'` until every ship with `seats.min > 0` has at least `min` human members
  (online or not), then `'running'` (never goes back), then `'ended'` once `world.outcome` is set.
  While waiting, commands apply but time does not advance.
- **authorize(member, cmd)**: spectator or no ship -> `spectator`; `phase === 'ended'` -> `ended`;
  scope not in grants and no `'*'` -> `forbidden`.
- **pause**: allowed if `rules.pause` is `'any'`, or `'crew'` and the member is crew; else `forbidden`.
- **rematch**: allowed when ended, for any crew member (or anyone when the spec has no human seats, as in
  `aiVsAi`); else `not-ended`.
  New seed `nextSeed(seed, round)`, new world, `round += 1`, empty log, same members,
  `manualPause = false`, phase recomputed, AI occupants recreated with fresh memory. `nextSeed` is host
  policy injected by the Lobby: `rematchSeed` (a public formula) for tools and explicit seeds, fresh
  randomness for secret ones, since the ended snapshot reveals the round's seed.
- **paused** counts online crew, not spectators: `pauseWhenEmpty` stops the fight while its crew is away
  (a phone asleep, a reload), and a stranger watching must not let the AI destroy that ship. Idle
  disposal (14.6) still counts every online human, so a watcher keeps a paused match alive.

`tick()`:

```js
tick() {
  this.updatePhase();
  const batch = this.inbox.splice(0);
  const ok = [];
  for (const q of batch) {
    const why = this.authorize(q.member, q.cmd);
    if (why) this.ack(q, why); else ok.push(q);
  }
  if (this.phase === 'ended') {                // late commands are still acked ('ended')
    if (this.dirty) this.broadcast();          // and roster changes still go out
    return;
  }
  const t = this.world.tick;
  const cmds = ok.map(q => ({ ...q.cmd, ship: q.member.ship }));
  const applied = applyCommands(this.world, cmds, this.content);
  cmds.forEach((cmd, i) => { if (applied.results[i] === null) this.record([t, ok[i].member.id, cmd]); });
  this.outbox.push(...applied.events);
  const running = this.phase === 'running' && !this.paused;
  if (running) this.outbox.push(...advance(this.world, this.content));
  ok.forEach((q, i) => this.ack(q, applied.results[i]));     // after advance: ack.tick is post-tick
  if (this.world.outcome) this.phase = 'ended';
  const due = running ? this.world.tick % this.spec.rules.snapEvery === 0 : ok.length > 0 || this.dirty;
  if (due || this.phase === 'ended') this.broadcast();
}
```

- `ack(q, why)` sends `{ t: 'ack', re: q.rid, ok: !why, why?, tick: this.world.tick }` to the member's
  occupant when `q.rid !== null`. Acks are always sent before the broadcast that reflects them, so the
  first snapshot a client receives after an ack already contains the command's effect. That is the
  client's rule for clearing pending styling (no tick arithmetic needed).
- `dirty` is set by join, leave, attach, detach, pause and rematch, and cleared by `broadcast`.
- `broadcast()` groups members by `perspectiveKey`, builds one string per key:
  `encode({ t: 'snap', round, tick, phase, paused, roster, view: project(world, p), ev: outbox filtered by projectEvent })`
  (plus `seed` when the phase is `ended`, for the outcome screen), delivers it to every online member
  with that key (AI included), then clears `outbox`.
- The log holds `[tick, memberId, cmd]` for every command the sim accepted, with `ship` already stamped
  on `cmd`, which is exactly what `replay` needs (no member table). A rejected command changed nothing, so
  leaving it out does not change the replay. `record` keeps at most `LOG_LIMIT` entries per round; past
  that it stops recording and sets `truncated` (the record can no longer reproduce the round), so a
  long-lived match never grows its log without bound.

### 14.5 `class Session` (`session.js`)

One per Link; it is the human occupant (`kind 'human'`, `deliver(text)` sends on the link).

- Parsing and dispatch run inside one error boundary (as `Lobby.tickAll` does for match ticks): a throw
  in any handler is reported through `lobby.onError` and answered `error bad-message` (with `re` when the
  rid was readable), and the connection stays open. No client message can throw out of the host.
- Before `hello`, any other message gets `error hello-first`.
- `hello`: wrong `v` -> `error upgrade-required`, then close. Known `token` -> resume that player
  (closing any older session of it); unknown or missing -> new player with a fresh token
  (16 random bytes as hex) and the sanitized name (trimmed, control characters removed, at most 24
  characters, default `Captain`). Reply `welcome`. If the player has a live membership:
  `match.attach`, push `joined`, `match.sendSnapshot`.
- `create`: `lobby.create(player, preset, opts)`; on success, leave any previous match, `join` with no
  preference, attach, reply `joined` (with `re`), send a snapshot.
- `join`: `lobby.get(code)` or `error no-match`; `match.join(player, { ship, spectate })`; then as create.
- `leave`: `lobby.unseat`; reply `ok` (also outside a match). `cmd`: no membership -> `error
  not-in-match`; else `match.submit` of the canonical command (15).
- `pause`, `rematch`: `match.control`; reply `ok` or `error <code>`. `list`: reply `lobby`.
- `ping`: reply `pong { ct, tick }`.
- Link close: crew are detached (`match.detach`; the player keeps its token and seat). A spectator holds
  no seat, so it is unseated (`lobby.unseat(player, false)`) and has nothing to reserve; a reconnecting
  client re-joins by code (17.2). A player left with no session and no match is forgotten
  (`lobby.forgetPlayer`).
- Rate limit: token bucket, 30 messages per second, burst 60; over the limit -> `error rate-limited`
  and drop; 200 drops -> close.

### 14.6 `class Lobby` (`lobby.js`)

```js
export class Lobby {
  constructor({ content, clock, presets = PRESETS })   // validates content (throws); clock.every(TICK_MS, tickAll)
  connect(link)                       // -> Session
  create(player, preset, opts)        // -> Match | { error }; seed policy below
  createFromSpec(spec, seed, nextSeed?)   // -> Match (tools and tests only; not reachable from the protocol)
  get(code)                           // -> Match | undefined
  list()                              // -> lobby entries for live exhibitions (no human seats)
  tickAll()                           // tick every match; dispose idle ones
  close()                             // stop the clock, close sessions
  login(token, name)                  // -> Player (known token: resume; else a new player and token)
  seat(player, match, want)           // join, leaving any other match only once the join succeeded
  unseat(player, chosen = true)       // leave the player's match (below)
  forgetPlayer(player)                // drop a player with no session and no match
}
```

- Match codes: 5 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I or O), unique among live matches.
- Idle disposal: when a match has no online humans, record `idleSince = clock.now()`; when humans return,
  clear it; dispose after `rules.idleTtlMs`. Also cap live matches at 500 (`error busy`).
- A player is in at most one match; create or join moves them.
- Lifetime rule: drop what has nothing to resume. `unseat` clears the player's fields first (so a player
  moving to another match is not sent `left`), then `match.leave`; a match that a request (leave, create,
  join elsewhere) leaves with no human member is disposed at once (`'empty'`), so one identity holds at
  most one live match. A spectator whose link closes is unseated with `chosen` false, which leaves an
  empty exhibition to its idle TTL, so a watcher whose network blips can come back. Idle TTL is for
  seats of disconnected humans. A player with no session and no match is forgotten; its token then
  simply starts a new player.
- Seed policy: `opts.seed` is honored only when at most one side of the spec has human seats (`vsAi`,
  `aiVsAi`); then rematch seeds follow the public `rematchSeed`. Otherwise (`pvp`) a given seed is
  ignored, the seed is a random u32, and every rematch draws a fresh one, so neither player can predict
  the evasion rolls (the ended snapshot reveals the finished round's seed, which is then harmless).
- `list()` shows only non-ended matches with no human seats (every spec ship has `seats.max === 0`:
  exhibitions to spectate). A code for a match with human seats is an invitation, shared out of band.
- `dispose` sends `left { reason }` to the match's online humans and forgets its offline ones.

### 14.7 `replay.js`

```js
export function replay({ spec, seed, log, finalTick }, content)   // -> World
```

Create the world with `createWorld({ seed, ships: spec.ships }, content)`. Then, while
`world.tick < finalTick`: apply (with `applyCommands`; logged commands already carry their ship) every
command logged at `world.tick`, in log order, then `advance`. Finally apply any commands logged at
`finalTick`. `Match.replayRecord()` returns `{ spec, seed, log, finalTick: world.tick, truncated }`.
Paused and waiting stretches need no special handling: commands applied while time stood still carry
that tick and apply before that tick's advance. Each command mutates only its own ship and ends with a
derive of that ship, and derive is idempotent, so the host ticks that split them carried no information
and one merged batch equals several small ones (section 11). A `truncated` record cannot reproduce its
round.

## 15. Protocol (`shared/net/protocol.js`)

JSON text frames. Every message is an object with type `t`. Requests may carry an integer `rid`; the one
reply to a request carries `re` with the same value. Messages without `re` are pushes.

```js
export const PROTOCOL_VERSION = 1;
export const LIMITS = { maxBytes: 16384, nameLen: 24, ratePerSec: 30, burst: 60 };
export const MESSAGES = {
  client: {
    hello:   { v: 'int', token: 'str?', name: 'str?' },
    list:    { rid: 'int' },
    create:  { rid: 'int', preset: 'str', opts: 'obj?' },
    join:    { rid: 'int', code: 'str', ship: 'str?', spectate: 'bool?' },
    leave:   { rid: 'int' },
    cmd:     { rid: 'int', c: 'obj' },
    pause:   { rid: 'int', on: 'bool' },
    rematch: { rid: 'int' },
    ping:    { ct: 'int' },
  },
  server: {
    welcome: { player: 'str', token: 'str', name: 'str', v: 'int', content: 'str' },
    joined:  { re: 'int?', code: 'str', preset: 'str', you: 'obj', rules: 'obj', round: 'int' },
    snap:    { round: 'int', tick: 'int', phase: 'str', paused: 'bool', roster: 'arr', view: 'obj', ev: 'arr', seed: 'int?' },
    ack:     { re: 'int', ok: 'bool', tick: 'int', why: 'str?' },
    ok:      { re: 'int' },
    lobby:   { re: 'int', matches: 'arr' },
    error:   { re: 'int?', code: 'str', msg: 'str' },
    left:    { reason: 'str' },
    pong:    { ct: 'int', tick: 'int' },
  },
};
export const ERROR_TEXT           // protocol error code -> human text (the server's `msg`; the client's REASON_TEXT spreads it)
export function parseClient(text)   // -> { ok: true, msg } | { ok: false, code: 'bad-message', msg: string, rid? }
export function parseServer(text)   // same, against MESSAGES.server
export function encode(msg)         // JSON.stringify
```

Field types: `int` (safe integer), `str` (string, at most 64 characters except `token`), `bool`, `obj`
(plain object), `arr`; a `?` suffix means optional. Unknown fields are ignored (a parsed message keeps only
`t` and its schema fields). `cmd.c.type` must be a key of `COMMANDS` (otherwise `bad-message`). Then `c` is
rebuilt from `COMMANDS[type].args` with the same keep-only-schema-fields rule: a declared field is kept
only when its value fits its shape (objects rebuilt field by field, arrays element by element), anything
else is dropped. A dropped field reaches the sim as absent, so argument semantics still belong to
`COMMANDS[type].check`, which answers with its own reason (`bad-arg`, `no-system`, ...).
Text longer than `maxBytes` is rejected before parsing. A malformed message gets `error bad-message`
and the connection stays open.

### 15.1 Examples

```json
{"t":"hello","v":1,"name":"shawn"}
{"t":"welcome","player":"p1","token":"9f2c4e0b7a1d4c3e8b6a5f4e3d2c1b0a","name":"shawn","v":1,"content":"3fa9c021"}

{"t":"create","rid":1,"preset":"vsAi","opts":{"ship":"candlewick","ai":"captain"}}
{"t":"joined","re":1,"code":"QXRTV","preset":"vsAi","round":1,
 "you":{"member":"m2","ship":"s1","side":"blue","role":"crew","grants":["*"]},
 "rules":{"pause":"crew","pauseWhenEmpty":true,"snapEvery":2,"idleTtlMs":600000,"tickMs":50}}

{"t":"snap","round":1,"tick":1342,"phase":"running","paused":false,
 "roster":[{"id":"m2","name":"shawn","kind":"human","ship":"s1","online":true},
           {"id":"m1","name":"Gloam (Captain)","kind":"ai","ship":"s2","online":true}],
 "view":{"v":1,"tick":1342,"nextId":58,"ships":{"s1":{"...":"as in 7.2"},"s2":{"...":"as in 7.2, redacted"}},
         "shots":[{"id":"p57","bp":"flint","from":{"ship":"s2","device":"w7"},"to":{"ship":"s1","room":"W"},
                   "flight":{"v":25000,"max":100000,"rate":100}}],"outcome":null},
 "ev":[{"type":"fired","tick":1336,"ship":"s2","device":"w7","bp":"flint","shots":["p57"]}]}

{"t":"cmd","rid":12,"c":{"type":"setPower","system":"shields","level":4}}
{"t":"cmd","rid":13,"c":{"type":"setDevicePower","device":"w2","on":true}}
{"t":"cmd","rid":14,"c":{"type":"setTarget","device":"w1","target":{"ship":"s2","room":"W"}}}
{"t":"cmd","rid":15,"c":{"type":"setAuto","device":"w1","on":true}}
{"t":"cmd","rid":16,"c":{"type":"moveCrew","crew":["c4"],"room":"E"}}
{"t":"ack","re":12,"ok":true,"tick":1343}
{"t":"ack","re":13,"ok":false,"why":"no-reactor","tick":1343}

{"t":"join","rid":2,"code":"QXRTV"}
{"t":"join","rid":2,"code":"QXRTV","spectate":true}
{"t":"error","re":2,"code":"seat-full","msg":"That ship has no free seats."}

{"t":"pause","rid":5,"on":true}
{"t":"ok","re":5}
{"t":"rematch","rid":6}
{"t":"list","rid":7}
{"t":"lobby","re":7,"matches":[{"code":"HWMNB","preset":"aiVsAi","name":"Exhibition","phase":"running",
  "ships":[{"id":"s1","bp":"candlewick","side":"blue","open":0},{"id":"s2","bp":"lampblack","side":"red","open":0}],
  "spectators":2}]}
{"t":"ping","ct":81234}
{"t":"pong","ct":81234,"tick":1342}
```

### 15.2 Rates and transport

| What | Rate |
|---|---|
| Sim | 20 Hz (`TICK_MS` 50) |
| Snapshots | every `snapEvery` (2) ticks = 10 Hz while running; immediately after state changes while paused or waiting |
| Client ping | every 2 s (RTT display; liveness) |
| ws heartbeat | server pings every 15 s; terminates sockets without a pong |
| Render | `requestAnimationFrame` |

Full projected snapshots (about 3 to 5 KB of JSON for two ships, roughly 1 KB after deflate). They make
reconnect, late join and spectating trivial. A structural JSON diff can later be added in Session
without touching the sim. `perMessageDeflate` is on with a 1 KB threshold.

### 15.3 Error codes

`bad-message`, `hello-first`, `upgrade-required`, `rate-limited`, `bad-preset`, `bad-opts`, `busy`,
`no-match`, `bad-ship`, `seat-full`, `not-in-match`, `forbidden`, `not-ended`. Ack `why` values are the
sim reasons of section 11 plus `forbidden`, `spectator`, `ended`. `ERROR_TEXT` holds one text per protocol
code, used by both the server and the client.

## 16. The AI (`shared/ai`)

The AI is a member whose occupant parses the same snapshot text a human gets and returns commands
through the same `submit` and authorization path. It never sees the world.

**The one trick.** The AI values *stats*, not system names. It imagines candidate actions on a
`structuredClone` of the projected ship using the sim's own `applyEffects`, `deriveShip` and
`computeStats`, then scores the result with one utility function. A new system that changes `evasion`
or `shieldLayers` is valued correctly with no AI change; a new effect is valued correctly if its
consequences reach stats or hull. Both halves of the AI use the same counterfactual for a payload: what
one hit is worth (`hitGains`) chooses the room to aim at and is part of what a power plan is worth, so a
weapon is powered for whatever its payload does (hull, systems, ion, crew), never for one effect key.

### 16.1 `estimate.js`

```js
export function poweredDevices(ship)                    // devices with powered === true
export function threatOf(foe, content)                  // the foe as it could stand within one command (memoized per foe object)
export function volley(att, def, content, devices = poweredDevices(att))   // { dps, shots: Map<device id, { land, block }> }
export function dps(att, def, content, devices = poweredDevices(att))      // volley(...).dps: expected hull damage per second
export function utility(me, foe, content, weights)      // the score the AI maximizes
export function hitGains(me, foe, content, weights)     // per blueprint: { rooms, best, block }, what one shot is worth
export function imagine(ship, content, mutate)          // clone, mutate(clone), deriveShip(clone), return clone
export function imagineHit(ship, room, payload, content)   // imagine with applyEffects(clone, room, payload, quiet ctx)
```

`volley(att, def)` (and `dps`, its rate):

1. Devices that cannot pay their cost (`canPay`) are skipped; none left -> 0.
   `L = def.stats.shieldLayers`. For each device, its hit chance is
   `p = bp.canMiss ? 1 - clamp(def.stats.evasion - bp.accuracy, 0, 100) / 100 : 1`.
2. Cycle time: `T = max over devices of bp.chargeMs * 100 / att.stats.chargePct` (ms).
3. Shot list: each device contributes `bp.shots` entries `{ p, pierce, hull: onHit.hull ?? 0 }`,
   blockable shots (pierce < L) first, in device order.
4. Walk the list with `layers = L` (float): `b = clamp(layers - pierce, 0, 1)`;
   `dmg += p * (1 - b) * hull`; `layers -= p * b`; the shot's device gets `land += p * (1 - b)` and
   `block += p * b` (expected landed and blocked shots per volley).
5. `dps = dmg / (T / 1000)`.

`threatOf(foe)`: one allocation the foe can actually reach within one command.

1. `armed = imagine(foe, s => { every system that takes a want: want = 0; every device: on = true,
   powered = false })`, so weapons get reactor bars first, in slot order, within capacity.
2. `threat = imagine(armed, s => { every system that takes a want: want = level })`, so the bars left go
   to systems in `systemOrder`.

Damage and ion still bind through capacity, and the reactor is respected. The result is memoized per foe
object (a WeakMap; views are never mutated), since a think calls `utility` hundreds of times.

`utility(me, foe) = weights.offense * dps(me, threat) / max(1, foe.pools.hull.v)
                  - weights.defense * dps(threat, me) / max(1, me.pools.hull.v)`, with `threat = threatOf(foe)`.

That is "who dies first" in rate form: the fraction of the enemy's life I remove per second minus the
reverse. Both terms use the same imagined foe: what it can bring to bear within one command, not its
momentary power. With momentary flags, two AIs best-respond to each other's power and oscillate forever:
its weapons are off, so my shields are worthless, so I drop them, so it powers weapons; and its shields
are down, so my ion weapon is worthless, so I cut it mid-charge (an unpowered device drains at 3x).

`hitGains(me, foe)`, once per blueprint among my devices, with `now = utility(me, foe)`:

- `rooms[i] = utility(me, imagineHit(foe, roomIds[i], bp.onHit)) - now`, over the foe's rooms in
  geometry order; `best = max(0, ...rooms)`;
- `block = max(0, utility(me, imagineHit(foe, blockRoom(foe), bp.onBlock)) - now)` when `onBlock` has
  effects, else 0.

`imagine` copies with a plain-data deep copy rather than `structuredClone` (identical on parsed views,
about four times faster; it is the AI's inner loop).

### 16.2 `brain.js`

```js
/** @typedef {{ rng: () => number, nextThink: number }} Memory */
export function think(snap, me, mem, profile, content)   // -> Command[] (without ship); pure except mem
export function bestPower(my, foe, content, weights, gains = hitGains(...))   // -> the imagined ship under the greedy power plan
export function planPower(my, foe, content, profile, plan = bestPower(...))   // -> Command[]
export function planWeapons(view, my, foe, content, profile, mem, gains?)     // -> Command[]
export function planCrew(my, foe, content, profile, plan?, gains?)            // -> Command[]
```

`think`: return `[]` if `profile.passive`, if `snap.tick < mem.nextThink`, if the phase is not
`running`, if paused, if `view.outcome` is set, or if my ship is out. Set
`mem.nextThink = snap.tick + profile.thinkEveryTicks`. `foe` = the enemy (not out) with the lowest hull,
ties by spawn order. `gains = hitGains(my, foe)` and `plan = bestPower(my, foe, weights, gains)` are
computed once. Return `planPower ++ planWeapons ++ (profile.crew ? planCrew : [])`.

**What a plan is worth.** `planValue(plan) = utility(plan, foe) + sum over the plan's powered, payable
devices of (land * gain.best + block * gain.block)`, with `land` and `block` from `volley(plan,
threatOf(foe))`: the expected utility after each device's next volley. A device whose payload does no
hull damage (Hush Pulse's ion) is still worth its counterfactual, so it is not cut mid-charge when the
foe shows no shield layer.

**planPower** (greedy from scratch every think, so absolute commands never drift):

1. Start from an imagined copy of my ship with every reactor system `want 0` and every device off.
2. Repeat while free reactor > 0: candidates are runs: `+k` bars on each reactor non-host system, for
   every k that fits (k = 1 and 2 are the original lookahead for shields' two bars per layer), and, for
   each off device that fits, that device plus each later off device that still fits (single steps never
   power Lampblack's weapons, which only get through shields together). Score each by
   `(planValue(after) - planValue(now)) / bars`, times 1.2 when the run only restores the ship's current
   intent (hysteresis, so near ties do not flip devices off and drain their charge). Take the best if its
   score is above 0; ties break by `systemOrder`, then slot order.
3. Emit commands only for differences from the current ship, in this order: devices off, systems
   lowered, systems raised, devices on (so freed bars are available to later commands in the same batch).

**planWeapons**, for each of my powered devices that is fully charged and has no target:

1. **Volley sync:** hold (emit nothing) if `profile.patienceMs > 0`, `foe.pools.shield.v > bp.pierce`,
   and another of my powered devices that is not yet full and can pay its cost will be full within
   `patienceMs` (`msToFull`). Counting full devices would make two full weapons wait for each other
   forever (`msToFull` of a full meter is 0).
2. Otherwise score every room of the foe with `hitGains`:
   `score(room) = utility(my, imagineHit(foe, room, bp.onHit)) - utility(my, foe)` (the gain the hit buys).
   Normalize by the largest absolute score (or 1), weight each room by `exp(score / max(temperature, 0.01))`,
   and sample one with `mem.rng`. Emit `setTarget(device, { ship: foe.id, room })`.

Shields first, then weapons, emerges from the counterfactual: knocking out a layer or a weapon changes
`dps` the most. Ion weapons are valued the same way, because `imagineHit` runs the ion effect and
`deriveShip` sheds the power.

**planCrew**:

1. Tasks: one per system room that is damaged or mannable; whoever goes repairs the system, then mans
   it. A damaged system's value is the `planValue` of the best power plan with the system fully repaired
   and manned minus the `planValue` of the current plan (valuing one bar of repair at fixed power is
   mostly zero: the plan has already rerouted the bars, and half a shield layer buys nothing). An intact
   mannable room's value is `planValue` with one crew member standing there minus `planValue` with the
   room empty, at planned power. Only positive values are tasks.
2. Assign crew greedily, highest `value / (1 + pathLength / 4)` first; a crew member already doing a
   task keeps it unless the new value exceeds the old by 20 percent (hysteresis).
3. Emit `moveCrew([id], room)` only for crew whose destination room changes.

### 16.3 `occupant.js`

```js
export function aiOccupant({ profile, seed, content, ship, submit })   // -> Occupant { kind: 'ai', deliver(text) }
```

`deliver(text)`: parse; ignore everything but `snap`. Release queued commands whose `due <= snap.tick`
through `submit`. Then call `think(snap, { ship, side }, mem, profile, content)` and queue its commands with
`due = snap.tick + profile.reactionTicks`. On a new `round`, reset memory and the queue. The AI is
tick-driven (never wall-clock), so AI-vs-AI is deterministic from the seed down to the final hash.

Difficulty is data: `thinkEveryTicks`, `reactionTicks`, `temperature`, `patienceMs`, `crew`, `weights`.
The same occupant later provides autopilot for a disconnected PvP seat and bot crewmates in co-op.

## 17. Client (`client/`)

### 17.1 Boot and URL parameters

| Parameter | Effect |
|---|---|
| (none) | menu |
| `?play=ai&ship=candlewick&ai=captain&seed=3` | create `vsAi` and play |
| `?watch=ai&a=candlewick&b=lampblack&seed=7` | create `aiVsAi` and spectate |
| `?pvp=new` | create `pvp`, show the code and share link |
| `?join=CODE` (`&spectate=1`) | join a match |
| `?local` | run the host in this browser (offline; no server needed after load) |
| `?server=wss://host/ws` | server URL override (needed for a packaged phone app) |
| `?debug` | expose `window.__ftl` |
| `?name=shawn` | player name |

Default server URL: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`.

### 17.2 Logic modules (pure, Node-testable)

```js
// net.js (browser)
/** @typedef {() => Promise<Link>} Connector */
export function wsConnector(url)        // Link over a browser WebSocket; resolves on open
export function localConnector()        // lazily: new Lobby({ content: CONTENT, clock: realClock() }) + memoryLinkPair

// game-client.js
export class GameClient extends EventTarget {
  constructor(connector, { name, tokenStore, now = () => performance.now() })
  start()                               // connect + hello; resolves with welcome
  request(msg)                          // assigns rid; resolves with the reply; rejects with { code, msg } on error
  create(preset, opts); join(code, opts); list(); leave(); pause(on); rematch()
  cmd(c)                                // -> rid; pending until its ack, then cleared by the first snap received after that ack
  status                                // 'connecting' (first attempt only) | 'online' | 'reconnecting' | 'outdated'
  you; rules; code; snap; recvAt; pending /* Map<rid, { c, ackTick? }> */; lastAck
  intent                                // undefined (fresh) | null (no match) | { code, spectate }: the membership it means
  // events: 'status', 'welcome', 'joined', 'snap', 'ack', 'error', 'left'
}
```

- `tokenStore` is `{ get(): string | null, set(token): void }`; `main.js` backs it with `sessionStorage`:
  a reload resumes the seat, and every tab is its own player. (One token per browser would make two tabs
  take the seat from each other forever, since each reconnects when the server closes the older session,
  and a second tab could not join as a crewmate.)
- Reconnect: on link close, back off 0.5, 1, 2, 4, then 8 s maximum, reconnect, `hello` with the token.
  The server re-pushes `joined` and a snapshot when the seat survived. Pending commands are dropped on
  reconnect (they are absolute setters, so a duplicate is harmless and a loss is visible).
- Membership intent: the client owns the membership it means to be in, rather than trusting leftover
  state. `intent` is set by every `joined` it adopts and cleared (null) by `leave()` and `forget()`, at
  once, even offline. On every `welcome` (the first too, since Menu may be pressed while connecting) it
  reasserts an intent it has with one idempotent request and treats the reply as truth: `join(code,
  { spectate })` when it means a match (a surviving seat comes back unchanged; a spectator the server let
  go is seated again; `no-match` means the match is gone, so it forgets it and emits `left { reason:
  'gone' }`), else `leave`, which releases a seat the server kept while the client was away. A pushed
  `joined` (no `re`) is ignored while the intent is null. So a match that vanished during a disconnect
  (a server restart, the idle TTL passing while a phone slept) is reported instead of freezing the
  fight, and leaving sticks.
- Liveness: every received message stamps `lastRecv`. Pongs arrive every 2 s even while paused or
  waiting, so a link silent for three ping periods is dead (a half-open socket after a network change or
  a sleep can stay open for minutes); `ping()` then closes it and reconnects.
- Status: `connecting` is only the first attempt; every retry is `reconnecting`, so a server that is down
  at first load is reported (main.js words the banner by whether a welcome ever arrived).
- A rejected ack clears its pending entry at once: nothing changed, so no snapshot will confirm it (a
  refinement of "pending until the first snap after its ack").
- If `welcome.content !== CONTENT_HASH`, set status `outdated` and show "This client is out of date.
  Reload to update."
- On a new `round`, clear pending and FX.

```js
// ui-state.js
/** @typedef {{ mode: 'idle' } | { mode: 'aiming', device: string } | { mode: 'crew', crew: string[] }} Ui */
/** @typedef {{ kind: 'tapWeapon', device } | { kind: 'tapRoom', ship, room } | { kind: 'tapCrew', crew }
 *          | { kind: 'power', system, level } | { kind: 'toggleDevice', device } | { kind: 'toggleAuto', device }
 *          | { kind: 'tapEmpty' } | { kind: 'key', key }} Intent */
export function initialUi()                              // { mode: 'idle' }
export function reduceUi(ui, intent, { view, you })      // -> { ui, cmds: object[] }
export const REASON_TEXT                                 // reason -> short human text for toasts
```

Reducer rules (spectators, `you.ship === null`, never produce commands):

| State | Intent | Result |
|---|---|---|
| idle | `tapWeapon d` | if `d` has a target: `setTarget(d, null)`, stay idle; else aiming `d` |
| aiming `d` | `tapWeapon d` | idle |
| aiming `d` | `tapWeapon e` | aiming `e` |
| aiming `d` | `tapRoom` on an enemy ship | `setTarget(d, { ship, room })`, idle |
| aiming `d` | `tapRoom` on own ship | idle |
| idle | `tapCrew c` | crew `[c]` |
| crew `sel` | `tapCrew c` | toggle `c` in `sel`; empty selection -> idle |
| crew `sel` | `tapRoom` on own ship | `moveCrew(sel, room)`, idle |
| crew `sel` | `tapRoom` on an enemy ship | idle |
| any | `tapEmpty` | idle |
| any | `power system level` | `setPower(system, level)`, state unchanged |
| any | `toggleDevice d` | `setDevicePower(d, !on)` |
| any | `toggleAuto d` | `setAuto(d, !auto)` |
| any | `key '1'..'9'` | as `tapWeapon` on the device at that index |
| any | `key 'Escape'` | as `tapEmpty` |

```js
// scene.js
export function layoutScene(view, you, viewport, content)
  // viewport: { w, h } in CSS px of the stage canvas
  // -> { w, h, portrait, cell, ships: { [id]: { x, y, mirror, geo, rooms: { [room]: { x, y, w, h } } } },
  //      regions: { x, y, w, h, intent }[] }
export function pick(scene, x, y)                  // topmost region containing the point, else { kind: 'tapEmpty' }
export function roomCenter(scene, shipId, roomId)  // -> { x, y }
export function cellCenter(scene, shipId, cell)    // -> { x, y }
```

- `portrait = w / h < 1`. Landscape: own ship in the left bay, enemies in the right bay (stacked if
  several). Portrait: enemies in the top bay, own ship in the bottom bay. Spectators: `s1` takes the
  own-ship bay.
- `cell = min(48, largest size that fits every ship in its bay with a 1-cell margin)`. Enemy ships are
  mirrored horizontally so bows face each other.
- Regions: every room of every ship (`tapRoom`), and own crew (`tapCrew`, above rooms, at least 32 px
  square but never larger than its cell, so every room center picks its room at any size). Canvas crew taps are a convenience; the HUD crew chips are the primary 44 px targets. The renderer draws from the same scene, so geometry is defined once.

### 17.3 Presentation modules

```js
// render.js
export function createRenderer(canvas)   // -> { resize(w, h, dpr), draw(frame) }
//   frame: { scene, snap, elapsedMs, ui, you, fx, now }
// fx.js
export const FX                          // event type -> (event, scene, fxState) => void
export function createFx()               // -> { ingest(events, scene, view), draw(ctx, now), offset(now) -> {x, y}, reset() }
// hud.js
export function createHud(root, dispatch)   // -> { update({ snap, you, ui, pending, content, elapsedMs }), toast(text) }
// input.js
export function bindPointer(el, pick, dispatch)   // pointer events; tap = down/up within 10 px and 600 ms; returns unbind
// menu.js
export function createMenu(root, actions, content = CONTENT)   // -> { showStart(note?), showWaiting(code, link), showOutcome(snap, you), hide() }
//   actions: { playAi(opts), watchAi(opts), createPvp(opts), join(code, opts), rematch(), toMenu(), offline? }
// theme.js
export const THEME                       // colors, line widths, font stack, motion durations
```

**Time on screen.** Render the latest snapshot. `elapsedMs = paused ? 0 : min(now - recvAt, 250)`.
Every meter (charge bars, shield regen arcs, repair rings, crew steps, projectile flight) is drawn at
`meterAt(m, elapsedMs)`. No interpolation buffer and no clock sync. A projectile reaches its room
up to one snapshot before its `hit` event arrives; it holds there until the event fires the FX.
If that ever looks wrong, the upgrade is rendering one snapshot behind, inside `main.js` only.

**FX** come from events through the `FX` registry: `fired` (muzzle flare), `miss` (the shot sails past
plus a "MISS" glyph), `shieldHit` (halo ripple), `hit` (flash, screen shake, floating damage number),
`systemDamaged` (room lights stutter), `ionized` (cold flicker), `systemRepaired` (warm sparkle),
`crewDied` (mote fades), `shipOut` (rooms go dark one by one, then the hull breaks apart). Unknown
event types are ignored. `navigator.vibrate(20)` on own hull damage when available (stretch: WebAudio
synth blips).

**Pending and rejections.** Controls whose command is pending pulse softly. A rejected ack shows a toast
from `REASON_TEXT` (for example `no-reactor` -> "No free reactor power"); `REASON_TEXT` spreads the
protocol's `ERROR_TEXT`, overriding only where a player needs other words.

**Canvas resolution.** The backing store follows `devicePixelRatio`: a ResizeObserver handles CSS size
changes, and the frame loop compares the ratio each frame, so a window moved to another monitor (same
CSS size, new ratio) is redrawn sharp.

### 17.4 Screen layout

The page is a CSS grid: top bar, stage (canvas), HUD (DOM). `height: 100dvh`, padding from
`env(safe-area-inset-*)`, viewport meta `width=device-width, initial-scale=1, viewport-fit=cover,
user-scalable=no`. The canvas has `touch-action: none`; HUD buttons have `touch-action: manipulation`;
`user-select: none` and a suppressed context menu on the game surface. Every tap target is at least
44 x 44 CSS px. Nothing depends on hover: the selected weapon's blurb shows in its card while aiming.

Desktop (landscape, for example 1440 x 900):

```
+----------------------------------------------------------------------------------------+
| FASTER THAN LUMOS   code QXRTV   round 1   [Pause]        vs Gloam (Captain)   [Menu]  |  48 px
+----------------------------------------------------------------------------------------+
|                                                                                          |
|   Candlewick  hull 17/20  evasion 15%              Lampblack  hull 12/17  evasion 20%    |
|        (  (  [W][S][H]  )  )      . . . shots . . .      (  [H][W][E]  )                 |  stage
|                                                                                          |
+----------------------------------------------------------------------------------------+
| REACTOR  [o][ ][ ][ ][ ][ ][ ]     | [Ember Volley ====== ][P][A] | [Ines 100] [Tomo 85]  |
|  [+]   [+]    [+]    [+]           | [Long Needle  ...... ][P][A] | [Wen  100]            |  ~180 px
|  |||    ||     ||     |  pips      |                              |                       |
|  [-]   [-]    [-]    [-]           |                              |                       |
|  HELM  SHLD   ENG    WPN           |                              |                       |
+----------------------------------------------------------------------------------------+
```

Phone portrait (for example 390 x 844):

```
+--------------------------------------+
| QXRTV  r1        [Pause]     [Menu]  |  44 px
+--------------------------------------+
|  Lampblack 12/17  ev 20%             |
|       (  [H][W][E]  )   (mirrored)   |  stage: enemy bay
|            .   shots   .             |
|  Candlewick 17/20  ev 15%            |
|       (  [W][S][H]  )                |  stage: own bay
+--------------------------------------+
| [Ember Volley ===] [Long Needle ..]  |  weapons row: cards side by side (three fit),
| [P]    [A]        [P]    [A]         |  toggles under each card (scrolls sideways past that)
| R [o][ ][ ][ ][ ][ ][ ]              |  reactor
| [+][+][+][+]  pip columns  [-][-]..  |  systems row, ~120 px
| [Ines 100] [Tomo 85] [Wen 100]       |  crew row, 48 px
+--------------------------------------+
```

HUD widgets:

- **Reactor:** a row of filaments; lit = free bars.
- **System column** (one per system in `systemOrder`): `[+]` button, pip stack, `[-]` button, label.
  `[+]` dispatches `power(system, power + 1)`, `[-]` dispatches `power(system, power - 1)`; tapping or
  dragging vertically across the pip stack dispatches `power(system, level under the finger)` on release.
  The hit test reads the drawn pips, not the stack's box (pips sit packed at the bottom of a taller
  stack): the level is the number of pips whose bottom edge is at or below the pointer.
  Pips: lit = powered, dim = installed, hatched red = damaged, cold blue = ionized. Subsystems are
  read-only. The column shows a crew glyph when manned.
- **Weapon card:** name, charge bar, cost glyph, target badge (the enemy room letter), a `[P]` power
  toggle and an `[A]` auto toggle. Tapping the body dispatches `tapWeapon`. The aiming card glows and the
  enemy rooms show reticles. Its status word comes from the sim's fire rule (`fireBlock`): a charged,
  targeted device reads "Firing" only when it will fire; one that cannot pay reads "Out of missiles".
- **Crew chip:** name, hp bar, task icon (walk, repair, man). Tap toggles selection.
- **Outcome overlay:** Victory or Defeat (or "Blue wins" for spectators), seed, `[Rematch]`, `[Menu]`.
  The waiting and outcome panels cover the HUD row as well as the stage, so their buttons are never
  below the fold on a short landscape phone (the HUD is inert once ended; nothing has started while
  waiting), and the verdict's size follows the viewport's height as well as its width.
- **Connection banner** for `reconnecting` ("Connection lost. Reconnecting.", or before any welcome
  "Cannot reach the server. Retrying.") and `outdated`.

The HUD adapts to width, not only orientation. In landscape below 1280 px wide (tablets, small laptops)
and on landscape phones, crew chips become 44 px motes, which gives the width to the weapon cards. On
landscape phones (height up to 520 px) the HUD is one compact row that keeps only controls: read-only
system columns (helm, weapons) are left out, since the canvas rooms draw the same power bars, and weapon
cards stack their toggles under the body, so two cards with every toggle fit from 568 px wide. On phones
weapon cards share their row down to 90 px each (two 44 px toggles and the border), so Lampblack's three
fit in portrait and from 667 px wide in landscape; narrower, the next card visibly peeks in and the row
scrolls, so no weapon is ever silently out of view. The e2e suite asserts that every HUD button lies
inside the viewport and inside its scroll container at landscape phone sizes from 568 x 320, in portrait
and on tablets, for two and three weapons.

### 17.5 Visual identity: "power is light"

Deep ink background (`#0b0d1a`), ships as luminous line art. Each room's glow follows its system's
power (warm amber, `#ffcf6e`, brightness = power / level); the reactor is drawn as a lamp core with
filaments; shield layers are cyan halo rings (`#6ee7ff`) around the hull; ion is a cold blue flicker
(`#9ab8ff`); damage is a red hatch (`#ff5a5f`) with stuttering light. Crew are small motes with
initials. Projectiles: `spark` (short bright streak), `dart` (thin line with a long trail), `pulse`
(expanding ring), keyed by the weapon's `look`. Typography: the system UI font stack, tabular numbers.
No external fonts or images; everything is procedural, so there is no asset pipeline and nothing
resembles the original game's UI.

### 17.6 Debug hook

With `?debug`, `window.__ftl = { client, ui, scene, phase, lastAck, errors, tapPoint(kind, ...args) }`
where `tapPoint('weapon', index)`, `tapPoint('room', shipId, roomId)` and `tapPoint('crew', crewId)`
return page coordinates of that control. `document.body.dataset.phase` mirrors
`boot | menu | waiting | running | ended`. Uncaught errors are collected in `errors`.

## 18. Server (`server/`)

```js
// main.js
export async function startServer({ port = 8080, host = '0.0.0.0', clock = realClock() } = {})
  // -> { port, lobby, close(): Promise<void> }
// Direct run (node server/main.js): startServer({ port: Number(process.env.PORT) || 8080 }), log the URL.

// static.js
export function serveStatic(req, res, root)   // -> true if handled
// ws-link.js
export function wsLink(socket)                // -> Link
```

- `node:http` server. `GET /` serves `client/index.html`; `/client/*` and `/shared/*` are served from
  disk; `GET /healthz` returns `ok`; everything else is 404. Path traversal is rejected (resolve, then
  check the prefix). MIME types for `.html .js .css .json .svg .png .ico`. `Cache-Control: no-cache`
  with ETag (mtime and size), so edits show on reload.
- `new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.maxBytes, perMessageDeflate: { threshold: 1024 } })`.
  On connection: `lobby.connect(wsLink(socket))`. Heartbeat every 15 s.
- `wsLink.send` drops messages and closes the socket if `bufferedAmount` exceeds 4 MB.
- `wsLink` gives every socket an `'error'` listener. `ws` emits `'error'` on any protocol violation by the
  peer (a frame over `maxPayload`, an unmasked frame, bad UTF-8), after it has started closing that socket
  with the right status code; an unheard `'error'` event would kill the process. The `'close'` listener
  then detaches the session like any other disconnect.
- In production, terminate TLS (wss) at a reverse proxy.

## 19. Test plan

All tests use `node:test` and `node:assert/strict`; no test dependencies. `npm test` must finish in
under 30 seconds. `test/helpers/fixtures.js` provides tiny injected content (a 1-room and a 3-room
ship, a test weapon with `canMiss: false`) and world builders.

### 19.1 Unit tests (`test/*.test.js`)

| File | Covers |
|---|---|
| `rng.test.js` | fixed sequence for a seed; `roll` always draws once; `roll(0)` false, `roll(100)` true |
| `time.test.js` | `tickMeter` math, clamps, negative start, negative rate; `meterAt` extrapolation |
| `geometry.test.js` | Candlewick rooms and doors exactly as in 9.2, Lampblack's derived by the same rules; bad maps throw (non-rectangle, disconnected); `findPath` determinism |
| `power.test.js` | settle invariants; damage and ion free bars; repair restores from free bars only; device shedding in slot order; idempotence |
| `stats.test.js` | tables, manned bonuses, the helm as data (`unmanned` autopilot table, power 0 zeroes evasion), engines-off mul, the 7.2 worked numbers |
| `combat.test.js` | evasion 0 hits; `canMiss: false`; block pops one layer and applies `onBlock`; `pierce` passes without popping; a 3-shot volley strips 2 layers and lands 1; ion lowers capacity next derive |
| `crew.test.js` | `planMove` picks free cells, respects claims, mid-step continuity; repair stacks; tasks |
| `commands.test.js` | every row of the section 11 table (valid and each invalid argument); results array alignment; one merged batch equals the same commands one at a time, including lowering and raising shields |
| `view.test.js` | seed and rng stripped; enemy `want/on/target/auto` absent; own fields present; mutating a view never touches the world |
| `content.test.js` | shipped content validates; each crafted bad fixture yields its error; `CONTENT_HASH` stable |
| `protocol.test.js` | every 15.1 example parses; malformed messages (bad JSON, wrong types, oversize, unknown `t`, unknown command type) rejected; commands rebuilt from their declared args; one error text per protocol code |
| `ui-state.test.js` | every row of the reducer table; spectators produce no commands |
| `scene.test.js` | the center of every room region picks that room, in portrait and landscape, also with own crew standing there on small phone stages; enemy mirrored |
| `purity.test.js` | grep: no `Math.random`, `Date`, `performance`, `setTimeout`, `node:`, `window`, `document` in `shared/sim`, `shared/ai`, `shared/content`; no non-integer Math in `shared/sim`; every import in `shared/` and `client/` is relative with `.js` |

### 19.2 Simulation tests

- `determinism.test.js`: two worlds from the same seed and the same scripted command log produce the same
  `hashWorld` after 2000 ticks; a different seed produces a different hash. `checkInvariants` is empty
  after every tick of an AI-vs-AI run.
- `replay.test.js`: run an `aiVsAi` match to the end; `replay({ spec, seed, log })` reproduces the final
  hash, including a run with a pause injected mid-fight, a scripted human match with waiting and pauses,
  and shields stepped down and back up in two host ticks while paused.

### 19.3 Host and AI tests (headless, no sockets)

- `match.test.js` (Match with `manualClock` via Lobby): join rules (`seat-full`, `bad-ship`, spectate),
  authorization (`forbidden`, `spectator`, `ended`), pause policy per preset, `pauseWhenEmpty`, waiting
  phase in `pvp` until both seats fill, rematch (round, seed, reset), one identical string per
  perspective key per broadcast, acks carry the right tick; the log keeps only accepted commands up to
  `LOG_LIMIT`; a spectator does not unpause a `vsAi` whose crew is away; seed policy; `list` shows only
  exhibitions; a match left by its last human is disposed; closed spectators are unseated and forgotten;
  a throwing handler is answered `bad-message` and the link stays open.
- `ai.test.js`: with fixture worlds, `planPower` emits lowers before raises and only diffs; a fully
  charged weapon facing shields holds when another weapon is about to be ready (captain), and fires when
  `patienceMs` is 0; targeting prefers the shields room against a shielded foe; `drifter` never commands;
  Lampblack keeps Hush Pulse powered against a foe with no shield layer; a data-only weapon whose payload
  has no `hull` key is powered for what it does, and a blocked shot is valued by its `onBlock`.
- `duel.test.js`: `aiVsAi` captain vs captain, seeds 1 to 20: every match ends with an outcome within
  6000 ticks (5 simulated minutes), no exceptions, both AIs issued commands; the same seed twice gives
  the same winner and final hash (on one thread and across the duel tool's worker threads); three seeds
  with the ship order reversed also end. `aiVsAi` with `aiA: 'captain'` and `aiB: 'drifter'`: the captain
  wins in at least 19 of 20 seeds.
- `local.test.js`: `GameClient` over `memoryLinkPair` to a Lobby on `manualClock` (the `?local` path)
  completes hello, create, joined, snap, cmd, ack, and pending clears with the first snap after the ack;
  a co-op crewmate and a spectator join by code, and a new client with the same token store (a reload)
  resumes the same member in the same fight; a reconnect to a vanished match reports it; Menu while
  reconnecting (or before the first welcome) releases the kept seat; a silent link is dropped after three
  ping periods; an unreachable server reports `reconnecting` before any welcome.

### 19.4 WebSocket smoke test (`ws.test.js`)

`startServer({ port: 0 })`, then with plain `ws` clients:

1. A: `hello` -> `welcome` with a token and `content` equal to `CONTENT_HASH`.
2. A: `create vsAi { ai: 'drifter', seed: 1 }` -> `joined` (`you.ship === 's1'`), then at least two
   snaps with increasing ticks; the view has `s1` and `s2`, `s2` systems lack `want`, view lacks `rng`.
3. A: `cmd setTarget` on its Ember device at `s2` room `S` -> `ack ok`. `cmd setPower { system: 'nope' }`
   -> `ack ok:false why:'no-system'`.
4. B: `hello`, `join { code }` -> `joined` on `s1` (co-op crew). C: `join { code, spectate: true }`, then
   `cmd` -> `ack ok:false why:'spectator'`.
5. A closes; a new socket sends `hello { token }` -> `welcome`, then `joined` and a snap.
6. Malformed JSON -> `error bad-message`, and the socket stays open (a following `ping` gets `pong`).
   A frame over `maxPayload` closes only that socket (1009); the server keeps serving other clients.
7. `GET /`, `/client/main.js`, `/shared/sim/index.js` return 200 with the right MIME; `/../package.json`
   and `/server/main.js` return 404.

### 19.5 Headless Chrome (`test/e2e/browser.test.js`)

`test/helpers/cdp.js` (about 100 lines, using the `ws` dependency, no Puppeteer):

- Find Chrome (`CHROME` env, else `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, else
  skip the test with a message). Launch with `--headless=new --remote-debugging-port=0
  --user-data-dir=<tmp> --no-first-run --no-default-browser-check`; read the port from
  `<user-data-dir>/DevToolsActivePort`; open a page with `PUT /json/new` (recent Chrome requires PUT);
  connect to its `webSocketDebuggerUrl`; expose `send(method, params)` and event waiting.

Scenarios (server from `startServer({ port: 0 })`):

1. **Desktop watch:** 1440 x 900, open `/?watch=ai&seed=7&debug`; wait until `__ftl.phase === 'running'`,
   then 4 s; save `test/artifacts/desktop-watch.png`.
2. **Phone play:** `Emulation.setDeviceMetricsOverride` 390 x 844, `deviceScaleFactor` 3, `mobile` true,
   plus `Emulation.setTouchEmulationEnabled`; open `/?play=ai&ai=drifter&seed=3&debug`; wait for running;
   tap `tapPoint('weapon', 0)` then `tapPoint('room', 's2', 'S')` with `Input.dispatchTouchEvent`
   (touchStart then touchEnd); wait until `__ftl.lastAck.ok === true`; wait 2 s; save
   `test/artifacts/phone-play.png`.
3. **Co-op:** a phone player lowers engines and raises shields with the HUD steppers and sends a crew
   member to engines with chip-then-room taps (each ack ok, each change seen in a later snapshot); a
   second tab joins the code as crew and its order shows on the first; a third spectates (read-only HUD);
   a reload of the first tab resumes the same member. Screenshots `coop-*.png`.
4. **Phone landscape:** 844 x 390, same page; save `test/artifacts/phone-landscape.png`.
   Then layout checks: every HUD button is on screen from 568 x 320 to 1080 x 810 in landscape, in
   portrait and on a tablet, with two and three weapons; a tap on a drawn pip asks for that pip's level;
   the canvas follows a pixel-ratio change; the waiting and outcome panels keep their buttons on screen at
   844 x 390, 667 x 375 and 320 x 568; an unreachable server shows its banner.
5. Every scenario fails on `Runtime.exceptionThrown`, console errors, or `__ftl.errors.length > 0`, and
   asserts the canvas is not blank (sample `getImageData`: more than 1000 pixels differ from the
   background).

The lead should open the PNGs and look at them; that visual check is part of done.

### 19.6 Balance tool

`node tools/duel.js candlewick lampblack --ai captain --games 200 [--seed 1] [--threads N]` runs `Match`
directly (`createFromSpec`, ticking in a loop) and prints win rates, average duration (and its range) and
average remaining hull. One game takes about 0.55 s on one core, so the tool splits the seed range over
worker threads (every core by default; results are identical to one thread): 200 games take about 11 s on
12 cores. `runDuel` also accepts injected `content` for tuning experiments. Target for M1: neither side
above 70 percent at equal difficulty, measured captain vs captain (the default foe); 8.6 records the
other difficulties, which differ in skill (volley sync) more than the ships do.

## 20. Build plan

### 20.1 Work packages (parallel after the interface freeze)

The freeze is this document plus `shared/sim/types.js`, written first by the lead (an hour of work).

| Package | Files | Depends on (signatures only) |
|---|---|---|
| A. Sim foundations | `time, rng, geometry, world, hash, index` | types |
| B. Power and stats | `power, stats, pools, statuses, derive` | A |
| C. Combat and devices | `effects, combat, devices` | A, B |
| D. Crew, commands, step, view | `crew, commands, step, view` | A, B, C |
| E. Content | `content/*` including `validate.js` | sim registries' names (EFFECT_ORDER, DELIVERIES, STATUSES) |
| F. AI | `ai/*` | B, C, D (view-safe helpers) |
| G. Host and net | `net/*, host/*` | D, F (`aiOccupant` signature) |
| H. Server | `server/*` | G |
| I. Client logic | `game-client, ui-state, scene, net` | D (checks), G (protocol) |
| J. Client presentation | `index.html, style.css, main, render, fx, hud, input, menu, theme` | I |
| K. Tests and tools | `test/*`, `tools/duel.js` | everything, written against the spec in parallel |

Each package writes its own unit tests from section 19.

### 20.2 Order of integration

1. A to D plus E: `determinism.test.js` passes with scripted commands.
2. F, then G with `manualClock`: `duel.test.js` passes before any UI exists.
3. H: `ws.test.js` passes.
4. I then J: playable in the browser at `npm start` -> `http://localhost:8080`.
5. `browser.test.js` and screenshots; then tune content with `tools/duel.js`.

### 20.3 Definition of done for M1

- `npm install && npm start`, open the page: menu -> Fight the AI -> both ships render, power can be
  rerouted, weapons charge and fire on tap-tap, shields pop, hits damage systems and crew, crew walk and
  repair, the AI fights back, the fight ends in Victory or Defeat, Rematch works.
- A second browser can join the same code as co-op crew or as a spectator; `?pvp=new` plus a joined
  friend gives a working duel; reloading the page reconnects into the same fight.
- `npm test` and `npm run test:e2e` pass; the screenshots look right on desktop and phone.
- `CLAUDE.md` has the section 1 rules.

### 20.4 Cut order if time runs short (cut from the top, nothing below depends on it)

1. `?local` offline mode. 2. Drag on pip stacks (keep `[+]` and `[-]`). 3. Keyboard shortcuts, vibration,
audio. 4. Lobby list UI (the protocol message stays). 5. Crew walking animation (crew teleport to the
destination cell at the end of the path; the walk meter remains in state). 6. `pvp` preset UI (the
preset stays; reachable by URL).

## 21. Growth path and scope

### 21.1 How later features land

| Feature | What changes | What does not |
|---|---|---|
| PvP 1v1 | already in M1 (`pvp` preset) | |
| Co-op crews | M1: several humans per ship. Later: a `grant` match action (a later joiner gets `[]` until crew grant it) and fine-grained scopes (`weapons:w1`, `crew:c3`) | protocol, sim |
| FFA, fleets, 2v2 | more spec ships and sides; scene stacks N ships per bay; AI picks a foe | sim (no two-ship assumptions) |
| Spectators, delayed spectating | M1 has spectators; delay is a per-perspective buffer in `Match.broadcast` | sim |
| Autopilot on disconnect | Match attaches an `aiOccupant` to an offline human member after a grace period | sim, AI |
| Fog of war, sensors | a `sensors` system plus rules in `project` and `projectEvent` | everything else |
| Doors, oxygen, fire, breach | `ship.rooms` state; room statuses (`fire`, `breach`) in STATUSES; an `atmosphere` phase; `fire`/`breach` effects; doors system and `setDoor` command | hit pipeline, commands registry |
| Medbay | one system entry plus a `tick` hook in a new SYSTEM_HOOKS registry and a `heal` effect | |
| Beams, flak, drones, cloak, teleport, hacking | DELIVERIES entries, device kinds, statuses, `activate` command | devices, hit pipeline |
| Crew skills, species, augments | more merge calls in `computeStats`; crew fields | every stats consumer |
| Sectors, events, stores | a campaign layer above combat; a ship is plain data carried between combat worlds (transient fields reset) | combat sim |
| Replays | `Match.log` plus spec and seed already reproduce a match; add a viewer | |
| Bandwidth | a structural JSON diff in Session (arrays by `id`) | sim, client rendering |
| Scale | each match in a `worker_thread` behind a MessagePort Link | Match, sim |
| Phone app | Capacitor wrapping `client/` with `?server=`; or a PWA manifest and service worker; optional esbuild bundle of the same sources | architecture |

### 21.2 Deliberately out of M1

Oxygen, fire, breach, doors control, medbay, sensors and fog beyond the intent redaction, beams, drones,
cloak, teleport and boarding, crew combat and skills, augments, FTL jump, sectors, events, stores,
scrap; delta snapshots, client prediction, binary encoding; accounts and persistence (tokens live in
memory and die with the server); matchmaking and ratings; PWA, service worker, Capacitor; chat.

## 22. Risks and decisions to watch

1. **Power semantics.** `want` persists through damage and ion and restores only from free bars; a
   player who rerouted the freed bars keeps them. This matches the original's feel; confirm in play.
2. **Rendering without a buffer.** Meters are extrapolated from the latest snapshot for at most 250 ms.
   On a jittery phone connection, meters may tick back slightly when a late snapshot arrives. The fix
   (render one snapshot behind) is local to `main.js`.
3. **AI cost.** Each think clones a ship about a hundred times (hit gains per blueprint and room, the
   power greedy, crew tasks; `threatOf` is memoized per foe). A captain-vs-captain game of about 2300
   ticks costs about 0.55 s of one core, so a think is a few milliseconds; at think intervals of 6 to 30
   ticks this is negligible, but measure it in `duel.js`.
4. **Registry creep.** Registries are plain objects; no classes, no ECS, no plugin loader. A new
   registry needs a second real entry. M1 registries: COMMANDS, EFFECTS, STATUSES (one entry with
   fire and breach imminent), DELIVERIES (one entry, beam imminent), FX, PRESETS, MESSAGES. The helm's
   evasion rule turned out to be data (`unmanned` tables), so SYSTEM_HOOKS has no M1 entry; it returns
   with medbay's `tick` hook.
5. **Stale-by-one-tick derived data** (damage reaching power, manning reaching stats) is deliberate.
6. **Real time in PvP** with no pause is a design question, not an architecture one; pause policy is
   already per preset.
7. **Static serving of `shared/`** exposes the sim and AI source. That is fine (no secrets live in
   `shared/`), but never put server secrets there.
8. **Floating-point in the AI** is deterministic on one engine; AI-vs-AI hashes are reproducible on the
   same Node version, which is all the tests require. Replays never depend on it, because AI commands
   are logged.
9. **Seating has no consent step yet.** Every crew member gets `['*']` and any holder of a code can take a
   free seat or spectate. `list()` no longer publishes codes of matches with human seats, so a code is an
   invitation, but in `pvp` whoever holds it (the opponent included, with a second identity) can still
   take a seat on the other ship until the `grant` action lands (21.1).
10. **Many-connection floods.** Rate limits are per session; one identity holds at most one live match,
   but many connections can still each create one (an `aiVsAi` lingers for its 2 minute idle TTL). A
   per-address cap at the server boundary (the remote address passed into `lobby.connect`) is the next
   layer.

---

## Appendix A: scoring of the three proposals

Weights: elegance and generality x3, fit for multiplayer growth x2, fit for milestone 1 buildability x2,
mobile and browser fit x1. Scores out of 10; weighted total out of 80.

| Proposal | Elegance (x3) | Multiplayer (x2) | M1 build (x2) | Mobile (x1) | Total |
|---|---|---|---|---|---|
| Simulation-first | 9 | 7 | 7 | 6 | **61** |
| Multiplayer-first | 7 | 10 | 5 | 9 | **60** |
| Minimalist | 8 | 6 | 8 | 7 | **59** |

**Simulation-first (61, backbone).** The strongest set of general mechanisms: integer meters, ordered
phases, a single stats fold, pools, devices with a parameterized hit pipeline, effect and status
registries, view-shaped-like-world. Its file split parallelizes well. Weaknesses: the networking,
lobby and lifecycle were thin, and the client and mobile story was a paragraph. Kept almost whole as the
sim; replaced its interpolation buffer and `vsShield` enum with grafts below.

**Multiplayer-first (60).** Best on growth: the Link abstraction, perspectives with one shared string per
key, scopes and grants, MatchSpec presets, acks with ticks, reconnect, manual clock, and a CDP test using
the existing `ws` dependency; also the most careful mobile thinking (safe areas, hit regions, pure UI
reducer, server URL as config). Weaknesses: bots-as-network-clients over async memory links adds
machinery and makes determinism depend on microtask scheduling; float ramps and a two-timeline mirror
are more than M1 needs. Grafted nearly all of the host, protocol, client logic split and test harness;
kept the bot fairness property by feeding AI occupants the identical snapshot string, synchronously.

**Minimalist (59).** The smallest concept set and the most buildable plan, with three ideas that made the
final design better: ASCII ship maps, derived manning (no station cells), the `pierce` rule that unifies
"blocked" and "ignores shields", and an AI that values stats through counterfactuals instead of naming
systems; plus the "power is light" visual identity. Weaknesses: floats in sim time, code hooks inside
content (content could not be hashed or shipped as data), a single large `sim.js` that defeats parallel
work, and a two-message protocol without versioning, permissions or content checks.
