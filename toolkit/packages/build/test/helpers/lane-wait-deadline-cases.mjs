import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const WAITER = process.env.WT_LANE_WAITER_TEST_SOURCE ?? fileURLToPath(new URL('../../../../../plugin/bin/wt-lane-wait.mjs', import.meta.url))
const running = { runId: '1-1', state: 'running', workerPid: 42, childPid: 43 }
const alive = { status: 'running', worker: 'running', child: 'running' }

export const deadlineCases = [
  { title: 'reports the waiter budget ending while the lane worker is alive', record: running,
    verdict: alive, status: 125, output: 'WAIT BUDGET ENDED: lane pid 42 still running\n' },
  { title: 'keeps a recorded lane deadline distinct from a terminal timeout',
    record: { ...running, state: 'decision-needed', reason: 'timeout-bound', timeoutAt: '2000-01-01T00:00:00.000Z', decisionDueAt: '2000-01-01T00:05:00.000Z' },
    verdict: { ...alive, status: 'decision-needed' }, status: 125, output: 'WAIT BUDGET ENDED: lane pid 42 still running state=decision-needed timeoutAt=2000-01-01T00:00:00.000Z decisionDueAt=2000-01-01T00:05:00.000Z\n' },
  { title: 'preserves the supervisor timeout-abandonment exit',
    record: { ...running, state: 'abandoned', reason: 'timeout-bound', decisionSource: 'grace-default', exit: 126 },
    status: 126, output: 'LANE DONE exit=126 cause=timeout report=none log=/host/run.log\n' },
  ...[['extension-ceiling', 'timeout'], ['idle', 'idle'], ['owner', 'owner'], ['grace-error', 'grace-error']].map(([source, cause]) => ({
    title: `reports abandonment cause ${cause} from decisionSource=${source} despite a stale timeout reason`,
    record: { ...running, state: 'abandoned', reason: 'timeout-bound', decisionSource: source, exit: 126 },
    status: 126, output: `LANE DONE exit=126 cause=${cause} report=none log=/host/run.log\n`,
  })),
  { title: 'reports normal lane completion from the host record', record: { ...running, state: 'exited', exit: 0 },
    status: 0, output: 'LANE DONE exit=0 report=none log=/host/run.log\n' },
  { title: 'does not infer a timeout from a lane exit of 124', record: { ...running, state: 'exited', exit: 124 },
    status: 124, output: 'LANE DONE exit=124 report=none log=/host/run.log\n' },
  ...['darwin', 'win32'].map((platform) => ({ title: `reports unknown liveness when ${platform} process evidence is unavailable`,
    platform, record: running, verdict: { status: 'unknown', reason: 'identity-unreadable', worker: 'unknown', child: 'unknown' },
    status: 125, output: 'WAIT BUDGET ENDED: lane pid 42 liveness unknown (identity-unreadable)\n' })),
  { title: 'reports a surviving child without claiming its gone worker is running', record: running,
    verdict: { status: 'worker-gone-child-alive', worker: 'gone', child: 'running' },
    status: 125, output: 'WAIT BUDGET ENDED: lane pid 42 gone; child pid 43 still running\n' },
  { title: 'reports the live worker while terminal publication is pending', record: { ...running, state: 'terminating' },
    verdict: alive, status: 125, output: 'WAIT BUDGET ENDED: lane pid 42 still running state=terminating\n' },
  { title: 'keeps a failed launch with no exit and no surviving processes an unknown exit',
    record: { ...running, state: 'launch-failed' }, verdict: { status: 'terminal', worker: 'gone', child: 'gone' },
    status: 1, output: 'LANE DIED exit=unknown\n' },
  { title: 'reports a missing matching record as an unknown exit at the deadline', record: null,
    verdict: { status: 'unknown', reason: 'invalid-record', worker: 'unknown', child: 'unknown' },
    status: 1, output: 'LANE DIED exit=unknown\n' },
]

export function runDeadlineCase(scenario) {
  let now = 0
  let stdout = ''
  const process = { argv: ['node', 'waiter', '--dir', '/fixture', '--pid', '42', '--timeout', '0.01'],
    stdout: { write(text) { stdout += text } }, stderr: { write(text) { throw new Error(text) } } }
  const context = {
    process, path, Int32Array, SharedArrayBuffer,
    Date: { now: () => now }, Atomics: { wait(_array, _index, _value, ms) { now += ms } },
    realpathSync: (value) => value, statSync() { throw new Error('no report') },
    laneHostDir: () => '/host', laneHostPlatform: scenario.platform ?? 'linux', legacySupervision: () => [],
    readCurrentSupervisions: () => scenario.record ? [{ record: scenario.record }] : [], classifyLane: () => scenario.verdict ?? alive,
  }
  runInNewContext(readFileSync(WAITER, 'utf8').replace(/^import .*\n/gm, ''), context)
  return { status: process.exitCode, stdout }
}
