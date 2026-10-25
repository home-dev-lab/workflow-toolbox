import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLaneQueue } from '../../../../../plugin/bin/lib/host/lane-suite-queue.mjs'

const worker = process.env.WT_LANE_DEADLINE_MODULE ?? new URL('../../../../../plugin/bin/lib/host/lane-deadline-worker.mjs', import.meta.url)
const { createLaneDeadline } = await import(worker)

function configureHarnessTimers(t, options) {
  if (!options.realTime) t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 })
  if (options.withoutOwnerPoll) {
    const interval = globalThis.setInterval
    t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => interval(callback, ms === 100 ? 1_000_000_000 : ms, ...args))
  }
}

export function harness(t, options = {}) {
  const scratch = fs.mkdtempSync(join(tmpdir(), 'broker-deadline-')), root = join(scratch, 'worktree')
  fs.mkdirSync(root)
  const lock = join(root, 'lock'), decisionFile = join(root, 'decision.json'), log = join(root, 'run.log')
  fs.writeFileSync(log, '')
  configureHarnessTimers(t, options)
  let state = { runId: '1-1', state: 'running', extensions: [] }, evidence = null, failure = null, readFailure = null
  const store = options.stateWriterFactory?.(state)
  const current = () => store ? store.current() : state
  const terminal = [], journal = []
  const opts = { dir: root, log, timeout: 2, decisionGrace: 1, maxExtensions: 0, idleWindow: 0.5, idleTimeout: 0, ...options }
  const modules = { argvSummary: () => 'stub', latestWorktreeWrite: () => ({ status: 'known', at: 100_000 }), readLogTail: () => '', processEvidenceStatus: () => 'live', hostAdapter: { readProcessSnapshot: () => ({ processes: [{ pid: 4, ppid: 2, cpuTicks: 0 }, { pid: 6, ppid: 2, cpuTicks: 0, startIdentity: 123, pidNamespace: 'fixture' }] }) } }
  const monotonicNow = options.realTime ? () => performance.now() : () => 100_000 + elapsed
  let elapsed = 0, deadline, authorize = options.authorizeTimeout
  if (!options.realTime) t.mock.method(performance, 'now', options.monotonic ? monotonicNow : () => Date.now())
  t.after(() => { deadline?.clear(); if (!options.realTime) t.mock.timers.reset(); t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(scratch, { recursive: true, force: true }) })
  deadline = createLaneDeadline({ opts, runId: '1-1', args: [], child: options.child ?? { pid: 4 }, childPid: 4, workerPid: 2, launchedAtMs: 100_000, monotonicNow: options.monotonic ? monotonicNow : () => Date.now(), transitionBoundMs: 0, decisionFile, suiteLockRoot: lock, modules, supervisorFiles: [root],
    ...(options.child ? {} : { authorizeTimeout: async () => authorize ? authorize() : { terminate: (await readLaneQueue({ runId: '1-1', monotonicNow, readSuiteQueue: async () => typeof evidence === 'function' ? evidence() : evidence }))?.status !== 'queued' },
      readSuiteQueue: async () => { if (evidence instanceof Error) throw evidence; return typeof evidence === 'function' ? evidence() : evidence } }),
    current: () => { if (readFailure) throw readFailure; return current() }, writeState: (extra) => { if (failure) failure(extra); if (store) store.writeState(extra); else state = { ...state, ...extra } }, journal: (event) => journal.push(event), cleanupBrief: () => opts.cleanupHandler?.(), endGroup: (...args) => opts.terminalHandler ? opts.terminalHandler(...args) : terminal.push(args), appendLine: (line) => { fs.appendFileSync(log, `${line}\n`); return true } })
  const tick = async (ms) => {
    if (options.realTime) { await new Promise((resolve) => setTimeout(resolve, ms)); return }
    for (let left = ms; left > 0;) { const step = Math.min(left, 50); elapsed += step; t.mock.timers.tick(step); for (let n = 0; n < 32; n++) await Promise.resolve(); left -= step }
  }
  const ticket = (value = { pid: 6, startTime: 123, pidNamespace: 'fixture', leaseId: 'old' }) => {
    fs.mkdirSync(join(lock, 'queue.d'), { recursive: true })
    fs.writeFileSync(join(lock, 'queue.d', '0000000000000001.json'), typeof value === 'string' ? value : JSON.stringify(value))
  }
  const queued = () => { const since = Date.now(); evidence = () => ({ runId: '1-1', status: 'queued', since, observedAt: Date.now(), queuedMs: Date.now() - since }) }
  const publish = (extra = {}) => fs.writeFileSync(decisionFile, JSON.stringify({ runId: '1-1', timeoutAt: current().timeoutAt, decision: 'extend', ...extra }))
  return { root, scratch, opts, lock, log, decisionFile, modules, terminal, journal, tick, ticket, queued, publish, current, clear: () => deadline.clear(true), clearBeforeSignal: () => deadline.clear(), writeState: (extra) => { state = { ...state, ...extra } }, evidence: (value) => { evidence = value }, authority: (value) => { authorize = value }, fail: (value) => { failure = value }, failRead: (value) => { readFailure = value } }
}
