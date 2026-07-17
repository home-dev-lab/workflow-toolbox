// capabilities.test.ts — the per-run CAPABILITIES section contract (card
// #1820698986697196666): a launch's `--args` JSON may carry a `capabilities`
// section ({ mcpServers, agents, skills }) that the delegated-run server
// composes into the SDK query() options. The launcher validates it EARLY
// (fail fast client-side, loud on typos); the server imports the same module
// so both sides share one contract.

import { describe, expect, it } from 'vitest'
import { composeCapabilityOptions, extractCapabilities } from '../src/capabilities.js'

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
})
