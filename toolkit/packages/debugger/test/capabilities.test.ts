// capabilities.test.ts — the per-run CAPABILITIES section contract (card
// #1820698986697196666): a launch's `--args` JSON may carry a `capabilities`
// section ({ mcpServers, agents, skills }) that the delegated-run server
// composes into the SDK query() options. The launcher validates it EARLY
// (fail fast client-side, loud on typos); the server imports the same module
// so both sides share one contract.

import { describe, expect, it } from 'vitest'
import { BARE_SKILLS_SETTINGS, composeCapabilityOptions, extractCapabilities, mergeSkillSettings } from '../src/capabilities.js'

const validMcp = {
  serena: { type: 'stdio', command: 'uvx', args: ['serena', 'start-mcp-server'] },
}
const validAgents = {
  'wt-check': {
    description: 'Read-only code-intelligence checker.',
    prompt: 'You are wt-check.',
    tools: ['Read', 'mcp__serena__find_symbol'],
    model: 'haiku',
  },
}

describe('extractCapabilities', () => {
  it('returns null spec (no errors) when args has no capabilities section', () => {
    expect(extractCapabilities({ target: 'x' })).toEqual({ spec: null, errors: [] })
  })

  it('returns null spec for non-object args (undefined, null, string)', () => {
    expect(extractCapabilities(undefined)).toEqual({ spec: null, errors: [] })
    expect(extractCapabilities(null)).toEqual({ spec: null, errors: [] })
    expect(extractCapabilities('{"a":1}')).toEqual({ spec: null, errors: [] })
  })

  it('treats capabilities: null as ABSENT (the JSON idiom for an omitted key) — review 3.1 lock', () => {
    // Pre-contract behavior: {capabilities: null} launched fine (unknown args keys ignored).
    // The section being null must NOT hard-fail the launch.
    expect(extractCapabilities({ capabilities: null })).toEqual({ spec: null, errors: [] })
  })

  it('rejects wrong-typed optional agent fields (model/effort/maxTurns/mcpServers) — review 1.1 lock', () => {
    const r = extractCapabilities({
      capabilities: {
        agents: { foo: { description: 'd', prompt: 'p', model: 42, effort: {}, maxTurns: 'ten', mcpServers: 'nope' } },
      },
    })
    expect(r.spec).toBeNull()
    for (const field of ['model', 'effort', 'maxTurns', 'mcpServers']) {
      expect(r.errors.some((e) => e.includes('foo') && e.includes(field)), `expected an error for ${field}`).toBe(true)
    }
  })

  it('accepts well-typed optional agent fields', () => {
    const r = extractCapabilities({
      capabilities: {
        agents: {
          ok: { description: 'd', prompt: 'p', model: 'haiku', effort: 'low', maxTurns: 3, background: false, skills: ['x'], mcpServers: [{ s: { command: 'uvx' } }] },
        },
      },
    })
    expect(r.errors).toEqual([])
    expect(r.spec).not.toBeNull()
  })

  it('rejects unknown keys INSIDE an agent definition (typo defence, loud) — review 1.2 lock', () => {
    const r = extractCapabilities({
      capabilities: { agents: { a: { description: 'd', prompt: 'p', disalowedTools: ['Bash'] } } },
    })
    expect(r.spec).toBeNull()
    expect(r.errors.some((e) => e.includes('a') && e.includes('disalowedTools'))).toBe(true)
  })

  it('rejects wrong-typed mcpServers anchor values (type: 123, command: null) — review 1.3 lock', () => {
    const badType = extractCapabilities({ capabilities: { mcpServers: { s: { type: 123 } } } })
    expect(badType.errors.some((e) => e.includes('s') && e.includes('type'))).toBe(true)
    const badCmd = extractCapabilities({ capabilities: { mcpServers: { s: { command: null } } } })
    expect(badCmd.errors.some((e) => e.includes('s') && e.includes('command'))).toBe(true)
  })

  it('rejects __proto__/constructor/prototype entry names in both maps — review 1.4 lock (defence-in-depth for the SDK layer)', () => {
    const m = extractCapabilities({ capabilities: { mcpServers: JSON.parse('{"__proto__": {"command": "evil"}}') } })
    expect(m.spec).toBeNull()
    expect(m.errors.some((e) => e.includes('__proto__'))).toBe(true)
    const a = extractCapabilities({ capabilities: { agents: { constructor: { description: 'd', prompt: 'p' } } } })
    expect(a.spec).toBeNull()
    expect(a.errors.some((e) => e.includes('constructor'))).toBe(true)
  })

  it('rejects a non-object capabilities section', () => {
    const r = extractCapabilities({ capabilities: 'serena' })
    expect(r.spec).toBeNull()
    expect(r.errors.some((e) => e.includes('capabilities'))).toBe(true)
  })

  it('accepts a full valid section and echoes it as the spec', () => {
    const r = extractCapabilities({
      capabilities: { mcpServers: validMcp, agents: validAgents, skills: ['playwright-cli'] },
    })
    expect(r.errors).toEqual([])
    expect(r.spec).toEqual({ mcpServers: validMcp, agents: validAgents, skills: ['playwright-cli'] })
  })

  it('rejects unknown keys LOUDLY (typo defence: mcpServer vs mcpServers)', () => {
    const r = extractCapabilities({ capabilities: { mcpServer: validMcp } })
    expect(r.spec).toBeNull()
    expect(r.errors.some((e) => e.includes('mcpServer'))).toBe(true)
  })

  it('rejects an mcpServers entry that is not an object or lacks any launch/connect field', () => {
    const noShape = extractCapabilities({ capabilities: { mcpServers: { serena: 'uvx' } } })
    expect(noShape.errors.length).toBeGreaterThan(0)
    const empty = extractCapabilities({ capabilities: { mcpServers: { serena: {} } } })
    expect(empty.errors.some((e) => e.includes('serena'))).toBe(true)
  })

  it('rejects an agents entry missing description or prompt', () => {
    const r = extractCapabilities({ capabilities: { agents: { bad: { description: 'x' } } } })
    expect(r.spec).toBeNull()
    expect(r.errors.some((e) => e.includes('bad') && e.includes('prompt'))).toBe(true)
  })

  it('rejects agents tools that are not a string array', () => {
    const r = extractCapabilities({
      capabilities: { agents: { a: { description: 'd', prompt: 'p', tools: 'Read' } } },
    })
    expect(r.errors.some((e) => e.includes('tools'))).toBe(true)
  })

  it('rejects skills that are not a string array', () => {
    const r = extractCapabilities({ capabilities: { skills: 'playwright-cli' } })
    expect(r.errors.some((e) => e.includes('skills'))).toBe(true)
  })

  it('collects MULTIPLE errors in one pass instead of stopping at the first', () => {
    const r = extractCapabilities({
      capabilities: { skills: 42, agents: { a: { prompt: 'p' } }, bogus: true },
    })
    expect(r.errors.length).toBeGreaterThanOrEqual(3)
  })
})

describe('composeCapabilityOptions', () => {
  it('emits exactly the present sections as a query() options fragment', () => {
    const frag = composeCapabilityOptions({ mcpServers: validMcp, agents: validAgents })
    expect(frag).toEqual({ mcpServers: validMcp, agents: validAgents })
  })

  it('emits {} for an empty spec (nothing invented)', () => {
    expect(composeCapabilityOptions({})).toEqual({})
  })

  it('passes skills through as the SDK enable-filter', () => {
    expect(composeCapabilityOptions({ skills: ['a'] })).toEqual({ skills: ['a'] })
  })

  // §6.3 — skill-settings layer emission (spec-only fragment; the SERVER deep-merges
  // it over BARE_SKILLS_SETTINGS, so composeCapabilityOptions never carries the default).
  it('emits a settings fragment from skillOverrides + disableBundledSkills', () => {
    expect(
      composeCapabilityOptions({ skillOverrides: { 'deep-research': 'off' }, disableBundledSkills: false }),
    ).toEqual({ settings: { skillOverrides: { 'deep-research': 'off' }, disableBundledSkills: false } })
  })

  it('emits settings with only skillOverrides when disableBundledSkills is absent', () => {
    expect(composeCapabilityOptions({ skillOverrides: { doctor: 'on' } })).toEqual({
      settings: { skillOverrides: { doctor: 'on' } },
    })
  })

  it('emits settings carrying disableBundledSkills:false (a present false is not dropped)', () => {
    expect(composeCapabilityOptions({ disableBundledSkills: false })).toEqual({
      settings: { disableBundledSkills: false },
    })
  })

  it('empty spec stays {} — no settings invented (existing lock preserved)', () => {
    expect(composeCapabilityOptions({})).toEqual({})
  })
})

describe('extractCapabilities — skill-settings sections (§6.3)', () => {
  it('accepts all four skillOverride modes + a boolean disableBundledSkills', () => {
    const r = extractCapabilities({
      capabilities: {
        skillOverrides: { a: 'on', b: 'name-only', c: 'user-invocable-only', d: 'off' },
        disableBundledSkills: true,
      },
    })
    expect(r.errors).toEqual([])
    expect(r.spec).toEqual({
      skillOverrides: { a: 'on', b: 'name-only', c: 'user-invocable-only', d: 'off' },
      disableBundledSkills: true,
    })
  })

  it('extracts disableBundledSkills:false and KEEPS it (present-false not dropped at extraction — built-ins-declared regime)', () => {
    // Locks the unconditional `else` in extractCapabilities: a truthy-check regression would
    // silently drop a legitimate `false`, turning the built-ins-declared regime into a no-op,
    // and every merge/compose test (which build the spec by hand) would still pass.
    const r = extractCapabilities({ capabilities: { disableBundledSkills: false } })
    expect(r.errors).toEqual([])
    expect(r.spec).toEqual({ disableBundledSkills: false })
  })

  it('rejects an unknown skillOverride mode (loud on typos)', () => {
    const r = extractCapabilities({ capabilities: { skillOverrides: { deep: 'disabled' } } })
    expect(r.spec).toBeNull()
    expect(r.errors.some((e) => e.includes('deep') && e.includes('disabled'))).toBe(true)
  })

  it('rejects a non-object skillOverrides section', () => {
    const r = extractCapabilities({ capabilities: { skillOverrides: 'off' } })
    expect(r.spec).toBeNull()
    expect(r.errors.some((e) => e.includes('skillOverrides'))).toBe(true)
  })

  it('rejects a non-boolean disableBundledSkills', () => {
    const r = extractCapabilities({ capabilities: { disableBundledSkills: 'true' } })
    expect(r.spec).toBeNull()
    expect(r.errors.some((e) => e.includes('disableBundledSkills'))).toBe(true)
  })

  it('rejects __proto__ inside the skillOverrides map (prototype-collision defence)', () => {
    const r = extractCapabilities({
      capabilities: { skillOverrides: JSON.parse('{"__proto__": "off"}') },
    })
    expect(r.spec).toBeNull()
    expect(r.errors.some((e) => e.includes('__proto__'))).toBe(true)
  })
})

describe('extractCapabilities — $cap: placeholder rejection (§5.2 resolver bypass)', () => {
  it('rejects an unexpanded $cap:<need> token in an agent tools allowlist', () => {
    const r = extractCapabilities({
      capabilities: {
        agents: { a: { description: 'd', prompt: 'p', tools: ['Read', '$cap:code-intelligence'] } },
      },
    })
    expect(r.spec).toBeNull()
    expect(r.errors.some((e) => e.includes('a') && e.includes('$cap:code-intelligence'))).toBe(true)
  })

  it('accepts a normal (non-placeholder) tools allowlist', () => {
    const r = extractCapabilities({
      capabilities: { agents: { a: { description: 'd', prompt: 'p', tools: ['Read', 'mcp__serena__find_symbol'] } } },
    })
    expect(r.errors).toEqual([])
    expect(r.spec).not.toBeNull()
  })
})

describe('BARE_SKILLS_SETTINGS + mergeSkillSettings (§6.1/§6.3)', () => {
  it('BARE_SKILLS_SETTINGS is the exact zero-skill default (doctor override belt-and-braces)', () => {
    expect(BARE_SKILLS_SETTINGS).toEqual({ disableBundledSkills: true, skillOverrides: { doctor: 'off' } })
  })

  it('with no override returns the default settings (a delegated run WITHOUT capabilities is still zero-skill)', () => {
    expect(mergeSkillSettings(BARE_SKILLS_SETTINGS)).toEqual({
      disableBundledSkills: true,
      skillOverrides: { doctor: 'off' },
    })
  })

  it('deep-merges skillOverrides per skill — a spec override does NOT wipe the default doctor:off (naive-spread guard, MINOR-5)', () => {
    expect(mergeSkillSettings(BARE_SKILLS_SETTINGS, { skillOverrides: { 'deep-research': 'off' } })).toEqual({
      disableBundledSkills: true,
      skillOverrides: { doctor: 'off', 'deep-research': 'off' },
    })
  })

  it('spec wins per skill key — doctor:on overrides the default doctor:off', () => {
    expect(mergeSkillSettings(BARE_SKILLS_SETTINGS, { skillOverrides: { doctor: 'on' } })).toEqual({
      disableBundledSkills: true,
      skillOverrides: { doctor: 'on' },
    })
  })

  it('built-ins-declared regime — spec disableBundledSkills:false DROPS the default true (MINOR-6)', () => {
    expect(mergeSkillSettings(BARE_SKILLS_SETTINGS, { disableBundledSkills: false })).toEqual({
      disableBundledSkills: false,
      skillOverrides: { doctor: 'off' },
    })
  })

  it('never mutates its inputs — frozen base + override do not throw, and inputs stay unchanged', () => {
    // BARE_SKILLS_SETTINGS is a SHARED exported mutable constant: a mutating merge would
    // corrupt the zero-skill default for every future consumer. Freezing both inputs turns
    // any accidental write (Object.assign onto base, a property write) into a thrown TypeError
    // under ESM strict mode — so a green run proves the documented non-mutation guarantee.
    const base = Object.freeze({ disableBundledSkills: true, skillOverrides: Object.freeze({ doctor: 'off' as const }) })
    const override = Object.freeze({ skillOverrides: Object.freeze({ 'deep-research': 'off' as const }) })
    const out = mergeSkillSettings(base, override)
    expect(out).toEqual({ disableBundledSkills: true, skillOverrides: { doctor: 'off', 'deep-research': 'off' } })
    expect(base.skillOverrides).toEqual({ doctor: 'off' })
    expect(override.skillOverrides).toEqual({ 'deep-research': 'off' })
  })
})
