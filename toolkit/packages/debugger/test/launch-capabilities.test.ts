// launch-capabilities.test.ts — the LAUNCHER-side capability composition glue
// (card I3 #1821494490959971801; frozen design v2 §3.2/§5/§9). Pure unit tests,
// ZERO model calls, ZERO real processes: probes/availability are passed in.
//
// composeLaunchCapabilities is the seam cmdLaunch calls after it has (I/O side)
// read the sidecar, loaded the registry and run the probes. It: resolves needs,
// substitutes $CWD launcher-side, projects the sidecar (sidecarToCapabilitiesSpec),
// projects the SEAM skill settings (skillOverrides/disableBundledSkills that I2
// deliberately leaves on the sidecar type), and merges the caller's args
// capabilities OVER the sidecar resolution (precedence §3.3: server-BARE default <
// sidecar resolution < caller args). Fail-loud → capabilities null.

import { describe, expect, it } from 'vitest'
import { composeLaunchCapabilities, resolveObserverRequires, sidecarPathFor, substituteCwd } from '../src/launch-capabilities.js'
import type { CapabilityRegistry, CapabilitySidecar } from '../src/capability-registry.js'
import type { CapabilitiesSpec } from '../src/capabilities.js'

const registry: CapabilityRegistry = {
  version: 1,
  providers: {
    'code-intelligence': [
      {
        name: 'serena',
        mcpServers: { serena: { command: 'uvx', args: ['serena', 'start-mcp-server', '--project', '$CWD'] } },
        tools: ['mcp__serena__*'],
        protocolHint: 'Use the symbolic tools; do not fall back to text search.',
      },
    ],
    'docs-lookup': [{ name: 'context7', mcpServers: { context7: { command: 'ctx' } }, tools: ['mcp__context7__*'] }],
  },
}

/** A reviewer role needing code-intelligence + optional skills settings. */
const sidecar: CapabilitySidecar = {
  version: 1,
  roles: { reviewer: { agent: 'wf-reviewer', needs: [{ need: 'code-intelligence', params: { language: 'ts' } }] } },
  agents: {
    'wf-reviewer': { description: 'Diff reviewer', prompt: 'Review the diff.', model: 'sonnet', tools: ['Read', '$cap:code-intelligence'] },
  },
  skillOverrides: { 'deep-research': 'off' },
  disableBundledSkills: false,
}

const base = { registry, availability: { serena: true }, webAvailable: true, requesterCwd: '/proj', callerCapabilities: null as CapabilitiesSpec | null }

// ------------------------------- sidecarPathFor (unit) -------------------------------

describe('sidecarPathFor', () => {
  it('derives <artifact>.capabilities.json next to the resolved .js workflow', () => {
    expect(sidecarPathFor('/roots/my-wf.js')).toBe('/roots/my-wf.capabilities.json')
  })
  it('appends (never returns the workflow path itself) for a non-.js path', () => {
    expect(sidecarPathFor('/roots/my-wf')).toBe('/roots/my-wf.capabilities.json')
  })
})

// ------------------------------- substituteCwd (unit) -------------------------------

describe('substituteCwd', () => {
  it('replaces $CWD recursively in nested strings/arrays/objects, verbatim otherwise', () => {
    const out = substituteCwd({ serena: { command: 'uvx', args: ['--project', '$CWD', 'keep'], nested: { p: '$CWD/x' } } }, '/proj')
    expect(out).toEqual({ serena: { command: 'uvx', args: ['--project', '/proj', 'keep'], nested: { p: '/proj/x' } } })
  })

  it('reports whether any $CWD token was seen (for the degenerate-cwd guard)', () => {
    expect(substituteCwd({ a: 'no token' }, '/proj')).toEqual({ a: 'no token' })
  })
})

// ------------------------------- composeLaunchCapabilities -------------------------------

describe('composeLaunchCapabilities — resolved happy path', () => {
  it('expands $cap:, mounts the provider mcpServers with $CWD substituted, appends the resolution note', () => {
    const r = composeLaunchCapabilities({ ...base, sidecar })
    expect(r.errors).toEqual([])
    expect(r.capabilities).not.toBeNull()
    const spec = r.capabilities as CapabilitiesSpec
    // $cap:code-intelligence → the provider's exact tools; Read kept; no degraded Grep/Glob added.
    expect(spec.agents?.['wf-reviewer']?.tools).toEqual(['Read', 'mcp__serena__*'])
    // provider mcpServers mounted at session level, $CWD → requesterCwd.
    expect(spec.mcpServers?.['serena']).toEqual({ command: 'uvx', args: ['serena', 'start-mcp-server', '--project', '/proj'] })
    // the mechanical resolution note is appended to the tooled prompt.
    expect(spec.agents?.['wf-reviewer']?.prompt).toContain('## Capability resolution')
    expect(spec.agents?.['wf-reviewer']?.prompt).toContain('serena')
  })

  it('projects the SEAM skill settings (skillOverrides/disableBundledSkills off the sidecar type)', () => {
    const r = composeLaunchCapabilities({ ...base, sidecar })
    const spec = r.capabilities as CapabilitiesSpec
    expect(spec.skillOverrides).toEqual({ 'deep-research': 'off' })
    expect(spec.disableBundledSkills).toBe(false)
  })

  it('carries the resolution report for auditing', () => {
    const r = composeLaunchCapabilities({ ...base, sidecar })
    expect(r.report).toEqual([
      { need: 'code-intelligence', provider: 'serena', mcpServers: { serena: { command: 'uvx', args: ['serena', 'start-mcp-server', '--project', '/proj'] } }, tools: ['mcp__serena__*'], protocolHint: 'Use the symbolic tools; do not fall back to text search.' },
    ])
  })
})

describe('composeLaunchCapabilities — degradation', () => {
  it('falls to the named grep-glob degradation when the provider is unavailable (required need with a fallback = OK)', () => {
    const r = composeLaunchCapabilities({ ...base, availability: { serena: false }, sidecar })
    expect(r.errors).toEqual([])
    const spec = r.capabilities as CapabilitiesSpec
    expect(spec.agents?.['wf-reviewer']?.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(spec.mcpServers).toBeUndefined()
    expect(r.report[0]).toMatchObject({ need: 'code-intelligence', unresolved: true, degradation: 'degraded:grep-glob' })
  })

  it('REFUSES (fail-loud) a required need that degrades to none', () => {
    const bad: CapabilitySidecar = {
      version: 1,
      roles: { researcher: { agent: 'wf-researcher', needs: [{ need: 'web-search' }] } },
      agents: { 'wf-researcher': { description: 'r', prompt: 'p', tools: ['$cap:web-search'] } },
    }
    const r = composeLaunchCapabilities({ ...base, registry: { version: 1, providers: {} }, sidecar: bad })
    expect(r.capabilities).toBeNull()
    expect(r.errors.join('\n')).toMatch(/required capability 'web-search'.*unresolvable/)
  })
})

describe('composeLaunchCapabilities — caller-args precedence (sidecar < caller)', () => {
  it('a caller agent override wins per key while the rest of the sidecar survives', () => {
    const caller: CapabilitiesSpec = {
      agents: { 'wf-reviewer': { description: 'Overridden', prompt: 'Caller prompt', tools: ['Read'] } },
      mcpServers: { extra: { command: 'x' } },
    }
    const r = composeLaunchCapabilities({ ...base, sidecar, callerCapabilities: caller })
    const spec = r.capabilities as CapabilitiesSpec
    // caller wins for the agent it names
    expect(spec.agents?.['wf-reviewer']?.description).toBe('Overridden')
    expect(spec.agents?.['wf-reviewer']?.tools).toEqual(['Read'])
    // caller mcpServers merged in alongside the sidecar-resolved serena
    expect(spec.mcpServers?.['extra']).toEqual({ command: 'x' })
    expect(spec.mcpServers?.['serena']).toBeDefined()
  })

  it('merges skill settings per key with the caller winning (mergeSkillSettings)', () => {
    const caller: CapabilitiesSpec = { skillOverrides: { 'deep-research': 'on', 'other': 'off' }, disableBundledSkills: true }
    const r = composeLaunchCapabilities({ ...base, sidecar, callerCapabilities: caller })
    const spec = r.capabilities as CapabilitiesSpec
    // caller wins on deep-research; caller's 'other' added; disableBundledSkills caller wins
    expect(spec.skillOverrides).toEqual({ 'deep-research': 'on', 'other': 'off' })
    expect(spec.disableBundledSkills).toBe(true)
  })
})

describe('resolveObserverRequires (observer wire contract, no refusal)', () => {
  it('resolves a need to its provider with $CWD substituted', () => {
    const [r] = resolveObserverRequires([{ need: 'code-intelligence' }], registry, { serena: true }, true, '/obs')
    expect(r).toEqual({
      need: 'code-intelligence',
      provider: 'serena',
      mcpServers: { serena: { command: 'uvx', args: ['serena', 'start-mcp-server', '--project', '/obs'] } },
      tools: ['mcp__serena__*'],
      protocolHint: 'Use the symbolic tools; do not fall back to text search.',
    })
  })

  it('embeds an UNRESOLVED entry for a required need with no provider (NEVER throws/refuses)', () => {
    const out = resolveObserverRequires([{ need: 'web-search' }], { version: 1, providers: {} }, {}, true, '/obs')
    expect(out).toEqual([{ need: 'web-search', unresolved: true, degradation: 'degraded:none', tools: [] }])
  })
})

describe('composeLaunchCapabilities — guards', () => {
  it('surfaces the MAJOR-2 guard (a concrete mcp__ tool in a sidecar agent) as a launch refusal', () => {
    const smuggle: CapabilitySidecar = {
      version: 1,
      roles: { reviewer: { agent: 'wf-reviewer', needs: [{ need: 'code-intelligence' }] } },
      agents: { 'wf-reviewer': { description: 'r', prompt: 'p', tools: ['$cap:code-intelligence', 'mcp__serena__write_memory'] } },
    }
    const r = composeLaunchCapabilities({ ...base, sidecar: smuggle })
    expect(r.capabilities).toBeNull()
    expect(r.errors.join('\n')).toMatch(/concrete MCP tool/)
  })

  it('REFUSES when a resolved provider needs $CWD but the requester cwd is unresolvable', () => {
    const r = composeLaunchCapabilities({ ...base, requesterCwd: '', sidecar })
    expect(r.capabilities).toBeNull()
    expect(r.errors.join('\n')).toMatch(/\$CWD/)
  })

  it('no skill settings anywhere → merged spec omits them', () => {
    const plain: CapabilitySidecar = {
      version: 1,
      roles: { reviewer: { agent: 'wf-reviewer', needs: [{ need: 'code-intelligence' }] } },
      agents: { 'wf-reviewer': { description: 'r', prompt: 'p', tools: ['$cap:code-intelligence'] } },
    }
    const r = composeLaunchCapabilities({ ...base, sidecar: plain })
    const spec = r.capabilities as CapabilitiesSpec
    expect(spec.skillOverrides).toBeUndefined()
    expect(spec.disableBundledSkills).toBeUndefined()
  })
})
