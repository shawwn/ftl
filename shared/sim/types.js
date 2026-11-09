// @ts-check
// JSDoc typedefs for the simulation (design doc 7.1) and its content (section 8). No runtime code.
// Doc choice: argument bags on Command and SimEvent are typed `any` (doc: unknown) so consumers can read
// fields without casts; validation lives in COMMANDS[type].check, not in the type.

/** @typedef {{ v: number, max: number, rate: number }} Meter */

/**
 * @typedef {object} World
 * @property {1} v                     state schema version
 * @property {number} seed             u32 used to create rng (hidden from players)
 * @property {number} tick             completed ticks
 * @property {number} rng              mulberry32 state, u32 (hidden from players)
 * @property {number} nextId
 * @property {Record<string, Ship>} ships   insertion order = spawn order
 * @property {Shot[]} shots
 * @property {null | { winner: string | null, tick: number }} outcome   winner is a side, null for a draw
 */

/**
 * @typedef {object} Ship
 * @property {string} id
 * @property {string} bp
 * @property {string} name
 * @property {string} side
 * @property {null | 'hull' | 'crew'} out   set once in cleanup; an out ship is a wreck
 * @property {number} reactor
 * @property {Record<string, number>} stores        consumables: missiles now
 * @property {Record<string, Pool>} pools           M1: hull, shield
 * @property {Record<string, SystemState>} systems  keyed by system type, in content.systemOrder
 * @property {Device[]} devices                     slot order matters (power shedding)
 * @property {Crew[]} crew
 * @property {Stats} stats                          DERIVED every derive; never authoritative
 */

/** @typedef {{ v: number, max: number, regen?: Meter }} Pool */

/**
 * @typedef {object} SystemState
 * @property {number} level              installed bars
 * @property {number} [want]             intent; only on reactor-drawing, non-host systems; redacted for enemies
 * @property {number} power              actual, written only by settlePower
 * @property {number} damage             damaged bars, 0..level
 * @property {Meter} repair              progress toward repairing one bar
 * @property {Record<string, Status>} status
 */

/** @typedef {{ n: number, timer: Meter }} Status   stacking timed status (ion) */

/** @typedef {{ status: Record<string, Status> }} StatusHolder   systems now; rooms, crew, ships later */

/**
 * @typedef {object} Device
 * @property {string} id
 * @property {string} bp
 * @property {string} host               system type that powers it
 * @property {boolean} [on]              intent; redacted for enemies
 * @property {boolean} powered           actual, written only by settlePower
 * @property {Meter} charge
 * @property {Target | null} [target]    redacted for enemies
 * @property {boolean} [auto]            keep target after firing; redacted for enemies
 */

/** @typedef {{ ship: string, room: string }} Target */

/** @typedef {'walk' | 'repair' | 'man' | 'idle'} Task */

/**
 * @typedef {object} Crew
 * @property {string} id
 * @property {string} name
 * @property {[number, number]} cell         current cell (ship grid coordinates)
 * @property {[number, number][]} path       remaining cells; path[0] is the cell being stepped into
 * @property {Meter} walk                    progress of the current step
 * @property {number} hp
 * @property {number} maxHp
 * @property {Task} task                     DERIVED
 */

/** @typedef {{ id: string, bp: string, from: { ship: string, device: string }, to: Target, flight: Meter }} Shot */

/** @typedef {Record<string, number>} Stats   M1 keys: evasion, shieldLayers, shieldRegenPct, chargePct, repairPct, walkPct, hullMax */

/** @typedef {{ type: string, ship: string } & Record<string, any>} Command   ship stamped by host */
/** @typedef {{ type: string, tick: number } & Record<string, any>} SimEvent */
/** @typedef {{ kind: 'side', side: string } | { kind: 'all' }} Perspective */
/** @typedef {World} View   same shape minus seed and rng, with redacted fields absent */
/** @typedef {(e: object) => void} Emit */
/** @typedef {{ content: Content, emit: Emit }} Ctx */

/**
 * @typedef {object} CommandDef
 * @property {string} scope
 * @property {Record<string, ArgShape>} args   argument shapes; the protocol rebuilds a client's command from them
 * @property {(world: World | View, ship: Ship, cmd: Command, content: Content) => string | null} check   pure
 * @property {(world: World, ship: Ship, cmd: Command, ctx: Ctx) => string | null} apply             mutates
 */

/**
 * A command argument's shape, in the protocol's field vocabulary: a type name ('str' | 'int' | 'bool'),
 * [shape] for an array of that shape, or { field: shape } for an object of exactly those fields (or null).
 * The elements are shapes again (JSDoc typedefs cannot name themselves).
 * @typedef {string | unknown[] | Record<string, unknown>} ArgShape
 */

/** @typedef {{ id: string, x: number, y: number, w: number, h: number, system: string | null }} Room */
/** @typedef {{ id: string, a: string, b: string, x: number, y: number, dir: 'v' | 'h' }} Door */

/**
 * @typedef {object} Geometry
 * dir 'v': the wall segment between (x,y) and (x+1,y). dir 'h': between (x,y) and (x,y+1).
 * @property {number} w
 * @property {number} h
 * @property {Record<string, Room>} rooms
 * @property {string[]} roomIds                  first appearance, row-major
 * @property {Record<string, string>} cellRoom   "x,y" -> room id
 * @property {Door[]} doors
 * @property {Record<string, string[]>} edges    "x,y" -> walkable neighbor keys (right, down, left, up)
 */

// ---- Content (section 8) ----

/** @typedef {{ add?: Record<string, number>, mul?: Record<string, number> }} Mods   one stat modifier bundle */
/** @typedef {{ add?: Record<string, number[]>, mul?: Record<string, number[]> }} PowerTables   indexed by power */
/** @typedef {{ max: string, regenMs?: number, ratePct?: string }} PoolDef */

/**
 * @typedef {object} BaseContent
 * @property {Stats} stats
 * @property {Record<string, PoolDef>} pools
 * @property {string[]} poolOrder
 * @property {number} repairMs
 * @property {number} walkMs
 * @property {number} drainPct
 * @property {number} crewHp
 */

/**
 * @typedef {object} SystemDef
 * @property {string} label
 * @property {number} maxLevel
 * @property {boolean} reactor          false marks a subsystem (power = capacity, no reactor draw)
 * @property {boolean} mannable
 * @property {string} [hosts]           device kind this system powers
 * @property {PowerTables} [byPower]
 * @property {Mods} [manned]            applies when manned and power > 0
 * @property {PowerTables} [unmanned]   applies when not manned (indexed by power)
 */

/** @typedef {Record<string, number>} Payload   effect name (EFFECT_ORDER) -> amount */

/**
 * @typedef {object} DeviceBp
 * @property {string} kind
 * @property {string} name
 * @property {string} [blurb]
 * @property {number} power
 * @property {number} chargeMs
 * @property {'enemyRoom'} target
 * @property {Record<string, number>} cost
 * @property {string} delivery         name in DELIVERIES
 * @property {number} shots
 * @property {number} gapMs
 * @property {number} travelMs
 * @property {number} accuracy
 * @property {number} pierce
 * @property {boolean} canMiss
 * @property {Payload} onBlock
 * @property {Payload} onHit
 * @property {string} [look]
 */

/**
 * @typedef {object} ShipBp
 * @property {string} name
 * @property {string} [blurb]
 * @property {string[]} map
 * @property {Record<string, string>} legend          room character -> system type
 * @property {(string | string[])[]} [doors]           explicit [a, b] room pairs ('WE' works too)
 * @property {Stats} [stats]                           overrides base.stats
 * @property {number} reactor
 * @property {Record<string, { level: number, power?: number }>} systems
 * @property {{ bp: string, on?: boolean }[]} devices
 * @property {Record<string, number>} stores
 * @property {{ name: string, room: string }[]} crew
 */

/**
 * @typedef {object} AiProfile
 * @property {string} label
 * @property {string} persona
 * @property {boolean} passive
 * @property {number} thinkEveryTicks
 * @property {number} reactionTicks
 * @property {number} temperature
 * @property {number} patienceMs
 * @property {boolean} crew
 * @property {{ offense: number, defense: number }} weights
 */

/**
 * @typedef {object} Content
 * @property {BaseContent} base
 * @property {Record<string, SystemDef>} systems
 * @property {string[]} systemOrder
 * @property {Record<string, { decayMs: number }>} statuses
 * @property {Record<string, DeviceBp>} devices
 * @property {Record<string, ShipBp>} ships
 * @property {Record<string, AiProfile>} ai
 */

export {};
