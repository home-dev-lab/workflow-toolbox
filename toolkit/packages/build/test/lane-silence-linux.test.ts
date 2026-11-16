import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
// @ts-expect-error ESM runtime module
import { createLaneDeadline } from '../../../../plugin/bin/lib/host/lane-deadline-worker.mjs'
// @ts-expect-error ESM runtime module
import { readLinuxIdleProcProcesses } from '../../../../plugin/bin/lib/host/linux.mjs'

it.skipIf(process.platform !== 'linux')('abandons a real sleeping Linux process despite a bounded worktree scan', async (context) => {
  const snapshot = () => readLinuxIdleProcProcesses({ readFile: readFileSync, readDirectory: readdirSync, observedAt: Date.now() })
  const initial = snapshot()
  if (!initial || initial.supported === false) context.skip()
  const child = spawn('sleep', ['20'], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const root = mkdtempSync(join(tmpdir(), 'lane-silence-linux-'))
  const log = join(root, 'run.log'); writeFileSync(log, '')
  let state: Record<string, unknown> = {}
  // Wait on the deadline's own events, never on a fixed deadline: the test timeout is the only bound.
  let onDecision: (snapshot: Record<string, unknown>) => void = () => {}, onEnd = () => {}
  const decided = new Promise<Record<string, unknown>>((resolve) => { onDecision = resolve }), ended = new Promise<void>((resolve) => { onEnd = resolve })
  const endGroup = vi.fn(() => { onEnd() })
  const deadline = createLaneDeadline({ child: { pid: child.pid, laneSandbox: { suiteBroker: {} } }, childPid: child.pid, args: [], runId: 'linux-sleep', launchedAtMs: Date.now(), transitionBoundMs: 0,
    opts: { dir: root, log, timeout: 1, decisionGrace: 0.2, idleWindow: 0.4, idleTimeout: 0, maxExtensions: 3 }, decisionFile: join(root, 'decision.json'),
    readSuiteQueue: async () => ({ runId: 'linux-sleep', status: 'running', inFlight: 0, since: Date.now(), observedAt: Date.now(), queuedMs: 0 }),
    authorizeTimeout: async () => ({ terminate: true }), cancelTimeout: async () => ({ cancelled: true }), readSilenceSnapshot: snapshot,
    current: () => state, writeState: (extra: Record<string, unknown>) => { state = { ...state, ...extra }; if (state.state === 'decision-needed' && state.defaultDecision === 'abandon') onDecision({ ...state }) }, appendLine: (line: string) => { appendFileSync(log, `${line}\n`); return true },
    modules: { latestWorktreeWrite: () => ({ status: 'unknown', at: null, bounded: true }), hostAdapter: { readProcessSnapshot: snapshot }, argvSummary: () => ['sleep'], readLogTail: () => '', processEvidenceStatus: () => 'live' }, endGroup, cleanupBrief() {}, journal() {},
  })
  try {
    expect(await decided).toMatchObject({ state: 'decision-needed', defaultDecision: 'abandon', evidence: { silence: { status: 'silent' } } })
    await ended
    expect(endGroup).toHaveBeenCalledWith(126, expect.objectContaining({ receiptLines: ['TERMINATION=timeout'] }))
  } finally { deadline.clear(); child.kill(); await exited; rmSync(root, { recursive: true, force: true }) }
})
