import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { aggregateRunCosts, appendCostReport, attributePilotTurns, computeRunCost, formatAggregate, matchLaneSessions } from '../../../../plugin/bin/lib/run-cost-core.mjs'

const CLI = new URL('../../../../plugin/bin/wt-run-cost.mjs', import.meta.url).pathname

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'wt-run-cost-')); roots.push(value); return value }

afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

describe('run cost', () => {
  it('attributes streamed assistant usage to lifecycle phases with exact token numbers', () => {
    const phases = [
      { phase: 'discovery', round: null, entered_at: 1000, exited_at: 2000 },
      { phase: 'plan', round: null, entered_at: 2000, exited_at: 3000 },
      { phase: 'critic', round: 1, entered_at: 3000, exited_at: 4000 },
      { phase: 'plan', round: null, entered_at: 4000, exited_at: 5000 },
      { phase: 'critic', round: 2, entered_at: 5000, exited_at: 6000 },
    ]
    const messages = [
      { arrived_at: 2500, model: 'claude-opus-5', input: 3, cache_creation: 5, cache_read: 7, output: 11 },
      { arrived_at: 3500, model: 'claude-opus-5', input: 13, cache_creation: 17, cache_read: 19, output: 23 },
      { arrived_at: 5500, model: 'claude-opus-5', input: 29, cache_creation: 31, cache_read: 37, output: 41 },
    ]

    expect(attributePilotTurns(messages, phases)).toEqual([
      expect.objectContaining({ phase: 'plan', round: null, tokens: { family: 'anthropic', input: 3, cache_write: 5, cache_read: 7, output: 11, reasoning: 'not measured', first_pass_input: 8, fresh_tokens: 19 } }),
      expect.objectContaining({ phase: 'critic', round: 1, tokens: { family: 'anthropic', input: 13, cache_write: 17, cache_read: 19, output: 23, reasoning: 'not measured', first_pass_input: 30, fresh_tokens: 53 } }),
      expect.objectContaining({ phase: 'critic', round: 2, tokens: { family: 'anthropic', input: 29, cache_write: 31, cache_read: 37, output: 41, reasoning: 'not measured', first_pass_input: 60, fresh_tokens: 101 } }),
    ])
  })

  it('counts OpenAI reasoning in fresh tokens while preserving raw columns', () => {
    const lane = root(); writeFileSync(join(lane, 'route.json'), JSON.stringify({ route: 'FULL', executor: 'opencode' })); writeFileSync(join(lane, 'summary.json'), JSON.stringify({ completed: true }))
    writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [], result_totals: { input: 0, cache_creation: 0, cache_read: 0, output: 0 } }))
    writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({ started_at: 1000, ended_at: 3000, phases: [], lanes: [{ phase: 'critic', round: 1, started_at: 1000, ended_at: 3000 }] }))
    const cost = computeRunCost({ laneDir: lane, worktree: '/work/a', sessions: [{ id: 's', directory: '/work/a', model: { providerID: 'openai', id: 'gpt' }, tokens_input: 100, tokens_output: 20, tokens_reasoning: 30, tokens_cache_read: 40, time_created: 1200, time_updated: 2800 }] })
    expect(cost.phases[0].models['openai/gpt']).toEqual({ family: 'openai', input: 100, cache_write: 'not measured', cache_read: 40, output: 20, reasoning: 30, first_pass_input: 100, fresh_tokens: 150 })
  })

  it('passes hostile-looking database paths after sqlite option termination with a raised buffer', () => {
    const lane = root(); writeFileSync(join(lane, 'route.json'), JSON.stringify({ route: 'FULL', executor: 'opencode' })); writeFileSync(join(lane, 'summary.json'), JSON.stringify({ completed: true })); writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [], result_totals: {} })); writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({ started_at: 1000, ended_at: 2000, phases: [], lanes: [] }))
    let receipt: { args?: string[], maxBuffer?: number } = {}
    computeRunCost({ laneDir: lane, worktree: '/work/a', dbPath: '-database', execFile: (_program: string, args: string[], options: { maxBuffer: number }) => { receipt = { args, maxBuffer: options.maxBuffer }; return '[]' } })
    expect(receipt.args?.slice(0, 4)).toEqual(['-readonly', '-json', '--', '-database'])
    expect(receipt.maxBuffer).toBe(64 * 1024 * 1024)
  })

  it('derives wall time from archived transcript timestamps and marks it inferred', () => {
    const lane = root(); writeFileSync(join(lane, 'route.json'), JSON.stringify({ route: 'LITE', executor: 'claude-sdk' })); writeFileSync(join(lane, 'summary.json'), JSON.stringify({ completed: true, minutes: 999 }))
    writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [], result_totals: {} })); writeFileSync(join(lane, 'sdk-transcript.json'), JSON.stringify([{ timestamp: '2026-01-01T00:00:00.000Z' }, { timestamp: '2026-01-01T00:41:26.400Z' }]))
    const cost = computeRunCost({ laneDir: lane, worktree: '/work/a' })
    expect(cost.totals.wall_time_ms).toBe(2_486_400)
    expect(cost.window).toMatchObject({ started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:41:26.400Z', inferred: true })
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

  it('matches inferred logs by their own timestamps and retains unmatched sessions', () => {
    const lane = root(); writeFileSync(join(lane, 'route.json'), JSON.stringify({ route: 'FULL', executor: 'opencode' })); writeFileSync(join(lane, 'summary.json'), JSON.stringify({ completed: true })); writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [], result_totals: {} }))
    writeFileSync(join(lane, 'critic-run.z.log'), '2026-01-01T00:02:00.000Z start\n2026-01-01T00:03:00.000Z end\n')
    writeFileSync(join(lane, 'review-run.a.log'), '2026-01-01T00:05:00.000Z start\n2026-01-01T00:06:00.000Z end\n')
    writeFileSync(join(lane, 'harden-run.empty.log'), '2026-01-01T00:08:00.000Z start\n2026-01-01T00:09:00.000Z end\n')
    const row = (id: string, created: number, updated: number, input: number) => ({ id, directory: '/work/a', model: { providerID: 'openai', id }, tokens_input: input, tokens_output: 1, tokens_reasoning: 2, tokens_cache_read: 3, time_created: created, time_updated: updated })
    const cost = computeRunCost({ laneDir: lane, worktree: '/work/a', sessions: [row('review', Date.parse('2026-01-01T00:05:10Z'), Date.parse('2026-01-01T00:05:20Z'), 50), row('critic', Date.parse('2026-01-01T00:02:10Z'), Date.parse('2026-01-01T00:02:20Z'), 20), row('extra', Date.parse('2026-01-01T00:07:00Z'), Date.parse('2026-01-01T00:07:10Z'), 70)] })
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'critic').models['openai/critic'].input).toBe(20)
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'review').models['openai/review'].input).toBe(50)
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'harden').unknown).toHaveLength(1)
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'unmatched').models['openai/extra'].input).toBe(70)
    expect(cost.families.openai.input).toBe(140)
  })

  it('reports unknown outcome when summary.json is absent and replaces only its delimited report block', () => {
    const lane = root(); writeFileSync(join(lane, 'route.json'), JSON.stringify({ route: 'LITE', executor: 'claude-sdk', cardId: '7' })); writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [], result_totals: {} })); writeFileSync(join(lane, 'sdk-transcript.json'), JSON.stringify([{ timestamp: '2026-01-01T00:00:00Z' }]))
    const cost = computeRunCost({ laneDir: lane, worktree: '/work/a' })
    expect(cost.outcome).toEqual({ status: 'unknown', reason: 'summary.json unavailable' })
    const original = '# Pilot\n\n## Run Cost\nThis pilot-authored heading stays.\n\n<!-- run-cost -->\nold generated text\n<!-- /run-cost -->\n\n## Closing\nkeep me\n'
    const updated = appendCostReport(original, cost)
    expect(updated).toContain('## Run Cost\nThis pilot-authored heading stays.')
    expect(updated).toContain('## Closing\nkeep me')
    expect(updated.match(/<!-- run-cost -->/g)).toHaveLength(1)
    expect(updated).not.toContain('old generated text')
  })

  it('aggregates complete runs by route by default and lists partial runs separately', () => {
    const reports = root()
    for (const [name, cost] of [
      ['lite-complete', { card_id: '1', route: 'LITE', window: { started_at: '2026-01-01T00:00:00.000Z' }, outcome: { status: 'complete' }, unknown: [], families: { anthropic: { input: 10, cache_write: 2, cache_read: 30, output: 4, reasoning: 'not measured', first_pass_input: 12, fresh_tokens: 16 }, openai: null }, totals: { wall_time_ms: 100 } }],
      ['full-complete', { card_id: '2', route: 'FULL', window: { started_at: '2026-01-01T00:01:00.000Z' }, outcome: { status: 'complete' }, unknown: ['gap'], families: { anthropic: { input: 20, cache_write: 3, cache_read: 40, output: 5, reasoning: 'not measured', first_pass_input: 23, fresh_tokens: 28 }, openai: { input: 100, cache_write: 'not measured', cache_read: 400, output: 50, reasoning: 25, first_pass_input: 100, fresh_tokens: 175 } }, totals: { wall_time_ms: 200 } }],
      ['full-mirror', { card_id: '2', route: 'FULL', worktree: '/different/path', window: { started_at: '2026-01-01T00:01:00.000Z' }, outcome: { status: 'complete' }, unknown: ['gap'], families: { anthropic: { input: 20, cache_write: 3, cache_read: 40, output: 5, reasoning: 'not measured', first_pass_input: 23, fresh_tokens: 28 }, openai: { input: 100, cache_write: 'not measured', cache_read: 400, output: 50, reasoning: 25, first_pass_input: 100, fresh_tokens: 175 } }, totals: { wall_time_ms: 200 } }],
      ['full-partial', { card_id: '3', route: 'FULL', window: { started_at: '2026-01-01T00:02:00.000Z' }, outcome: { status: 'partial', reason: 'critic bound' }, unknown: [], families: { anthropic: null, openai: { input: 1000, cache_write: 'not measured', cache_read: 1000, output: 1000, reasoning: 1000, first_pass_input: 1000, fresh_tokens: 3000 } }, totals: { wall_time_ms: 300 } }],
    ] as const) {
      const lane = join(reports, name, '.lane'); mkdirSync(lane, { recursive: true }); writeFileSync(join(lane, 'cost.json'), JSON.stringify(cost))
    }

    const result = aggregateRunCosts(reports)
    expect(result.routes.LITE).toMatchObject({ runs: 1, unknown: 0, families: { anthropic: { input: 10, reasoning: 'not measured' } } })
    expect(result.routes.FULL).toMatchObject({ runs: 1, unknown: 1, families: { anthropic: { output: 5, reasoning: 'not measured' }, openai: { output: 50, reasoning: 25, cache_write: 'not measured' } } })
    expect(result.partial).toEqual([expect.objectContaining({ archive: 'full-partial', route: 'FULL', reason: 'critic bound' })])
    expect(aggregateRunCosts(reports, { includePartial: true }).routes.FULL).toMatchObject({ runs: 2, unknown: 1, families: { openai: { input: 1100, fresh_tokens: 3175 } } })

    const defaultCli = spawnSync(process.execPath, [CLI, reports], { encoding: 'utf8' })
    expect(defaultCli.status).toBe(0)
    expect(defaultCli.stdout).toContain('FULL | anthropic | 1 | incomplete (1 unknown) | 20 | 3 | 40 | 5 | not measured | 23 | 28 | 200')
    expect(defaultCli.stdout).toContain('FULL | openai | 1 | incomplete (1 unknown) | 100 | not measured | 400 | 50 | 25 | 100 | 175 | 200')
    expect(defaultCli.stdout).toContain('full-partial | FULL | critic bound')
    const partialCli = spawnSync(process.execPath, [CLI, reports, '--include-partial'], { encoding: 'utf8' })
    expect(partialCli.status).toBe(0)
    expect(formatAggregate(aggregateRunCosts(reports, { includePartial: true }))).toContain('FULL | openai | 2 | incomplete (1 unknown) | 1100 | not measured | 1400 | 1050 | 1025 | 1100 | 3175 | 500')
    expect(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status).toBe(2)
  })
})
