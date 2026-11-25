import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const hostUrl = process.env.SUITE_RESOURCE_HOST_MODULE ?? new URL('../../plugin/bin/lib/host/suite-lock-resources.mjs', import.meta.url).href
const self = fileURLToPath(import.meta.url)

async function churnWorker() {
  const memory = Buffer.alloc(64 * 1024 * 1024, 1)
  const churn = spawn('bash', ['-c', 'while :; do bash -c \'bash -c "sleep 0.03; :"; :\'; done'], { stdio: 'ignore' })
  const timer = setInterval(() => {
    const until = performance.now() + 25
    while (performance.now() < until) memory[0] = (memory[0] + 1) % 256
  }, 100)
  process.on('SIGTERM', () => { clearInterval(timer); churn.kill(); process.exit(0) })
  await delay(30000)
  clearInterval(timer); churn.kill()
}

function startTree() {
  return spawn('setpriv', ['--pdeathsig', 'TERM', 'bash', '-c', '"$@" & wait', 'resource-wrapper', process.execPath, self, '--churn-worker'],
    { detached: true, stdio: 'ignore' })
}

async function stopTree(child) {
  const exited = once(child, 'exit')
  try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await exited
}

function memoryWorker() {
  process.on('message', () => {
    let allocation = Buffer.alloc(96 * 1024 * 1024, 1)
    const during = process.memoryUsage().rss
    allocation = null
    for (let i = 0; i < 3; i++) global.gc()
    process.send({ during, after: process.memoryUsage().rss, freed: allocation === null })
  })
  process.send('ready')
}

async function betweenSampleMemory() {
  if (process.platform !== 'linux') { console.log('SKIP high-water allocation requires Linux procfs'); return }
  const { createSuiteResourceReader } = await import(hostUrl)
  const child = spawn(process.execPath, ['--expose-gc', self, '--memory-worker'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  try {
    await once(child, 'message')
    const reader = createSuiteResourceReader()
    const before = await reader(child.pid)
    const reply = once(child, 'message')
    child.send('allocate-and-free')
    const [memory] = await reply
    assert.ok(memory.freed && memory.during - memory.after >= 64 * 1024 * 1024, 'fixture must free at least 64 MiB before the next sample')
    const after = await reader(child.pid)
    assert.equal(after.unknown, undefined)
    const peak = after.processes[0].memMiB
    assert.ok(peak >= before.processes[0].memMiB + 64, 'VmHWM must retain an allocation freed between samples')
    assert.ok(peak >= 96 && peak < 256, '96 MiB transient allocation plus runtime must peak between 96 and 256 MiB')
  } finally { const exited = once(child, 'exit'); child.kill(); await exited }
}

async function realChurn() {
  if (process.platform !== 'linux') { console.log('SKIP real churn requires Linux procfs and setpriv'); return }
  const { createSuiteResourceReader, createSuiteResourceSampler } = await import(hostUrl)
  const child = startTree()
  const reader = createSuiteResourceReader()
  const snapshots = []
  const sampler = createSuiteResourceSampler({ pid: child.pid, schedule: () => ({ unref() {} }), cancel() {},
    readTree: async (...args) => { const snapshot = await reader(...args); snapshots.push(snapshot); return snapshot } })
  try {
    for (let i = 0; i < 15; i++) { await sampler.sample(); await delay(1000) }
    const result = sampler.stop()
    console.log(JSON.stringify({ result, samples: snapshots.length }))
    assert.deepEqual(result.unknownReasons, [], 'real churning process tree must produce a complete observation')
    assert.ok(result.peakCores >= 0.01 && result.peakCores < 4, 'one duty-cycled worker plus churn must peak between 0.01 and 4 cores')
    assert.ok(result.peakMemMiB >= 64 && result.peakMemMiB < 512, '64 MiB resident worker plus wrappers must peak between 64 and 512 MiB')
    for (const snapshot of snapshots) {
      const memory = snapshot.processes.reduce((sum, process) => sum + process.memMiB, 0)
      assert.ok(result.peakMemMiB >= memory, 'recorded memory peak must cover every sampled family total')
    }
  } finally { sampler.stop(); await stopTree(child) }
}

export const resourceChurnCases = [
  ['real multilevel churn yields complete bounded peaks', realChurn],
  ['real child allocation freed between samples remains in the memory peak', betweenSampleMemory],
]

if (process.argv.includes('--churn-worker')) await churnWorker()
else if (process.argv.includes('--memory-worker')) memoryWorker()
else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [name, test] of resourceChurnCases) {
    try { await test(); console.log(`PASS ${name} EXIT=0`) }
    catch (error) { console.error(`FAIL ${name} EXIT=1\n${error.stack}`); process.exitCode = 1 }
  }
}
