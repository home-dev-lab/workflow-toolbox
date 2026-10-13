import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error runtime host helper
import { computeRunCost } from '../../../../plugin/bin/lib/run-cost-core.mjs'

const roots: string[] = []
const originalLstat = fs.lstatSync.bind(fs)
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cost-lanes-'))); roots.push(root)
  const worktree = join(root, 'worktree'); mkdirSync(worktree)
  const laneDir = join(worktree, '.lane'); const hostDir = join(root, 'host')
  mkdirSync(laneDir); mkdirSync(hostDir)
  const lanes = [1, 2].map(round => ({ phase: 'critic', round, executor: 'opencode', model: 'openai/gpt', state: 'completed', started_at: 1000, ended_at: 2000, usage_file: `critic-run.${round}.log.usage.json` }))
  const timeline = { started_at: 1000, ended_at: 2000, phases: lanes.map(lane => ({ phase: lane.phase, round: lane.round, entered_at: 1000, exited_at: 2000 })), lanes }
  const row = (id: string) => ({ id, directory: worktree, model: { providerID: 'openai', id: 'gpt' }, tokens_input: 3, tokens_cache_read: 5, tokens_output: 7, tokens_reasoning: 11, time_created: 1100, time_updated: 1900 })
  const receipt = (round: number, changes = {}) => ({ version: 1, receipt_for: lanes[round - 1]!.usage_file, source: 'opencode session store', directory: worktree, status: 'ok', store_kind: 'private', sessions: [row(`s${round}`)], ...changes })
  const save = (round: number, changes = {}, dir = hostDir) => writeFileSync(join(dir, lanes[round - 1]!.usage_file), JSON.stringify(receipt(round, changes)))
  writeFileSync(join(laneDir, 'route.json'), JSON.stringify({ route: 'FULL' }))
  writeFileSync(join(laneDir, 'summary.json'), JSON.stringify({ completed: true, served_model: 'claude-pilot' }))
  writeFileSync(join(laneDir, 'usage.json'), JSON.stringify({ messages: [{ model: 'claude-pilot', arrived_at: 1500, input: 13, cache_read: 17, output: 19 }], result_totals: { input: 13, cache_read: 17, output: 19 } }))
  const persist = () => writeFileSync(join(laneDir, 'lifecycle.json'), JSON.stringify(timeline))
  persist()
  const saveClaude = (round: number, totals: Record<string, number>, model = 'claude-pilot') => {
    Object.assign(lanes[round - 1]!, { executor: 'claude-sdk', model })
    writeFileSync(join(hostDir, lanes[round - 1]!.usage_file), JSON.stringify({ receipt_for: lanes[round - 1]!.usage_file, directory: worktree, model, totals }))
    persist()
  }
  const priceTable = { models: { 'openai/gpt': { input: 2, cache_read: 0.1, output: 10 }, 'claude-pilot': { input: 2, cache_read: 0.1, output: 10 } } }
  const compute = (options = {}) => computeRunCost({ laneDir, worktree, laneHostDir: hostDir, sessions: [], priceTable, ...options })
  return { worktree, laneDir, hostDir, lanes, timeline, row, receipt, save, saveClaude, persist, compute }
}

// These historic-window fixtures need explicit birthtimes, independent of when the test runs.
function hostLog(hostDir: string, name: string, birthtimeMs = 0, mtimeMs = 1500) {
  const file = join(hostDir, name); writeFileSync(file, 'host log'); utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  vi.spyOn(fs, 'lstatSync').mockImplementation(((name: fs.PathLike) => {
    const stat = originalLstat(name)
    return String(name) === file ? Object.assign(stat, { birthtimeMs }) : stat
  }) as typeof fs.lstatSync)
}

  it('marks one missing call incomplete in a two-call run', () => {
    const f = fixture(); f.save(1)
    const cost = f.compute()
    expect(cost.coverage.lanes).toMatchObject({ expected: 2, counted: 1, status: 'incomplete', missing: [{ phase: 'critic', round: 2, reason: expect.any(String) }] })
    expect(cost.coverage.status).toBe('incomplete')
  })
  it('prices both lanes separately and uses billed token shares at full precision', () => {
    const f = fixture(); f.save(1); f.save(2)
    const cost = f.compute()
    expect(cost.version).toBe(2)
    expect(cost.coverage.lanes).toEqual({ expected: 2, counted: 2, missing: [], status: 'complete' })
    expect(cost.phases[0].lane?.models['openai/gpt']).toMatchObject({ input: 3, cache_read: 5, output: 7, reasoning: 11 })
    expect(cost.phases[0].lane?.usd).toBe((3 * 2 + 5 * 0.1 + 7 * 10) / 1e6)
    expect(cost.phases[0].lane_share?.tokens).toBe(15 / 64)
    expect(cost.phases[0].lane_share?.usd).toBe(cost.phases[0].lane?.usd / cost.phases[0].usd)
    expect(cost.sources.lanes).toContain('opencode session store')
  })
  it('does not query the shared store when every OpenCode lane has a receipt', () => {
    const f = fixture(); f.save(1); f.save(2)
    const query = vi.fn(() => { throw new Error('must not query') })
    expect(f.compute({ sessions: undefined, execFile: query }).coverage.lanes?.status).toBe('complete')
    expect(query).not.toHaveBeenCalled()
  })
  it('leaves lane shares null on phases without a lane call', () => {
    const f = fixture(); f.save(1); f.save(2)
    f.timeline.phases.push({ phase: 'discovery', round: 0, entered_at: 3000, exited_at: 4000 }); f.persist()
    const phase = f.compute().phases.find((row: { phase: string }) => row.phase === 'discovery')
    expect(phase.lane).toBeNull(); expect(phase.lane_share).toBeNull()
  })
  it('prices the lane independently of the same-model combined context tier', () => {
    const f = fixture()
    for (const round of [1, 2]) {
      f.saveClaude(round, { input: 3, cache_creation: 0, cache_read: 5, output: 7 })
    }
    const priceTable = { models: { 'claude-pilot': { input: 2, cache_read: 0.1, output: 10, tiers: [{ input: 4, output: 20, tier: { type: 'context', size: 10 } }] } } }
    const phase = f.compute({ priceTable }).phases[0]
    expect(phase.models['claude-pilot'].price_tier).toEqual({ type: 'context', size: 10 })
    expect(phase.lane?.models['claude-pilot']).not.toHaveProperty('price_tier')
    expect(phase.lane?.usd).toBe(76.5 / 1e6)
    expect(phase.lane_share?.usd).toBe((76.5 / 1e6) / (586.2 / 1e6))
  })
  it('deduplicates private receipt sessions against the shared sweep', () => {
    const f = fixture(); f.save(1)
    const cost = f.compute({ sessions: [f.row('s1'), f.row('s2')] })
    expect(cost.families.openai?.input).toBe(6)
    expect(cost.phases.some((phase: { phase: string }) => phase.phase === 'unmatched')).toBe(false)
    expect(cost.coverage.lanes?.counted).toBe(1)
  })
  it('preserves an unavailable receipt reason', () => {
    const f = fixture(); f.save(1, { status: 'unavailable', reason: 'sqlite3 not found', sessions: [] }); f.save(2)
    expect(f.compute().coverage.lanes?.missing[0]?.reason).toContain('sqlite3 not found')
  })
  it('counts a finite completed Claude receipt only from the host directory', () => {
    const f = fixture(); f.saveClaude(1, { input: 3, cache_creation: 5, cache_read: 7, output: 11 }, 'claude-opus-5'); f.save(2)
    const cost = f.compute()
    expect(cost.coverage.lanes?.counted).toBe(2)
    expect(cost.phases[0].lane?.models['claude-opus-5']).toMatchObject({ input: 3, cache_write: 5, cache_read: 7, output: 11 })
  })
  it('rejects a forged worktree receipt', () => {
    const f = fixture(); f.save(1, {}, f.laneDir); f.save(2)
    expect(f.compute().coverage.lanes?.counted).toBe(1)
  })
  it.each(['symlink', 'directory', 'json', 'foreign directory'])('rejects an invalid host receipt: %s', kind => {
    const f = fixture(); f.save(2)
    const file = join(f.hostDir, f.lanes[0]!.usage_file)
    if (kind === 'symlink') { f.save(1, {}, f.laneDir); symlinkSync(join(f.laneDir, f.lanes[0]!.usage_file), file) }
    if (kind === 'directory') mkdirSync(file)
    if (kind === 'json') writeFileSync(file, '{')
    if (kind === 'foreign directory') f.save(1, { directory: '/foreign' })
    expect(f.compute().coverage.lanes?.counted).toBe(1)
  })
  it('reports foreign shared-store usage as inferred rather than complete', () => {
    const f = fixture(); f.save(2)
    const cost = f.compute({ sessions: [f.row('foreign')] })
    expect(cost.phases[0].lane?.models['openai/gpt']?.input).toBe(3)
    expect(cost.coverage.lanes).toMatchObject({ counted: 1, status: 'incomplete' })
    expect(cost.coverage.status).toBe('incomplete')
    expect(cost.phases[0].lane?.calls[0]?.status).toBe('inferred')
  })
  it('deduplicates repeated rows in the shared-store fallback', () => {
    const f = fixture(); f.save(2)
    const row = f.row('shared')
    const cost = f.compute({ sessions: [row, row] })
    expect(cost.families.openai?.input).toBe(6)
    expect(cost.coverage.lanes?.counted).toBe(1)
  })
  it('shows shared receipt rows but cannot count the invocation', () => {
    const f = fixture(); f.save(1, { store_kind: 'shared' }); f.save(2)
    const cost = f.compute()
    expect(cost.phases[0].lane?.models['openai/gpt']?.input).toBe(3)
    expect(cost.coverage.lanes?.counted).toBe(1)
    expect(cost.phases[0].lane?.calls[0]?.status).toBe('inferred')
    expect(cost.coverage.status).toBe('incomplete')
  })
  it('deduplicates ids globally and marks both receipt owners inferred', () => {
    const f = fixture(); f.save(1); f.save(2, { sessions: [f.row('s1')] })
    const cost = f.compute()
    expect(cost.families.openai?.input).toBe(3)
    expect(cost.coverage.lanes).toMatchObject({ counted: 0, status: 'incomplete', missing: [expect.objectContaining({ reason: expect.stringContaining('session id') }), expect.objectContaining({ reason: expect.stringContaining('session id') })] })
    expect(cost.coverage.status).toBe('incomplete')
  })
  it.each(['running', 'no end'])('retains rows but marks unfinished lane incomplete: %s', state => {
    const f = fixture(); f.save(1); f.save(2)
    Object.assign(f.lanes[0]!, state === 'no end' ? { ended_at: null } : { state }); f.persist()
    const cost = f.compute()
    expect(cost.phases[0].lane?.models['openai/gpt']?.input).toBe(3)
    expect(cost.coverage.lanes?.counted).toBe(1)
    expect(cost.coverage.status).toBe('incomplete')
  })
  it.each(['tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_reasoning', 'tokens_cache_write'])('rejects nonnumeric usage column %s', column => {
    const f = fixture(); f.save(1, { sessions: [{ ...f.row('s1'), [column]: undefined }] }); f.save(2)
    if (column === 'tokens_reasoning' || column === 'tokens_cache_write') f.save(1, { sessions: [{ ...f.row('s1'), [column]: 'bad' }] })
    expect(f.compute().coverage.lanes?.missing[0]?.reason).toContain(column)
  })
  it('rejects missing Claude totals instead of treating them as zero', () => {
    const f = fixture(); f.saveClaude(1, { input: 3 }, 'claude-opus-5'); f.save(2)
    expect(f.compute().coverage.lanes?.counted).toBe(1)
  })
  it.each([{ sessions: [] }, { sessions: {} }, { sessions: [null] }, { sessions: [{ id: '', tokens_input: 1 }] }])('rejects malformed session rows $sessions', ({ sessions }) => {
    const f = fixture(); f.save(1, { sessions }); f.save(2)
    expect(f.compute().coverage.lanes?.counted).toBe(1)
  })
  it('rejects a lifecycle receipt path outside the host directory', () => {
    const f = fixture(); f.save(1, {}, f.laneDir); f.save(2)
    f.lanes[0]!.usage_file = join(f.laneDir, f.lanes[0]!.usage_file); f.persist()
    expect(f.compute().coverage.lanes?.counted).toBe(1)
  })
  it('resolves a worktree alias to the receipt realpath', () => {
    const f = fixture(); f.save(1); f.save(2)
    const alias = join(f.hostDir, 'worktree-alias'); symlinkSync(f.worktree, alias, 'junction')
    const cost = f.compute({ worktree: alias })
    expect(cost.coverage.lanes?.status).toBe('complete')
    expect(cost.phases[0].lane?.models['openai/gpt']?.input).toBe(3)
  })
  it.each(['harden-extra-run.nonce.log', 'harden-extra-run.secondary.nonce.log', 'harden-extra-run.secondary-run.nonce.log'])('counts an orphan host log in the expected denominator: %s', name => {
    const f = fixture(); f.save(1); f.save(2)
    hostLog(f.hostDir, name)
    expect(f.compute().coverage.lanes).toMatchObject({ expected: 3, counted: 2, status: 'incomplete', missing: [{ phase: 'harden-extra', round: null, reason: 'host lane log with no lifecycle lane record' }] })
  })
  it('excludes named lifecycle logs and logs outside the run window from orphan counts', () => {
    const f = fixture(); f.save(1); f.save(2)
    for (const name of ['critic-run.1.log', 'critic-run.2.log', 'review-run.outside.log']) {
      hostLog(f.hostDir, name, 0, name.includes('outside') ? 3000 : 1500)
    }
    expect(f.compute().coverage.lanes).toMatchObject({ expected: 2, counted: 2, status: 'complete' })
  })
  it('marks an inferred timeline incomplete even with a host log', () => {
    const f = fixture(); rmSync(join(f.laneDir, 'lifecycle.json'))
    hostLog(f.hostDir, 'critic-run.orphan.log')
    expect(f.compute({ startedAt: 1000, endedAt: 2000 }).coverage.lanes).toMatchObject({ expected: 1, status: 'incomplete' })
  })
  it('does not treat null lifecycle window timestamps as authoritative epoch bounds', () => {
    const f = fixture(); f.save(1); f.save(2)
    Object.assign(f.timeline, { started_at: null, ended_at: null }); f.persist()
    hostLog(f.hostDir, 'harden-run.orphan.log')
    const cost = f.compute()
    expect(cost.coverage.lanes).toMatchObject({ expected: 3, counted: 2, status: 'incomplete' })
    expect(cost.coverage.status).toBe('incomplete')
  })
  it.each(['price unknown', 'subscription', 'zero phase cost'])('names the dollar share limitation: %s', reason => {
    const f = fixture()
    for (const round of [1, 2]) f.saveClaude(round, { input: 3, cache_creation: 0, cache_read: 5, output: reason === 'zero phase cost' ? 0 : 7 })
    const rates = { input: 0, output: reason === 'subscription' ? 0 : 1 }
    const priceTable = reason === 'price unknown' ? { models: {} } : { models: { 'claude-pilot': rates } }
    if (reason === 'zero phase cost') {
      const usage = JSON.parse(readFileSync(join(f.laneDir, 'usage.json'), 'utf8')); usage.messages[0].output = 0; usage.result_totals.output = 0; writeFileSync(join(f.laneDir, 'usage.json'), JSON.stringify(usage))
    }
    expect(f.compute({ priceTable }).phases[0].lane_share?.usd).toBe(reason)
  })

it.each([0, 1])('F1 suppresses shares for a phase with %s of two calls counted', counted => {
  const f = fixture(); f.lanes[1]!.round = 1; f.persist()
  if (counted) f.save(1)
  const phase = f.compute().phases[0]
  expect(phase.lane_share).toEqual({ tokens: null, usd: 'lane usage incomplete' })
  expect(phase.lane.calls.map((call: { status: string }) => call.status)).toEqual(counted ? ['counted', 'missing'] : ['missing', 'missing'])
  expect(phase.lane.models['openai/gpt']?.input ?? 0).toBe(counted * 3)
})

it.each(['openai', 'claude'])('A1 rejects a receipt_for mismatch for %s', family => {
  const f = fixture(); f.save(2)
  if (family === 'claude') f.saveClaude(1, { input: 3, cache_creation: 0, cache_read: 5, output: 7 })
  else f.save(1)
  const file = join(f.hostDir, f.lanes[0]!.usage_file)
  const receipt = JSON.parse(readFileSync(file, 'utf8')); receipt.receipt_for = 'earlier.log.usage.json'; writeFileSync(file, JSON.stringify(receipt))
  const cost = f.compute()
  expect(cost.coverage.lanes.counted).toBe(1)
  expect(cost.coverage.lanes.missing[0].reason).toContain('receipt_for')
})

it.each([900, 2100, null, '1100'])('A1 rejects a session time_created outside the finite invocation window: %s', time_created => {
  const f = fixture(); f.save(1, { sessions: [f.row('valid'), { ...f.row('stale'), time_created }] }); f.save(2)
  const cost = f.compute()
  expect(cost.coverage.lanes.counted).toBe(1)
  expect(cost.coverage.lanes.missing[0].reason).toContain('time_created')
})

it.each(['started_at', 'ended_at'])('A1 rejects a non-finite lane window bound: %s', bound => {
  const f = fixture(); f.save(1); f.save(2); Object.assign(f.lanes[0]!, { [bound]: null }); f.persist()
  expect(f.compute().coverage.lanes.missing[0].reason).toContain(bound)
})

it('A1 accepts session creation at both inclusive invocation boundaries', () => {
  const f = fixture(); f.save(1, { sessions: [1000, 2000].map(time_created => ({ ...f.row(String(time_created)), time_created })) }); f.save(2)
  expect(f.compute().coverage.lanes.counted).toBe(2)
})

it.each(['openai', 'claude'])('A2 rejects every duplicate usage_file owner without double charging %s', family => {
  const f = fixture()
  if (family === 'claude') for (const round of [1, 2]) f.saveClaude(round, { input: 3, cache_creation: 0, cache_read: 5, output: 7 })
  else f.save(1)
  f.lanes[1]!.usage_file = f.lanes[0]!.usage_file; f.persist()
  const cost = f.compute()
  expect(cost.coverage.lanes.counted).toBe(0)
  expect(cost.coverage.lanes.missing.map((call: { reason: string }) => call.reason)).toEqual([expect.stringContaining('duplicate usage_file'), expect.stringContaining('duplicate usage_file')])
  expect(cost.phases.every((phase: { lane: { models: object } }) => Object.keys(phase.lane.models).length === 0)).toBe(true)
})

it.each([500, 1500, 2000])('A3 counts an omitted log born at %s and last written after the run', birthtime => {
  const f = fixture(); f.save(1); f.save(2); hostLog(f.hostDir, 'review-run.omitted.log', birthtime, 3000)
  expect(f.compute().coverage.lanes).toMatchObject({ expected: 3, counted: 2, status: 'incomplete' })
})

it.each([[0, 1500], [2100, 3000], [500, 900]])('A3 checks lifetime overlap with birthtime %s and mtime %s', (birthtime, mtime) => {
  const f = fixture(); f.save(1); f.save(2); hostLog(f.hostDir, 'review-run.window.log', birthtime, mtime)
  expect(f.compute().coverage.lanes.expected).toBe(birthtime === 0 ? 3 : 2)
})

it('A5 counts a valid host receipt after its original worktree is deleted', () => {
  const f = fixture(); f.save(1); f.save(2)
  const archive = join(f.hostDir, 'archive'); fs.cpSync(f.laneDir, archive, { recursive: true }); rmSync(f.worktree, { recursive: true })
  const cost = f.compute({ laneDir: archive })
  expect(cost.coverage.lanes.status).toBe('complete')
  expect(cost.families.openai.input).toBe(6)
})

it.each(['openai', 'claude'])('A6 counts fully captured failed %s calls with a finite end', family => {
  const f = fixture(); f.save(2)
  if (family === 'claude') f.saveClaude(1, { input: 3, cache_creation: 0, cache_read: 5, output: 7 })
  else f.save(1)
  f.lanes[0]!.state = 'failed'; f.persist()
  const cost = f.compute()
  expect(cost.coverage.lanes).toMatchObject({ counted: 2, status: 'complete' })
  expect(cost.phases[0].lane.calls[0].status).toBe('counted')
})

it('A9 queries and attributes shared fallback rows through the canonical worktree alias', () => {
  const f = fixture(); f.save(2)
  const alias = join(f.hostDir, 'alias'); symlinkSync(f.worktree, alias, 'junction')
  const query = vi.fn<(bin: string, args: string[]) => string>(() => JSON.stringify([f.row('shared')]))
  const cost = f.compute({ worktree: alias, sessions: undefined, execFile: query })
  expect(cost.phases[0].lane.calls[0].status).toBe('inferred')
  expect(query.mock.calls[0]?.[1]?.[4]).toContain(`directory='${f.worktree}'`)
  expect(cost.families.openai.input).toBe(6)
})

it.each(['tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_reasoning', 'tokens_cache_write'])('A13 rejects negative usage column %s', column => {
  const f = fixture(); f.save(1, { sessions: [{ ...f.row('s1'), [column]: -1 }] }); f.save(2)
  const cost = f.compute()
  expect(cost.coverage.lanes.counted).toBe(1)
  expect(cost.coverage.lanes.missing[0].reason).toContain(column)
})

it.each(['input', 'output', 'cache_read', 'cache_creation'])('A13 rejects negative Claude total %s', column => {
  const f = fixture(); f.saveClaude(1, { input: 3, output: 7, cache_read: 5, cache_creation: 0, [column]: -1 }); f.save(2)
  const cost = f.compute()
  expect(cost.coverage.lanes.counted).toBe(1)
  expect(cost.coverage.lanes.missing[0].reason).toContain(column === 'cache_creation' ? 'cache_write' : column)
})

it('A14 names independently priced lane dollars above a decreasing-tier phase', () => {
  const f = fixture(); for (const round of [1, 2]) f.saveClaude(round, { input: 3, cache_creation: 0, cache_read: 5, output: 7 })
  const priceTable = { models: { 'claude-pilot': { input: 10, output: 10, cache_read: 1, tiers: [{ input: 0.1, output: 0.1, cache_read: 0.01, tier: { type: 'context', size: 10 } }] } } }
  const phase = f.compute({ priceTable }).phases[0]
  expect(phase.lane.usd).toBeGreaterThan(phase.usd)
  expect(phase.lane_share.usd).toBe('lane priced above phase')
  expect(phase.lane_share.tokens).toBe(15 / 64)
})
