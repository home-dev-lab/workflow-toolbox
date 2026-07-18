// observer-def.test.ts — the args `observers` section contract (observers-custom
// design: authoring/launch is the FAIL-LOUD regime). extractObservers mirrors
// extractCapabilities' posture: absent/null section = absent; every violation
// collected in ONE pass; entries null when anything is wrong (all-or-nothing);
// unknown keys and prototype-collision names are errors, never silent no-ops.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { extractObservers, OBSERVER_EMITTABLE_TYPES, CADENCE_FLOOR_MS } from '../src/observer-def.js'
import { WT_COMM_SCHEMAS } from '@workflow-toolbox/comm'

/** The design's reference example (docs-butler, §7) — must validate as-is. */
function docsButler(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'docs-butler',
    description: 'Watches long-running implementer agents and proactively supplies sourced documentation context.',
    watch: { roles: ['implementer', 'fixer'] },
    cadenceMs: 300000,
    brain: {
      mandate:
        'You watch a coding agent transcript delta. When external documentation would materially help, retrieve the minimal excerpt and emit one observer.hint with full provenance. Hints inform; they never instruct.',
      model: 'claude-haiku-4-5',
    },
    emits: ['observer.hint'],
    actions: ['summary', 'nudge', 'wt-comm'],
    requires: [{ need: 'docs-lookup' }, { need: 'code-intelligence', optional: true }],
  }
}

function minimal(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'stall-watch',
    description: 'Reports stalls.',
    watch: { phases: ['implement'] },
    brain: { mandate: 'Summarize meaningful state changes in the observed delta.' },
  }
}

function argsWith(def: Record<string, unknown>): Record<string, unknown> {
  return { observers: [{ definition: def }] }
}

function errorsFor(def: Record<string, unknown>): string[] {
  return extractObservers(argsWith(def)).errors
}

// The launcher-emitted `resolution` wire contract (card I3): observers entries may
// carry a resolved NeedResolution[] (produced by wt-observe launch, read by the
// companion server). extractObservers must ACCEPT + shape-validate it (loud-on-typos).
const RESOLVED = { need: 'docs-lookup', provider: 'context7', mcpServers: { context7: { command: 'ctx' } }, tools: ['mcp__context7__*'], protocolHint: 'use it' }
const UNRESOLVED = { need: 'web-search', unresolved: true, degradation: 'degraded:none', tools: [] }

describe('extractObservers — resolution wire contract (card I3)', () => {
  it('accepts an entry carrying a valid resolved+unresolved resolution', () => {
    const r = extractObservers({ observers: [{ definition: minimal(), resolution: [RESOLVED, UNRESOLVED] }] })
    expect(r.errors).toEqual([])
    expect(r.entries).not.toBeNull()
    expect((r.entries as Array<{ resolution?: unknown }>)[0]?.resolution).toEqual([RESOLVED, UNRESOLVED])
  })

  it('rejects a non-array resolution', () => {
    const r = extractObservers({ observers: [{ definition: minimal(), resolution: 'nope' }] })
    expect(r.errors.some((e) => e.includes('resolution') && e.includes('array'))).toBe(true)
  })

  it('rejects a resolution item missing need', () => {
    const r = extractObservers({ observers: [{ definition: minimal(), resolution: [{ provider: 'p', mcpServers: {}, tools: [] }] }] })
    expect(r.errors.some((e) => e.includes('.need'))).toBe(true)
  })

  it('rejects a resolution item that is neither resolved nor unresolved', () => {
    const r = extractObservers({ observers: [{ definition: minimal(), resolution: [{ need: 'x', tools: [] }] }] })
    expect(r.errors.some((e) => e.includes('provider') || e.includes('unresolved'))).toBe(true)
  })

  it('rejects an unknown key inside a resolution item (loud-on-typos)', () => {
    const r = extractObservers({ observers: [{ definition: minimal(), resolution: [{ ...RESOLVED, bogus: 1 }] }] })
    expect(r.errors.some((e) => e.includes('bogus'))).toBe(true)
  })

  it('still rejects an unknown TOP-LEVEL entry key (resolution did not widen the entry envelope)', () => {
    const r = extractObservers({ observers: [{ definition: minimal(), bogusKey: 1 }] })
    expect(r.errors.some((e) => e.includes('bogusKey'))).toBe(true)
  })
})

describe('extractObservers — section presence', () => {
  it('returns null entries (no errors) when args has no observers section', () => {
    expect(extractObservers({ target: 'x' })).toEqual({ entries: null, errors: [] })
  })

  it('returns null entries for non-object args (undefined, null, string)', () => {
    expect(extractObservers(undefined)).toEqual({ entries: null, errors: [] })
    expect(extractObservers(null)).toEqual({ entries: null, errors: [] })
    expect(extractObservers('{"a":1}')).toEqual({ entries: null, errors: [] })
  })

  it('treats observers: null as ABSENT (the JSON idiom for an omitted key — capabilities parity)', () => {
    expect(extractObservers({ observers: null })).toEqual({ entries: null, errors: [] })
  })

  it('rejects a non-array observers section', () => {
    const r = extractObservers({ observers: { definition: minimal() } })
    expect(r.entries).toBeNull()
    expect(r.errors).toHaveLength(1)
  })

  it('accepts an empty array (zero observers, valid)', () => {
    expect(extractObservers({ observers: [] })).toEqual({ entries: [], errors: [] })
  })

  it('rejects more than 16 entries', () => {
    const r = extractObservers({ observers: Array.from({ length: 17 }, () => ({ definitionFile: 'a.observer.json' })) })
    expect(r.entries).toBeNull()
    expect(r.errors.some((e) => e.includes('16'))).toBe(true)
  })
})

describe('extractObservers — entry shape (definition XOR definitionFile)', () => {
  it('accepts the docs-butler reference definition as-is and returns it', () => {
    const r = extractObservers(argsWith(docsButler()))
    expect(r.errors).toEqual([])
    expect(r.entries).toHaveLength(1)
    const entry = r.entries![0]!
    expect('definition' in entry && entry.definition.name).toBe('docs-butler')
  })

  it('accepts a minimal definition (defaults are the server side, not injected here)', () => {
    const r = extractObservers(argsWith(minimal()))
    expect(r.errors).toEqual([])
    const entry = r.entries![0]!
    if ('definition' in entry) {
      expect(entry.definition.emits).toBeUndefined()
      expect(entry.definition.actions).toBeUndefined()
    } else {
      throw new Error('expected inline definition')
    }
  })

  it('accepts a definitionFile entry with the composer artifact suffix', () => {
    const r = extractObservers({ observers: [{ definitionFile: 'docs-butler.observer.json' }] })
    expect(r.errors).toEqual([])
    expect(r.entries).toHaveLength(1)
  })

  it('rejects a non-object entry, an empty entry, both-keys, and unknown entry keys', () => {
    expect(extractObservers({ observers: ['x'] }).errors).toHaveLength(1)
    expect(extractObservers({ observers: [{}] }).errors).toHaveLength(1)
    expect(
      extractObservers({ observers: [{ definition: minimal(), definitionFile: 'a.observer.json' }] }).errors,
    ).toHaveLength(1)
    expect(extractObservers({ observers: [{ definitionFiel: 'a.observer.json' }] }).errors.some((e) => e.includes('definitionFiel'))).toBe(
      true,
    )
  })

  it('rejects absolute, traversal, wrong-suffix, and empty definitionFile paths', () => {
    for (const bad of ['/abs/docs-butler.observer.json', '../up.observer.json', 'a/../b.observer.json', 'plain.json', '']) {
      const r = extractObservers({ observers: [{ definitionFile: bad }] })
      expect(r.entries, `should reject ${JSON.stringify(bad)}`).toBeNull()
    }
  })

  it('rejects duplicate inline definition names across entries', () => {
    const r = extractObservers({ observers: [{ definition: minimal() }, { definition: minimal() }] })
    expect(r.entries).toBeNull()
    expect(r.errors.some((e) => e.includes('stall-watch'))).toBe(true)
  })
})

describe('validate — definition envelope', () => {
  it('collects ALL violations in one pass', () => {
    const bad = { ...minimal(), schemaVersion: 2, name: 'Bad Name', description: '' }
    expect(errorsFor(bad).length).toBeGreaterThanOrEqual(3)
  })

  it('schemaVersion must be the integer 1', () => {
    expect(errorsFor({ ...minimal(), schemaVersion: 2 }).some((e) => e.includes('schemaVersion'))).toBe(true)
    expect(errorsFor({ ...minimal(), schemaVersion: '1' }).some((e) => e.includes('schemaVersion'))).toBe(true)
    const noVersion = minimal()
    delete noVersion['schemaVersion']
    expect(errorsFor(noVersion).some((e) => e.includes('schemaVersion'))).toBe(true)
  })

  it('name must match ^[a-z0-9-]{1,64}$', () => {
    expect(errorsFor({ ...minimal(), name: 'Docs_Butler' })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), name: 'a'.repeat(65) })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), name: '' })).toHaveLength(1)
  })

  it('description must be 1-500 chars', () => {
    expect(errorsFor({ ...minimal(), description: '' })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), description: 'x'.repeat(501) })).toHaveLength(1)
  })

  it('unknown definition keys are typos (fail loud), including JSON-parsed __proto__', () => {
    expect(errorsFor({ ...minimal(), cadence: 60000 }).some((e) => e.includes('cadence'))).toBe(true)
    // A literal {__proto__: {}} would SET the prototype instead of creating a key —
    // build the hostile payload from raw JSON, where __proto__ becomes a REAL key.
    const raw = JSON.parse(
      '{"observers":[{"definition":{"schemaVersion":1,"name":"x","description":"d","watch":{"roles":["r"]},"brain":{"mandate":"Summarize meaningful state changes now."},"__proto__":{"polluted":true}}}]}',
    ) as Record<string, unknown>
    const r = extractObservers(raw)
    expect(r.entries).toBeNull()
    expect(r.errors.some((e) => e.includes('__proto__'))).toBe(true)
  })
})

describe('validate — watch', () => {
  it('watch is required and needs at least one NON-EMPTY selector', () => {
    const noWatch = minimal()
    delete noWatch['watch']
    expect(errorsFor(noWatch)).toHaveLength(1)
    expect(errorsFor({ ...minimal(), watch: {} })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), watch: { roles: [] } })).toHaveLength(1)
  })

  it('accepts roles alone, phases alone, or both', () => {
    expect(errorsFor({ ...minimal(), watch: { roles: ['implementer'] } })).toEqual([])
    expect(errorsFor({ ...minimal(), watch: { phases: ['implement'] } })).toEqual([])
    expect(errorsFor({ ...minimal(), watch: { roles: ['implementer'], phases: ['implement'] } })).toEqual([])
  })

  it('bounds selector arrays (1-16) and item grammar (^[A-Za-z0-9_-]{1,64}$)', () => {
    expect(errorsFor({ ...minimal(), watch: { roles: Array.from({ length: 17 }, (_, i) => `r${i}`) } })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), watch: { roles: ['bad role!'] } })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), watch: { roles: ['a'.repeat(65)] } })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), watch: { roles: [42] } })).toHaveLength(1)
  })

  it('names the v0 refusals: watch.run (no whole-run content watch) and watch.transcriptFile (machine path)', () => {
    const runErrors = errorsFor({ ...minimal(), watch: { roles: ['r'], run: true } })
    expect(runErrors.some((e) => e.includes('run') && !e.includes('unknown'))).toBe(true)
    const fileErrors = errorsFor({ ...minimal(), watch: { roles: ['r'], transcriptFile: '/tmp/x.jsonl' } })
    expect(fileErrors.some((e) => e.includes('transcriptFile') && e.toLowerCase().includes('machine'))).toBe(true)
  })
})

describe('validate — cadence and brain', () => {
  it('cadenceMs must be an integer >= 60000 (the server registration floor)', () => {
    expect(errorsFor({ ...minimal(), cadenceMs: 60000 })).toEqual([])
    expect(errorsFor({ ...minimal(), cadenceMs: 59999 }).some((e) => e.includes('60000'))).toBe(true)
    expect(errorsFor({ ...minimal(), cadenceMs: 60000.5 })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), cadenceMs: '60000' })).toHaveLength(1)
  })

  it('brain is required with a 20-4000 char mandate', () => {
    const noBrain = minimal()
    delete noBrain['brain']
    expect(errorsFor(noBrain)).toHaveLength(1)
    expect(errorsFor({ ...minimal(), brain: { mandate: 'too short' } })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), brain: { mandate: 'x'.repeat(4001) } })).toHaveLength(1)
  })

  it('brain rejects unknown keys, non-string model, and non-positive-integer timeoutMs', () => {
    const mandate = 'Summarize meaningful state changes in the observed delta.'
    expect(errorsFor({ ...minimal(), brain: { mandate, temperature: 0.5 } })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), brain: { mandate, model: 42 } })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), brain: { mandate, timeoutMs: 0 } })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), brain: { mandate, timeoutMs: 1.5 } })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), brain: { mandate, model: 'claude-haiku-4-5', timeoutMs: 120000 } })).toEqual([])
  })
})

describe('validate — emits, actions, coherence', () => {
  it('OBSERVER_EMITTABLE_TYPES drift-locks against the wt-comm schema map (locked copy, loud divergence)', () => {
    // The const is deliberately import-free (the launcher CLI bundles this module);
    // THIS test is the single-source tie: a type added to WT_COMM_SCHEMAS fails here
    // until OBSERVER_EMITTABLE_TYPES learns it, and vice versa.
    const expected = Object.keys(WT_COMM_SCHEMAS).filter((t) => t.startsWith('observer.'))
    expect([...OBSERVER_EMITTABLE_TYPES].sort()).toEqual(expected.sort())
    expect(OBSERVER_EMITTABLE_TYPES).toContain('observer.hint')
  })

  it('emits accepts observer.hint and refuses non-observer or unknown types and duplicates', () => {
    expect(errorsFor({ ...minimal(), emits: ['observer.hint'], actions: ['summary', 'wt-comm'] })).toEqual([])
    expect(errorsFor({ ...minimal(), emits: ['status.digest'], actions: ['wt-comm'] }).some((e) => e.includes('status.digest'))).toBe(true)
    expect(errorsFor({ ...minimal(), emits: ['observer.unknown'], actions: ['wt-comm'] })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), emits: ['observer.hint', 'observer.hint'], actions: ['wt-comm'] })).toHaveLength(1)
  })

  it("actions accepts summary/nudge/wt-comm, refuses duplicates, and NAMES 'pause' as reserved", () => {
    expect(errorsFor({ ...minimal(), actions: ['summary', 'nudge'] })).toEqual([])
    expect(errorsFor({ ...minimal(), actions: ['summary', 'summary'] })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), actions: ['bogus'] })).toHaveLength(1)
    const pauseErrors = errorsFor({ ...minimal(), actions: ['pause'] })
    expect(pauseErrors.some((e) => e.toLowerCase().includes('reserved'))).toBe(true)
  })

  it("coherence: 'wt-comm' in actions <=> emits non-empty (both directions)", () => {
    expect(errorsFor({ ...minimal(), actions: ['wt-comm'] })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), actions: ['wt-comm'], emits: [] })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), emits: ['observer.hint'] })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), emits: ['observer.hint'], actions: ['summary'] })).toHaveLength(1)
  })
})

describe('validate — requires (abstract capability needs)', () => {
  it('accepts needs with optional flags and abstract string params', () => {
    expect(
      errorsFor({ ...minimal(), requires: [{ need: 'docs-lookup' }, { need: 'code-intelligence', optional: true, params: { language: 'ts' } }] }),
    ).toEqual([])
  })

  it('refuses bad need grammar, wrong-typed optional/params, unknown keys, and >16 items', () => {
    expect(errorsFor({ ...minimal(), requires: [{ need: 'Docs Lookup' }] })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), requires: [{ need: 'docs-lookup', optional: 'yes' }] })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), requires: [{ need: 'docs-lookup', params: { level: 2 } }] })).toHaveLength(1)
    expect(errorsFor({ ...minimal(), requires: [{ need: 'docs-lookup', binary: '/usr/bin/x' }] }).some((e) => e.includes('binary'))).toBe(
      true,
    )
    expect(errorsFor({ ...minimal(), requires: Array.from({ length: 17 }, (_, i) => ({ need: `n-${i}` })) })).toHaveLength(1)
  })

  it('review lock F4: the proto-defence Set and isRecord live in ONE module, imported by both validators', () => {
    // The bundle review flagged FORBIDDEN_ENTRY_NAMES/isRecord duplicated verbatim
    // across capabilities.ts and observer-def.ts with no drift protection. Single
    // definition site: validator-shared.ts defines them; both validators import.
    const shared = readFileSync(new URL('../src/validator-shared.ts', import.meta.url), 'utf8')
    const capabilities = readFileSync(new URL('../src/capabilities.ts', import.meta.url), 'utf8')
    const observerDef = readFileSync(new URL('../src/observer-def.ts', import.meta.url), 'utf8')
    expect(shared).toMatch(/const FORBIDDEN_ENTRY_NAMES = new Set/)
    for (const src of [capabilities, observerDef]) {
      expect(src).not.toMatch(/const FORBIDDEN_ENTRY_NAMES = new Set/)
      expect(src).not.toMatch(/function isRecord\(/)
      expect(src).toMatch(/from '\.\/validator-shared\.js'/)
    }
  })

  it('review lock F5: CADENCE_FLOOR_MS is EXPORTED as the normative floor (60000) for the server to import', () => {
    // Cross-repo drift protection by dependency inversion: the shared contract owns
    // the floor; the companion server imports it instead of re-declaring it.
    expect(CADENCE_FLOOR_MS).toBe(60000)
  })

  it('refuses prototype-collision params keys (raw JSON, where __proto__ is a real key)', () => {
    const raw = JSON.parse(
      '{"observers":[{"definition":{"schemaVersion":1,"name":"x","description":"d","watch":{"roles":["r"]},"brain":{"mandate":"Summarize meaningful state changes now."},"requires":[{"need":"docs-lookup","params":{"__proto__":"x"}}]}}]}',
    ) as Record<string, unknown>
    const r = extractObservers(raw)
    expect(r.entries).toBeNull()
    expect(r.errors.some((e) => e.includes('__proto__'))).toBe(true)
  })
})
