# Faster than Lumos (FTL)

A multiplayer-focused, browser-based game with mechanics in the spirit of real-time ship-to-ship combat
games like *Faster Than Light* (2012). Browser first, but kept amenable to becoming a phone app.

## Guiding principle

**Elegance beats dogged determination.** Implement the most general way to do things rather than
rushing to get everything done. Prefer a small number of powerful, general concepts over many
special cases. When a feature seems to need a bespoke code path, first ask what general mechanism
it is an instance of, and build that instead. It is fine for a milestone to ship less if what it
ships is the right shape.

Practical consequences:

- New content (ships, weapons, systems) should be data or a small plugin, not edits to core loops.
- There is one command vocabulary: humans and AI drive ships with exactly the same commands.
- The server is authoritative; clients send intents, never state.
- Shared simulation code runs unchanged on the server, in tests, and in the browser.
- Keep dependencies and tooling minimal; no build step for the client unless it clearly earns its keep.

## Originality

Mechanics may resemble FTL, but every name, ship, weapon, line of text, piece of art and the visual
style must be our own. Do not reuse FTL ship names, races, weapon names, or its UI look.

## Mobile

Touch first: pointer events, no hover-only interactions, layouts that work in phone portrait.

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
