// capability-registry.test.ts — the AUTHORING→LAUNCH capability resolver (card
// I2 #1821494465542489559; frozen design v2 §3-5 capability-registry-design.md).
// Unit tests only, ZERO model calls: probes are injected (fake spawn), the
// machine registry is read from temp fixtures.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadCapabilityRegistry,
  resolveCapabilities,
  probeProviders,
  sidecarToCapabilitiesSpec,
  resolutionsToBrainOptions,
  type CapabilityRegistry,
  type CapabilitySidecar,
  type NeedResolution,
  type ProbeSpawn,
} from '../src/capability-registry.js'

const registry: CapabilityRegistry = {
  version: 1,
  providers: {
    'code-intelligence': [
      {
        name: 'serena',
        mcpServers: { serena: { command: 'uvx', args: ['serena', 'start-mcp-server', '--project', '$CWD'] } },
        tools: ['mcp__serena__*'],
        protocolHint: 'Use the symbolic tools; do not fall back to text search.',
        probe: { command: 'uvx --version', timeoutMs: 5000 },
      },
    ],
    'docs-lookup': [
      { name: 'context7', mcpServers: { context7: { command: 'ctx' } }, tools: ['mcp__context7__*'] },
    ],
  },
}

// ------------------------------- resolveCapabilities -------------------------------

describe('resolveCapabilities', () => {
  it('resolves a need to its first available provider (verbatim mcpServers/tools/protocolHint)', () => {
    const [r] = resolveCapabilities([{ need: 'code-intelligence' }], registry, { availability: { serena: true } })
    expect(r).toEqual({
      need: 'code-intelligence',
      provider: 'serena',
      mcpServers: { serena: { command: 'uvx', args: ['serena', 'start-mcp-server', '--project', '$CWD'] } },
      tools: ['mcp__serena__*'],
      protocolHint: 'Use the symbolic tools; do not fall back to text search.',
    })
  })

  it('treats a provider with no probe result as available (declaration = responsibility)', () => {
    const [r] = resolveCapabilities([{ need: 'docs-lookup' }], registry, {})
    expect(r).toMatchObject({ need: 'docs-lookup', provider: 'context7' })
  })

  it('falls to the named degradation when the sole provider is probed-unavailable (code-intelligence → grep-glob)', () => {
    const [r] = resolveCapabilities([{ need: 'code-intelligence' }], registry, { availability: { serena: false } })
    expect(r).toEqual({ need: 'code-intelligence', unresolved: true, degradation: 'degraded:grep-glob', tools: ['Grep', 'Glob', 'Read'] })
  })

  it('picks the first AVAILABLE provider in registry order (ordered providers)', () => {
    const twoProv: CapabilityRegistry = {
      version: 1,
      providers: {
        'code-intelligence': [
          { name: 'first', tools: ['mcp__first__*'] },
          { name: 'second', tools: ['mcp__second__*'] },
        ],
      },
    }
    const [r] = resolveCapabilities([{ need: 'code-intelligence' }], twoProv, { availability: { first: false, second: true } })
    expect(r).toMatchObject({ provider: 'second', tools: ['mcp__second__*'] })
  })

  it('degrades docs-lookup to web when web is available, to none when not', () => {
    const bare: CapabilityRegistry = { version: 1, providers: {} }
    const withWeb = resolveCapabilities([{ need: 'docs-lookup' }], bare, { webAvailable: true })[0]
    expect(withWeb).toEqual({ need: 'docs-lookup', unresolved: true, degradation: 'degraded:web', tools: ['WebSearch', 'WebFetch'] })
    const noWeb = resolveCapabilities([{ need: 'docs-lookup' }], bare, { webAvailable: false })[0]
    expect(noWeb).toEqual({ need: 'docs-lookup', unresolved: true, degradation: 'degraded:none', tools: [] })
  })

  it('maps web-search → degraded:none and context-offload → degraded:inline when unresolved', () => {
    const bare: CapabilityRegistry = { version: 1, providers: {} }
    expect(resolveCapabilities([{ need: 'web-search' }], bare, {})[0]).toMatchObject({ degradation: 'degraded:none', tools: [] })
    expect(resolveCapabilities([{ need: 'context-offload' }], bare, {})[0]).toMatchObject({ degradation: 'degraded:inline', tools: [] })
  })

  it('an unknown open-vocabulary need with no provider degrades to none (tools [])', () => {
    const bare: CapabilityRegistry = { version: 1, providers: {} }
    expect(resolveCapabilities([{ need: 'telepathy' }], bare, {})[0]).toEqual({ need: 'telepathy', unresolved: true, degradation: 'degraded:none', tools: [] })
  })

  it('dedups needs by need string (one resolution per unique need)', () => {
    const res = resolveCapabilities([{ need: 'code-intelligence' }, { need: 'code-intelligence', params: { language: 'ts' } }], registry, {})
    expect(res).toHaveLength(1)
  })
})

// ------------------------------- probeProviders -------------------------------

describe('probeProviders', () => {
  it('marks a probe available on exit code 0, unavailable on non-zero', async () => {
    const spawn: ProbeSpawn = (argv) => Promise.resolve({ code: argv[0] === 'uvx' ? 0 : 1, timedOut: false })
    const avail = await probeProviders(registry, { spawn })
    expect(avail).toEqual({ serena: true })
  })

  it('marks a timed-out probe unavailable', async () => {
    const spawn: ProbeSpawn = () => Promise.resolve({ code: null, timedOut: true })
    expect(await probeProviders(registry, { spawn })).toEqual({ serena: false })
  })

  it('marks a spawn error unavailable', async () => {
    const spawn: ProbeSpawn = () => Promise.resolve({ code: null, timedOut: false, error: 'ENOENT' })
    expect(await probeProviders(registry, { spawn })).toEqual({ serena: false })
  })

  it('tokenizes the command to argv (no shell) and passes the timeout through', async () => {
    let seenArgv: string[] = []
    let seenTimeout = 0
    const spawn: ProbeSpawn = (argv, opts) => {
      seenArgv = argv
      seenTimeout = opts.timeoutMs
      return Promise.resolve({ code: 0, timedOut: false })
    }
    await probeProviders(registry, { spawn })
    expect(seenArgv).toEqual(['uvx', '--version'])
    expect(seenTimeout).toBe(5000)
  })

  it('omits providers that declare no probe (assumed available downstream)', async () => {
    const spawn: ProbeSpawn = () => Promise.resolve({ code: 0, timedOut: false })
    const avail = await probeProviders(registry, { spawn })
    expect('context7' in avail).toBe(false)
  })
})

// ------------------------------- loadCapabilityRegistry -------------------------------

describe('loadCapabilityRegistry', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cap-reg-'))
  const savedEnv = process.env.WT_CAPABILITY_REGISTRY
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.WT_CAPABILITY_REGISTRY
    else process.env.WT_CAPABILITY_REGISTRY = savedEnv
  })

  const write = (name: string, body: string): string => {
    const p = join(tmp, name)
    writeFileSync(p, body)
    return p
  }

  it('returns an EMPTY registry (no errors) when the file is absent (harness-only machine)', () => {
    const r = loadCapabilityRegistry({ path: join(tmp, 'does-not-exist.json') })
    expect(r).toEqual({ registry: { version: 1, providers: {} }, errors: [] })
  })

  it('reads and validates a well-formed registry', () => {
    const p = write('ok.json', JSON.stringify(registry))
    const r = loadCapabilityRegistry({ path: p })
    expect(r.errors).toEqual([])
    expect(r.registry).toEqual(registry)
  })

  it('reports invalid JSON as an error (fail-loud), empty registry', () => {
    const p = write('bad.json', '{ not json ')
    const r = loadCapabilityRegistry({ path: p })
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.registry.providers).toEqual({})
  })

  it('rejects a wrong version and a non-object providers map (multiple errors, one pass)', () => {
    const p = write('v.json', JSON.stringify({ version: 2, providers: [] }))
    const r = loadCapabilityRegistry({ path: p })
    expect(r.errors.some((e) => e.includes('version'))).toBe(true)
    expect(r.errors.some((e) => e.includes('providers'))).toBe(true)
  })

  it('rejects a provider missing name and an unknown provider key (loud on typos)', () => {
    const p = write('prov.json', JSON.stringify({ version: 1, providers: { 'code-intelligence': [{ tools: ['x'], boops: 1 }] } }))
    const r = loadCapabilityRegistry({ path: p })
    expect(r.errors.some((e) => e.includes('name'))).toBe(true)
    expect(r.errors.some((e) => e.includes('boops'))).toBe(true)
  })

  it('rejects __proto__ as a need key (prototype-collision defence)', () => {
    const p = write('proto.json', '{"version":1,"providers":{"__proto__":[]}}')
    const r = loadCapabilityRegistry({ path: p })
    expect(r.errors.some((e) => e.includes('__proto__'))).toBe(true)
  })

  it('honours WT_CAPABILITY_REGISTRY when no explicit path is given', () => {
    const p = write('env.json', JSON.stringify(registry))
    process.env.WT_CAPABILITY_REGISTRY = p
    const r = loadCapabilityRegistry()
    expect(r.errors).toEqual([])
    expect(r.registry).toEqual(registry)
  })
})

// ------------------------------- sidecarToCapabilitiesSpec -------------------------------

const sidecar: CapabilitySidecar = {
  version: 1,
  roles: {
    reviewer: { agent: 'wf-reviewer', needs: [{ need: 'code-intelligence', params: { language: 'ts' } }] },
  },
  agents: {
    'wf-reviewer': { description: 'Diff-grounded reviewer.', prompt: 'You are wf-reviewer.', tools: ['Read', '$cap:code-intelligence'], model: 'sonnet' },
  },
}

const resolvedServena = (): NeedResolution[] => resolveCapabilities([{ need: 'code-intelligence' }], registry, { availability: { serena: true } })

describe('sidecarToCapabilitiesSpec', () => {
  it('expands $cap:<need> to the provider tools + mounts its mcpServers, appends a resolution note to the prompt', () => {
    const { spec, errors, report } = sidecarToCapabilitiesSpec(sidecar, resolvedServena())
    expect(errors).toEqual([])
    expect(spec.agents?.['wf-reviewer']?.tools).toEqual(['Read', 'mcp__serena__*'])
    expect(spec.mcpServers).toEqual({ serena: { command: 'uvx', args: ['serena', 'start-mcp-server', '--project', '$CWD'] } })
    expect(spec.agents?.['wf-reviewer']?.prompt).toContain('## Capability resolution')
    expect(spec.agents?.['wf-reviewer']?.prompt).toContain('serena')
    expect(report).toEqual(resolvedServena())
  })

  it('expands an unresolved need to its degradation tools and marks it DEGRADED in the prompt', () => {
    const degraded = resolveCapabilities([{ need: 'code-intelligence' }], registry, { availability: { serena: false } })
    const { spec, errors } = sidecarToCapabilitiesSpec(sidecar, degraded)
    expect(errors).toEqual([])
    expect(spec.agents?.['wf-reviewer']?.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(spec.agents?.['wf-reviewer']?.prompt).toContain('DEGRADED: degraded:grep-glob')
    expect(spec.mcpServers).toBeUndefined()
  })

  it('MAJOR-2 (a): rejects a concrete mcp__ tool in the sidecar and never leaks it into the spec', () => {
    const evil: CapabilitySidecar = {
      ...sidecar,
      agents: { 'wf-reviewer': { description: 'd', prompt: 'p', tools: ['$cap:code-intelligence', 'mcp__evil__exfil'] } },
    }
    const { spec, errors } = sidecarToCapabilitiesSpec(evil, resolvedServena())
    expect(errors.some((e) => e.includes('mcp__evil__exfil'))).toBe(true)
    expect(spec.agents?.['wf-reviewer']?.tools).not.toContain('mcp__evil__exfil')
  })

  it('MAJOR-2 (b): rejects an mcpServers field on a sidecar agent def', () => {
    const evil = {
      ...sidecar,
      agents: { 'wf-reviewer': { description: 'd', prompt: 'p', tools: [], mcpServers: [{ evil: { command: 'x' } }] } },
    } as unknown as CapabilitySidecar
    const { errors } = sidecarToCapabilitiesSpec(evil, resolvedServena())
    expect(errors.some((e) => e.includes('wf-reviewer') && e.includes('mcpServers'))).toBe(true)
  })

  it('MINOR-7: a $cap:<need> not declared in the role needs is a fail-loud authoring error', () => {
    const typo: CapabilitySidecar = {
      ...sidecar,
      agents: { 'wf-reviewer': { description: 'd', prompt: 'p', tools: ['$cap:code-inteligence'] } },
    }
    const { errors } = sidecarToCapabilitiesSpec(typo, resolvedServena())
    expect(errors.some((e) => e.includes('code-inteligence'))).toBe(true)
  })

  it('§5.4: a REQUIRED need that resolves to degraded:none is a fail-loud launch error; optional:true is not', () => {
    const reqSidecar: CapabilitySidecar = {
      version: 1,
      roles: { r: { agent: 'a', needs: [{ need: 'web-search' }] } },
      agents: { a: { description: 'd', prompt: 'p', tools: ['$cap:web-search'] } },
    }
    const bare: CapabilityRegistry = { version: 1, providers: {} }
    const reqRes = resolveCapabilities([{ need: 'web-search' }], bare, {})
    expect(sidecarToCapabilitiesSpec(reqSidecar, reqRes).errors.length).toBeGreaterThan(0)

    const optSidecar: CapabilitySidecar = {
      ...reqSidecar,
      roles: { r: { agent: 'a', needs: [{ need: 'web-search', optional: true }] } },
    }
    expect(sidecarToCapabilitiesSpec(optSidecar, reqRes).errors).toEqual([])
  })

  it('rejects a role that references an unknown agent', () => {
    const orphan: CapabilitySidecar = {
      version: 1,
      roles: { r: { agent: 'ghost', needs: [] } },
      agents: {},
    }
    const { errors } = sidecarToCapabilitiesSpec(orphan, [])
    expect(errors.some((e) => e.includes('ghost'))).toBe(true)
  })

  it('does NOT project skillOverrides/disableBundledSkills into the spec (I1/I3 seam)', () => {
    const withSkills: CapabilitySidecar = {
      ...sidecar,
      skillOverrides: { 'deep-research': 'off' },
      disableBundledSkills: false,
    }
    const { spec } = sidecarToCapabilitiesSpec(withSkills, resolvedServena())
    expect('skillOverrides' in spec).toBe(false)
    expect('disableBundledSkills' in spec).toBe(false)
  })
})

// ------------------------------- resolutionsToBrainOptions -------------------------------

describe('resolutionsToBrainOptions', () => {
  it('unions mcpServers/allowedTools and collects protocolHints across resolutions', () => {
    const res = resolveCapabilities([{ need: 'code-intelligence' }, { need: 'docs-lookup' }], registry, {})
    const brain = resolutionsToBrainOptions(res)
    expect(brain.mcpServers).toEqual({
      serena: { command: 'uvx', args: ['serena', 'start-mcp-server', '--project', '$CWD'] },
      context7: { command: 'ctx' },
    })
    expect(brain.allowedTools).toEqual(['mcp__serena__*', 'mcp__context7__*'])
    expect(brain.protocolHints).toEqual(['Use the symbolic tools; do not fall back to text search.'])
  })

  it('includes degradation tools in allowedTools and mounts no server for a degraded need', () => {
    const bare: CapabilityRegistry = { version: 1, providers: {} }
    const res = resolveCapabilities([{ need: 'code-intelligence' }], bare, {})
    const brain = resolutionsToBrainOptions(res)
    expect(brain.mcpServers).toEqual({})
    expect(brain.allowedTools).toEqual(['Grep', 'Glob', 'Read'])
    expect(brain.protocolHints).toEqual([])
  })
})
