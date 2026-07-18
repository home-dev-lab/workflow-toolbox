// docs-butler-observer.test.ts — gate for the committed docs-butler observer example
// (card C8). The committed pair spec → emitted artifact must stay byte-identical to
// what the shipped scaffolder emits (same anti-drift shape as plugin-bundle-identity),
// and the artifact must pass the SHARED validator the launch bridge fails loud on.
// TDD: written before the example files exist (RED step).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scaffoldObserver, assertObserverScaffoldSpec } from '@workflow-toolbox/scaffold'
import type { ObserverScaffoldSpec } from '@workflow-toolbox/scaffold'
import { validateObserverDefinition } from '@workflow-toolbox/debugger/observer-def'

const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPEC_PATH = join(EXAMPLES_DIR, 'docs-butler.spec.json')
const ARTIFACT_PATH = join(EXAMPLES_DIR, 'docs-butler.observer.json')

function readSpec(): ObserverScaffoldSpec {
  const parsed = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as unknown
  assertObserverScaffoldSpec(parsed)
  return parsed
}

describe('docs-butler committed example — spec/artifact identity', () => {
  it('the committed spec is a valid ObserverScaffoldSpec', () => {
    expect(() => readSpec()).not.toThrow()
  })

  it('the committed artifact is byte-identical to what the shipped scaffolder emits from the committed spec (regenerate: pnpm wt:scaffold observer examples/docs-butler.spec.json --out-dir examples)', () => {
    const emitted = scaffoldObserver(readSpec())
    const committed = readFileSync(ARTIFACT_PATH, 'utf8')
    expect(committed).toBe(emitted)
  })

  it('the committed artifact passes the SHARED validator with zero violations', () => {
    const parsed = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as unknown
    const errors: string[] = []
    validateObserverDefinition(parsed, 'observer', errors)
    expect(errors).toEqual([])
  })
})

describe('docs-butler committed example — reference-case semantic locks (design §7)', () => {
  function artifact(): Record<string, unknown> {
    return JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as Record<string, unknown>
  }

  it('watches the long-running roles implementer and fixer', () => {
    const watch = artifact()['watch'] as { roles?: string[] }
    expect(watch.roles).toEqual(['implementer', 'fixer'])
  })

  it('may emit observer.hint and carries the coupled wt-comm action (bidirectional coherence)', () => {
    const a = artifact()
    expect(a['emits']).toEqual(['observer.hint'])
    expect(a['actions']).toEqual(['summary', 'nudge', 'wt-comm'])
  })

  it('requires docs-lookup (hard) and code-intelligence (optional) — abstract needs only', () => {
    const requires = artifact()['requires'] as { need: string; optional?: boolean }[]
    expect(requires).toHaveLength(2)
    const docsLookup = requires.find((r) => r.need === 'docs-lookup')
    const codeIntel = requires.find((r) => r.need === 'code-intelligence')
    expect(docsLookup).toBeDefined()
    expect(docsLookup?.optional).not.toBe(true)
    expect(codeIntel?.optional).toBe(true)
  })

  it('cadence respects the schema floor and the brain pins the cheap default model', () => {
    const a = artifact()
    expect(a['cadenceMs']).toBeGreaterThanOrEqual(60000)
    const brain = a['brain'] as { model?: string }
    expect(brain.model).toBe('claude-haiku-4-5')
  })
})
