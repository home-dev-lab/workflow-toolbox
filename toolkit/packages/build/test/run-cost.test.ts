import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { aggregateRunCosts, attributePilotTurns, matchLaneSessions } from '../../../../plugin/bin/lib/run-cost-core.mjs'

const CLI = new URL('../../../../plugin/bin/wt-run-cost.mjs', import.meta.url).pathname

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'wt-run-cost-')); roots.push(value); return value }

afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

describe('run cost', () => {
  it('attributes pilot turns to lifecycle phases and repeated critic rounds by receipt timestamps', () => {
    const phases = [
      { phase: 'discovery', round: null, entered_at: 1000, exited_at: 2000 },
      { phase: 'plan', round: null, entered_at: 2000, exited_at: 3000 },
      { phase: 'critic', round: 1, entered_at: 3000, exited_at: 4000 },
      { phase: 'plan', round: null, entered_at: 4000, exited_at: 5000 },
      { phase: 'critic', round: 2, entered_at: 5000, exited_at: 6000 },
    ]
    const turns = [
      { ended_at: 2500, model: 'claude-opus-5', input: 3, cache_creation: 5, cache_read: 7, output: 11 },
      { ended_at: 3500, model: 'claude-opus-5', input: 13, cache_creation: 17, cache_read: 19, output: 23 },
      { ended_at: 5500, model: 'claude-opus-5', input: 29, cache_creation: 31, cache_read: 37, output: 41 },
    ]

    expect(attributePilotTurns(turns, phases)).toEqual([
      expect.objectContaining({ phase: 'plan', round: null, tokens: expect.objectContaining({ input: 3, cache_write: 5, cache_read: 7, output: 11, reasoning: 'not measured', first_pass_input: 8 }) }),
      expect.objectContaining({ phase: 'critic', round: 1, tokens: expect.objectContaining({ first_pass_input: 30 }) }),
      expect.objectContaining({ phase: 'critic', round: 2, tokens: expect.objectContaining({ first_pass_input: 60 }) }),
    ])
  })

  it('matches OpenCode sessions only to the exact worktree and overlapping lane window', () => {
    const sessions = [
      { id: 'before', directory: '/work/a', time_created: 1, time_updated: 99 },
      { id: 'overlap-start', directory: '/work/a', time_created: 90, time_updated: 110 },
      { id: 'inside', directory: '/work/a', time_created: 120, time_updated: 180 },
      { id: 'overlap-end', directory: '/work/a', time_created: 190, time_updated: 220 },
      { id: 'other-tree', directory: '/work/b', time_created: 120, time_updated: 180 },
      { id: 'after', directory: '/work/a', time_created: 201, time_updated: 300 },
    ]
    expect(matchLaneSessions(sessions, '/work/a', 100, 200).map((row: { id: string }) => row.id))
      .toEqual(['overlap-start', 'inside', 'overlap-end'])
  })

  it('reports an unmatched lane as unknown with a reason, never zero', () => {
    expect(matchLaneSessions([], '/work/a', 100, 200, { explain: true })).toEqual({
      status: 'unknown',
      reason: 'no OpenCode session matched directory /work/a and lane window 100..200',
    })
  })

  it('aggregates complete runs by route by default and lists partial runs separately', () => {
    const reports = root()
    for (const [name, cost] of [
      ['lite-complete', { route: 'LITE', outcome: { status: 'complete' }, totals: { input: 10, cache_write: 2, cache_read: 30, output: 4, reasoning: 1, first_pass_input: 12, fresh_tokens: 16, wall_time_ms: 100 } }],
      ['full-complete', { route: 'FULL', worktree: '/work/full', window: { started_at: '2026-01-01T00:00:00.000Z' }, outcome: { status: 'complete' }, totals: { input: 20, cache_write: 3, cache_read: 40, output: 5, reasoning: 2, first_pass_input: 23, fresh_tokens: 28, wall_time_ms: 200 } }],
      ['full-mirror', { route: 'FULL', worktree: '/work/full', window: { started_at: '2026-01-01T00:00:00.000Z' }, outcome: { status: 'complete' }, totals: { input: 20, cache_write: 3, cache_read: 40, output: 5, reasoning: 2, first_pass_input: 23, fresh_tokens: 28, wall_time_ms: 200 } }],
      ['full-partial', { route: 'FULL', outcome: { status: 'partial', reason: 'critic bound' }, totals: { input: 1000, cache_write: 1000, cache_read: 1000, output: 1000, reasoning: 1000, first_pass_input: 2000, fresh_tokens: 3000, wall_time_ms: 300 } }],
    ] as const) {
      const lane = join(reports, name, '.lane'); mkdirSync(lane, { recursive: true }); writeFileSync(join(lane, 'cost.json'), JSON.stringify(cost))
    }

    const result = aggregateRunCosts(reports)
    expect(result.routes.LITE).toMatchObject({ runs: 1, input: 10, first_pass_input: 12 })
    expect(result.routes.FULL).toMatchObject({ runs: 1, input: 20, first_pass_input: 23 })
    expect(result.partial).toEqual([expect.objectContaining({ archive: 'full-partial', route: 'FULL', reason: 'critic bound' })])
    expect(result.routes.FULL.input).not.toBe(1020)

    expect(aggregateRunCosts(reports, { includePartial: true }).routes.FULL).toMatchObject({ runs: 2, input: 1020, first_pass_input: 2023 })

    const defaultCli = spawnSync(process.execPath, [CLI, reports], { encoding: 'utf8' })
    expect(defaultCli.status).toBe(0)
    expect(defaultCli.stdout).toContain('FULL | 1 | 20 | 3 | 40 | 5 | 2 | 23 | 28 | 200')
    expect(defaultCli.stdout).toContain('full-partial | FULL | critic bound')
    const partialCli = spawnSync(process.execPath, [CLI, reports, '--include-partial'], { encoding: 'utf8' })
    expect(partialCli.status).toBe(0)
    expect(partialCli.stdout).toContain('FULL | 2 | 1020 | 1003 | 1040 | 1005 | 1002 | 2023 | 3028 | 500')
    expect(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status).toBe(2)
  })
})
