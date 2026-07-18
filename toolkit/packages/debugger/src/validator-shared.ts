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

/** True iff `v` is an array of strings. Shared by every launch-args validator
 *  (capabilities.ts, capability-registry.ts, observer-def.ts) — single definition
 *  site so the string-array guard cannot drift apart between the contracts. */
export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/** Keys any of which make an mcpServers entry launchable/connectable — the SDK
 *  validates the full config shape; we reject the obviously-degenerate AND
 *  wrong-typed anchor values before they ride to the server and die far from
 *  the operator. */
export const MCP_ANCHOR_KEYS = ['command', 'url', 'type'] as const

/** Validate an mcpServers map (server-name → server config) the same way BOTH
 *  the launch-args contract and the capability registry require: entry names are
 *  proto-collision-safe, each config is an object carrying at least one
 *  launch/connect anchor, and any present anchor is a string. Every problem is
 *  pushed into `errors` in one pass. (Single definition site: every consumer —
 *  capabilities.ts (launch-args contract) and capability-registry.ts (machine
 *  registry) — calls THIS, so the two contracts' mcpServers validation can never
 *  drift apart.) */
export function validateMcpServersShape(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path} must be an object map of server-name → server config`)
    return
  }
  for (const name of Object.keys(v)) {
    if (FORBIDDEN_ENTRY_NAMES.has(name)) {
      errors.push(`${path}.${name} is a forbidden entry name (prototype-collision defence)`)
      continue
    }
    const cfg = v[name]
    if (!isRecord(cfg)) {
      errors.push(`${path}.${name} must be an object (server config)`)
      continue
    }
    if (!MCP_ANCHOR_KEYS.some((k) => k in cfg)) {
      errors.push(`${path}.${name} lacks any of ${MCP_ANCHOR_KEYS.join('/')} — not a launchable server config`)
    }
    for (const k of MCP_ANCHOR_KEYS) {
      if (k in cfg && typeof cfg[k] !== 'string') errors.push(`${path}.${name}.${k} must be a string`)
    }
  }
}
