// capability-scout-example.test.ts — locks the committed reference example's
// HAND-WRITTEN capability sidecar (card I5, design §10 I5 + NIT-11).
//
// Two contracts this gate holds:
//  1. Every committed toolkit/workflows/*.capabilities.json is machine-agnostic
//     — it passes lintSidecarMachineAgnostic (the MAJOR-2 launch-time guard: no
//     concrete mcp__ token, no mcpServers on an agent def, exact tool allowlists).
//     I5 writes the FIRST such sidecar by hand, so this is the first thing the
//     guard ever ran against outside a fake unit fixture.
//  2. The capability-scout example resolves & degrades EXACTLY as the design's
//     code-intelligence vocabulary says (§4.3): resolved (serena available) →
//     [Read, mcp__serena__*] + serena mounted; degraded (bare machine) →
//     [Read, Grep, Glob] with nothing mounted. This is the unit twin of the e2e
//     acceptance — it locks the two profiles without a model call.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  lintSidecarMachineAgnostic,
  resolveCapabilities,
  sidecarToCapabilitiesSpec,
  type CapabilityRegistry,
  type CapabilitySidecar,
} from '../src/capability-registry.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WORKFLOWS_DIR = join(REPO_ROOT, 'toolkit/workflows')

const readSidecar = (name: string): CapabilitySidecar =>
  JSON.parse(readFileSync(join(WORKFLOWS_DIR, name), 'utf8')) as CapabilitySidecar

// A registry with a probe-able serena code-intelligence provider — the design
// §4.2 / capability-registry.test.ts fixture, verbatim. Availability is injected
// (no probe runs here): the resolver is pure once availability is known.
const serenaRegistry: CapabilityRegistry = {
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
  },
}
// A bare machine: no registry providers at all → every need degrades.
const bareRegistry: CapabilityRegistry = { version: 1, providers: {} }

describe('committed capability sidecars — machine-agnostic (MAJOR-2 guard)', () => {
  const sidecars = readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.capabilities.json'))
    .sort()

  it('there is at least one committed sidecar to cover', () => {
    expect(sidecars.length).toBeGreaterThan(0)
  })

  for (const name of sidecars) {
    it(`${name} is machine-agnostic (lintSidecarMachineAgnostic → no findings)`, () => {
      expect(lintSidecarMachineAgnostic(readSidecar(name))).toEqual([])
    })
  }
})

describe('capability-scout reference example — resolved vs degraded profiles', () => {
  it('declares exactly one code-intelligence role bound to the code-scout agent', () => {
    const sidecar = readSidecar('capability-scout.capabilities.json')
    const role = sidecar.roles.scout!
    expect(role.agent).toBe('code-scout')
    expect(role.needs).toEqual([{ need: 'code-intelligence' }])
    // the agent tools use ONLY a $cap placeholder + a non-MCP builtin (Read)
    expect(sidecar.agents['code-scout']!.tools).toEqual(['Read', '$cap:code-intelligence'])
  })

  it('the built workflow binds agentType to the sidecar agent key (rename-drift lock)', () => {
    // The whole example hinges on SDK name-matching: rt.agent({agentType:'X'}) ⟷
    // sidecar.agents['X']. If a future edit renames one side and not the other, the
    // composed identity is never used and capability resolution silently no-ops at
    // launch (the run still "succeeds"). Lock the binding against that drift.
    const sidecar = readSidecar('capability-scout.capabilities.json')
    const artifact = readFileSync(join(WORKFLOWS_DIR, 'capability-scout.js'), 'utf8')
    for (const [roleName, role] of Object.entries(sidecar.roles)) {
      expect(
        sidecar.agents[role.agent],
        `role '${roleName}' points at undeclared agent '${role.agent}'`,
      ).toBeDefined()
      const spawnsIt = new RegExp(`agentType:\\s*['"]${role.agent}['"]`).test(artifact)
      expect(
        spawnsIt,
        `built capability-scout.js never spawns agentType '${role.agent}' — rename drift between sidecar and workflow`,
      ).toBe(true)
    }
  })

  it('RESOLVED (serena available): tools expand to [Read, mcp__serena__*] and serena mounts', () => {
    const sidecar = readSidecar('capability-scout.capabilities.json')
    const resolutions = resolveCapabilities(sidecar.roles.scout!.needs, serenaRegistry, {
      availability: { serena: true },
    })
    const { spec, errors } = sidecarToCapabilitiesSpec(sidecar, resolutions)
    expect(errors).toEqual([])
    expect(spec).not.toBeNull()
    expect(spec!.agents!['code-scout']!.tools).toEqual(['Read', 'mcp__serena__*'])
    expect(spec!.mcpServers).toMatchObject({ serena: { command: 'uvx' } })
  })

  it('DEGRADED (bare machine): tools expand to [Read, Grep, Glob] with nothing mounted', () => {
    const sidecar = readSidecar('capability-scout.capabilities.json')
    const resolutions = resolveCapabilities(sidecar.roles.scout!.needs, bareRegistry, {})
    const { spec, errors } = sidecarToCapabilitiesSpec(sidecar, resolutions)
    expect(errors).toEqual([])
    expect(spec).not.toBeNull()
    expect(spec!.agents!['code-scout']!.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(spec!.mcpServers).toBeUndefined()
  })
})
