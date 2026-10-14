import childProcess, { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error ESM runtime module
import { createLifecycleLaunch } from '../../../../plugin/bin/lib/lifecycle-launch.mjs'
// @ts-expect-error runtime module
import { supervisionPaths } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
// @ts-expect-error runtime module
import { laneHostDir } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'
// @ts-expect-error runtime module
import { createLifecycleServer } from '../../../../plugin/bin/lib/sdk-pilot-lifecycle-server.mjs'

const roots: string[] = []
const snapshots: string[] = []
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); syncBuiltinESMExports()
  for (const snapshot of snapshots.splice(0)) fs.rmSync(snapshot, { recursive: true, force: true })
  for (const root of roots.splice(0)) {
    fs.rmSync(laneHostDir(root), { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function launcherSource(root: string, phase: string, immediate: boolean | 'A') {
  const pathsBySlot = Object.fromEntries([null, 'critic-A', 'critic-B'].map((slot) => [slot ?? phase, supervisionPaths(root, '123-1', slot)]))
  return `import fs from 'node:fs'; import path from 'node:path';
const arg = (name) => process.argv[process.argv.indexOf(name)+1];
const root=arg('--dir'), brief=arg('--brief'), slot=process.env.WT_LANE_SUPERVISION_SLOT ?? null;
const text=fs.readFileSync(brief,'utf8'), tick=String.fromCharCode(96);
const info=text.startsWith('{') ? JSON.parse(text) : {report:text.split('Write the report to '+tick)[1].split(tick)[0],paths:${JSON.stringify(pathsBySlot)}[slot ?? '${phase}']}, paths=info.paths;
fs.mkdirSync(path.dirname(paths.record),{recursive:true});
fs.writeFileSync(paths.record,JSON.stringify({runId:'123-1',workerPid:42001,workerArgv:['fixture'],workerStartTime:1,childPid:42002,childArgv:['fixture'],childStartTime:1,owner:'pilot',ownerToken:arg('--owner-token'),state:'decision-needed',timeoutAt:'first',evidence:{}}));
fs.writeFileSync(paths.pointer,JSON.stringify({runId:'123-1'}));
fs.writeFileSync(path.join(root,(slot ?? '${phase}')+'.json'),JSON.stringify({...info,log:arg('--log'),snapshot:path.dirname(brief)}));
if (${JSON.stringify(immediate)} === true || (${JSON.stringify(immediate)} === 'A' && slot === 'critic-A')) { fs.appendFileSync(arg('--log'),'EXIT=0\\n'); fs.writeFileSync(info.report,${JSON.stringify(phase === 'critic' ? 'VERDICT: changes-requested\nFINDINGS:\n- fixture finding\n' : 'report\n')}); fs.writeFileSync(paths.record,JSON.stringify({runId:'123-1',state:'launch-failed'})); }
process.stdout.write('pid=42001\\nrun=123-1\\n');`
}

function fixture(phase = 'tdd', immediate: boolean | 'A' = false, inheritedSlot?: string) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'owned-lane-')); roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  const laneDir = path.join(root, '.lane'); fs.mkdirSync(laneDir)
  const launcher = path.join(root, 'launcher.mjs'); fs.writeFileSync(launcher, launcherSource(root, phase, immediate))
  const state = { phase, ownedLanes: new Map(), pendingControl: null, laneReceiptSeq: 0, priorCriticRounds: [], verifySnapshot: null }
  let onInspect: (() => void) | null = null
  const afterInspections = (effect: () => void, count = 6) => {
    let remaining = count
    onInspect = () => { if (--remaining === 0) { onInspect = null; effect() } }
  }
  const records: Array<{ ended_at: number | null, exit?: string }> = []
  const laneProcessReader = { inspect: (pid: number) => { onInspect?.(); return { pid, argv: ['fixture'], startTime: 1 } }, processExists: () => true, processState: () => 'S' }
  const launch = createLifecycleLaunch({ root, laneDir, executor: 'gpt-lane', executorEnv: { ...process.env, WT_LANE_SUPERVISION_SLOT: inheritedSlot },
    frozenModels: { code: 'test', critic: 'test', review: 'test' }, state, laneBriefContexts: new Map([[phase, 'brief']]),
    prepareLaneBrief: (_phase: string, _context: string, report: string, snapshot: string) => {
      snapshots.push(snapshot)
      const slot = /\.([AB])\./.exec(report)?.[1]; const paths = supervisionPaths(root, '123-1', slot ? `critic-${slot}` : null)
      return { canonical: 'brief', launch: JSON.stringify({ report, paths }) }
    }, assertLaneDir: () => {}, refusal: (edge: string, missing: string, file: string) => `edge refused: ${edge}; missing ${missing}: ${file}`,
    lanePhases: new Set([phase]), phases: [phase], gates: () => new Set(['lint']), laneLauncher: launcher, lanePollMs: 2, laneWaitMs: 2,
    lanePlatform: 'linux', laneProcessReader,
    recordLaneStart: () => { const record = { ended_at: null }; records.push(record); return record },
    recordLaneEnd: (record: typeof records[number], time: number, exit: string) => { record.ended_at = time; record.exit = exit },
  })
  const info = (slot = phase) => JSON.parse(fs.readFileSync(path.join(root, `${slot}.json`), 'utf8'))
  const finish = (slot = phase, exit = 0, report = true) => {
    const saved = info(slot)
    fs.appendFileSync(saved.log, `EXIT=${exit}\n`)
    if (report) fs.writeFileSync(saved.report, phase === 'critic' ? 'VERDICT: changes-requested\nFINDINGS:\n- fixture finding\n' : 'report\n')
    fs.writeFileSync(saved.paths.record, JSON.stringify({ runId: '123-1', state: 'launch-failed' }))
  }
  const control = (effect: (args: readonly string[]) => void) => {
    const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((...args: Parameters<typeof childProcess.execFileSync>) => { effect(args[1] ?? []); return 'decision submitted' })
    syncBuiltinESMExports(); return spy
  }
  return { ...launch, root, state, records, info, finish, control, afterInspections, launcher, laneProcessReader }
}

function machineFixture(f: ReturnType<typeof fixture>) {
  const archiveRoot = fs.mkdtempSync(path.join(tmpdir(), 'owned-lane-archive-')); roots.push(archiveRoot)
  execFileSync('git', ['init', '-q'], { cwd: archiveRoot })
  fs.writeFileSync(path.join(archiveRoot, '.gitignore'), '.claude/reports/\n')
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.lane/\n.claude/reports/\n')
  const server = createLifecycleServer({ worktree: f.root, archiveRoot, route: 'LITE', models: { lane: 'test', review: 'test' }, cardId: 'fixture', sessionTag: 'fixture',
    laneLauncher: f.launcher, laneWaitMs: 2, lanePollMs: 2, lanePlatform: 'linux', laneProcessReader: f.laneProcessReader, rules: [] })
  const tools = server.instance._registeredTools as Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>
  const invoke = async (name: string, args: Record<string, unknown>) => (await tools[name]!.handler(args)).content[0]!.text
  return { server, invoke }
}

it('T2 a lifecycle transitions on the receipt published by its extended lane', async () => {
  const f = fixture(); const m = machineFixture(f)
  await m.invoke('transition', { phase: 'discovery', tool_use_id: 'start', record: '## External-source ledger\n- Claim: fixture\n  Source: fixture\n  Fetched content: fixture\n  Verdict: confirmed\nGrounding route: proceed\n' })
  await m.invoke('write_artifact', { kind: 'brief', content: 'brief' })
  const timeout = await m.invoke('run', { kind: 'lane', phase: 'tdd' }); snapshots.push(f.info().snapshot)
  const timelineBefore = m.server.timeline().lanes[0].ended_at
  f.control(() => f.afterInspections(() => f.finish()))
  const control = await m.invoke('run', { kind: 'control', decision: 'extend' })
  vi.restoreAllMocks(); syncBuiltinESMExports()
  expect(await m.invoke('transition', { phase: 'tdd', tool_use_id: 'after-extend' })).toBe('accepted phase=verify')
  expect(timeout).toContain('TIMEOUT'); expect(timelineBefore).toBeNull()
  expect(control).toBe('control extend submitted; lane tdd EXIT=0')
  expect(m.server.timeline().lanes[0].exit_code).toBe('0')
})

it('T1 retains owned snapshot and open timeline, refusing a duplicate launch', async () => {
  const f = fixture(); expect(await f.run({ kind: 'lane', phase: 'tdd' })).toContain('TIMEOUT')
  expect(f.records[0]!.ended_at, 'TIMEOUT must leave the timeline lane open').toBeNull()
  expect(f.state.ownedLanes.size).toBe(1); expect(fs.existsSync(f.info().snapshot)).toBe(true)
  expect(await f.run({ kind: 'lane', phase: 'tdd' })).toContain('lane tdd is owned and live')
  expect(f.records).toHaveLength(1)
})

it('T2 extends the same wait, ignoring the answered decision until consumed', async () => {
  const f = fixture(); await f.run({ kind: 'lane', phase: 'tdd' })
  const spy = f.control(() => f.afterInspections(() => {
    const info = f.info(); const saved = JSON.parse(fs.readFileSync(info.paths.record, 'utf8'))
    saved.state = 'running'; saved.decisionTransitionDueAt = new Date(Date.now() + 60_000).toISOString()
    fs.writeFileSync(info.paths.record, JSON.stringify(saved)); f.afterInspections(() => f.finish())
  }))
  expect(await f.run({ kind: 'control', decision: 'extend' })).toBe('control extend submitted; lane tdd EXIT=0')
  expect(spy.mock.calls[0]![1]).not.toContain('--slot')
  expect(f.state.ownedLanes.size).toBe(0); expect(f.state.laneReceiptSeq).toBe(1)
  expect(f.laneEvidence('tdd')).toBeNull(); expect(fs.existsSync(f.info().snapshot)).toBe(false)
})

it.each([true, false])('T2 abandon receipt report=%s finalizes and permits a fresh launch', async (report) => {
  const f = fixture(); await f.run({ kind: 'lane', phase: 'tdd' })
  f.control(() => { f.finish('tdd', 126, report) })
  expect(await f.run({ kind: 'control', decision: 'abandon' })).toBe(`control abandon submitted; lane tdd EXIT=${report ? '126' : 'missing'}`)
  expect(f.state.ownedLanes.size).toBe(0)
  await f.run({ kind: 'lane', phase: 'tdd' }); expect(f.records).toHaveLength(2)
})

it('T3 reconciles a lane that finished before control without submitting a decision', async () => {
  const f = fixture(); await f.run({ kind: 'lane', phase: 'tdd' }); f.finish()
  const spy = f.control(() => { throw new Error('must not submit') })
  expect(await f.run({ kind: 'control', decision: 'extend' })).toBe('lane tdd EXIT=0')
  expect(spy).not.toHaveBeenCalled(); expect(f.state.ownedLanes.size).toBe(0)
})

it('T3 reconciles terminal completion during a refused CLI call', async () => {
  const f = fixture(); await f.run({ kind: 'lane', phase: 'tdd' })
  f.control(() => { f.finish(); throw new Error('no current decision point (terminal)') })
  expect(await f.run({ kind: 'control', decision: 'extend' })).toBe('lane tdd EXIT=0')
  expect(f.state.ownedLanes.size).toBe(0)
})

it.each(['gone', 'terminal'])('T3 finalizes a %s lane without a receipt before any decision', async (status) => {
  const f = fixture(); await f.run({ kind: 'lane', phase: 'tdd' })
  const info = f.info(); const saved = JSON.parse(fs.readFileSync(info.paths.record, 'utf8'))
  if (status === 'terminal') saved.state = 'launch-failed'
  else { saved.workerStartTime = 2; saved.childStartTime = 2 }
  fs.writeFileSync(info.paths.record, JSON.stringify(saved))
  const spy = f.control(() => { throw new Error('must not submit') })
  expect(await f.run({ kind: 'control', decision: 'abandon' })).toBe(`lane tdd ${status === 'gone' ? 'EXIT=missing' : 'TERMINAL receipt=missing'}`)
  expect(spy).not.toHaveBeenCalled(); expect(f.state.ownedLanes.size).toBe(0)
  expect(f.records[0]!.ended_at).not.toBeNull(); expect(fs.existsSync(info.snapshot)).toBe(false)
})

it('T3 keeps separate critic ownership and reconciles B finishing while waiting on A', async () => {
  const f = fixture('critic'); await f.run({ kind: 'lane', phase: 'critic' })
  const ownedAtTimeout = f.state.ownedLanes.size
  const selection = await f.run({ kind: 'control', decision: 'extend' })
  const spy = f.control(() => { f.finish('critic-B'); f.afterInspections(() => f.finish('critic-A')) })
  await f.run({ kind: 'control', decision: 'extend', criticLane: 'A' })
  expect(await f.run({ kind: 'control', decision: 'extend', criticLane: 'B' })).toBe('lane critic EXIT=0')
  expect(ownedAtTimeout).toBe(2); expect(selection).toContain('criticLane')
  expect(spy).toHaveBeenCalledTimes(1); expect(spy.mock.calls[0]![1]).toContain('critic-A')
  expect(f.state.laneReceiptSeq).toBe(1); expect(f.laneEvidence('critic')).toBeNull()
})

it('T3 selects critic B with its exact saved slot', async () => {
  const f = fixture('critic', 'A'); await f.run({ kind: 'lane', phase: 'critic' })
  const receiptsBefore = f.state.laneReceiptSeq
  const spy = f.control(() => f.finish('critic-B'))
  const result = await f.run({ kind: 'control', decision: 'extend', criticLane: 'B' })
  expect(spy.mock.calls[0]![1]).toContain('--slot'); expect(spy.mock.calls[0]![1]).toContain('critic-B')
  expect(result).toBe('control extend submitted; lane critic EXIT=0'); expect(receiptsBefore).toBe(0)
})

it('T3 the default ownership slot excludes inherited launch and control slots', async () => {
  const f = fixture('tdd', false, 'ambient-launch'); await f.run({ kind: 'lane', phase: 'tdd' })
  expect(fs.existsSync(path.join(f.root, 'tdd.json')), 'default launch must clear an inherited supervision slot').toBe(true)
  vi.stubEnv('WT_LANE_SUPERVISION_SLOT', 'ambient-control')
  const spy = f.control(() => f.finish())
  expect(await f.run({ kind: 'control', decision: 'extend' })).toBe('control extend submitted; lane tdd EXIT=0')
  expect(spy.mock.calls[0]![1]).not.toContain('--slot')
  expect(spy.mock.calls[0]![2]).toMatchObject({ env: { WT_LANE_SUPERVISION_SLOT: undefined } })
})

it('T2 a later decision point remains owned until abandon, including an extension ceiling', async () => {
  const f = fixture(); await f.run({ kind: 'lane', phase: 'tdd' })
  f.control(() => { const info = f.info(); const saved = JSON.parse(fs.readFileSync(info.paths.record, 'utf8')); saved.timeoutAt = 'second'; fs.writeFileSync(info.paths.record, JSON.stringify(saved)) })
  expect(await f.run({ kind: 'control', decision: 'extend' })).toContain('TIMEOUT')
  expect(f.state.ownedLanes.size).toBe(1)
  vi.restoreAllMocks(); syncBuiltinESMExports()
  // The supervisor may turn extend into abandon at its ceiling.
  f.control(() => f.finish('tdd', 126))
  expect(await f.run({ kind: 'control', decision: 'extend' })).toBe('control extend submitted; lane tdd EXIT=126')
  expect(f.state.ownedLanes.size).toBe(0)
})

it('T3 preserves a still-live CLI refusal and ownership', async () => {
  const f = fixture(); await f.run({ kind: 'lane', phase: 'tdd' })
  f.control(() => { throw new Error('no current decision point (running)') })
  expect(await f.run({ kind: 'control', decision: 'extend' })).toContain('control extend (no current decision point (running))')
  expect(f.state.ownedLanes.size).toBe(1)
})

it('T4 a failed log audit cannot leave an eligible receipt in memory', async () => {
  const f = fixture('tdd', true); const write = fs.writeFileSync
  vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).includes('evidence.json.') && String(args[1]).includes('tdd-run.log')) throw new Error('injected log audit failure')
    return write(...args)
  })
  syncBuiltinESMExports()
  await f.run({ kind: 'lane', phase: 'tdd' })
  expect(f.laneEvidence('tdd'), 'failed log audit must leave receipt ineligible').toContain('lane receipt unchanged')
  expect(f.state.laneReceiptSeq).toBe(0)
})

it.each(['copy', 'audit'])('T4 terminal %s failure removes ownership and leaves evidence ineligible', async (failure) => {
  const f = fixture(); await f.run({ kind: 'lane', phase: 'tdd' }); f.finish()
  if (failure === 'copy') vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('injected copy failure') })
  else {
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).includes('evidence.json.')) throw new Error('injected audit failure')
      return write(...args)
    })
  }
  syncBuiltinESMExports()
  expect(await f.run({ kind: 'control', decision: 'extend' })).toContain('edge refused:')
  expect(f.state.ownedLanes.size).toBe(0); expect(f.state.laneReceiptSeq).toBe(0)
  expect(f.laneEvidence('tdd')).toContain('lane receipt unchanged')
  expect(f.records[0]!.ended_at).not.toBeNull(); expect(fs.existsSync(f.info().snapshot)).toBe(false)
  vi.restoreAllMocks(); syncBuiltinESMExports()
  expect(await f.run({ kind: 'lane', phase: 'tdd' })).toContain('TIMEOUT'); expect(f.records).toHaveLength(2)
})
