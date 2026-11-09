// @ts-check
// All content as one deep-frozen, JSON-compatible tree (design doc 8.1). CONTENT_HASH lets a stale client
// detect a mismatch. Importing sim/hash.js and sim/geometry.js (deepFreeze) are allowed content -> sim
// imports: both are pure, and the sim never imports content.

import base from './base.js';
import systems, { systemOrder } from './systems.js';
import statuses from './statuses.js';
import devices from './devices.js';
import ships from './ships.js';
import ai from './ai-profiles.js';
import { fnv1a } from '../sim/hash.js';
import { deepFreeze } from '../sim/geometry.js';

/** @type {import('../sim/types.js').Content} */
export const CONTENT = deepFreeze({ base, systems, systemOrder, statuses, devices, ships, ai });
export const CONTENT_HASH = fnv1a(JSON.stringify(CONTENT));
