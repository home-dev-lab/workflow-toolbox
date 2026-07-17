// validator-shared.ts — the tiny helpers BOTH launch-args validators
// (capabilities.ts, observer-def.ts) build on. Single definition site (bundle
// review lock F4): the proto-collision defence Set and the record guard may
// never drift apart between the two contracts.

/** Entry/key names that collide with Object.prototype machinery. Our own code only
 *  ever Object.entries()/spreads validated maps (pollution-safe), but composed
 *  fragments are handed onward to code whose internal merging we cannot audit —
 *  reject them outright (defence-in-depth; no legitimate entry is named
 *  `__proto__`). */
export const FORBIDDEN_ENTRY_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
