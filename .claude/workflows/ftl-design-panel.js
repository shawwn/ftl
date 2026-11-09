export const meta = {
  name: 'ftl-design-panel',
  description: 'Three independent architecture proposals for Faster than Lumos, then a judge synthesizes one design doc',
  phases: [
    { title: 'Propose', detail: '3 architects, different angles' },
    { title: 'Synthesize', detail: 'judge scores and writes docs/design.md' },
  ],
}

const BRIEF = `
PROJECT: "Faster than Lumos" (FTL), an ORIGINAL browser game whose mechanics are very similar to the 2012 game
"Faster Than Light" (real-time ship-to-ship combat: rooms on a grid, reactor power allocated to systems
like shields/engines/weapons/piloting/oxygen/medbay/doors, weapons with charge times that target enemy rooms,
projectiles vs shield layers, evasion, hull, system damage, crew who walk between rooms, man stations and repair).
Unlike the original, ours is MULTIPLAYER-FOCUSED. Browser-based, but should be amenable to becoming a phone app
(touch-first input, responsive layout, no hover-only interactions, could later be wrapped with Capacitor/PWA).
Server hosting is no problem.

IMPORTANT ORIGINALITY RULE: mechanics may resemble FTL, but all names, ships, weapons, text, art and visual style
must be our own. Do not reuse FTL ship names (e.g. Kestrel), races, weapon names (e.g. "Burst Laser II", "Artemis"),
or its UI look. Generic terms (shields, engines, laser, missile, hull, reactor) are fine.

THE USER'S GUIDING PRINCIPLE: "Focus on implementing the most general way to do things, rather than getting everything
done instantly. Elegance beats dogged determination." Design for a small number of powerful, general concepts.

FIRST MILESTONE (what will be built right after this design):
  1. a server (Node.js 23 is available; npm works; the 'ws' package is fine; keep deps minimal),
  2. a client: an HTML page that connects to the server via WebSocket and renders/controls a ship,
  3. an AI opponent the user can fight.
The fight may be extremely basic (two ships, a gun that one-shots), but richer FTL-like combat is welcome if the
architecture makes it natural. The architecture must make later growth (PvP, co-op crews where several players share
one ship, more systems, crew, events/sectors/map, spectators, reconnect) natural rather than a rewrite.

ENVIRONMENT: macOS, Node v23.6, npm, Google Chrome installed (usable headless for automated client tests).
Project dir /Users/shawn/ml/ftl is currently EMPTY (greenfield). No git repo yet.
Zero-build client is preferred (native ES modules in the browser) so shared simulation code can be imported by
both the server and the browser without a bundler. Plain JS with JSDoc types, or argue for something else.

Do NOT write any files. Return your proposal as markdown text.
`

const ANGLES = [
  {
    key: 'simulation',
    prompt: `You are a game-simulation architect. ANGLE: simulation-first and data-driven.
Design the core simulation so that FTL-like mechanics emerge from a few general mechanisms:
- the world/state shape (ships, rooms, doors, systems, weapons, crew, projectiles) as plain serializable data;
- a fixed-timestep deterministic tick (seeded RNG) so the same code can run on server, in tests, and headless AI-vs-AI;
- systems as instances of a generic "system" concept (power, capacity/level, damage, manning bonus) with per-type behavior
  plugged in via a small registry, rather than bespoke code paths;
- weapons/projectiles/damage resolution as a general pipeline (fire -> travel -> evasion roll -> shield interaction -> effects
  on room/system/hull/crew) where weapon types are data (laser vs missile vs ion vs beam differ by parameters/effects);
- player intents as a single "command" vocabulary validated and applied by the sim (set power, target, move crew, toggle door...);
- content (ship blueprints, weapon blueprints) as JSON-like data with original names.
Give concrete module/file layout, the key function signatures, the state shape (with an example), the command list,
and how the tick update is ordered. Explain what makes it general and what you deliberately leave out of milestone 1.`,
  },
  {
    key: 'multiplayer',
    prompt: `You are a multiplayer/netcode architect. ANGLE: multiplayer-first.
Design the server, protocol, and client architecture:
- authoritative server running the match simulation at a fixed tick; clients send intents (commands), never state;
- a single "Controller" abstraction so a human over WebSocket and an in-process AI are interchangeable (the AI should
  issue exactly the same commands a human would, ideally seeing only what a human could see);
- matches/lobby: create/join match, N ships per match, M players per ship (co-op crews), spectators, fight-the-AI flow,
  reconnect with a token; permission model for which player may command which ship;
- message protocol (JSON is fine; justify snapshot vs delta, rates), client-side interpolation for smooth rendering;
- client architecture: zero-build ES modules, canvas rendering, touch-first input (pointer events), responsive layout for phones;
- how the same shared sim modules are served to the browser;
- testing strategy: unit tests (node --test), headless AI-vs-AI matches, a WebSocket smoke test, and a headless Chrome screenshot test.
Give concrete file layout, the protocol message list with examples, and the key interfaces. Explain what makes it general
and what you deliberately leave out of milestone 1.`,
  },
  {
    key: 'minimalist',
    prompt: `You are a minimalist software designer with taste. ANGLE: the fewest concepts that generalize.
Propose the smallest, most elegant architecture for the whole thing (shared sim, server, client, AI) where adding a new
system, weapon, ship, or game mode is adding DATA or a small plugin, not editing core loops. Ruthlessly cut accidental
complexity: argue which abstractions earn their keep (e.g. one command vocabulary, one controller interface, one state tree,
one tick function, one renderer that draws from state) and which are premature (e.g. ECS frameworks, delta compression,
client prediction, build tooling, TypeScript?). Make a clear call on each. Also propose the AI opponent design
(e.g. a utility-scored policy over the same command vocabulary, so it is general across ships and loadouts).
Give the concrete file tree (aim for few files), each file's responsibility in one line, key signatures, and a short
"what milestone 1 includes" list that would make a genuinely fun first fight.`,
  },
]

phase('Propose')
const proposals = await parallel(ANGLES.map(a => () =>
  agent(BRIEF + '\n\n' + a.prompt, { label: `propose:${a.key}`, phase: 'Propose' })
    .then(text => ({ key: a.key, text }))))

const got = proposals.filter(p => p && p.text)
log(`${got.length}/3 proposals received`)

phase('Synthesize')
const synthesis = await agent(BRIEF.replace('Do NOT write any files. Return your proposal as markdown text.', '') + `

You are the lead architect and judge. Below are ${got.length} independent proposals from architects with different angles.
1. Score each on: elegance/generality (weight 3), fit for multiplayer growth (2), fit for milestone 1 buildability (2),
   mobile/browser fit (1). Briefly justify scores.
2. Synthesize ONE final design, taking the best proposal as the backbone and grafting the strongest ideas from the others.
   Resolve every disagreement with a decisive call. The final design must be concrete enough that several engineers could
   implement different files in parallel without talking to each other: exact file tree, every module's exports with
   signatures, the full state shape with an example, the full command vocabulary with validation rules, the protocol
   message list with JSON examples, the tick ordering, the content schema with the milestone-1 content (two original ships
   with original names, a few original weapons), the AI policy, the client screen layout (desktop and phone portrait),
   and the test plan (unit, headless AI-vs-AI, websocket smoke test, headless Chrome screenshot).
   Prefer plain JS ES modules + JSDoc, zero-build client, 'ws' as the only runtime dependency unless strongly justified.
3. WRITE the final design to /Users/shawn/ml/ftl/docs/design.md (create the docs dir). This is the only file you may write.
   Put the scoring in a short appendix at the end. Never use em-dashes or en-dashes in the doc.
Return a short summary (under 300 words) of the key decisions and anything you think the lead should double check.

${got.map(p => `\n\n===== PROPOSAL: ${p.key} =====\n${p.text}`).join('')}
`, { label: 'synthesize', phase: 'Synthesize' })

return { synthesis, proposalKeys: got.map(p => p.key) }
