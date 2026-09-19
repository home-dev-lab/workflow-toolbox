import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { aggregateRunCosts, appendCostReport, attributePilotTurns, computeRunCost, formatAggregate, matchLaneSessions } from '../../../../plugin/bin/lib/run-cost-core.mjs'

const CLI = fileURLToPath(new URL('../../../../plugin/bin/wt-run-cost.mjs', import.meta.url))
const OUTPUT_UNDERCOUNT_FIXTURE = new URL('./fixtures/run-cost/sdk-output-undercount.json', import.meta.url)
const LANE_FAMILIES_FIXTURE = new URL('./fixtures/run-cost/lane-families.json', import.meta.url)
const KNOWN_RUN_FIXTURE = new URL('./fixtures/run-cost/sdk-lite-run-20260919.cost.json', import.meta.url)
const PRICE_TABLE = new URL('../../../../plugin/pricing/model-prices.json', import.meta.url)
type LaneFixture = { phase: string, round: number | null, started_at: number, ended_at: number, [key: string]: unknown }

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'wt-run-cost-')); roots.push(value); return value }

afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

describe('run cost', () => {
  function catalogue(models: Record<string, unknown>) {
    return { openai: { models }, 'zai-coding-plan': { models } }
  }

  function pricedModel(model: string, tokens: Record<string, unknown>, priceTable?: object) {
    const lane = root()
    const family = String(tokens.family ?? 'anthropic')
    writeFileSync(join(lane, 'route.json'), JSON.stringify({ route: 'LITE' }))
    writeFileSync(join(lane, 'summary.json'), JSON.stringify({ completed: true, served_model: model }))
    const openAi = family !== 'anthropic'
    writeFileSync(join(lane, 'usage.json'), JSON.stringify(openAi
      ? { messages: [], result_totals: {} }
      : { messages: [{ model, arrived_at: 1500, ...tokens }], result_totals: tokens }))
    writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({
      started_at: 1000,
      ended_at: 2000,
      phases: [{ phase: 'test', round: null, entered_at: 1000, exited_at: 2000 }],
      lanes: openAi ? [{ phase: 'test', round: null, executor: 'opencode', model, started_at: 1100, ended_at: 1900 }] : [],
    }))
    const slash = model.indexOf('/')
    const sessions = openAi ? [{
      id: 'priced-model', directory: '/work/priced-model',
      model: { providerID: slash < 0 ? family : model.slice(0, slash), id: slash < 0 ? model : model.slice(slash + 1) },
      tokens_input: tokens.input, tokens_output: tokens.output, tokens_reasoning: tokens.reasoning,
      tokens_cache_read: tokens.cache_read, tokens_cache_write: tokens.cache_write,
      time_created: 1200, time_updated: 1800,
    }] : undefined
    const cost = computeRunCost({ laneDir: lane, worktree: '/work/priced-model', sessions, priceTable })
    const row = Object.values(cost.phases.flatMap((phase: { models: Record<string, unknown> }) => Object.values(phase.models)))[0] as Record<string, unknown>
    return { cost, row }
  }

  function withPriceEnvironment(directory: string, action: () => unknown) {
    const keys = ['CLAUDE_CONFIG_DIR', 'CLAUDE_PLUGIN_DATA', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'] as const
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'config')
    delete process.env.CLAUDE_PLUGIN_DATA
    process.env.XDG_CACHE_HOME = join(directory, 'cache')
    process.env.XDG_STATE_HOME = join(directory, 'state')
    try { return action() } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  }

  it('loads the fresh OpenCode catalogue as primary and records its file and mtime', () => {
    const directory = root()
    const catalogueFile = join(directory, 'cache', 'opencode', 'models.json')
    mkdirSync(join(directory, 'cache', 'opencode'), { recursive: true })
    writeFileSync(catalogueFile, JSON.stringify(catalogue({ model: { id: 'model', cost: { input: 2, output: 3, cache_read: 1, cache_write: 4 } } })))

    const priced = withPriceEnvironment(directory, () => pricedModel('openai/model', { family: 'openai', input: 1_000_000 }).cost) as ReturnType<typeof pricedModel>['cost']

    expect(priced.price_table).toMatchObject({ catalogue_file: catalogueFile, catalogue_mtime: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), catalogue_status: 'loaded' })
    expect(priced.phases[0].models['openai/model']).toMatchObject({ usd: 2, price_label: 'API price equivalent', input_context_tokens: 1_000_000 })
  })

  it('lets the user override win over the catalogue and fallback without changing either file', () => {
    const directory = root()
    const catalogueFile = join(directory, 'cache', 'opencode', 'models.json')
    const overrideFile = join(directory, 'state', 'workflow-toolbox', 'model-prices.override.json')
    mkdirSync(join(directory, 'cache', 'opencode'), { recursive: true })
    mkdirSync(join(directory, 'state', 'workflow-toolbox'), { recursive: true })
    writeFileSync(catalogueFile, JSON.stringify(catalogue({ model: { id: 'model', cost: { input: 2, output: 3 } } })))
    writeFileSync(overrideFile, JSON.stringify({ models: { 'openai/model': { input: 7, output: 8, cache_read: 0, cache_write: 0 } } }))
    const before = readFileSync(overrideFile, 'utf8')

    const { row } = withPriceEnvironment(directory, () => pricedModel('openai/model', { family: 'openai', input: 1_000_000 })) as ReturnType<typeof pricedModel>

    expect(row).toMatchObject({ usd: 7, price_source: 'user override' })
    expect(readFileSync(overrideFile, 'utf8')).toBe(before)
  })

  it('switches catalogue tiers when reported input context exceeds the threshold', () => {
    const table = {
      models: {
        'openai/model': {
          input: 4, output: 20, cache_read: 0.4, cache_write: 5,
          tiers: [{ input: 8, output: 30, cache_read: 0.8, cache_write: 10, tier: { type: 'context', size: 272_000 } }],
        },
      },
    }

    expect(pricedModel('openai/model', { family: 'openai', input: 272_000, output: 1_000_000 }, table).row.usd).toBe(21.088)
    expect(pricedModel('openai/model', { family: 'openai', input: 272_001, output: 1_000_000 }, table).row.usd).toBe(32.176008)
  })

  it('labels a zero-priced catalogue route as subscription', () => {
    const directory = root()
    const catalogueFile = join(directory, 'cache', 'opencode', 'models.json')
    mkdirSync(join(directory, 'cache', 'opencode'), { recursive: true })
    writeFileSync(catalogueFile, JSON.stringify(catalogue({ model: { id: 'model', cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } })))

    const { row } = withPriceEnvironment(directory, () => pricedModel('zai-coding-plan/model', { family: 'zai-coding-plan', input: 1_000_000 })) as ReturnType<typeof pricedModel>
    expect(row.usd).toBe('subscription')
  })

  it('uses a stated fallback reason and still returns price unknown when no source has the provider model', () => {
    const directory = root()
    const missingCatalogue = join(directory, 'cache', 'opencode', 'models.json')
    const { cost, row } = withPriceEnvironment(directory, () => pricedModel('other/missing', { family: 'other', input: 1 })) as ReturnType<typeof pricedModel>

    expect(cost.price_table).toMatchObject({ catalogue_file: missingCatalogue, catalogue_status: 'fallback', catalogue_reason: expect.stringContaining('not found') })
    expect(row.usd).toBe('price unknown')
  })

  it('ships complete, dated prices for every required model', () => {
    const table = JSON.parse(readFileSync(PRICE_TABLE, 'utf8'))
    expect(table).toMatchObject({ version: expect.any(String), as_of: expect.stringMatching(/^\d{4}-\d\d-\d\d$/) })
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna', 'openai/gpt-6-astra']) {
      expect(table.models[model]).toMatchObject({
        family: expect.stringMatching(/^(anthropic|openai)$/), input: expect.any(Number), cache_read: expect.any(Number), output: expect.any(Number),
        source_url: expect.stringMatching(/^https:\/\//), retrieved: expect.stringMatching(/^\d{4}-\d\d-\d\d$/),
      })
      expect(Object.hasOwn(table.models[model], 'cache_write')).toBe(true)
    }
  })

  it('prices Anthropic and OpenAI tokens without billing reasoning twice', () => {
    const table = JSON.parse(readFileSync(PRICE_TABLE, 'utf8'))
    expect(pricedModel('anthropic/claude-opus-5-20260901', { family: 'anthropic', input: 1_000_000, cache_write: 2_000_000, cache_read: 3_000_000, output: 4_000_000 }, table).row.usd).toBe(119)
    expect(pricedModel('openai/gpt-5.6-sol-20260901', { family: 'openai', input: 1_000_000, cache_write: 'not measured', cache_read: 2_000_000, output: 3_000_000, reasoning: 9_000_000 }, table).row.usd).toBe(64.8)
    expect(pricedModel('unlisted-model', { family: 'anthropic', input: 1 }, table).row.usd).toBe('price unknown')
    expect(pricedModel('claude-haiku-4-5-20251001', { family: 'anthropic', input: 1_000_000 }, table).row.usd).toBe(1)
    expect(pricedModel('claude-opus-50', { family: 'anthropic', input: 1 }, table).row.usd).toBe('price unknown')
  })

  it('prices the archived sdk-lite run exactly as hand-computed from reported classes', () => {
    const table = JSON.parse(readFileSync(PRICE_TABLE, 'utf8'))
    const fixture = JSON.parse(readFileSync(KNOWN_RUN_FIXTURE, 'utf8'))
    const opus = pricedModel('claude-opus-5', { family: 'anthropic', input: 50, cache_write: 86547, cache_read: 1568264, output: 15061 }, table).row
    const haiku = pricedModel('claude-haiku-4-5-20251001', { family: 'anthropic', input: 1449, cache_write: 0, cache_read: 0, output: 17 }, table).row
    const openai = pricedModel('openai/gpt-5.6-sol', fixture.phases[1].models['openai/gpt-5.6-sol'], table).row
    const handComputed = (
      (50 * 5) + (86547 * 6.25) + (1568264 * 0.5) + (15061 * 25)
      + (1449 * 1) + (17 * 5)
      + (184228 * 4) + (3339648 * 0.4) + (14744 * 20)
    ) / 1_000_000
    expect(Number(opus.usd) + Number(haiku.usd) + Number(openai.usd)).toBeCloseTo(handComputed, 12)
    expect(openai).toMatchObject({ reasoning: 6575, usd: (184228 * 4 + 3339648 * 0.4 + 14744 * 20) / 1_000_000 })
  })

  function archiveDerivedLaneCost(route: object, lanes: LaneFixture[], sessions: object[] = []) {
    const lane = root()
    writeFileSync(join(lane, 'route.json'), JSON.stringify(route))
    writeFileSync(join(lane, 'summary.json'), JSON.stringify({ completed: true, served_model: 'claude-opus-5' }))
    writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [], result_totals: {} }))
    writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({
      started_at: Math.min(...lanes.map((item) => item.started_at)) - 1,
      ended_at: Math.max(...lanes.map((item) => item.ended_at)) + 1,
      phases: lanes.map((item) => ({ phase: item.phase, round: item.round, entered_at: item.started_at, exited_at: item.ended_at })),
      lanes,
    }))
    return { lane, sessions }
  }

  function cliLane() {
    const lane = root()
    writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId: 'cli-card', route: 'LITE', executor: 'claude-sdk' }))
    writeFileSync(join(lane, 'summary.json'), JSON.stringify({ completed: true, served_model: 'claude-sonnet-5' }))
    writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [], result_totals: {} }))
    writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({ started_at: 1000, ended_at: 2000, phases: [], lanes: [] }))
    return lane
  }

  function spawnCompute(lane: string, output: string, ...args: string[]) {
    return spawnSync(process.execPath, [CLI, '--compute', lane, '--output', output, '--worktree', '/work/cli', ...args], { encoding: 'utf8' })
  }

  function realOutputUndercountLane(resultOutput = 134665) {
    const fixture = JSON.parse(readFileSync(OUTPUT_UNDERCOUNT_FIXTURE, 'utf8'))
    const lane = root()
    writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId: '1863152845168052185', route: 'FULL', executor: 'claude-sdk' }))
    writeFileSync(join(lane, 'summary.json'), JSON.stringify({ completed: true, served_model: 'claude-opus-5' }))
    writeFileSync(join(lane, 'usage.json'), JSON.stringify({
      messages: [fixture.assistant_message_usage_sum],
      result_totals: { ...fixture.terminal_result.usage, output_tokens: resultOutput },
      model_usage: fixture.terminal_result.modelUsage,
    }))
    writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({
      started_at: Date.parse('2026-09-14T23:43:20.926Z'),
      ended_at: Date.parse('2026-09-15T00:38:40.268Z'),
      phases: [{ phase: 'critic', round: 1, entered_at: Date.parse('2026-09-15T00:00:00.000Z'), exited_at: Date.parse('2026-09-15T00:30:00.000Z') }],
      lanes: [],
    }))
    return lane
  }

  it('reconciles the real transcript output undercount without marking the run incomplete', () => {
    const cost = computeRunCost({ laneDir: realOutputUndercountLane(), worktree: '/work/real-run' })

    expect(cost.cross_checks.pilot_result).toMatchObject({
      agrees: true,
      message_sum: { output: 1010, fresh_tokens: 254745 },
      attributed_sum: { output: 134665, fresh_tokens: 388400 },
      result_total: { output: 134665, fresh_tokens: 388400 },
      difference: { input: 0, cache_write: 0, cache_read: 0, output: 0, first_pass_input: 0, fresh_tokens: 0 },
    })
    expect(cost.cross_checks.model_usage).toMatchObject({
      agrees: true,
      primary_model: 'claude-opus-5',
      model_total: { input: 148, cache_write: 253587, cache_read: 10288682, output: 134665, first_pass_input: 253735, fresh_tokens: 388400 },
      result_total: { input: 148, cache_write: 253587, cache_read: 10288682, output: 134665, first_pass_input: 253735, fresh_tokens: 388400 },
      difference: { input: 0, cache_write: 0, cache_read: 0, output: 0, first_pass_input: 0, fresh_tokens: 0 },
    })
    expect(cost.families.anthropic).toMatchObject({ input: 1840, output: 134679, fresh_tokens: 390106 })
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'reconciled')).toMatchObject({
      models: { 'claude-opus-5': { output: 133655, fresh_tokens: 133655 } },
      unknown: [],
    })
    expect(cost.reconciled).toEqual([expect.objectContaining({
      kind: 'terminal_result_output',
      tokens: 133655,
      reason: 'The terminal SDK result is the only source for whole-run output; no independent instrument exists today, so undercount cannot be discriminated and only overcount can.',
    })])
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'unattributed')).toMatchObject({
      models: { 'claude-haiku-4-5-20251001': { input: 1692, output: 14, fresh_tokens: 1706 } },
      unknown: [],
    })
    expect(cost.unknown).toEqual([])
    const report = appendCostReport('# Run\n', cost)
    expect(report).not.toContain('SDK model/result usage disagreement:')
    expect(report).toContain('The terminal SDK result is the only source for whole-run output; no independent instrument exists today, so undercount cannot be discriminated and only overcount can.')
    expect(report).toContain('Per-phase output attribution is vacuous for this claude-sdk run: 133655 of 134665 output tokens sit in reconciled.')

    const reports = root()
    const archiveLane = join(reports, 'real-run', '.lane')
    mkdirSync(archiveLane, { recursive: true })
    writeFileSync(join(archiveLane, 'cost.json'), JSON.stringify(cost))
    const aggregate = spawnSync(process.execPath, [CLI, reports], { encoding: 'utf8' })
    expect(aggregate.status).toBe(0)
    expect(aggregate.stdout).toContain('FULL | anthropic | 1 | complete | 1840 | 253587 | 10288682 | 134679 | not measured | 255427 | 390106')
  })

  it('reconciles a positive terminal-result residual without an arbitrary share cutoff', () => {
    const cost = computeRunCost({ laneDir: realOutputUndercountLane(1_010_000), worktree: '/work/sparse-messages' })
    expect(cost.cross_checks.pilot_result).toMatchObject({ agrees: true, attributed_sum: { output: 1_010_000 }, difference: { output: 0, fresh_tokens: 0 } })
    expect(cost.reconciled).toEqual([expect.objectContaining({ kind: 'terminal_result_output', tokens: 1_008_990 })])
    expect(cost.unknown).toEqual([])
  })

  it('reports assistant-message output overcount as a disagreement', () => {
    const cost = computeRunCost({ laneDir: realOutputUndercountLane(1000), worktree: '/work/altered-run' })
    expect(cost.cross_checks.pilot_result).toMatchObject({ agrees: false, difference: { output: 10, fresh_tokens: 10 } })
    expect(cost.reconciled).toEqual([])
    expect(cost.unknown).toEqual([])
  })

  it('marks a genuine primary-model/result divergence red', () => {
    const lane = realOutputUndercountLane()
    const usage = JSON.parse(readFileSync(join(lane, 'usage.json'), 'utf8'))
    usage.model_usage['claude-opus-5'].outputTokens -= 1
    writeFileSync(join(lane, 'usage.json'), JSON.stringify(usage))

    const check = computeRunCost({ laneDir: lane, worktree: '/work/divergent-model-usage' }).cross_checks.model_usage
    expect(check).toMatchObject({
      agrees: false,
      primary_model: 'claude-opus-5',
      difference: { output: -1, fresh_tokens: -1 },
    })
  })

  it('records an unmatched dated primary model key as unknown without double counting it', () => {
    const lane = realOutputUndercountLane()
    const usage = JSON.parse(readFileSync(join(lane, 'usage.json'), 'utf8'))
    usage.model_usage = { 'claude-opus-5-20260915': usage.model_usage['claude-opus-5'] }
    writeFileSync(join(lane, 'usage.json'), JSON.stringify(usage))

    const cost = computeRunCost({ laneDir: lane, worktree: '/work/dated-primary' })
    expect(cost.cross_checks.model_usage).toEqual({
      status: 'unavailable',
      reason: 'SDK modelUsage has no key matching primary model claude-opus-5',
    })
    expect(cost.unknown).toEqual(['SDK modelUsage has no key matching primary model claude-opus-5; model rows were not added because the primary cannot be identified safely'])
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'unattributed')).toBeUndefined()
    expect(cost.families.anthropic).toMatchObject({ input: 148, output: 134665, fresh_tokens: 388400 })
  })

  it('records when the SDK model-usage cross-check is unavailable', () => {
    const lane = realOutputUndercountLane()
    const usage = JSON.parse(readFileSync(join(lane, 'usage.json'), 'utf8'))
    delete usage.model_usage
    writeFileSync(join(lane, 'usage.json'), JSON.stringify(usage))
    expect(computeRunCost({ laneDir: lane, worktree: '/work/legacy-run' }).cross_checks.model_usage).toEqual({
      status: 'unavailable',
      reason: 'SDK result modelUsage unavailable',
    })
  })

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
    writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({ started_at: 1000, ended_at: 3000, phases: [], lanes: [{ phase: 'critic', round: 1, executor: 'gpt-lane', model: 'openai/gpt', started_at: 1000, ended_at: 3000 }] }))
    const cost = computeRunCost({ laneDir: lane, worktree: '/work/a', sessions: [{ id: 's', directory: '/work/a', model: { providerID: 'openai', id: 'gpt' }, tokens_input: 100, tokens_output: 20, tokens_reasoning: 30, tokens_cache_read: 40, time_created: 1200, time_updated: 2800 }] })
    expect(cost.phases[0].models['openai/gpt']).toMatchObject({ family: 'openai', input: 100, cache_write: 'not measured', cache_read: 40, output: 20, reasoning: 30, first_pass_input: 100, fresh_tokens: 150, usd: 'price unknown' })
  })

  it('attributes each lane by its own model family when a run mixes Claude and GPT lanes', () => {
    const fixture = JSON.parse(readFileSync(LANE_FAMILIES_FIXTURE, 'utf8'))
    const claudeLane = { ...fixture.claude.lane, executor: 'claude-sdk' }
    const gptLane = { ...fixture.gpt.lane, executor: 'gpt-lane' }
    const { lane, sessions } = archiveDerivedLaneCost(
      { ...fixture.claude.route, executor: 'claude-sdk' },
      [claudeLane, gptLane],
      [fixture.gpt.session],
    )
    writeFileSync(join(lane, claudeLane.usage_file), JSON.stringify(fixture.claude.usage))

    const cost = computeRunCost({ laneDir: lane, worktree: fixture.gpt.worktree, sessions })

    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'tdd').models['claude-sonnet-5'])
      .toMatchObject({ family: 'anthropic', input: 266, output: 77146, fresh_tokens: 296546 })
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'critic').models['openai/gpt-5.6-sol'])
      .toMatchObject({ family: 'openai', input: 85338, output: 3483, reasoning: 1790, fresh_tokens: 90611 })
    expect(cost.unknown).toEqual([])
  })

  it('uses archived lane model evidence instead of a contradictory run executor', () => {
    const fixture = JSON.parse(readFileSync(LANE_FAMILIES_FIXTURE, 'utf8'))
    const { lane, sessions } = archiveDerivedLaneCost(
      { ...fixture.gpt.route, executor: 'claude-sdk' },
      [fixture.gpt.lane],
      [fixture.gpt.session],
    )

    const cost = computeRunCost({ laneDir: lane, worktree: fixture.gpt.worktree, sessions })

    expect(cost.phases[0].models['openai/gpt-5.6-sol']).toMatchObject({ family: 'openai', fresh_tokens: 90611 })
    expect(cost.unknown).toEqual([])
  })

  it('reports contradictory executor and model evidence on one lane as unknown', () => {
    const fixture = JSON.parse(readFileSync(LANE_FAMILIES_FIXTURE, 'utf8'))
    const contradictory = { ...fixture.gpt.lane, executor: 'opencode', model: 'anthropic/claude-sonnet-5' }
    const { lane, sessions } = archiveDerivedLaneCost(fixture.gpt.route, [contradictory], [fixture.gpt.session])

    const cost = computeRunCost({ laneDir: lane, worktree: fixture.gpt.worktree, sessions })

    expect(cost.phases[0].models).toEqual({})
    expect(cost.phases[0].unknown[0]).toContain('contradictory executor/model family evidence')
    expect(cost.families).toEqual({ anthropic: null, openai: null })
  })

  it('names an OpenAI lane lookup miss instead of recording zero or the run family', () => {
    const fixture = JSON.parse(readFileSync(LANE_FAMILIES_FIXTURE, 'utf8'))
    const { lane } = archiveDerivedLaneCost(fixture.gpt.route, [fixture.gpt.lane])

    const cost = computeRunCost({ laneDir: lane, worktree: fixture.gpt.worktree, sessions: [] })

    expect(cost.phases[0].models).toEqual({})
    expect(cost.phases[0].unknown).toEqual([
      `OpenAI lane usage unavailable for critic round 1: no OpenCode session row for worktree ${fixture.gpt.worktree} within 1789664921848..1789665120275`,
    ])
    expect(cost.families.openai).toBeNull()
  })

  it('reports an unknown lane family explicitly instead of assuming the run executor', () => {
    const laneRecord = { phase: 'critic', round: 1, model: 'unknown', started_at: 1000, ended_at: 2000, usage_file: null }
    const { lane } = archiveDerivedLaneCost({ route: 'FULL', executor: 'claude-sdk' }, [laneRecord])

    const cost = computeRunCost({ laneDir: lane, worktree: '/work/a', sessions: [] })

    expect(cost.phases[0].unknown).toEqual([
      'lane usage family unavailable for critic round 1: executor and model do not identify Anthropic or OpenAI',
    ])
    expect(cost.families).toEqual({ anthropic: null, openai: null })
  })

  it('passes hostile-looking database paths after sqlite option termination with a raised buffer', () => {
    const lane = root(); writeFileSync(join(lane, 'route.json'), JSON.stringify({ route: 'FULL', executor: 'opencode' })); writeFileSync(join(lane, 'summary.json'), JSON.stringify({ completed: true })); writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [], result_totals: {} })); writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({ started_at: 1000, ended_at: 2000, phases: [], lanes: [{ phase: 'critic', round: 1, executor: 'gpt-lane', model: 'openai/gpt', started_at: 1000, ended_at: 2000 }] }))
    let receipt: { args?: string[], maxBuffer?: number } = {}
    computeRunCost({ laneDir: lane, worktree: '/work/a', dbPath: '-database', execFile: (_program: string, args: string[], options: { maxBuffer: number }) => { receipt = { args, maxBuffer: options.maxBuffer }; return '[]' } })
    expect(receipt.args?.slice(0, 4)).toEqual(['-readonly', '-json', '--', '-database'])
    expect(receipt.maxBuffer).toBe(64 * 1024 * 1024)
  })

  it('degrades an unavailable OpenCode store to a family-specific unknown', () => {
    const fixture = JSON.parse(readFileSync(LANE_FAMILIES_FIXTURE, 'utf8'))
    const { lane } = archiveDerivedLaneCost(fixture.gpt.route, [fixture.gpt.lane])
    const cost = computeRunCost({ laneDir: lane, worktree: fixture.gpt.worktree, dbPath: '/missing/opencode.db', execFile: () => { throw new Error('sqlite unavailable') } })

    expect(cost.phases[0].models).toEqual({})
    expect(cost.phases[0].unknown[0]).toContain('OpenAI lane usage unavailable for critic round 1: OpenCode session store query failed: sqlite unavailable')
    expect(cost.families.openai).toBeNull()
  })

  it('requires an injected OpenCode DB path on unverified operating systems', () => {
    const fixture = JSON.parse(readFileSync(LANE_FAMILIES_FIXTURE, 'utf8'))
    const { lane } = archiveDerivedLaneCost(fixture.gpt.route, [fixture.gpt.lane])
    const cost = computeRunCost({ laneDir: lane, worktree: fixture.gpt.worktree, platform: 'win32' })

    expect(cost.phases[0].unknown[0]).toContain('OpenCode session store location is unverified on win32; pass --db or set WT_OPENCODE_DB')
    expect(cost.families.openai).toBeNull()
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
      reason: 'no OpenCode session row for worktree /work/a within 100..200',
    })
  })

  it('matches inferred logs by their own timestamps and retains unmatched sessions', () => {
    const lane = root(); writeFileSync(join(lane, 'route.json'), JSON.stringify({ route: 'FULL', executor: 'opencode', models: { critic: 'openai/critic', review: 'openai/review', code: 'openai/code' } })); writeFileSync(join(lane, 'summary.json'), JSON.stringify({ completed: true })); writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [], result_totals: {} }))
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

  it('parses every compute option through the spawned CLI', () => {
    const lane = cliLane()
    const output = join(root(), 'cost.json')
    const result = spawnCompute(lane, output, '--db', '/tmp/opencode.db', '--route', 'HARD', '--started-at', '2026-01-01T00:00:00.000Z', '--ended-at', '2026-01-01T00:01:00.000Z')

    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      route: 'HARD',
      worktree: '/work/cli',
      window: { started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:01:00.000Z' },
    })
  })

  it('prints usage and exits 2 when compute is missing a required option', () => {
    const result = spawnSync(process.execPath, [CLI, '--compute', cliLane(), '--worktree', '/work/cli'], { encoding: 'utf8' })

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/^Usage: node wt-run-cost\.mjs /)
  })

  it('prints usage and exits 2 for an unrecognised compute option', () => {
    const result = spawnCompute(cliLane(), join(root(), 'cost.json'), '--unexpected')

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/^Usage: node wt-run-cost\.mjs /)
  })

  it('reports an invalid explicit date through the CLI error boundary', () => {
    const result = spawnCompute(cliLane(), join(root(), 'cost.json'), '--started-at', 'not-a-date', '--ended-at', '2026-01-01T00:01:00.000Z')

    expect(result.status).toBe(2)
    expect(result.stderr).toBe('wt-run-cost: Invalid time value\n')
  })

  it('creates missing output parent directories on compute success', () => {
    const output = join(root(), 'missing', 'parents', 'cost.json')
    const result = spawnCompute(cliLane(), output)

    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ card_id: 'cli-card', route: 'LITE' })
  })

  it('writes a merged pilot report next to the compute output', () => {
    const lane = cliLane()
    const source = '# Pilot\n\nExisting text\n'
    writeFileSync(join(lane, 'pilot-report.md'), source)
    const destination = root()
    const result = spawnCompute(lane, join(destination, 'cost.json'))

    expect(result.status).toBe(0)
    expect(readFileSync(join(lane, 'pilot-report.md'), 'utf8')).toBe(source)
    expect(readFileSync(join(destination, 'pilot-report.md'), 'utf8')).toContain('<!-- run-cost -->')
  })

  it('does not create a pilot report when the lane has none', () => {
    const destination = root()
    const result = spawnCompute(cliLane(), join(destination, 'cost.json'))

    expect(result.status).toBe(0)
    expect(existsSync(join(destination, 'pilot-report.md'))).toBe(false)
  })

  it('prints the exact compute success receipt shape', () => {
    const output = join(root(), 'cost.json')
    const result = spawnCompute(cliLane(), output)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ output, route: 'LITE', outcome: { status: 'complete' }, unknown: 0 })
  })

  it('prints usage successfully for both help switches', () => {
    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
    const shortHelp = spawnSync(process.execPath, [CLI, '-h'], { encoding: 'utf8' })

    expect(help.status).toBe(0)
    expect(shortHelp.status).toBe(0)
    expect(help.stderr).toBe('')
    expect(shortHelp.stderr).toBe('')
    expect(shortHelp.stdout).toBe(help.stdout)
    expect(help.stdout).toMatch(/^Usage: node wt-run-cost\.mjs /)
  })

  it('prefixes thrown compute errors and exits 2', () => {
    const lane = root()
    const result = spawnCompute(lane, join(root(), 'cost.json'))

    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`wt-run-cost: ENOENT: no such file or directory, open '${join(lane, 'route.json')}'`)
  })

  it('rejects a stray aggregate argument with usage and exit 2', () => {
    const result = spawnSync(process.execPath, [CLI, root(), '--stray'], { encoding: 'utf8' })

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/^Usage: node wt-run-cost\.mjs /)
  })
})
