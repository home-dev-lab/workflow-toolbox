// observer-canaries.test.ts — the ONE thing about the live runner that is
// cheap to prove without spending an SDK launch: the flag-absent early return.
// runObserverCanaries() takes `env` as a parameter (not process.env directly)
// specifically so this path is reachable without touching real env or the
// network — it must short-circuit before ever calling query().

import { describe, expect, it } from 'vitest'
import { runObserverCanaries } from '../src/observer-canaries.js'

describe('runObserverCanaries — flag-absent path', () => {
  it('reports every leg NOT_MEASURED and spends zero live launches when the flag is unset', async () => {
    const { checks } = await runObserverCanaries({})
    expect(checks.map((c) => c.name)).toEqual([
      'observer-flag-present',
      'observer-positive-control',
      'observer-report-tool',
      'observer-sendmessage-refused',
      'observer-named-headless',
    ])
    expect(checks.every((c) => c.ok)).toBe(true)
    for (const c of checks.slice(1)) expect(c.detail).toMatch(/^\[NOT_MEASURED\]/)
  })

  it('also short-circuits when the flag is "0"', async () => {
    const { checks } = await runObserverCanaries({ CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: '0' })
    expect(checks[0]?.detail).toMatch(/is NOT set/)
    expect(checks.slice(1).every((c) => c.ok && c.detail.startsWith('[NOT_MEASURED]'))).toBe(true)
  })
})
