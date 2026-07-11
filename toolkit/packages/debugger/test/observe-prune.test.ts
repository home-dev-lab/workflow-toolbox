import { describe, it, expect } from 'vitest'
import {
  selectRuns,
  runNameFromScript,
  parseDurationMs,
  pathsToDelete,
  DEFAULT_TEST_PREFIXES,
  type PruneRunRecord,
} from '../src/observe-prune.js'

const NOW = 1_000_000_000
function rec(over: Partial<PruneRunRecord>): PruneRunRecord {
  const runId = over.runId ?? 'wf_x'
  return {
    runId,
    // 'in' checks (not ??) so an explicit null for name/scriptPath is preserved, not defaulted.
    name: 'name' in over ? (over.name ?? null) : 'probe-thing',
    mtimeMs: over.mtimeMs ?? NOW,
    jsonPath: over.jsonPath ?? `/c/projects/s/sess/workflows/${runId}.json`,
    scriptPath: 'scriptPath' in over ? (over.scriptPath ?? null) : `/c/projects/s/sess/workflows/scripts/probe-thing-${runId}.js`,
    sidecarDir: over.sidecarDir ?? `/c/projects/s/sess/subagents/workflows/${runId}`,
  }
}

describe('selectRuns', () => {
  const probe = rec({ runId: 'wf_probe', name: 'probe-agent-injection' })
  const test_ = rec({ runId: 'wf_test', name: '_test-thing' })
  const prod = rec({ runId: 'wf_prod', name: 'pr-review' })

  it('exact runId wins outright and ignores name/age', () => {
    expect(selectRuns([probe, prod], { runId: 'wf_prod', nowMs: NOW })).toEqual([prod])
  })

  it('with no criteria, matches ONLY the reserved test prefixes (never production)', () => {
    const got = selectRuns([probe, test_, prod], { nowMs: NOW })
    expect(got.map((r) => r.runId).sort()).toEqual(['wf_probe', 'wf_test'])
  })

  it('an explicit name-prefix overrides the default (targets a production run by name)', () => {
    expect(selectRuns([probe, prod], { namePrefixes: ['pr-'], nowMs: NOW }).map((r) => r.runId)).toEqual(['wf_prod'])
  })

  it("an explicit empty prefix ('') is the documented match-ALL escape hatch", () => {
    expect(selectRuns([probe, prod], { namePrefixes: [''], nowMs: NOW }).length).toBe(2)
  })

  it('age alone (no explicit prefix) can NOT sweep a production run — prefix gate still applies', () => {
    const oldProd = rec({ runId: 'wf_oldprod', name: 'pr-review', mtimeMs: NOW - 10 * 3_600_000 })
    const got = selectRuns([oldProd], { olderThanMs: 3_600_000, nowMs: NOW })
    expect(got).toEqual([]) // old, but not a test run and no explicit prefix → protected
  })

  it('age gate narrows test runs: only those at least olderThanMs old match', () => {
    const fresh = rec({ runId: 'wf_fresh', name: 'probe-a', mtimeMs: NOW - 60_000 })
    const stale = rec({ runId: 'wf_stale', name: 'probe-b', mtimeMs: NOW - 3 * 3_600_000 })
    const got = selectRuns([fresh, stale], { olderThanMs: 3_600_000, nowMs: NOW })
    expect(got.map((r) => r.runId)).toEqual(['wf_stale'])
  })

  it('a run with no recoverable name is never matched by prefix (only by explicit runId)', () => {
    const nameless = rec({ runId: 'wf_nameless', name: null })
    expect(selectRuns([nameless], { nowMs: NOW })).toEqual([])
    expect(selectRuns([nameless], { runId: 'wf_nameless', nowMs: NOW })).toEqual([nameless])
  })

  it('DEFAULT_TEST_PREFIXES covers probe-/_probe-/_test-', () => {
    expect(DEFAULT_TEST_PREFIXES).toContain('probe-')
    expect(DEFAULT_TEST_PREFIXES).toContain('_probe-')
    expect(DEFAULT_TEST_PREFIXES).toContain('_test-')
  })
})

describe('runNameFromScript', () => {
  it('strips the -<runId>.js suffix to recover meta.name', () => {
    expect(runNameFromScript('probe-agent-injection-wf_cde50091-be4.js', 'wf_cde50091-be4')).toBe('probe-agent-injection')
  })
  it('returns null when the filename does not carry the runId suffix', () => {
    expect(runNameFromScript('other-wf_zzz.js', 'wf_cde50091-be4')).toBeNull()
  })
  it('returns null for an empty name (a script that is just the runId)', () => {
    expect(runNameFromScript('-wf_x.js', 'wf_x')).toBeNull()
  })
})

describe('parseDurationMs', () => {
  it.each([
    ['45s', 45_000],
    ['30m', 1_800_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
    ['500ms', 500],
    ['1500', 1500], // bare integer = ms
  ])('parses %s → %d ms', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected)
  })
  it.each(['', 'abc', '2w', '-3h', '2.5h'])('returns null for unparseable %s', (input) => {
    expect(parseDurationMs(input)).toBeNull()
  })
})

describe('pathsToDelete', () => {
  it('collects json + script + sidecar, dropping a null script', () => {
    const r = rec({ runId: 'wf_x', scriptPath: null })
    expect(pathsToDelete(r)).toEqual([r.jsonPath, r.sidecarDir])
  })
})
