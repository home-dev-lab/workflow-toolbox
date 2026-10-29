import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error runtime host helper
import { computeRunCost } from '../../../../plugin/bin/lib/run-cost-core.mjs'
// @ts-expect-error runtime host helper
import { laneHostDir } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'
// @ts-expect-error runtime host helper
import { canonicalDirectory } from '../../../../plugin/bin/lib/host/canonical-path.mjs'

const roots: string[] = []
const originalLstat = fs.lstatSync.bind(fs)
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wt-cost-lanes-'))); roots.push(root)
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
  const launch = (round: number, requested: string, changes = {}) => ({ version: 1, launch_for: lanes[round - 1]!.usage_file, requested, realpath: worktree, spellings: [...new Set([requested, worktree])], recorded_at: 1050, store_kind: 'shared', ...changes })
  const saveLaunch = (round: number, requested: string, changes = {}) => writeFileSync(join(hostDir, `${lanes[round - 1]!.usage_file}.launch.json`), JSON.stringify(launch(round, requested, changes)))
  return { worktree, laneDir, hostDir, lanes, timeline, row, receipt, save, saveClaude, persist, compute, launch, saveLaunch }
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

function sessionStore(sqlite: typeof import('node:sqlite'), file: string, rows: ReturnType<ReturnType<typeof fixture>['row']>[]) {
  const db = new sqlite.DatabaseSync(file)
  try {
    db.exec('CREATE TABLE session(id TEXT,directory TEXT,model TEXT,tokens_input INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,tokens_cache_read INTEGER,tokens_cache_write INTEGER,time_created INTEGER,time_updated INTEGER)')
    const insert = db.prepare('INSERT INTO session VALUES(?,?,?,3,7,11,5,0,?,?)')
    for (const row of rows) insert.run(row.id, row.directory, JSON.stringify(row.model), row.time_created, row.time_updated)
  } finally { db.close() }
  return vi.fn((_bin: string, args: string[]) => {
    const reader = new sqlite.DatabaseSync(args[3]!, { readOnly: true })
    try { return JSON.stringify(reader.prepare(args[4]!).all()) } finally { reader.close() }
  })
}

it('L3 selects both worktree spellings with quoted SQL and keeps the window scoped', async ctx => {
  let sqlite: typeof import('node:sqlite') | undefined
  try { sqlite = await import('node:sqlite') } catch { ctx.skip('node:sqlite unavailable for shared-store SQL regression') }
  const f = fixture(); f.save(2)
  const alias = join(f.hostDir, "alias's worktree"); symlinkSync(f.worktree, alias, 'junction')
  const rows = [alias, f.worktree].flatMap((directory, index) => [
    { ...f.row(`inside-${index}`), directory },
    { ...f.row(`before-${index}`), directory, time_created: 800, time_updated: 900 },
    { ...f.row(`after-${index}`), directory, time_created: 2100, time_updated: 2200 },
  ])
  rows.push({ ...f.row('foreign'), directory: f.hostDir })
  const dbPath = join(f.hostDir, 'shared.db'); const query = sessionStore(sqlite!, dbPath, rows)
  f.saveLaunch(1, alias)
  const cost = f.compute({ worktree: f.worktree, dbPath, sessions: undefined, execFile: query })
  expect(cost.phases[0].lane.models['openai/gpt'].input).toBe(3)
  expect(cost.families.openai.input).toBe(6)
  expect(cost.unknown).toContainEqual(expect.stringContaining('inside-0'))
  expect(query).toHaveBeenCalledOnce()
  expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'unmatched')?.models['openai/gpt']).toBeUndefined()
})

it('L2 attributes alias-spelled rows through a symlink worktree on every OS', () => {
  const f = fixture(); f.save(2)
  const alias = join(f.hostDir, 'alias'); symlinkSync(f.worktree, alias, 'junction')
  f.save(1, { launch: f.launch(1, alias, { store_kind: 'private' }), alias_binding: 'stable', sessions: [{ ...f.row('alias'), directory: alias }] })
  const cost = f.compute({ worktree: alias })
  expect(cost.phases[0].lane.models['openai/gpt']).toMatchObject({ family: 'openai', input: 3, output: 7 })
  expect(cost.families.openai.input).toBe(6)
  expect(cost.worktree).toBe(alias)
  expect(cost.unknown).toEqual([])
})

it('L2 retains unmatched alias rows and names misses with the worktree as passed', () => {
  const f = fixture(); f.save(2)
  const alias = join(f.hostDir, 'alias'); symlinkSync(f.worktree, alias, 'junction')
  const row = { ...f.row('unmatched'), directory: alias, time_created: 2100, time_updated: 2200 }
  const cost = f.compute({ worktree: alias, sessions: [row] })
  expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'unmatched')?.models['openai/gpt']).toBeUndefined()
  expect(cost.unknown).toContainEqual(expect.stringContaining('unevidenced'))
  expect(cost.phases[0].unknown[0]).toContain(`no OpenCode session row for worktree ${alias} within`)
})

it('L2 retains unmatched canonical rows when the worktree is passed as an alias', () => {
  const f = fixture(); f.save(2)
  const alias = join(f.hostDir, 'alias'); symlinkSync(f.worktree, alias, 'junction')
  const row = { ...f.row('unmatched'), directory: f.worktree, time_created: 2100, time_updated: 2200 }
  const cost = f.compute({ worktree: alias, sessions: [row] })
  expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'unmatched')?.models['openai/gpt'].input).toBe(3)
})

it('L5 keeps host receipt directory validation canonical even for an accepted row alias', () => {
  const f = fixture(); f.save(2)
  const alias = join(f.hostDir, 'alias'); symlinkSync(f.worktree, alias, 'junction')
  f.save(1, { directory: alias })
  const cost = f.compute({ worktree: alias })
  expect(cost.coverage.lanes.counted).toBe(1)
  expect(cost.coverage.lanes.missing[0].reason).toBe('host receipt directory differs from run worktree realpath')
})

it('L5 validates receipts against the initial canonical snapshot if an alias changes', () => {
  const f = fixture(); f.save(2)
  const alias = join(f.hostDir, 'alias'), foreign = join(f.hostDir, 'foreign'); mkdirSync(foreign)
  symlinkSync(f.worktree, alias, 'junction'); f.save(1, { directory: foreign })
  const native = fs.realpathSync.native
  vi.spyOn(fs.realpathSync, 'native').mockImplementation(((file: fs.PathLike) => {
    const result = native(file)
    if (String(file) === alias) { rmSync(alias); symlinkSync(foreign, alias, 'junction') }
    return result
  }) as typeof fs.realpathSync.native)
  const cost = f.compute({ worktree: alias })
  expect(cost.phases[0].lane.calls[0].status).toBe('missing')
  expect(cost.phases[1].lane.calls[0].status).toBe('counted')
})

it('L5 never resolves recorded row directories through the filesystem', () => {
  const f = fixture(); f.save(2)
  const recorded = join(f.hostDir, 'recorded-alias'); symlinkSync(f.worktree, recorded, 'junction')
  const cost = f.compute({ sessions: [{ ...f.row('foreign'), directory: recorded }] })
  expect(cost.families.openai.input).toBe(3)
  expect(cost.phases[0].unknown[0]).toContain('no OpenCode session row')
  expect(cost.phases.some((phase: { phase: string }) => phase.phase === 'unmatched')).toBe(false)
})

function expectLexicalInput(cost: { families: { openai: { input: number } | null } }, canonicalIsLexical: boolean) {
  expect(cost.families.openai?.input ?? null).toBe(canonicalIsLexical ? 3 : null)
}

it('L5 never adds an extra lexical parent of a symlink to matching or SQL', async ctx => {
  let sqlite: typeof import('node:sqlite') | undefined
  try { sqlite = await import('node:sqlite') } catch { ctx.skip('node:sqlite unavailable for shared-store SQL regression') }
  const f = fixture(); const link = join(f.hostDir, 'link'); symlinkSync(f.worktree, link, 'junction')
  const worktree = `${link}${sep}..`; const rows = [{ ...f.row('foreign'), directory: f.hostDir }]
  const canonicalIsLexical = realpathSync.native(worktree) === f.hostDir
  const matched = f.compute({ worktree, sessions: rows })
  expectLexicalInput(matched, canonicalIsLexical)
  expect(matched.phases[0].unknown).toEqual(canonicalIsLexical ? [] : [expect.stringContaining('no OpenCode session row')])
  const dbPath = join(f.hostDir, 'shared.db'); const query = sessionStore(sqlite!, dbPath, rows)
  const queried = f.compute({ worktree, dbPath, sessions: undefined, execFile: query })
  expectLexicalInput(queried, canonicalIsLexical)
  expect(query.mock.calls[0]?.[1][4]?.includes(`directory='${f.hostDir.replaceAll("'", "''")}'`)).toBe(canonicalIsLexical)
})

it('K2 counts a stable evidenced alias receipt when the report supplies the canonical worktree', () => {
  const f = fixture(); f.save(2); const alias = join(f.hostDir, 'alias')
  f.save(1, { launch: f.launch(1, alias, { store_kind: 'private' }), alias_binding: 'stable', sessions: [{ ...f.row('alias'), directory: alias }] })
  expect(f.compute().coverage.lanes.counted).toBe(2)
})

it('K1b leaves retargeted alias receipt rows unknown and the call missing', () => {
  const f = fixture(); f.save(2); const alias = join(f.hostDir, 'alias')
  f.save(1, { launch: f.launch(1, alias, { store_kind: 'private' }), alias_binding: 'retargeted', sessions: [{ ...f.row('alias'), directory: alias }] })
  const cost = f.compute(); expect(cost.families.openai.input).toBe(3)
  expect(cost.unknown).toContainEqual(expect.stringContaining('alias'))
  expect(cost.phases[0].lane.calls[0].status).toBe('missing')
})

it('K2b recovers canonical rows after worker death but leaves launch-only alias rows unknown', () => {
  const f = fixture(); f.save(2); const alias = join(f.hostDir, 'alias'); f.saveLaunch(1, alias)
  const cost = f.compute({ sessions: [f.row('canonical'), { ...f.row('alias'), directory: alias }] })
  expect(cost.families.openai.input).toBe(6)
  expect(cost.unknown).toContainEqual(expect.stringContaining('alias'))
  expect(cost.phases[0].lane.calls[0].status).toBe('inferred')
})

it('K3 never attributes an unevidenced report alias after retargeting', () => {
  const f = fixture(); f.save(2); const alias = join(f.hostDir, 'alias'); symlinkSync(f.hostDir, alias, 'junction')
  const cost = f.compute({ worktree: alias, sessions: [{ ...f.row('alias'), directory: alias }] })
  expect(cost.families.openai).toBeNull()
  expect(cost.unknown).toContainEqual(expect.stringContaining('unevidenced'))
})

it('K4 refuses shared recovery when launch identity differs even if the new canonical row matches', () => {
  const f = fixture(); f.save(2); f.saveLaunch(1, f.worktree, { realpath: f.hostDir, spellings: [f.worktree, f.hostDir] })
  const query = vi.fn(() => JSON.stringify([f.row('foreign')])); const cost = f.compute({ sessions: undefined, execFile: query })
  expect(cost.families.openai.input).toBe(3); expect(query).not.toHaveBeenCalled()
  expect(cost.coverage.lanes.missing[0].reason).toBe('launch directory differs from report worktree realpath')
})

it.each([false, true])('K7 keeps overlapping alias receipts lane-local in reversed order=%s', reverse => {
  const f = fixture()
  for (const round of [1, 2]) {
    const alias = join(f.hostDir, `alias-${round}`)
    f.save(round, { store_kind: 'shared', launch: f.launch(round, alias), alias_binding: 'stable', sessions: [{ ...f.row(`s${round}`), directory: alias, tokens_input: round }] })
  }
  if (reverse) { f.timeline.lanes.reverse(); f.persist() }
  const cost = f.compute()
  for (const round of [1, 2]) expect(cost.phases.find((p: { round: number }) => p.round === round).lane.models['openai/gpt']?.input).toBe(round)
})

it.each([false, true])('K7 never lets another lane evidence admit a receipt alias: reversed=%s', reverse => {
  const f = fixture(); const aliases = [join(f.hostDir, 'alias-1'), join(f.hostDir, 'alias-2')]
  f.save(1, { store_kind: 'shared', launch: f.launch(1, aliases[0]!), alias_binding: 'stable', sessions: [{ ...f.row('foreign-alias'), directory: aliases[1] }] })
  f.save(2, { store_kind: 'shared', launch: f.launch(2, aliases[1]!), alias_binding: 'stable', sessions: [{ ...f.row('owned'), directory: aliases[1], tokens_input: 2 }] })
  if (reverse) { f.timeline.lanes.reverse(); f.persist() }
  const cost = f.compute()
  expect(cost.phases[0].lane.models['openai/gpt']).toBeUndefined()
  expect(cost.phases[1].lane.models['openai/gpt'].input).toBe(2)
  expect(cost.unknown).toContainEqual(expect.stringContaining('foreign-alias'))
})

it.each(['stale', 'wrong basename', 'wrong realpath'])('K4 K10 validates embedded launch evidence: %s', kind => {
  const f = fixture(); f.save(2)
  const changes = kind === 'stale' ? { recorded_at: 900 } : kind === 'wrong basename' ? { launch_for: 'other.json' } : { realpath: f.hostDir, spellings: [f.worktree, f.hostDir] }
  f.save(1, { launch: f.launch(1, f.worktree, changes) })
  const cost = f.compute(); expect(cost.families.openai.input).toBe(3)
  expect(cost.phases[0].lane.calls[0].status).toBe('missing')
})

it('K8 L5 refuses an ENOENT symlink-parent traversal identity', () => {
  const f = fixture(); const link = join(f.hostDir, 'link'); symlinkSync(f.worktree, link, 'junction')
  const worktree = `${link}${sep}..${sep}gone`; const query = vi.fn(() => JSON.stringify([{ ...f.row('lexical'), directory: join(f.hostDir, 'gone') }]))
  const cost = f.compute({ worktree, sessions: undefined, execFile: query })
  expect(cost.coverage.lanes.missing.map((r: { reason: string }) => r.reason)).toEqual(['worktree identity unavailable', 'worktree identity unavailable'])
  expect(query).not.toHaveBeenCalled(); expect(cost.families.openai).toBeNull()
})

it.each(['private', 'malformed', 'stale', 'wrong basename', 'missing kind', 'unknown kind'])('K9 K10 blocks shared fallback for a %s launch record', kind => {
  const f = fixture(); f.save(2)
  const changes = kind === 'private' ? { store_kind: 'private' } : kind === 'stale' ? { recorded_at: 900 } : kind === 'wrong basename' ? { launch_for: 'other.json' } : { store_kind: kind === 'missing kind' ? undefined : 'other' }
  if (kind === 'malformed') writeFileSync(join(f.hostDir, `${f.lanes[0]!.usage_file}.launch.json`), '{')
  else f.saveLaunch(1, f.worktree, changes)
  const query = vi.fn(() => JSON.stringify([f.row('unrelated')])); const cost = f.compute({ sessions: undefined, execFile: query })
  expect(query).not.toHaveBeenCalled(); expect(cost.families.openai.input).toBe(3)
  expect(cost.phases[0].lane.calls[0].status).toBe('missing')
  if (kind === 'private') expect(cost.coverage.lanes.missing[0].reason).toBe('private OpenCode store was not captured')
})

it('K11 refuses a dangling directory link as worktree identity', () => {
  const f = fixture(); const link = join(f.hostDir, 'dangling'); symlinkSync(join(f.hostDir, 'gone'), link, 'junction')
  const cost = f.compute({ worktree: link, sessions: [{ ...f.row('dangling'), directory: link }] })
  expect(cost.families.openai).toBeNull()
  expect(cost.coverage.lanes.missing[0].reason).toBe('worktree identity unavailable')
})

it.each([false, true])('K12 binds production host lookup to timeline identity: retargeted=%s', retargeted => {
  const f = fixture(); Object.assign(f.timeline, { worktree_realpath: f.worktree }); f.persist()
  vi.stubEnv('WT_LANE_HOST_STATE', undefined)
  vi.stubEnv('LOCALAPPDATA', undefined)
  vi.spyOn(os, 'userInfo').mockReturnValue({ ...os.userInfo(), homedir: f.hostDir })
  try {
    const productionHost = laneHostDir(f.worktree); mkdirSync(productionHost, { recursive: true }); roots.push(productionHost)
    f.save(1, {}, productionHost); f.save(2, {}, productionHost)
    const alias = join(f.hostDir, 'alias'); symlinkSync(retargeted ? f.hostDir : f.worktree, alias, 'junction')
    const query = vi.fn(() => JSON.stringify([{ ...f.row('new-target'), directory: f.hostDir }]))
    const cost = f.compute({ worktree: alias, laneHostDir: undefined, sessions: undefined, execFile: query })
    expect(cost.families.openai?.input ?? null).toBe(retargeted ? null : 6)
    expect(query).not.toHaveBeenCalled()
    if (retargeted) expect(cost.coverage.lanes.missing.map((r: { reason: string }) => r.reason)).toEqual(Array(2).fill("report worktree differs from the run's recorded worktree realpath"))
  } finally { vi.unstubAllEnvs() }
})

it.each([false, true])('R1 leaves another lane alias unpriced after retargeting: reversed=%s', reverse => {
  const f = fixture(); const alias = join(f.hostDir, 'alias'), foreign = join(f.hostDir, 'foreign')
  mkdirSync(foreign); symlinkSync(f.worktree, alias, 'junction')
  f.save(1, { store_kind: 'shared', launch: f.launch(1, alias), alias_binding: 'stable', sessions: [{ ...f.row('s1'), directory: alias }] })
  rmSync(alias); symlinkSync(foreign, alias, 'junction')
  Object.assign(f.lanes[1]!, { started_at: 3000, ended_at: 4000 })
  Object.assign(f.timeline, { ended_at: 4000 })
  Object.assign(f.timeline.phases[1]!, { entered_at: 3000, exited_at: 4000 })
  f.saveLaunch(2, f.worktree, { recorded_at: 3050 })
  if (reverse) f.timeline.lanes.reverse()
  f.persist()
  const foreignRow = { ...f.row('foreign-alias'), directory: alias, time_created: 3500, time_updated: 3900 }
  const query = vi.fn(() => JSON.stringify([foreignRow]))
  const cost = f.compute({ sessions: undefined, execFile: query })
  expect(query).toHaveBeenCalledOnce()
  expect(cost.families.openai.input).toBe(3)
  expect(cost.unknown).toContainEqual(expect.stringContaining('foreign-alias is ambiguous'))
  expect(cost.phases.find((p: { phase: string }) => p.phase === 'unmatched')?.models['openai/gpt']).toBeUndefined()
})

it.each([false, true])('R2 limits missing-evidence shared fallback to legacy lanes: marked=%s', marked => {
  const f = fixture(); f.save(2)
  if (marked) Object.assign(f.lanes[0]!, { launch_evidence: true })
  f.persist()
  const query = vi.fn(() => JSON.stringify([f.row('unrelated')]))
  const cost = f.compute({ sessions: undefined, execFile: query })
  expect(query).toHaveBeenCalledTimes(marked ? 0 : 1)
  expect(cost.families.openai.input).toBe(marked ? 3 : 6)
  expect(cost.phases[0].lane.calls[0].status).toBe(marked ? 'missing' : 'inferred')
  if (marked) expect(cost.coverage.lanes.missing[0].reason).toBe('OpenCode launch evidence missing: no usable receipt or launch record')
})

function missingEvidenceWindows(unreadable = false, reverse = false) {
  const f = fixture()
  for (const lane of f.lanes) Object.assign(lane, { launch_evidence: true })
  Object.assign(f.lanes[1]!, { started_at: 3000, ended_at: 4000 })
  Object.assign(f.timeline, { ended_at: 4000 })
  Object.assign(f.timeline.phases[1]!, { entered_at: 3000, exited_at: 4000 })
  f.saveLaunch(2, f.worktree, { recorded_at: 3050 })
  if (unreadable) {
    f.save(1)
    const receiptFile = join(f.hostDir, f.lanes[0]!.usage_file)
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) => {
      if (String(file) === receiptFile) throw Object.assign(new Error('receipt unreadable'), { code: 'EACCES' })
      return originalLstat(file)
    }) as typeof fs.lstatSync)
  }
  if (reverse) f.timeline.lanes.reverse()
  f.persist()
  return f
}

it.each([
  { unreadable: false, reverse: false }, { unreadable: false, reverse: true },
  { unreadable: true, reverse: false }, { unreadable: true, reverse: true },
])('R5 keeps a canonical row inside an evidence-less lane unpriced: unreadable=$unreadable reversed=$reverse', ({ unreadable, reverse }) => {
  const f = missingEvidenceWindows(unreadable, reverse)
  const query = vi.fn(() => JSON.stringify([f.row('inside-A')]))
  const cost = f.compute({ sessions: undefined, execFile: query })
  expect(query).toHaveBeenCalledOnce()
  expect(cost.unknown).toContainEqual(expect.stringMatching(/inside-A is ambiguous:.*critic round 1/))
  expect(cost.families.openai).toBeNull()
  expect(cost.phases.find((p: { phase: string }) => p.phase === 'unmatched')?.models['openai/gpt']).toBeUndefined()
  const call = cost.phases.find((p: { round: number }) => p.round === 1).lane.calls[0]
  expect(call.status).toBe('missing')
  expect(call.reason).toContain(unreadable ? 'receipt unreadable' : 'OpenCode launch evidence missing')
})

it.each([
  { name: 'ends at lane start', start: 900, end: 1000, unfinished: false },
  { name: 'starts at lane end', start: 2000, end: 2100, unfinished: false },
  { name: 'encloses lane', start: 900, end: 2100, unfinished: false },
  { name: 'unfinished lane gap', start: 2500, end: 2600, unfinished: true },
])('R5 checks inclusive span overlap: $name', ({ start, end, unfinished }) => {
  const f = missingEvidenceWindows()
  if (unfinished) { Object.assign(f.lanes[0]!, { ended_at: null, state: 'running' }); f.persist() }
  const row = { ...f.row('overlap'), time_created: start, time_updated: end }
  const cost = f.compute({ sessions: [row] })
  expect(cost.unknown).toContainEqual(expect.stringMatching(/overlap is ambiguous:.*critic round 1/))
  expect(cost.families.openai).toBeNull()
})

it('R5 still prices a canonical row in the gap outside every lane window', () => {
  const f = missingEvidenceWindows()
  const row = { ...f.row('outside'), time_created: 2500, time_updated: 2600 }
  const query = vi.fn(() => JSON.stringify([row]))
  const cost = f.compute({ sessions: undefined, execFile: query })
  expect(query).toHaveBeenCalledOnce()
  expect(cost.families.openai.input).toBe(3)
  expect(cost.phases.find((p: { phase: string }) => p.phase === 'unmatched').models['openai/gpt'].input).toBe(3)
  expect(cost.unknown).toContain('OpenCode session outside matched the run but no lane window')
})

it('R6 lets shared fallback recover a row from a launch-rejected receipt', () => {
  const f = fixture(); Object.assign(f.lanes[0]!, { launch_evidence: true }); f.persist()
  const row = f.row('s')
  f.save(1, { launch: f.launch(1, f.worktree, { launch_for: 'other.json' }), sessions: [row] })
  f.saveLaunch(2, f.worktree)
  const query = vi.fn(() => JSON.stringify([row]))
  const cost = f.compute({ sessions: undefined, execFile: query })
  expect(cost.phases[1].lane.models['openai/gpt']?.input).toBe(3)
  expect(cost.families.openai.input).toBe(3)
  expect(cost.phases[0].lane.calls[0]).toMatchObject({ status: 'missing', reason: 'OpenCode launch_for differs from lane usage_file' })
  expect(cost.phases[1].lane.calls[0].status).toBe('inferred')
  expect(query).toHaveBeenCalledOnce()
})

it('R6 lets shared fallback recover a row from duplicate receipt-file owners', () => {
  const f = fixture(); const row = f.row('s'); f.save(1, { sessions: [row] })
  f.lanes.push({ ...f.lanes[1]!, round: 3, usage_file: 'critic-run.3.log.usage.json' })
  f.timeline.phases.push({ ...f.timeline.phases[1]!, round: 3 })
  f.lanes[1]!.usage_file = f.lanes[0]!.usage_file; f.persist()
  f.saveLaunch(3, f.worktree)
  const cost = f.compute({ sessions: [row] })
  expect(cost.phases[2].lane.models['openai/gpt']?.input).toBe(3)
  expect(cost.families.openai.input).toBe(3)
  for (const phase of cost.phases.slice(0, 2)) expect(phase.lane.calls[0]).toMatchObject({ status: 'missing', reason: expect.stringContaining('duplicate usage_file') })
  expect(cost.phases[2].lane.calls[0].status).toBe('inferred')
})

it.each([null, 'unfinished'])('R7 retains launched receipt rows without a finite lane end: %s', ended_at => {
  const f = fixture(); f.save(2)
  Object.assign(f.lanes[0]!, { ended_at }); f.persist()
  f.save(1, { launch: f.launch(1, f.worktree, { store_kind: 'private' }) })
  const cost = f.compute()
  expect(cost.phases[0].lane.models['openai/gpt']?.input).toBe(3)
  expect(cost.families.openai.input).toBe(6)
  expect(cost.phases[0].lane.calls[0]).toMatchObject({ status: 'inferred', reason: 'lane has no finite ended_at' })
  expect(cost.coverage.lanes).toMatchObject({ counted: 1, status: 'incomplete' })
  expect(cost.coverage.status).toBe('incomplete')
})

it.each([null, 'unfinished'])('R7 still rejects a pre-start launch without a finite lane end: %s', ended_at => {
  const f = fixture(); f.save(2)
  Object.assign(f.lanes[0]!, { ended_at }); f.persist()
  f.save(1, { launch: f.launch(1, f.worktree, { store_kind: 'private', recorded_at: 900 }) })
  const cost = f.compute()
  expect(cost.phases[0].lane.calls[0]).toMatchObject({ status: 'missing', reason: 'OpenCode launch recorded_at lies outside lane started_at..ended_at' })
  expect(cost.phases[0].lane.models['openai/gpt']).toBeUndefined()
  expect(cost.families.openai.input).toBe(3)
})

it.each([
  { position: 'unmatched', start: 2500, input: -1000000 }, { position: 'fallback', start: 3500, input: -1000000 },
  { position: 'unmatched', start: 2500, input: 1000000 }, { position: 'fallback', start: 3500, input: 1000000 },
])('R8 validates shared rows before pricing: $position input=$input', ({ position, start, input }) => {
  const f = missingEvidenceWindows()
  const row = { ...f.row('shared'), time_created: start, time_updated: start + 100, tokens_input: input, tokens_output: 0, tokens_cache_read: 0, tokens_reasoning: 0, tokens_cache_write: 0 }
  const query = vi.fn(() => JSON.stringify([row]))
  const cost = f.compute({ sessions: undefined, execFile: query })
  expect(query).toHaveBeenCalledOnce()
  const phase = position === 'unmatched' ? cost.phases.find((p: { phase: string }) => p.phase === 'unmatched') : cost.phases[1]
  if (input < 0) {
    expect(cost.unknown).toContainEqual(expect.stringMatching(/shared.*non-finite, negative or missing token column tokens_input/))
    expect(cost.families.openai).toBeNull()
    expect(phase?.models['openai/gpt']).toBeUndefined()
    expect(cost.phases[1].lane.models['openai/gpt']).toBeUndefined()
  } else {
    expect(cost.families.openai.input).toBe(input)
    expect(phase.models['openai/gpt'].usd).toBe(2)
    expect(cost.unknown).not.toContainEqual(expect.stringContaining('token column'))
  }
})

it.each([42, { name: 'receipt' }])('R9 degrades a non-string usage_file to one missing lane: %s', usage_file => {
  const f = fixture(); f.save(2)
  Object.assign(f.lanes[0]!, { usage_file }); f.persist()
  const cost = f.compute()
  expect(cost.phases[0].lane.calls[0]).toMatchObject({ status: 'missing', reason: expect.stringContaining('usage_file') })
  expect(cost.phases[1].lane.models['openai/gpt']?.input).toBe(3)
  expect(cost.families.openai.input).toBe(3)
})

it('R3 resolves a live symlink ancestor before checking for a dangling link', () => {
  const f = fixture(); const alias = join(f.hostDir, 'alias'), child = join(alias, 'child')
  const native = vi.fn((input: string) => {
    if (input === alias) return f.worktree
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  const lstat = vi.fn((input: string) => {
    if (input === alias) return { isSymbolicLink: () => true }
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  expect(canonicalDirectory(child, { realpath: { native }, lstat })).toBe(join(f.worktree, 'child'))
  expect(native).toHaveBeenCalledWith(alias)
  expect(lstat).not.toHaveBeenCalledWith(alias)
})

it('R3 recovers a deleted child beneath a live filesystem symlink or junction', () => {
  const f = fixture(); const alias = join(f.hostDir, 'alias'), child = join(f.worktree, 'child')
  mkdirSync(child); symlinkSync(f.worktree, alias, 'junction'); rmSync(child, { recursive: true })
  expect(canonicalDirectory(join(alias, 'child'))).toBe(join(realpathSync.native(f.worktree), 'child'))
})

it('R4 returns no identity for a child beneath a regular file', () => {
  const f = fixture(); const file = join(f.hostDir, 'file'); writeFileSync(file, 'file')
  expect(canonicalDirectory(join(file, 'child'))).toBeNull()
})

it.skipIf(process.platform === 'win32')('R4 rejects /dev/null parent traversal [POSIX device path only]', () => {
  expect(canonicalDirectory('/dev/null/../gone')).toBeNull()
})

it('R4 returns no identity when a walked ancestor fails with ENOTDIR', () => {
  const f = fixture(); const input = join(f.hostDir, 'file', 'child')
  const native = vi.fn((value: string) => {
    throw Object.assign(new Error('unresolvable'), { code: value === input ? 'ENOENT' : 'ENOTDIR' })
  })
  expect(canonicalDirectory(input, { realpath: { native }, lstat: () => ({ isSymbolicLink: () => false }) })).toBeNull()
})

it('R4 returns no identity for a child beneath a regular file when the host reports ENOENT, as Windows does', () => {
  const f = fixture(); const file = join(f.hostDir, 'file'), input = join(file, 'child')
  const native = vi.fn((value: string) => {
    if (value === file) return file
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  const lstat = vi.fn(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })
  const stat = vi.fn((value: string) => ({ isDirectory: () => value !== file }))
  expect(canonicalDirectory(input, { realpath: { native }, lstat, stat })).toBeNull()
  expect(stat).toHaveBeenCalledWith(file)
})

it('R4 reports every OpenAI lane missing when a worktree component is a file', () => {
  const f = fixture(); const file = join(f.hostDir, 'file'); writeFileSync(file, 'file')
  const query = vi.fn(() => JSON.stringify([f.row('unrelated')]))
  const cost = f.compute({ worktree: join(file, 'child'), sessions: undefined, execFile: query })
  expect(cost.coverage.lanes.missing.map((r: { reason: string }) => r.reason)).toEqual(Array(2).fill('worktree identity unavailable'))
  expect(cost.phases.flatMap((p: { lane?: { calls: { status: string }[] } }) => p.lane?.calls ?? []).map((call: { status: string }) => call.status)).toEqual(['missing', 'missing'])
  expect(cost.families.openai).toBeNull(); expect(query).not.toHaveBeenCalled()
})
