import { describe, it, expect } from 'vitest'
import { scaffoldObserver, assertObserverScaffoldSpec, observerLaunchHint } from '../src/scaffold.js'
import type { ObserverScaffoldSpec } from '../src/scaffold.js'
import { validateObserverDefinition } from '@workflow-toolbox/debugger/observer-def'

// A minimal, valid abstract observer declaration (no concrete tool, no machine path).
const base: ObserverScaffoldSpec = {
  name: 'docs-butler',
  description: 'Watches long-running implementer agents and supplies sourced docs context.',
  watch: { roles: ['implementer'] },
  brain: {
    mandate: 'Watch the agent transcript delta; when external documentation would materially help, fetch the minimal excerpt and emit one observer.hint with full provenance. Otherwise stay silent.',
  },
}

/** Parse the emitted artifact and run it back through the SHARED validator — the
 *  emitter must NEVER produce a definition the shipped contract would reject. */
function validateEmitted(source: string): string[] {
  const parsed = JSON.parse(source) as unknown
  const errors: string[] = []
  validateObserverDefinition(parsed, 'observer', errors)
  return errors
}

describe('scaffoldObserver — emission', () => {
  it('is a pure function: same spec → byte-identical output', () => {
    expect(scaffoldObserver(base)).toBe(scaffoldObserver(base))
  })

  it('emits schemaVersion 1 and a trailing newline', () => {
    const json = scaffoldObserver(base)
    expect(json.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed['schemaVersion']).toBe(1)
    expect(parsed['name']).toBe('docs-butler')
  })

  it('emits a definition that PASSES the shipped shared validator (round-trip, 0 errors)', () => {
    expect(validateEmitted(scaffoldObserver(base))).toEqual([])
  })

  it('emits the optional emits/actions/requires when the spec declares them, still valid', () => {
    const json = scaffoldObserver({
      ...base,
      cadenceMs: 300000,
      emits: ['observer.hint'],
      actions: ['summary', 'nudge', 'wt-comm'],
      requires: [{ need: 'docs-lookup' }, { need: 'code-intelligence', optional: true }],
    })
    expect(validateEmitted(json)).toEqual([])
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed['emits']).toEqual(['observer.hint'])
    expect(parsed['actions']).toEqual(['summary', 'nudge', 'wt-comm'])
  })
})

describe('scaffoldObserver — validation is REUSED from the shared contract, never duplicated', () => {
  it('surfaces the coherence violation (emits without the wt-comm action) as a throw', () => {
    expect(() => scaffoldObserver({ ...base, emits: ['observer.hint'] })).toThrow(
      /emits is declared but actions lacks 'wt-comm'/,
    )
  })

  it('surfaces a non-emittable wt-comm type (shared validator message)', () => {
    expect(() =>
      scaffoldObserver({ ...base, emits: ['decision.response'], actions: ['wt-comm'] }),
    ).toThrow(/observers may emit only/)
  })

  it('surfaces an empty watch selector', () => {
    expect(() => scaffoldObserver({ ...base, watch: {} })).toThrow(/at least one selector/)
  })

  it('surfaces a non-kebab name', () => {
    expect(() => scaffoldObserver({ ...base, name: 'Docs Butler' })).toThrow(/name must match/)
  })

  // TEST-LOCK critique m1: the scaffolder stamps schemaVersion, but a stray non-1 value in
  // untrusted raw JSON is NOT silently coerced — it fails loud in the shared validator.
  it('fails loud on a stray non-1 schemaVersion (never silently normalized)', () => {
    expect(() =>
      scaffoldObserver({ ...base, schemaVersion: 2 } as unknown as ObserverScaffoldSpec),
    ).toThrow(/schemaVersion must be the integer 1/)
  })

  it('emits schemaVersion first in the artifact', () => {
    const json = scaffoldObserver(base)
    expect(json.indexOf('"schemaVersion"')).toBeLessThan(json.indexOf('"name"'))
  })

  it('refuses a machine path in watch (transcriptFile) — workflow-owned artifact', () => {
    expect(() =>
      scaffoldObserver({ ...base, watch: { transcriptFile: '/abs/path.jsonl' } as never }),
    ).toThrow(/transcriptFile is a machine path/)
  })
})

describe('observerLaunchHint — the args bridge + selector coupling + observer-consumer reminder', () => {
  it('is pure and always names the args.observers launch bridge with the artifact filename', () => {
    const hint = observerLaunchHint(base)
    expect(observerLaunchHint(base)).toBe(hint)
    expect(hint).toContain('args.observers')
    expect(hint).toContain('SIBLING of args.capabilities')
    expect(hint).toContain('definitionFile: "docs-butler.observer.json"')
  })

  // TEST-LOCK critique M2: the label ⇔ watch.roles coupling (the no-match footgun) is
  // taught for EVERY observer, not only wt-comm ones.
  it('always teaches the label ⇔ selector coupling (the no-match footgun)', () => {
    const hint = observerLaunchHint(base)
    expect(hint).toMatch(/label/)
    expect(hint).toMatch(/no-match/)
    expect(hint).toContain('role(s) implementer')
  })

  // TEST-LOCK: wt-comm observer scaffolding now describes the shipped auto-injection
  // scope while preserving the canonical teaching-pack reference and residual caveats.
  it('when the observer emits wt-comm, references the canonical teaching and says auto-injection is shipped for defineWorkflow inline observers', () => {
    const hint = observerLaunchHint({
      ...base,
      watch: { roles: ['implementer', 'fixer'] },
      emits: ['observer.hint'],
      actions: ['summary', 'wt-comm'],
    })
    expect(hint).toContain('teaching/wt-comm-observer-consumer.md')
    expect(hint).toContain('role(s) implementer, fixer')
    expect(hint).toMatch(/never copy it/)
    expect(hint).toMatch(/auto-injected|auto-injection is shipped/i)
    expect(hint).toMatch(/defineWorkflow/)
    expect(hint).toMatch(/inline/i)
    expect(hint).toMatch(/WT_COMM_PARAMS/)
    expect(hint).toMatch(/definitionFile/)
    expect(hint).toContain('wt-observe launch --comm-root <dir>')
    expect(hint).not.toMatch(/NOT yet wired/)
    expect(hint).not.toMatch(/runtime never briefs/)
  })

  it('when the observer does NOT emit wt-comm, omits the observer-consumer reminder', () => {
    const hint = observerLaunchHint(base) // base has no wt-comm action
    expect(hint).not.toContain('wt-comm-observer-consumer.md')
  })
})

describe('assertObserverScaffoldSpec', () => {
  it('accepts a well-formed spec object', () => {
    expect(() => assertObserverScaffoldSpec(base)).not.toThrow()
  })

  it('rejects a non-object', () => {
    expect(() => assertObserverScaffoldSpec(null)).toThrow(/JSON object/)
    expect(() => assertObserverScaffoldSpec('nope')).toThrow(/JSON object/)
  })
})
