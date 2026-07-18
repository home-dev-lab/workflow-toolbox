import { describe, it, expect } from 'vitest'
import { scaffoldCapabilities, assertCapabilitiesScaffoldSpec, capabilitiesLaunchHint } from '../src/scaffold.js'
import type { CapabilitiesScaffoldSpec } from '../src/scaffold.js'
import {
  lintSidecarMachineAgnostic,
  resolveCapabilities,
  sidecarToCapabilitiesSpec,
  type CapabilityRegistry,
  type CapabilitySidecar,
  type CapabilityNeed,
} from '@workflow-toolbox/debugger/capability-registry'

// A minimal, valid MACHINE-AGNOSTIC sidecar declaration: abstract needs + a $cap
// placeholder allowlist, no concrete tool, no machine path.
const base: CapabilitiesScaffoldSpec = {
  name: 'pr-review',
  roles: {
    reviewer: { agent: 'wf-reviewer', needs: [{ need: 'code-intelligence', params: { language: 'ts' } }] },
  },
  agents: {
    'wf-reviewer': {
      description: 'Diff-grounded reviewer.',
      prompt: 'You are wf-reviewer.',
      model: 'sonnet',
      tools: ['Read', '$cap:code-intelligence'],
    },
  },
}

/** Parse the emitted artifact and run it back through the SHARED launch lint — the
 *  emitter must NEVER produce a sidecar the shipped resolver would reject. */
function lintEmitted(source: string): string[] {
  return lintSidecarMachineAgnostic(JSON.parse(source) as never)
}

describe('scaffoldCapabilities — emission', () => {
  it('is a pure function: same spec → byte-identical output', () => {
    expect(scaffoldCapabilities(base)).toBe(scaffoldCapabilities(base))
  })

  it('emits version 1 first and a trailing newline', () => {
    const json = scaffoldCapabilities(base)
    expect(json.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed['version']).toBe(1)
    expect(json.indexOf('"version"')).toBeLessThan(json.indexOf('"roles"'))
  })

  it('emits a sidecar that PASSES the shipped shared lint (round-trip, 0 errors)', () => {
    expect(lintEmitted(scaffoldCapabilities(base))).toEqual([])
  })

  it('strips `name` from the emitted JSON (filename-only; a CapabilitySidecar has no name)', () => {
    const parsed = JSON.parse(scaffoldCapabilities(base)) as Record<string, unknown>
    expect(parsed['name']).toBeUndefined()
    expect(Object.keys(parsed)).toEqual(['version', 'roles', 'agents'])
  })

  it('emits the optional skills settings only when the spec declares them', () => {
    const json = scaffoldCapabilities({ ...base, skillOverrides: { 'deep-research': 'off' }, disableBundledSkills: true })
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed['skillOverrides']).toEqual({ 'deep-research': 'off' })
    expect(parsed['disableBundledSkills']).toBe(true)
    expect(lintEmitted(json)).toEqual([])
  })

  it('emits ONLY known sidecar keys — an unknown key in untrusted JSON never reaches the artifact', () => {
    const json = scaffoldCapabilities({ ...base, mcpServers: { evil: {} } } as unknown as CapabilitiesScaffoldSpec)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed['mcpServers']).toBeUndefined()
  })
})

describe('scaffoldCapabilities — validation is REUSED from the shared launch lint, never duplicated', () => {
  it('throws on a CONCRETE mcp__ tool (machine-agnostic violation)', () => {
    expect(() =>
      scaffoldCapabilities({
        ...base,
        agents: { 'wf-reviewer': { description: 'd', prompt: 'p', tools: ['$cap:code-intelligence', 'mcp__serena__find_symbol'] } },
      }),
    ).toThrow(/concrete MCP tool/)
  })

  it('throws on an mcpServers field on an agent def', () => {
    expect(() =>
      scaffoldCapabilities({
        ...base,
        agents: { 'wf-reviewer': { description: 'd', prompt: 'p', tools: [], mcpServers: [{ e: { command: 'x' } }] } as never },
      }),
    ).toThrow(/must not declare mcpServers/)
  })

  it('throws on an omitted tools allowlist (fail-open guard, never silently accepted)', () => {
    expect(() =>
      scaffoldCapabilities({ ...base, agents: { 'wf-reviewer': { description: 'd', prompt: 'p' } as never } }),
    ).toThrow(/no tools allowlist/)
  })

  it('throws on a $cap:<need> not declared in the role needs (typo)', () => {
    expect(() =>
      scaffoldCapabilities({
        ...base,
        agents: { 'wf-reviewer': { description: 'd', prompt: 'p', tools: ['$cap:code-inteligence'] } },
      }),
    ).toThrow(/not declared in its role needs/)
  })

  it('throws on a role referencing an unknown agent', () => {
    expect(() =>
      scaffoldCapabilities({ name: 'x', roles: { reviewer: { agent: 'ghost', needs: [] } }, agents: {} }),
    ).toThrow(/references unknown agent 'ghost'/)
  })

  it('throws on a structurally malformed sidecar (roles not an object)', () => {
    expect(() =>
      scaffoldCapabilities({ name: 'x', roles: 'nope', agents: {} } as unknown as CapabilitiesScaffoldSpec),
    ).toThrow(/sidecar\.roles must be an object/)
  })

  it('throws on a non-kebab name (must equal the workflow meta.name)', () => {
    expect(() => scaffoldCapabilities({ ...base, name: 'PR Review' })).toThrow(/invalid name/)
  })
})

// E2E: the emitted artifact is not just self-consistent — it is CONSUMABLE by the real
// launch resolver. Emit → resolve against a registry → project into the shipped spec.
describe('scaffoldCapabilities — the emitted sidecar round-trips through the launch resolver', () => {
  const registry: CapabilityRegistry = {
    version: 1,
    providers: {
      'code-intelligence': [
        { name: 'serena', mcpServers: { serena: { command: 'uvx', args: ['serena', '--project', '$CWD'] } }, tools: ['mcp__serena__*'], protocolHint: 'Use symbolic tools.' },
      ],
    },
  }

  it('emit → resolveCapabilities → sidecarToCapabilitiesSpec yields a valid spec with $cap expanded', () => {
    const sidecar = JSON.parse(scaffoldCapabilities(base)) as CapabilitySidecar
    const needs: CapabilityNeed[] = Object.values(sidecar.roles).flatMap((r) => r.needs)
    const resolutions = resolveCapabilities(needs, registry, { availability: { serena: true }, webAvailable: true })
    const { spec, errors } = sidecarToCapabilitiesSpec(sidecar, resolutions)
    expect(errors).toEqual([])
    expect(spec).not.toBeNull()
    // the $cap:code-intelligence placeholder resolved to the provider's tools + mount
    expect(spec?.agents?.['wf-reviewer']?.tools).toEqual(['Read', 'mcp__serena__*'])
    expect(Object.keys(spec?.mcpServers ?? {})).toEqual(['serena'])
  })
})

describe('capabilitiesLaunchHint — the placement + resolution + adoption guidance', () => {
  it('is pure and names the filename adjacency + machine-registry resolution', () => {
    const hint = capabilitiesLaunchHint(base)
    expect(capabilitiesLaunchHint(base)).toBe(hint)
    expect(hint).toContain('pr-review.capabilities.json')
    expect(hint).toContain('workflows/pr-review.js')
    expect(hint).toMatch(/MACHINE registry/)
    expect(hint).toMatch(/\$cap:<need>/)
  })

  it('teaches the adoption discipline (task-prompt instruction + remove the alternative)', () => {
    const hint = capabilitiesLaunchHint(base)
    expect(hint).toMatch(/TASK prompt/)
    expect(hint).toMatch(/keep the alternative OUT of the allowlist/)
    expect(hint).toContain('reviewer')
  })

  it('states the bare default when there are no tooled roles', () => {
    const hint = capabilitiesLaunchHint({ ...base, roles: {} })
    expect(hint).toMatch(/bare default/)
  })
})

describe('assertCapabilitiesScaffoldSpec', () => {
  it('accepts a well-formed spec object', () => {
    expect(() => assertCapabilitiesScaffoldSpec(base)).not.toThrow()
  })

  it('rejects a non-object', () => {
    expect(() => assertCapabilitiesScaffoldSpec(null)).toThrow(/JSON object/)
    expect(() => assertCapabilitiesScaffoldSpec('nope')).toThrow(/JSON object/)
  })

  it('rejects a missing name (drives the filename)', () => {
    expect(() => assertCapabilitiesScaffoldSpec({ roles: {}, agents: {} })).toThrow(/spec\.name must be a string/)
  })
})
