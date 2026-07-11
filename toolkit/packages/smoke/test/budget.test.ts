// budget.test.ts — unit tests for the pure pieces of canary C2: re-verifying
// the claim "two orchestrator-launched Workflow runs have SEPARATE budget
// pools" (budget.spent() does not leak across two independent SDK sessions).
// judgeBudget is tested against synthetic probe results — no agent runs here —
// part of `pnpm test`.

import { describe, expect, it } from 'vitest'
import { budgetProbeScript, BUDGET_COUNTER_NAME, BUDGET_ISOLATION_NAME, judgeBudget } from '../src/budget.js'

describe('budgetProbeScript', () => {
  it('is meta-first, meta is a pure JSON-shaped literal, and the label is embedded', () => {
    const s = budgetProbeScript('a')
    expect(s.trimStart().startsWith('export const meta')).toBe(true)
    expect(s).toContain('"name": "wt-canary-budget-a"')
    expect(s).toContain('"description": "C2 budget-pool probe a"')
  })

  it('produces a distinct script per label', () => {
    const a = budgetProbeScript('a')
    const b = budgetProbeScript('b')
    expect(a).not.toBe(b)
    expect(a).toContain('wt-canary-budget-a')
    expect(b).toContain('wt-canary-budget-b')
  })

  it('reads budget.spent()/budget.total around one real agent() call and returns the raw numbers', () => {
    const s = budgetProbeScript('a')
    expect(s).toContain('budget.spent()')
    expect(s).toContain('budget.total')
    expect(s).toContain('await agent(')
    expect(s).toContain('spentAtStart')
    expect(s).toContain('spentAfter')
    expect(s).toContain('return {')
  })

  it('the meta line itself parses as valid JSON once the export/const prefix is stripped', () => {
    const s = budgetProbeScript('b')
    const metaLine = s.split('\n')[0] as string
    const jsonText = metaLine.replace(/^export const meta = /, '')
    expect(() => JSON.parse(jsonText)).not.toThrow()
    const parsed = JSON.parse(jsonText) as { name: string; description: string }
    expect(parsed.name).toBe('wt-canary-budget-b')
  })
})

describe('judgeBudget (verdict logic)', () => {
  it('PASSES both checks when both counters advanced and second started with a fresh, near-zero pool', () => {
    const first = { spentAtStart: 0, spentAfter: 500 }
    const second = { spentAtStart: 0, spentAfter: 480 }
    const checks = judgeBudget({ first, second })
    expect(checks).toHaveLength(2)
    expect(checks.every((c) => c.ok)).toBe(true)
    expect(checks.find((c) => c.name === BUDGET_COUNTER_NAME)?.detail).toMatch(/0/)
    expect(checks.find((c) => c.name === BUDGET_ISOLATION_NAME)?.detail).toMatch(/below A's final spend/)
  })

  it('every detail string carries the raw observed numbers (evidence, not just a verdict)', () => {
    const first = { spentAtStart: 10, spentAfter: 600 }
    const second = { spentAtStart: 5, spentAfter: 450 }
    const checks = judgeBudget({ first, second })
    for (const c of checks) {
      expect(c.detail).toMatch(/spentAtStart=10/)
      expect(c.detail).toMatch(/spentAfter=600/)
      expect(c.detail).toMatch(/spentAtStart=5/)
      expect(c.detail).toMatch(/spentAfter=450/)
    }
  })

  it('FAILS the isolation check (the regression) when second inherits first\'s spend — a shared pool', () => {
    const first = { spentAtStart: 0, spentAfter: 500 }
    const second = { spentAtStart: 500, spentAfter: 900 } // second starts exactly where first left off
    const checks = judgeBudget({ first, second })
    const counter = checks.find((c) => c.name === BUDGET_COUNTER_NAME)
    const isolation = checks.find((c) => c.name === BUDGET_ISOLATION_NAME)
    expect(counter?.ok).toBe(true) // the counter itself still works — isolates the failure to isolation
    expect(isolation?.ok).toBe(false)
    expect(isolation?.detail).toMatch(/inherited|shared pool|at or above/i)
  })

  it('argument order is load-bearing: judging the SAME shared-pool fixture with first/second SWAPPED flips a real leak into a false PASS', () => {
    // This is exactly why judgeBudget takes a labeled { first, second } object
    // instead of two positional `unknown` params: a genuine leak (isolation
    // FAILS in the correct order, tested above) becomes an undetected false
    // PASS if a call site ever transposes which run is which. Naming the
    // fields doesn't make a swap impossible, but it makes it a visible,
    // deliberate typo (`{ first: b, second: a }`) instead of an invisible
    // argument-order slip a plain (unknown, unknown) signature permits.
    const leakedFirst = { spentAtStart: 0, spentAfter: 500 }
    const leakedSecond = { spentAtStart: 500, spentAfter: 900 }
    const correctOrder = judgeBudget({ first: leakedFirst, second: leakedSecond })
    const swappedOrder = judgeBudget({ first: leakedSecond, second: leakedFirst })
    expect(correctOrder.find((c) => c.name === BUDGET_ISOLATION_NAME)?.ok).toBe(false)
    expect(swappedOrder.find((c) => c.name === BUDGET_ISOLATION_NAME)?.ok).toBe(true)
  })

  it('FAILS the isolation check at the exact boundary — second starting AT first\'s final spend is not isolated', () => {
    // isolationOk requires spentAtStart < spentAfter (strict, no margin) — equality fails.
    const first = { spentAtStart: 0, spentAfter: 500 }
    const second = { spentAtStart: 500, spentAfter: 700 }
    const checks = judgeBudget({ first, second })
    const isolation = checks.find((c) => c.name === BUDGET_ISOLATION_NAME)
    expect(isolation?.ok).toBe(false)
  })

  it('PASSES with a non-zero per-launch baseline that is well below first\'s final spend (no margin required)', () => {
    // A real session-launch overhead (~130-140) observed live on BOTH probes —
    // no arbitrary safety margin needed, just strict less-than.
    const first = { spentAtStart: 136, spentAfter: 253 }
    const second = { spentAtStart: 133, spentAfter: 294 }
    const checks = judgeBudget({ first, second })
    expect(checks.every((c) => c.ok)).toBe(true)
  })

  it('double-fails (counter AND isolation) when the counter is inert — never gives isolation a hollow pass', () => {
    const first = { spentAtStart: 0, spentAfter: 0 }
    const second = { spentAtStart: 0, spentAfter: 0 }
    const checks = judgeBudget({ first, second })
    const counter = checks.find((c) => c.name === BUDGET_COUNTER_NAME)
    const isolation = checks.find((c) => c.name === BUDGET_ISOLATION_NAME)
    expect(counter?.ok).toBe(false)
    expect(counter?.detail).toMatch(/inert/)
    expect(isolation?.ok).toBe(false)
    expect(isolation?.detail).toMatch(/skipped/i)
    expect(isolation?.detail).toMatch(/inert/)
  })

  it('double-fails when only ONE side is inert (asymmetric inertness is still not isolation-observable)', () => {
    const first = { spentAtStart: 0, spentAfter: 500 } // advanced
    const second = { spentAtStart: 0, spentAfter: 0 } // inert
    const checks = judgeBudget({ first, second })
    const counter = checks.find((c) => c.name === BUDGET_COUNTER_NAME)
    const isolation = checks.find((c) => c.name === BUDGET_ISOLATION_NAME)
    expect(counter?.ok).toBe(false)
    expect(isolation?.ok).toBe(false)
  })

  it('FAILS both checks honestly when a result is not an object at all (malformed)', () => {
    const checks = judgeBudget({ first: undefined, second: { spentAtStart: 0, spentAfter: 500 } })
    const counter = checks.find((c) => c.name === BUDGET_COUNTER_NAME)
    const isolation = checks.find((c) => c.name === BUDGET_ISOLATION_NAME)
    expect(counter?.ok).toBe(false)
    expect(counter?.detail).toMatch(/unreadable/)
    expect(counter?.detail).toMatch(/A/)
    expect(isolation?.ok).toBe(false)
    expect(isolation?.detail).toMatch(/skipped/i)
  })

  it('FAILS both checks honestly when fields are present but not numeric (malformed)', () => {
    const checks = judgeBudget({
      first: { spentAtStart: '0', spentAfter: 500 },
      second: { spentAtStart: 0, spentAfter: 400 },
    })
    expect(checks.every((c) => !c.ok)).toBe(true)
  })

  it('FAILS both checks and names BOTH sides when both results are unreadable', () => {
    const checks = judgeBudget({ first: null, second: 'not an object' })
    const counter = checks.find((c) => c.name === BUDGET_COUNTER_NAME)
    expect(counter?.detail).toMatch(/both A and B/)
  })

  it('never invents numbers — an unreadable side is reported as unreadable, not as 0', () => {
    const checks = judgeBudget({ first: undefined, second: { spentAtStart: 0, spentAfter: 500 } })
    const counter = checks.find((c) => c.name === BUDGET_COUNTER_NAME)
    expect(counter?.detail).toMatch(/unreadable/)
    expect(counter?.detail).not.toMatch(/spentAtStart=0, spentAfter=0.*A/) // A must not be silently zero-filled
  })
})
