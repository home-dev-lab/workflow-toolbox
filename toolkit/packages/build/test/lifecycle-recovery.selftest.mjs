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
import { observeBlockedRun, finalizePilotLifecycle } from '../../../../plugin/bin/lib/pilot-blocked-run.mjs'
import { createLifecycleServer } from '../../../../plugin/bin/lib/sdk-pilot-lifecycle-server.mjs'

function launcherSource(root, phase, immediate, workerPid = 42001, includeRunId = true) {
  const paths = Object.fromEntries([null, 'critic-A', 'critic-B'].map((slot) => [slot ?? phase, supervisionPaths(root, '123-1', slot)]))
  return `import fs from 'node:fs'; import path from 'node:path';
const arg = (name) => process.argv[process.argv.indexOf(name)+1];
const slot=process.env.WT_LANE_SUPERVISION_SLOT ?? null, text=fs.readFileSync(arg('--brief'),'utf8'), tick=String.fromCharCode(96);
const info=text.startsWith('{') ? JSON.parse(text) : {report:text.split('Write the report to '+tick)[1].split(tick)[0]};
const paths=${JSON.stringify(paths)}[slot ?? '${phase}'];
fs.mkdirSync(path.dirname(paths.record),{recursive:true});
fs.writeFileSync(paths.record,JSON.stringify({runId:'123-1',workerPid:42001,workerArgv:['fixture'],workerStartTime:1,childPid:42002,childArgv:['fixture'],childStartTime:1,owner:'pilot',ownerToken:arg('--owner-token'),state:'decision-needed',timeoutAt:'first',evidence:{}}));
fs.writeFileSync(paths.pointer,JSON.stringify({runId:'123-1'}));
fs.writeFileSync(path.join(arg('--dir'),(slot ?? '${phase}')+'.json'),JSON.stringify({...info,paths,log:arg('--log'),snapshot:path.dirname(arg('--brief'))}));
if (${immediate}) { fs.appendFileSync(arg('--log'),'EXIT=0\\n'); fs.writeFileSync(info.report,${JSON.stringify(phase === 'critic' ? 'VERDICT: changes-requested\nFINDINGS:\n- fixture finding\n' : 'report\n')}); fs.writeFileSync(paths.record,JSON.stringify({runId:'123-1',state:'launch-failed'})); }
process.stdout.write(${JSON.stringify(`pid=${workerPid}\n${includeRunId ? 'run=123-1\n' : ''}`)});`
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

async function deadWorkerCheck(decision) {
  await withFixture('tdd', false, async (f) => {
    const child = childProcess.spawn(process.execPath, ['-e', '']); const pid = child.pid
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    let result
    if (decision === 'launch') {
      fs.writeFileSync(f.launcher, launcherSource(f.root, 'tdd', false, pid, false))
      result = await f.run({ kind: 'lane', phase: 'tdd' })
      fs.writeFileSync(f.launcher, launcherSource(f.root, 'tdd', false))
    } else {
      await f.run({ kind: 'lane', phase: 'tdd' })
      Object.assign(f.state.ownedLanes.get('tdd'), { runId: null, workerPid: pid })
      result = await f.run({ kind: 'control', decision })
    }
    assert.equal(result, 'lane tdd EXIT=missing', 'dead runId-less worker must end as EXIT=missing, not TIMEOUT')
    assert.equal(f.state.ownedLanes.size, 0, 'dead worker must release ownership')
    assert.match(await f.run({ kind: 'lane', phase: 'tdd' }), /TIMEOUT/, 'fresh launch must be admitted')
    assert.equal(f.state.ownedLanes.size, 1)
  })
}

function blockedRuntime(reason = null) {
  const writes = new Map(), logs = []
  const state = { phase: 'tdd', blocked: { cardId: 'recovery', refusal: { text: 'first refusal' } } }
  return { state, writes, logs, options: { dir: tmpdir() }, completed: false, incompleteReason: reason,
    lifecycleServer: { state: () => state, finalizePartial: () => {} }, now: () => 0,
    writeBlockedFile: (file, value) => writes.set(file, value), readBlockedFile: (file) => writes.get(file),
    readFile: (file) => writes.get(file), log: (line) => logs.push(line) }
}

function sourceFunction(name, next) {
  const source = fs.readFileSync(new URL('../../../../plugin/bin/lib/pilot-runner-core.mjs', import.meta.url), 'utf8')
  return source.slice(source.indexOf(name), source.indexOf(next, source.indexOf(name)))
}

async function planWaitBlockedCheck(waitNumber = 1) {
  const runtime = blockedRuntime(); runtime.state.phase = 'plan'; runtime.state.blocked = null
  runtime.pendingTurnEnds = 1
  runtime.lifecycleServer.dodDisputes = () => [{ resolution: null }]
  let waits = 0
  runtime.lifecycleServer.awaitDodDecisions = async () => {
    if (++waits === waitNumber) runtime.state.blocked = { cardId: 'recovery', refusal: { text: 'ownership refusal during binding' } }
  }
  const wait = new Function(`return (${sourceFunction('async function waitForPlanBinding(', '\nfunction partialInstruction(')})`)()
  const follow = new Function('observeBlockedRun', 'waitForPlanBinding', 'phasePromptActive', 'advanceContinuation', 'continuationContent', 'continuationMessage',
    `${sourceFunction('async function* phaseFollowUps(', '\nfunction recordSessionCall(')}\nreturn phaseFollowUps`)(observeBlockedRun, wait, () => true, () => {}, () => 'continue', () => ({ message: 'continuation' }))
  const current = { abort: () => {} }; runtime.pastBoundary = () => false
  assert.equal((await follow(runtime, current).next()).done, true, 'blocked condition during plan binding must not yield a continuation')
}

async function machineRecoveryCheck() {
  await withFixture('tdd', false, async (f) => {
    const archiveRoot = fs.mkdtempSync(join(tmpdir(), 'recovery-machine-archive-')); f.snapshots.push(archiveRoot)
    childProcess.execFileSync('git', ['init', '-q'], { cwd: archiveRoot })
    fs.writeFileSync(join(archiveRoot, '.gitignore'), '.claude/reports/\n')
    fs.writeFileSync(join(f.root, '.gitignore'), '.lane/\n.claude/reports/\n')
    const server = createLifecycleServer({ worktree: f.root, archiveRoot, route: 'LITE', cardId: 'fixture', sessionTag: 'fixture',
      models: { lane: 'test', review: 'test' }, laneLauncher: f.launcher, laneWaitMs: 2, lanePollMs: 2, rules: [],
      lanePlatform: 'linux', laneProcessReader: { inspect: (pid) => ({ pid, argv: ['fixture'], startTime: 1 }), processExists: () => true, processState: () => 'S' },
      boardContract: { boardId: 'fixture', listId: 'fixture' }, routeFinding: async () => ({ id: 'unrelated' }) })
    const tools = server.instance._registeredTools
    assert.equal(Object.hasOwn(tools.run.inputSchema.shape, 'criticLane'), false, 'run schema must not offer criticLane')
    for (const kind of ['lane', 'control']) {
      assert.equal(tools.run.inputSchema.safeParse({ kind, phase: 'tdd', criticLane: 'A' }).success, false,
        'MCP input validation must refuse criticLane instead of stripping it before the handler')
    }
    const invoke = async (name, args) => (await tools[name].handler(args)).content[0].text
    await invoke('transition', { phase: 'discovery', tool_use_id: 'start', record: '## External-source ledger\n- Claim: fixture\n  Source: fixture\n  Fetched content: fixture\n  Verdict: confirmed\nGrounding route: proceed\n' })
    await invoke('route_finding', { title: 'unrelated follow-up', l4Reason: 'unavailable dependency: fixture', risk: 'P2', effort: 'S' })
    await invoke('write_artifact', { kind: 'brief', content: 'brief' })
    await invoke('transition', { phase: 'tdd', tool_use_id: 'premature' })
    assert.equal(server.state().blocked, null, 'fresh launch is admissible: unrelated route must not block')
    // A receipt path that cannot be replaced closes the fresh-launch route as well.
    const log = join(laneHostDir(f.root), 'tdd-run.log'); fs.mkdirSync(log)
    await invoke('transition', { phase: 'tdd', tool_use_id: 'closed' })
    assert.equal(server.state().blocked?.cardId, 'unrelated', 'genuinely closed receipt edge must remain blocked')
    fs.rmSync(log, { recursive: true })
    assert.match(await invoke('run', { kind: 'lane', phase: 'tdd' }), /TIMEOUT/)
    f.snapshots.push(f.info().snapshot)
  })
}

function pairDecisionCheck(decision) {
  return withFixture('critic', false, async (f) => {
    await f.run({ kind: 'lane', phase: 'critic' })
    const calls = []
    childProcess.execFileSync = (_command, args) => {
      const slot = args[args.indexOf('--slot') + 1]; calls.push(slot)
      const owner = f.state.ownedLanes.get(slot)
      assert.equal(args[args.indexOf('--owner-token') + 1], owner.nonce)
      f.finish(slot); return 'decision submitted'
    }; syncBuiltinESMExports()
    assert.equal(await f.run({ kind: 'control', decision }), `control ${decision} submitted; lane critic EXIT=0`)
    assert.deepEqual(calls.sort(), ['critic-A', 'critic-B'])
    assert.equal(f.state.ownedLanes.size, 0); assert.equal(f.state.laneReceiptSeq, 1)
    assert.equal(f.laneEvidence('critic'), null)
  })
}

function laterCriticCheck(decision) {
  return withFixture('critic', false, async (f) => {
    f.state.priorCriticRounds.push({ round: 1 })
    assert.match(await f.run({ kind: 'lane', phase: 'critic' }), /TIMEOUT/)
    assert.equal(f.snapshots.length, 1, 'second critic round must launch exactly one lane with no slot')
    const record = f.state.ownedLanes.get('critic')
    assert.equal(f.state.ownedLanes.size, 1)
    assert.equal(record.slot, null); assert.equal(record.criticLane, undefined)
    assert.equal(f.info().paths.record, supervisionPaths(f.root, '123-1').record)
    const calls = []
    childProcess.execFileSync = (_command, args) => {
      calls.push(args); assert.equal(args.includes('--slot'), false)
      assert.equal(args[args.indexOf('--owner-token') + 1], record.nonce)
      f.finish(); return 'decision submitted'
    }; syncBuiltinESMExports()
    assert.equal(await f.run({ kind: 'control', decision }), `control ${decision} submitted; lane critic EXIT=0`)
    assert.equal(calls.length, 1); assert.equal(f.state.ownedLanes.size, 0)
    assert.equal(f.state.laneReceiptSeq, 1); assert.equal(f.laneEvidence('critic'), null)
    assert.equal(fs.existsSync(join(f.root, '.lane', 'critic-A-report.md')), false)
    assert.match(await f.run({ kind: 'lane', phase: 'critic' }), /TIMEOUT/)
    f.finish()
    assert.equal(await f.run({ kind: 'control', decision }), 'lane critic EXIT=0')
    assert.equal(calls.length, 1); assert.equal(f.state.laneReceiptSeq, 2)
  })
}

export const recoveryChecks = {
  ClaterExtend: () => laterCriticCheck('extend'),
  ClaterAbandon: () => laterCriticCheck('abandon'),
  CcallerDocs: async () => {
    for (const name of ['PILOT-CONTRACT.md', 'PILOT-RUNNER.md']) {
      const text = fs.readFileSync(new URL(`../../../../plugin/autonomy/${name}`, import.meta.url), 'utf8')
      assert.doesNotMatch(text, /criticLane/, `${name} must not instruct callers to pass the refused selector`)
      assert.match(text, /control.*whole pair/)
      assert.match(text, /retry relaunches both/)
      assert.match(text, /no selector/i)
      if (name === 'PILOT-CONTRACT.md') assert.ok(Buffer.byteLength(text) <= 6 * 1024, 'pilot contract must fit the existing 6 KiB budget')
    }
  },
  C1launch: () => deadWorkerCheck('launch'),
  C1extend: () => deadWorkerCheck('extend'),
  C1abandon: () => deadWorkerCheck('abandon'),
  C2: () => withFixture('critic', true, async (f) => {
    await f.run({ kind: 'lane', phase: 'critic' })
    fs.writeFileSync(f.launcher, launcherSource(f.root, 'critic', false))
    assert.match(await f.run({ kind: 'lane', phase: 'critic' }), /TIMEOUT/)
    assert.notEqual(f.laneEvidence('critic'), null, 'critic retry must invalidate the previous aggregate while owned')
    assert.equal(f.state.ownedLanes.size, 2, 'first-round critic retry must relaunch both slots')
    const owners = [...f.state.ownedLanes.values()]
    assert.match(await f.run({ kind: 'lane', phase: 'critic' }), /owned and live/)
    assert.deepEqual([...f.state.ownedLanes.values()], owners, 'pair retry must not replace either owned slot')
  }),
  C3: () => withFixture('critic', false, async (f) => {
    await f.run({ kind: 'lane', phase: 'critic' }); f.finish('critic-A')
    childProcess.execFileSync = () => { throw new Error('fixture still live') }; syncBuiltinESMExports()
    const result = await f.run({ kind: 'control', decision: 'extend' })
    assert.doesNotMatch(result, /criticLane A\|B/, 'critic control must act on the pair')
    assert.doesNotMatch(result, /lane critic EXIT=/, 'one unpublished sibling forbids an aggregate EXIT result')
    assert.equal(f.state.ownedLanes.size, 1)
    f.finish('critic-B')
    assert.equal(await f.run({ kind: 'control', decision: 'abandon' }), 'lane critic EXIT=0')
    assert.equal(f.state.ownedLanes.size, 0); assert.equal(f.state.laneReceiptSeq, 1)
  }),
  C3partial: () => withFixture('critic', false, async (f) => {
    await f.run({ kind: 'lane', phase: 'critic' }); f.finish('critic-A')
    const result = await f.run({ kind: 'control', decision: 'extend', criticLane: 'A' })
    assert.doesNotMatch(result, /lane critic EXIT=/, 'completed critic A must never claim aggregate EXIT while B is owned')
  }),
  CpairExtend: () => pairDecisionCheck('extend'),
  CpairAbandon: () => pairDecisionCheck('abandon'),
  CpairBrief: () => withFixture('critic', false, async (f) => {
    await f.run({ kind: 'lane', phase: 'critic' })
    f.identities.set('critic', 'V2'); f.finish('critic-A'); f.finish('critic-B')
    assert.match(await f.run({ kind: 'control', decision: 'extend' }), /current brief.*relaunch.*code=receipt/)
    assert.equal(f.state.ownedLanes.size, 0); assert.equal(f.state.laneReceiptSeq, 0)
    assert.notEqual(f.laneEvidence('critic'), null)
    fs.writeFileSync(f.launcher, launcherSource(f.root, 'critic', true))
    assert.equal(await f.run({ kind: 'lane', phase: 'critic' }), 'lane critic EXIT=0')
    assert.equal(f.state.laneReceiptSeq, 1)
  }),
  C5run: () => withFixture('tdd', true, async (f) => {
    assert.match(await f.run({ kind: 'lane', phase: 'tdd', criticLane: 'A' }), /criticLane.*not supported/, 'criticLane must be refused for run')
  }),
  C5control: () => withFixture('tdd', false, async (f) => {
    await f.run({ kind: 'lane', phase: 'tdd' })
    assert.match(await f.run({ kind: 'control', decision: 'abandon', criticLane: 'A' }), /criticLane.*not supported/, 'criticLane must be refused for control')
  }),
  C4: machineRecoveryCheck,
  C6reason: async () => {
    for (const reason of ['timeout', 'sdk stream error: fixture']) {
      const runtime = blockedRuntime(reason)
      assert.equal(observeBlockedRun(runtime), false)
      assert.equal(runtime.incompleteReason, reason, 'first terminal reason must win')
      assert.equal(runtime.writes.size, 0)
    }
  },
  C6once: async () => {
    const runtime = blockedRuntime(); observeBlockedRun(runtime)
    const before = [...runtime.writes]; runtime.state.blocked.refusal.text = 'later refusal'
    observeBlockedRun(runtime)
    assert.deepEqual([...runtime.writes], before, 'blocked report and summary must not be rewritten')
    assert.equal(runtime.logs.length, 1, 'blocked reason must be logged once')
    assert.match(runtime.incompleteReason, /first refusal/); assert.equal(runtime.blockedStop.refusal, 'first refusal')
  },
  C6write: async () => {
    const runtime = blockedRuntime(); const write = runtime.writeBlockedFile
    runtime.writeBlockedFile = (file, value) => { if (file.endsWith('blocked-report.md')) throw new Error('injected blocked write failure'); write(file, value) }
    assert.doesNotThrow(() => observeBlockedRun(runtime), 'blocked report write failure must not escape runner finalization')
    assert.equal(JSON.parse(runtime.writes.get(join(tmpdir(), '.lane', 'summary.json'))).blocked_on.refusal, 'first refusal')
    runtime.writeBlockedFile = () => { throw new Error('injected summary write failure') }
    const finalized = finalizePilotLifecycle(runtime, false)
    assert.equal(finalized.summary.blocked_on.refusal, 'first refusal', 'runner summary must retain blocker even when every blocked-summary write fails')
  },
  C7: () => planWaitBlockedCheck(1),
  C7second: () => planWaitBlockedCheck(2),
  F7: () => withFixture('critic', true, async (f) => {
    assert.equal(await f.run({ kind: 'lane', phase: 'critic' }), 'lane critic EXIT=0')
    f.identities.set('critic', 'V2'); f.invalidateLaneEvidence('critic')
    assert.equal(await f.run({ kind: 'lane', phase: 'critic' }), 'lane critic EXIT=0')
    const evidence = JSON.parse(fs.readFileSync(join(f.root, '.lane', 'evidence.json'), 'utf8')).entries
    for (const slot of ['A', 'B']) assert.equal(evidence[join(f.root, '.lane', `critic-${slot}-report.md`)].briefIdentity, 'V2')
    assert.equal(f.laneEvidence('critic'), null); assert.equal(f.state.laneReceiptSeq, 2)
  }),
  F8: () => withFixture('critic', true, async (f) => {
    assert.equal(await f.run({ kind: 'lane', phase: 'critic' }), 'lane critic EXIT=0')
    f.state.phase = 'tdd'
    const result = await f.run({ kind: 'lane', phase: 'critic' })
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
    const events = createLifecycleEvents(f.state, (phase) => f.canLaunchLane(phase))
    f.briefs.delete('tdd')
    events.route('receipt-recovery', 'fixture'); events.refused('receipt refusal', 'receipt')
    assert.notEqual(events.blocked(), null)
    f.briefs.set('tdd', 'brief')
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
    await f.run({ kind: 'lane', phase: 'critic' })
    const sibling = f.state.ownedLanes.get('critic-B'); f.finish('critic-A')
    const copy = fs.copyFileSync
    fs.copyFileSync = () => { throw new Error('injected A publication failure') }
    childProcess.execFileSync = () => { throw new Error('fixture still live') }; syncBuiltinESMExports()
    const failed = await f.run({ kind: 'control', decision: 'extend' })
    fs.copyFileSync = copy
    assert.doesNotMatch(failed, /lane critic EXIT=/); assert.equal(f.state.ownedLanes.has('critic-A'), false)
    const retry = await f.run({ kind: 'lane', phase: 'critic' })
    assert.match(retry, /owned and live/, 'pair retry must wait for the owned sibling')
    assert.equal(f.state.ownedLanes.get('critic-B'), sibling)
    f.finish('critic-B'); assert.match(await f.run({ kind: 'control', decision: 'abandon' }), /published receipts from both/)
    assert.equal(f.state.ownedLanes.size, 0)
    assert.match(await f.run({ kind: 'lane', phase: 'critic' }), /TIMEOUT/)
    assert.equal(f.state.ownedLanes.size, 2)
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
    assert.equal(await f.run({ kind: 'lane', phase: 'critic' }), 'lane critic EXIT=0')
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
