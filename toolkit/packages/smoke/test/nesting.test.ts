// nesting.test.ts — unit tests for the pure pieces of canary C1: re-verifying the
// claim "workflow() throws when called inside a child workflow (one nesting level
// only)" (manually verified once, 2026-06-05; see docs/public/architecture.md §2.2
// and plugin/skills/workflow-composer/references/api-reference.md). judgeNesting is
// tested against synthetic result objects (to pin the verdict logic) AND against a
// REAL round-trip result captured live from the runtime
// (test/fixtures/nesting-depth2-result.json) — the actual `result` field a
// completed parent→child→grandchild run wrote to its task_notification output
// file. No agent runs here — part of `pnpm test`.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canonicalizeReason } from '../src/edge.js'
import {
  CHILD_NAME,
  childScript,
  GRANDCHILD_NAME,
  grandchildScript,
  judgeNesting,
  PARENT_NAME,
  parentScript,
} from '../src/nesting.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixtureResult = (name: string): unknown => {
  const parsed = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
  return parsed['result']
}

describe('script generators', () => {
  it('grandchildScript is meta-first and returns a trivial marker', () => {
    const s = grandchildScript()
    expect(s.trimStart().startsWith('export const meta')).toBe(true)
    expect(s).toContain(GRANDCHILD_NAME)
  })

  it('childScript is meta-first, embeds the grandchild path, and never lets the nested throw escape', () => {
    const s = childScript('/tmp/wt-canary-xyz/wt-canary-nest-grandchild.js')
    expect(s.trimStart().startsWith('export const meta')).toBe(true)
    expect(s).toContain(JSON.stringify('/tmp/wt-canary-xyz/wt-canary-nest-grandchild.js'))
    expect(s).toContain('try')
    expect(s).toContain('catch')
    expect(s).toContain(CHILD_NAME)
  })

  it('parentScript is meta-first and embeds the child path', () => {
    const s = parentScript('/tmp/wt-canary-xyz/wt-canary-nest-child.js')
    expect(s.trimStart().startsWith('export const meta')).toBe(true)
    expect(s).toContain(JSON.stringify('/tmp/wt-canary-xyz/wt-canary-nest-child.js'))
    expect(s).toContain(PARENT_NAME)
  })
})

describe('judgeNesting (verdict logic)', () => {
  const okResult = {
    marker: CHILD_NAME,
    grandchildRejected: true,
    rejectionMessage:
      'workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.',
    grandchildResult: null,
  }

  it('PASSES both checks when depth-1 ran and depth-2 was rejected for a nesting-shaped reason', () => {
    const checks = judgeNesting(okResult)
    expect(checks).toHaveLength(2)
    expect(checks.every((c) => c.ok)).toBe(true)
  })

  it('attaches a canonicalReason to the PASSING depth-2 check, wiring it into the wording-drift detector', () => {
    const checks = judgeNesting(okResult)
    const depth2 = checks.find((c) => c.name.includes('depth-2'))
    expect(depth2?.canonicalReason).toBe(canonicalizeReason(okResult.rejectionMessage))
    expect(depth2?.canonicalReason).toBeTruthy()
  })

  it('depth-1 check FAILS when the result is not an object (parent never got a readable result)', () => {
    const checks = judgeNesting(undefined)
    const depth1 = checks.find((c) => c.name.includes('depth-1'))
    expect(depth1?.ok).toBe(false)
    expect(depth1?.detail).toMatch(/not an object/)
  })

  it('depth-1 check FAILS when the child marker is missing (parent did not reach/run the child)', () => {
    const checks = judgeNesting({ marker: 'someone-else', grandchildRejected: true })
    const depth1 = checks.find((c) => c.name.includes('depth-1'))
    expect(depth1?.ok).toBe(false)
    expect(depth1?.detail).toMatch(/marker/)
  })

  it('depth-2 check FAILS (the regression) when the grandchild call was NOT rejected', () => {
    const checks = judgeNesting({
      marker: CHILD_NAME,
      grandchildRejected: false,
      grandchildResult: { marker: GRANDCHILD_NAME },
    })
    const depth1 = checks.find((c) => c.name.includes('depth-1'))
    const depth2 = checks.find((c) => c.name.includes('depth-2'))
    expect(depth1?.ok).toBe(true) // depth-1 still ran fine — isolates the failure to depth-2
    expect(depth2?.ok).toBe(false)
    expect(depth2?.detail).toMatch(/ALLOWED|regression/i)
  })

  it('depth-2 check FAILS when rejected, but the message does not look nesting-related (wording drift)', () => {
    const checks = judgeNesting({
      marker: CHILD_NAME,
      grandchildRejected: true,
      rejectionMessage: 'some unrelated parse error',
    })
    const depth2 = checks.find((c) => c.name.includes('depth-2'))
    expect(depth2?.ok).toBe(false)
    expect(depth2?.detail).toMatch(/did not look like/)
    expect(depth2?.canonicalReason).toBe(canonicalizeReason('some unrelated parse error'))
  })

  it('depth-1 check does not depend on depth-2 outcome (isolated failure attribution)', () => {
    // A broken workflow() that makes the CHILD itself never run (marker missing)
    // must fail depth-1, regardless of what grandchildRejected says.
    const checks = judgeNesting({ marker: null, grandchildRejected: true })
    const depth1 = checks.find((c) => c.name.includes('depth-1'))
    expect(depth1?.ok).toBe(false)
  })
})

describe('judgeNesting against a REAL captured round-trip result', () => {
  it('the depth-2 workflow() call is really rejected by the current runtime', () => {
    const result = fixtureResult('nesting-depth2-result.json')
    const checks = judgeNesting(result)
    expect(checks.every((c) => c.ok)).toBe(true)
  })

  it('the depth-2 check carries a canonicalized reason from the real rejection message', () => {
    const result = fixtureResult('nesting-depth2-result.json') as { rejectionMessage: string }
    const checks = judgeNesting(result)
    const depth2 = checks.find((c) => c.name.includes('depth-2'))
    expect(depth2?.canonicalReason).toBe(canonicalizeReason(result.rejectionMessage))
  })
})
