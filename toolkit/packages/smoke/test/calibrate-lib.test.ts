// calibrate-lib.test.ts — unit tests for the PURE budgetFloor-calibration core.
//
// These run in `pnpm test` (collected by the packages/*/test/**/*.test.ts glob).
// The live capture runner (src/calibrate.ts) is held out of the suite, like
// run.ts / canary-all.ts — only the deterministic logic is asserted here.
//
// Honesty contract under test (plan-critic H1/H2, B1): the runtime exposes NO
// per-agent token primitive, so calibration is a CROSS-RUN approximation. The
// derive math therefore (a) NEVER blends the authoritative budget.spent() signal
// with the unverified notification token signal into one mean — they are
// segregated; (b) does NOT attribute whole-run tokens to per-model buckets; and
// (c) yields a null recommendation (with a reason) when no token signal exists,
// rather than inventing a floor number.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  readTaskUsage,
  summarizeRun,
  deriveCalibration,
  recommendFloor,
  formatCalibrationReport,
  CALIBRATION_SCHEMA_VERSION,
  type RunStatsRecord,
} from '../src/calibrate-lib.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

// ---------------------------------------------------------------------------
// readTaskUsage — parse the (previously dropped) task_notification usage block
// ---------------------------------------------------------------------------

describe('readTaskUsage', () => {
  it('parses the usage block off a REAL captured task_notification fixture', () => {
    const msg: unknown = JSON.parse(
      readFileSync(join(FIXTURES, 'task-notification-completed.json'), 'utf8'),
    )
    expect(readTaskUsage(msg)).toEqual({
      totalTokens: 14854,
      toolUses: 2,
      durationMs: 8882,
    })
  })

  it('returns null when the message is not a task_notification', () => {
    expect(readTaskUsage({ type: 'system', subtype: 'init' })).toBeNull()
    expect(readTaskUsage({ type: 'assistant' })).toBeNull()
    expect(readTaskUsage(null)).toBeNull()
    expect(readTaskUsage('nope')).toBeNull()
  })

  it('degrades each field to null when usage is missing or malformed (canary discipline)', () => {
    expect(
      readTaskUsage({ type: 'system', subtype: 'task_notification' }),
    ).toEqual({ totalTokens: null, toolUses: null, durationMs: null })
    expect(
      readTaskUsage({
        type: 'system',
        subtype: 'task_notification',
        usage: { total_tokens: 'x', tool_uses: 2 },
      }),
    ).toEqual({ totalTokens: null, toolUses: 2, durationMs: null })
  })
})

// ---------------------------------------------------------------------------
// summarizeRun — parsed output file (+ optional usage) → one RunStatsRecord
// ---------------------------------------------------------------------------

const SYNTHETIC_OUTPUT = {
  summary: 'calibration probe',
  agentCount: 4,
  logs: [],
  result: {
    budgetSpent: 32000,
    claims: 4,
    votes: 1,
    envelope: {
      value: [],
      stats: { itemsIn: 4, itemsOut: 4, agentsSpawned: 4, dropped: 0, truncated: 0 },
      warnings: [],
      trail: [
        { stage: 'adversarialVerification:verify:0:0', outcome: 'ok', model: 'haiku' },
        { stage: 'adversarialVerification:verify:1:0', outcome: 'ok', model: 'haiku' },
        { stage: 'adversarialVerification:verify:2:0', outcome: 'ok', model: 'haiku' },
        { stage: 'adversarialVerification:verify:3:0', outcome: 'ok', model: 'haiku' },
      ],
    },
  },
}

const TS = '2026-06-08T00:00:00.000Z'

describe('summarizeRun', () => {
  it('captures the authoritative budgetSpent + runtime agentCount + notification usage', () => {
    const rec = summarizeRun({
      label: 'wt-calib',
      timestamp: TS,
      runId: 'wabc123',
      output: SYNTHETIC_OUTPUT,
      usage: { totalTokens: 30000, toolUses: 4, durationMs: 5000 },
    })
    expect(rec.schemaVersion).toBe(CALIBRATION_SCHEMA_VERSION)
    expect(rec.workflow).toBe('wt-calib')
    expect(rec.timestamp).toBe(TS)
    expect(rec.runId).toBe('wabc123')
    expect(rec.runtimeAgentCount).toBe(4)
    expect(rec.agentsSpawned).toBe(4)
    expect(rec.budgetSpent).toBe(32000)
    expect(rec.notificationTotalTokens).toBe(30000)
    expect(rec.notificationToolUses).toBe(4)
    expect(rec.durationMs).toBe(5000)
    expect(rec.patterns).toContain('adversarialVerification')
  })

  it('is deterministic — same input + injected timestamp → identical record', () => {
    const base = { label: 'wt-calib', timestamp: TS, output: SYNTHETIC_OUTPUT, usage: null }
    expect(summarizeRun(base)).toEqual(summarizeRun(base))
  })

  it('fills nulls + a note when there is NO token signal at all (structural-only run)', () => {
    const rec = summarizeRun({
      label: 'arbitrary',
      timestamp: TS,
      output: { agentCount: 3, result: { envelope: { stats: { agentsSpawned: 3 } } } },
      usage: null,
    })
    expect(rec.budgetSpent).toBeNull()
    expect(rec.notificationTotalTokens).toBeNull()
    expect(rec.runtimeAgentCount).toBe(3)
    expect(rec.notes.join(' ')).toMatch(/no token signal/i)
  })

  it('never throws on an odd/partial output shape — degrades to nulls + notes', () => {
    const rec = summarizeRun({ label: 'weird', timestamp: TS, output: 42, usage: null })
    expect(rec.runtimeAgentCount).toBeNull()
    expect(rec.budgetSpent).toBeNull()
    expect(rec.notes.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// deriveCalibration — segregate authoritative vs observed; never blend (H2)
// ---------------------------------------------------------------------------

function rec(partial: Partial<RunStatsRecord>): RunStatsRecord {
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    workflow: 'w',
    timestamp: TS,
    runId: null,
    runtimeAgentCount: null,
    agentsSpawned: null,
    budgetSpent: null,
    notificationTotalTokens: null,
    notificationToolUses: null,
    durationMs: null,
    patterns: [],
    notes: [],
    ...partial,
  }
}

describe('deriveCalibration', () => {
  it('averages tokens-per-agent over AUTHORITATIVE records only', () => {
    const cal = deriveCalibration([
      rec({ budgetSpent: 8000, runtimeAgentCount: 4 }),
      rec({ budgetSpent: 12000, runtimeAgentCount: 4 }),
    ])
    expect(cal.authoritative.recordCount).toBe(2)
    expect(cal.authoritative.totalTokens).toBe(20000)
    expect(cal.authoritative.totalAgents).toBe(8)
    expect(cal.authoritative.avgTokensPerAgent).toBe(2500)
  })

  it('segregates the observed (notification-only) signal — NEVER blends it into the authoritative mean (H2)', () => {
    const cal = deriveCalibration([
      rec({ budgetSpent: 8000, runtimeAgentCount: 4 }), // authoritative: 2000/agent
      rec({ notificationTotalTokens: 90000, runtimeAgentCount: 3 }), // observed only
    ])
    expect(cal.authoritative.avgTokensPerAgent).toBe(2000) // unpolluted by the 90000 record
    expect(cal.observed.recordCount).toBe(1)
    expect(cal.observed.avgTokensPerAgent).toBe(30000)
  })

  it('guards divide-by-zero (zero agents) → null avg, not NaN/Infinity', () => {
    const cal = deriveCalibration([rec({ budgetSpent: 5000, runtimeAgentCount: 0 })])
    // a record with 0 agents contributes no usable signal
    expect(cal.authoritative.avgTokensPerAgent).toBeNull()
  })

  it('counts records with no token signal and notes them', () => {
    const cal = deriveCalibration([
      rec({ runtimeAgentCount: 3 }), // structural only
      rec({ budgetSpent: 6000, runtimeAgentCount: 3 }),
    ])
    expect(cal.recordCount).toBe(2)
    expect(cal.authoritative.recordCount).toBe(1)
    expect(cal.notes.join(' ')).toMatch(/1 .*no token signal/i)
  })

  it('falls back to notificationToolUses as the agent count when runtimeAgentCount is absent', () => {
    const cal = deriveCalibration([
      rec({ notificationTotalTokens: 60000, notificationToolUses: 6 }),
    ])
    expect(cal.observed.avgTokensPerAgent).toBe(10000)
  })

  it('notes when an AUTHORITATIVE record borrows its agent count from notification tool_uses (MEDIUM#1)', () => {
    const cal = deriveCalibration([
      // budgetSpent present, but no runtime/envelope agent count → denominator
      // borrowed from notificationToolUses (cross-signal provenance)
      rec({ budgetSpent: 8000, runtimeAgentCount: null, agentsSpawned: null, notificationToolUses: 4 }),
    ])
    expect(cal.authoritative.avgTokensPerAgent).toBe(2000) // 8000 / 4
    expect(cal.notes.join(' ')).toMatch(/borrowed the agent count from the notification/i)
  })
})

// ---------------------------------------------------------------------------
// recommendFloor — floor ≈ avgTokensPerAgent × (claims×votes + synthesis) × margin
// ---------------------------------------------------------------------------

describe('recommendFloor', () => {
  const cal = deriveCalibration([rec({ budgetSpent: 20000, runtimeAgentCount: 10 })]) // 2000/agent

  it('applies the documented formula on the authoritative average', () => {
    const r = recommendFloor(cal, { expectedClaims: 5, votesPerClaim: 3, synthesisAgents: 1, safetyMargin: 1.5 })
    expect(r.source).toBe('authoritative')
    expect(r.avgTokensPerAgent).toBe(2000)
    expect(r.expectedAgents).toBe(16) // 5*3 + 1
    expect(r.recommendedFloor).toBe(48000) // 2000 * 16 * 1.5
  })

  it('uses the observed signal (labelled) when no authoritative data exists', () => {
    const obs = deriveCalibration([rec({ notificationTotalTokens: 30000, runtimeAgentCount: 10 })])
    const r = recommendFloor(obs, { expectedClaims: 1, votesPerClaim: 1, synthesisAgents: 0 })
    expect(r.source).toBe('observed')
    expect(r.avgTokensPerAgent).toBe(3000)
  })

  it('returns a null floor WITH a reason when there is no usable token signal (B1 degrade path)', () => {
    const empty = deriveCalibration([rec({ runtimeAgentCount: 4 })])
    const r = recommendFloor(empty, { expectedClaims: 3 })
    expect(r.source).toBe('none')
    expect(r.recommendedFloor).toBeNull()
    expect(r.rationale).toMatch(/no .*token signal|insufficient/i)
  })
})

// ---------------------------------------------------------------------------
// formatCalibrationReport — human report carries the honesty caveat
// ---------------------------------------------------------------------------

describe('formatCalibrationReport', () => {
  it('renders the recommended floor and the cross-run-approximation caveat', () => {
    const cal = deriveCalibration([rec({ budgetSpent: 20000, runtimeAgentCount: 10 })])
    const r = recommendFloor(cal, { expectedClaims: 5 })
    const report = formatCalibrationReport(cal, r)
    expect(report).toMatch(/approximation/i)
    expect(report).toMatch(/recommended/i)
    expect(report).toContain('2000')
  })

  it('states the no-signal degrade path honestly instead of a fake number', () => {
    const empty = deriveCalibration([rec({ runtimeAgentCount: 4 })])
    const r = recommendFloor(empty, { expectedClaims: 3 })
    const report = formatCalibrationReport(empty, r)
    expect(report).toMatch(/no .*token signal|insufficient/i)
    expect(report).not.toMatch(/recommended floor:\s*\d/i)
  })
})
