import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLifecycleLaunch } from '../../../../plugin/bin/lib/lifecycle-launch.mjs'
import { createLifecycleEvents } from '../../../../plugin/bin/lib/lifecycle-events.mjs'
import { supervisionPaths } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
import { laneHostDir } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'
import { archiveLifecycle } from '../../../../plugin/bin/lib/lifecycle-report-edge.mjs'

function launcherSource(root, phase, immediate) {
  const paths = Object.fromEntries([null, 'critic-A', 'critic-B'].map((slot) => [slot ?? phase, supervisionPaths(root, '123-1', slot)]))
  return `import fs from 'node:fs'; import path from 'node:path';
const arg = (name) => process.argv[process.argv.indexOf(name)+1];
const slot=process.env.WT_LANE_SUPERVISION_SLOT ?? null, info=JSON.parse(fs.readFileSync(arg('--brief'),'utf8'));
const paths=${JSON.stringify(paths)}[slot ?? '${phase}'];
fs.mkdirSync(path.dirname(paths.record),{recursive:true});
fs.writeFileSync(paths.record,JSON.stringify({runId:'123-1',workerPid:42001,workerArgv:['fixture'],workerStartTime:1,childPid:42002,childArgv:['fixture'],childStartTime:1,owner:'pilot',ownerToken:arg('--owner-token'),state:'decision-needed',timeoutAt:'first',evidence:{}}));
fs.writeFileSync(paths.pointer,JSON.stringify({runId:'123-1'}));
fs.writeFileSync(path.join(arg('--dir'),(slot ?? '${phase}')+'.json'),JSON.stringify({...info,paths,log:arg('--log')}));
if (${immediate}) { fs.appendFileSync(arg('--log'),'EXIT=0\\n'); fs.writeFileSync(info.report,${JSON.stringify(phase === 'critic' ? 'VERDICT: changes-requested\nFINDINGS:\n- fixture finding\n' : 'report\n')}); fs.writeFileSync(paths.record,JSON.stringify({runId:'123-1',state:'launch-failed'})); }
process.stdout.write('pid=42001\\nrun=123-1\\n');`
}

function launchFixture(f, phase) {
  return createLifecycleLaunch({ root: f.root, laneDir: join(f.root, '.lane'), executor: 'gpt-lane', executorEnv: process.env,
    frozenModels: { code: 'test', critic: 'test' }, state: f.state, laneBriefContexts: f.briefs, laneBriefIdentities: f.identities,
    prepareLaneBrief: (_phase, _context, report, snapshot) => {
      f.snapshots.push(snapshot); return { canonical: 'brief', launch: JSON.stringify({ report }) }
    }, assertLaneDir: () => {}, refusal: (edge, missing, file, code) => `edge refused: ${edge}; missing ${missing}: ${file}${code ? `; code=${code}` : ''}`,
    lanePhases: new Set([phase]), phases: [phase], gates: () => new Set(), laneLauncher: f.launcher, lanePollMs: 2, laneWaitMs: 2,
    lanePlatform: 'linux', laneProcessReader: {
      inspect: (pid) => { f.onInspect?.(); return f.gone?.has(pid) ? null : { pid, argv: ['fixture'], startTime: 1 } },
      processExists: (pid) => !f.gone?.has(pid), processState: () => 'S',
    },
  })
}

function fixture(phase = 'tdd', immediate = false) {
  const root = fs.mkdtempSync(join(tmpdir(), 'lifecycle-recovery-'))
  fs.mkdirSync(join(root, '.lane')); childProcess.execFileSync('git', ['init', '-q'], { cwd: root })
  const launcher = join(root, 'launcher.mjs'); fs.writeFileSync(launcher, launcherSource(root, phase, immediate))
  const f = { root, launcher, snapshots: [], onInspect: null, briefs: new Map([[phase, 'brief']]), identities: new Map([[phase, 'V1']]),
    state: { phase, ownedLanes: new Map(), laneReceiptSeq: 0, priorCriticRounds: [], verifySnapshot: null } }
  f.info = (slot = phase) => JSON.parse(fs.readFileSync(join(root, `${slot}.json`), 'utf8'))
  f.finish = (slot = phase) => {
    const info = f.info(slot); fs.appendFileSync(info.log, 'EXIT=0\n')
    fs.writeFileSync(info.report, phase === 'critic' ? 'VERDICT: changes-requested\nFINDINGS:\n- fixture finding\n' : 'report\n')
    fs.writeFileSync(info.paths.record, JSON.stringify({ runId: '123-1', state: 'launch-failed' }))
  }
  return Object.assign(f, launchFixture(f, phase))
}

async function withFixture(phase, immediate, check) {
  const f = fixture(phase, immediate)
  const originalExec = childProcess.execFileSync; const originalCopy = fs.copyFileSync; const originalRename = fs.renameSync
  try { await check(f) } finally {
    childProcess.execFileSync = originalExec; fs.copyFileSync = originalCopy; fs.renameSync = originalRename; syncBuiltinESMExports()
    for (const snapshot of f.snapshots) fs.rmSync(snapshot, { recursive: true, force: true })
    fs.rmSync(laneHostDir(f.root), { recursive: true, force: true }); fs.rmSync(f.root, { recursive: true, force: true })
  }
}

function runningControlCheck(decision, completes) {
  return withFixture('tdd', false, async (f) => {
    await f.run({ kind: 'lane', phase: 'tdd' })
    const info = f.info(); const saved = JSON.parse(fs.readFileSync(info.paths.record, 'utf8'))
    saved.state = 'running'; saved.decisionTransitionDueAt = new Date(Date.now() + (completes ? 1000 : -1)).toISOString()
    fs.writeFileSync(info.paths.record, JSON.stringify(saved))
    let submissions = 0; let inspections = 0
    childProcess.execFileSync = () => { submissions += 1; return 'decision submitted' }; syncBuiltinESMExports()
    f.onInspect = () => { if (completes && ++inspections === 3) f.finish() }
    const result = await f.run({ kind: 'control', decision })
    assert.equal(submissions, 0, 'running reconciliation must resume observation without a CLI decision')
    if (completes) {
      assert.equal(result, 'lane tdd EXIT=0'); assert.equal(f.state.ownedLanes.size, 0)
    } else {
      assert.match(result, /TIMEOUT.*liveness=running/); assert.equal(f.state.ownedLanes.size, 1)
    }
  })
}

function orphanAbandonCheck() {
  return withFixture('tdd', false, async (f) => {
    await f.run({ kind: 'lane', phase: 'tdd' })
    f.gone = new Set([42001])
    let submissions = 0
    childProcess.execFileSync = () => { submissions += 1; f.finish(); return 'decision submitted' }; syncBuiltinESMExports()
    const result = await f.run({ kind: 'control', decision: 'abandon' })
    assert.doesNotMatch(result, /decision-needed/, `fixture must reach the orphan state, got: ${result}`)
    assert.equal(submissions, 1, 'abandon of a worker-gone-child-alive lane must reach the control CLI, which terminates the orphan child')
  })
}

export const recoveryChecks = {
  F7: () => withFixture('critic', true, async (f) => {
    assert.equal(await f.run({ kind: 'lane', phase: 'critic' }), 'lane critic EXIT=0')
    f.identities.set('critic', 'V2'); f.invalidateLaneEvidence('critic')
    const result = await f.run({ kind: 'lane', phase: 'critic', criticLane: 'A' })
    assert.match(result, /edge refused:.*critic-B.*relaunch.*code=receipt/, 'stale critic B must refuse aggregation with a receipt-coded relaunch remedy')
    assert.notEqual(f.laneEvidence('critic'), null, 'mixed-brief receipts must remain ineligible')
    assert.equal(f.state.laneReceiptSeq, 1)
    assert.equal(await f.run({ kind: 'lane', phase: 'critic', criticLane: 'B' }), 'lane critic EXIT=0')
    assert.equal(f.laneEvidence('critic'), null); assert.equal(f.state.laneReceiptSeq, 2)
  }),
  F8: () => withFixture('critic', true, async (f) => {
    assert.equal(await f.run({ kind: 'lane', phase: 'critic' }), 'lane critic EXIT=0')
    f.state.phase = 'tdd'
    const result = await f.run({ kind: 'lane', phase: 'critic', criticLane: 'A' })
    assert.match(result, /edge refused: tdd->next; missing lane for current admitted phase:/, 'explicit critic retry must preserve its admission refusal')
    assert.equal(f.state.laneReceiptSeq, 1)
  }),
  F9: () => withFixture('tdd', false, async (f) => {
    const archiveRoot = fs.mkdtempSync(join(tmpdir(), 'lifecycle-recovery-archive-')); f.snapshots.push(archiveRoot)
    const laneDir = join(f.root, '.lane'); const reason = 'blocked: routed receipt-recovery'
    const blocked = { completed: false, reason, blocked_on: { card: 'receipt-recovery' } }
    fs.writeFileSync(join(f.root, '.gitignore'), '.lane/\n')
    fs.writeFileSync(join(laneDir, 'summary.json'), JSON.stringify(blocked))
    fs.writeFileSync(join(laneDir, 'blocked-report.md'), reason)
    fs.renameSync = () => { throw new Error('injected final archive rename failure') }
    assert.throws(() => archiveLifecycle({ root: f.root, archiveRoot, laneDir, cardId: 'fixture', route: 'LITE', head: 'fixture',
      phases: [], evidence: 'fixture', partial: { phase: 'tdd', reason }, implementation: { name: 'fixture' },
      assertDirectories: () => {}, copy: fs.cpSync, git: childProcess.execFileSync,
      sha256: (content) => createHash('sha256').update(content).digest('hex'), writeRegularFile: fs.writeFileSync,
    }), /injected final archive rename failure/)
    assert.equal(fs.existsSync(join(laneDir, 'summary.json')), true, 'archive withdrawal must retain the local blocked summary before runner repair')
    const summary = JSON.parse(fs.readFileSync(join(laneDir, 'summary.json'), 'utf8'))
    assert.equal(summary.completed, false); assert.equal(summary.reason, reason); assert.deepEqual(summary.blocked_on, blocked.blocked_on)
    assert.equal(summary.archive, undefined); assert.equal(fs.readFileSync(join(laneDir, 'blocked-report.md'), 'utf8'), reason)
    assert.deepEqual(fs.readdirSync(join(archiveRoot, '.claude', 'reports')), [])
  }),
  F1: () => withFixture('tdd', false, async (f) => {
    const events = createLifecycleEvents(f.state)
    events.route('receipt-recovery', 'fixture'); events.refused('receipt refusal', 'receipt')
    assert.notEqual(events.blocked(), null)
    let waitingBlocker = 'not observed'
    f.onInspect = () => { waitingBlocker = events.blocked() }
    const pending = f.run({ kind: 'lane', phase: 'tdd' }); const launchingBlocker = events.blocked()
    await pending
    assert.equal(launchingBlocker, null, 'recovery launch must suppress blocked termination before its first await')
    assert.equal(waitingBlocker, null, 'initial wait must remain owned')
    assert.equal(f.state.ownedLanes.size, 1)
    f.finish(); await f.run({ kind: 'control', decision: 'extend' }); assert.equal(f.state.ownedLanes.size, 0)
  }),
  F2: () => withFixture('critic', false, async (f) => {
    await f.run({ kind: 'lane', phase: 'critic', criticLane: 'A' })
    // Seed the independent sibling's ownership; this check concerns A's released slot.
    const sibling = { key: 'critic-B', phase: 'critic', criticLane: 'B', slot: 'critic-B' }
    f.state.ownedLanes.set(sibling.key, sibling); f.finish('critic-A')
    const copy = fs.copyFileSync
    fs.copyFileSync = () => { throw new Error('injected A publication failure') }
    const failed = await f.run({ kind: 'control', decision: 'extend', criticLane: 'A' })
    fs.copyFileSync = copy
    assert.match(failed, /publish lane pair/); assert.equal(f.state.ownedLanes.has('critic-A'), false)
    const retry = await f.run({ kind: 'lane', phase: 'critic', criticLane: 'A' })
    assert.match(retry, /lane critic TIMEOUT/, 'released critic A must restart while B remains owned')
    assert.equal(f.state.ownedLanes.get('critic-B'), sibling)
    const owner = f.state.ownedLanes.get('critic-A')
    assert.match(await f.run({ kind: 'lane', phase: 'critic', criticLane: 'A' }), /owned and live/)
    assert.equal(f.state.ownedLanes.get('critic-A'), owner)
  }),
  F3: () => withFixture('critic', true, async (f) => {
    const copy = fs.copyFileSync
    fs.copyFileSync = (...args) => {
      if (args[1] === join(f.root, '.lane', 'critic-A-report.md')) throw new Error('injected A publication failure')
      return copy(...args)
    }
    assert.match(await f.run({ kind: 'lane', phase: 'critic' }), /publish lane pair/)
    assert.equal(f.state.ownedLanes.size, 0); assert.equal(f.state.laneReceiptSeq, 0)
    assert.equal(fs.existsSync(join(f.root, '.lane', 'critic-B-report.md')), true)
    fs.copyFileSync = copy
    assert.equal(await f.run({ kind: 'lane', phase: 'critic', criticLane: 'A' }), 'lane critic EXIT=0')
    assert.equal(f.laneEvidence('critic'), null, 'successful explicit critic recovery must publish the canonical aggregate')
    assert.equal(f.state.laneReceiptSeq, 1, 'critic recovery must aggregate exactly once')
    const log = fs.readFileSync(join(laneHostDir(f.root), 'critic-run.log'), 'utf8')
    assert.equal((log.match(/LANE=[AB]/g) ?? []).length, 2)
  }),
  F4: async () => {
    for (const decision of ['extend', 'abandon']) {
      await runningControlCheck(decision, true); await runningControlCheck(decision, false)
    }
  },
  F6: orphanAbandonCheck,
  F5: () => withFixture('tdd', false, async (f) => {
    const archiveRoot = fs.mkdtempSync(join(tmpdir(), 'lifecycle-recovery-archive-')); f.snapshots.push(archiveRoot)
    const laneDir = join(f.root, '.lane'); const reason = 'blocked: routed card receipt-recovery: receipt refusal'
    const blocked = { completed: false, reason, blocked_on: { card: 'receipt-recovery', refusal: 'receipt refusal' } }
    fs.writeFileSync(join(f.root, '.gitignore'), '.lane/\n')
    fs.writeFileSync(join(laneDir, 'summary.json'), JSON.stringify(blocked))
    fs.writeFileSync(join(laneDir, 'blocked-report.md'), reason)
    const archive = (partial) => archiveLifecycle({ root: f.root, archiveRoot, laneDir, cardId: 'fixture', route: 'LITE', head: 'fixture',
      phases: [], evidence: 'fixture', partial, implementation: { name: 'fixture' },
      assertDirectories: () => {}, copy: fs.cpSync, git: childProcess.execFileSync,
      sha256: (content) => createHash('sha256').update(content).digest('hex'), writeRegularFile: fs.writeFileSync,
    })
    const result = archive({ phase: 'tdd', reason })
    const archived = JSON.parse(fs.readFileSync(join(result.archive.path, 'summary.json'), 'utf8'))
    assert.equal(archived.completed, false, 'archived summary must retain completed:false before any runner repair')
    assert.equal(archived.reason, reason); assert.deepEqual(archived.blocked_on, blocked.blocked_on)
    assert.deepEqual(JSON.parse(fs.readFileSync(join(laneDir, 'summary.json'), 'utf8')), archived)
    for (const partial of [null, { phase: 'tdd', reason: 'stream ended without receipt' }]) {
      fs.writeFileSync(join(laneDir, 'summary.json'), JSON.stringify(blocked))
      const next = archive(partial)
      const summary = JSON.parse(fs.readFileSync(join(next.archive.path, 'summary.json'), 'utf8'))
      assert.equal(summary.blocked_on, undefined, 'a new nonblocked archive must not inherit an old blocker')
      assert.equal(summary.completed, undefined); assert.equal(summary.reason, undefined)
    }
    fs.writeFileSync(join(laneDir, 'summary.json'), JSON.stringify(blocked))
    const prior = archive({ phase: 'tdd', reason: 'prior partial', finalizationReason: reason })
    assert.deepEqual(JSON.parse(fs.readFileSync(join(prior.archive.path, 'summary.json'), 'utf8')).blocked_on, blocked.blocked_on)
  }),
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const selected = process.argv[2] ? [process.argv[2]] : Object.keys(recoveryChecks)
  for (const name of selected) {
    try { await recoveryChecks[name](); console.log(`${name} PASS`) }
    catch (error) { console.error(error); process.exitCode = 1 }
  }
}
