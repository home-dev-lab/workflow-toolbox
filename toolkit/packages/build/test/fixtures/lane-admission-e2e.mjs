import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { inspectStartedProcess, main } from '../../../../../plugin/bin/wt-lane.mjs'
import { inspectProcess, supervisionPaths, writeJsonAtomic } from '../../../../../plugin/bin/lib/lane-supervisor-core.mjs'
import { laneHostDir } from '../../../../../plugin/bin/lib/host/lane-host-dir.mjs'
import { withLaneLaunchAdmission } from '../../../../../plugin/bin/lib/host/lane-launch-admission.mjs'

const root = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'lane-admission-e2e-'))
const lockPath = join(root, 'launch-admission.lock')

// sameRunId: the retry names the foreign record's run id explicitly (--run-id), so only the
// spawned-worker check can tell that record is not this invocation's.
async function foreignRecord(sameRunId = false) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { cwd: root, detached: true, stdio: 'ignore' })
  try {
    await once(child, 'spawn')
    const identity = inspectStartedProcess(inspectProcess, child.pid).identity
    assert.ok(identity)
    const runId = `${child.pid}-1`
    const paths = supervisionPaths(root, runId)
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(join(root, 'brief.md'), '# brief\n## Gates\npnpm test\n')
    const calls = []
    const counter = () => {
      queueMicrotask(() => {
        writeJsonAtomic(paths.record, { version: 1, runId, state: 'launching', owner: 'session', workerPid: child.pid,
          workerArgv: identity.argv, workerStartTime: identity.startTime, childPid: null, childArgv: null,
          childStartTime: null, worktree: root, timeoutAt: new Date(Date.now() + 60_000).toISOString(), timeoutSeconds: 60 })
        writeJsonAtomic(paths.pointer, { runId })
      })
      return { state: 'ok', count: 0, pids: [] }
    }
    const code = await main({ argv: ['--dir', root, '--brief', join(root, 'brief.md'), '--model', 'openai/gpt-6.1-sol',
      '--allow-no-git', '--allow-missing-install', '--min-available-mib', '0', ...(sameRunId ? ['--run-id', runId] : [])], admissionOptions: {
      lockPath, counter, stopWorker: (pid) => { calls.push(pid); return { status: 'ended' } },
    } })
    assert.equal(code, 1)
    assert.deepEqual(calls, [], 'a refused launcher must not terminate a newer foreign run')
    console.log(sameRunId ? 'foreign record under the same explicit run id: zero stop calls' : 'foreign startup record: original worker left untouched')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
    rmSync(laneHostDir(root), { recursive: true, force: true })
  }
}

try {
  if (process.argv[2] === 'foreign-record') {
    await foreignRecord()
  } else if (process.argv[2] === 'foreign-same-run-id') {
    await foreignRecord(true)
  } else if (process.argv[2] === 'hold') {
    await withLaneLaunchAdmission(async () => {
      console.log('holding')
      await new Promise((resolve) => setTimeout(resolve, 60_000))
      return 0
    }, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }) })
  } else if (process.argv[2] === 'refuse') {
    process.exitCode = await main({ argv: ['--dir', root, '--model', 'openai/gpt-6.1-sol', '--brief', join(root, 'brief.md')], admissionOptions: {
      lockPath, counter: () => ({ state: 'ok', count: 16, pids: [] }),
    } })
  } else {
    let visible = false
    const counter = () => ({ state: 'ok', count: visible ? 16 : 15, pids: visible ? [42] : [] })
    const launch = async (lease) => {
      await setImmediate()
      visible = true
      await lease.waitUntilVisible(() => 42)
      return 0
    }
    const options = { lockPath, counter, pollMs: 1 }
    const codes = await Promise.all([withLaneLaunchAdmission(launch, options), withLaneLaunchAdmission(launch, options)])
    codes.forEach((code, index) => console.log(`admission ${index + 1}: ${code === 0 ? 'admitted' : 'refused'} (exit ${code})`))
    process.exitCode = codes.filter((code) => code === 0).length === 1 ? 0 : 1
  }
} finally { rmSync(root, { recursive: true, force: true }) }
