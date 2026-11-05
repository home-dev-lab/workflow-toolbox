#!/usr/bin/env node
// Real wt-lane launch/worker paths with a dry provider: no model requests. All processes,
// admission claims, consent, configuration and host records belong to this probe's scratch.
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { main } from '../../plugin/bin/wt-lane.mjs'
import { readCurrentSupervision, shellQuote } from '../../plugin/bin/lib/lane-supervisor-core.mjs'
import { laneHostStateRoot } from '../../plugin/bin/lib/host/lane-host-dir.mjs'
import { hostAdapter } from '../../plugin/bin/lib/host/adapter.mjs'
import { LANE_LAUNCH_CAP } from '../../plugin/bin/lib/host/lane-launch-admission.mjs'
import { countLaneProcessesReal, LANE_PROCESS_NAMES } from '../../plugin/bin/lib/wt-lane-saturation-core.mjs'

const self = fileURLToPath(import.meta.url)

function probeCounter(root, count) {
  const pids = Array.from({ length: count }, (_, index) => readCurrentSupervision(join(root, `lane-${index}`))?.childPid)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  if (process.platform === 'win32') return { state: 'unknown', reason: 'pgrep is unavailable on win32' }
  return countLaneProcessesReal(LANE_PROCESS_NAMES, pids)
}

async function child(root, index) {
  const { count } = JSON.parse(readFileSync(join(root, 'probe.json'), 'utf8'))
  const dir = join(root, `lane-${index}`)
  process.exitCode = await main({ argv: ['--dir', dir, '--brief', join(dir, 'brief.md'), '--model', 'openai/gpt-6.1-sol', '--allow-no-git', '--min-available-mib', '0'],
    admissionOptions: { lockPath: join(root, 'admission.lock'), counter: () => probeCounter(root, count) } })
}

function prepare(root, count, preflightMs) {
  for (const part of ['bin', 'config', 'home', 'runtime']) mkdirSync(join(root, part))
  writeFileSync(join(root, 'probe.json'), JSON.stringify({ count }))
  writeFileSync(join(root, 'config', 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
  const provider = join(root, 'provider.mjs')
  // The provider's kernel process name is genuinely opencode, so the production pgrep
  // path measures only this probe's recorded children, rather than an injected count.
  const binary = join(root, 'runtime', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  copyFileSync(process.execPath, binary); chmodSync(binary, 0o755)
  writeFileSync(provider, `const args=process.argv.slice(2); if(args.includes('--version')) console.log('dry-probe-1'); else if(args.includes('debug')) { await new Promise(r=>setTimeout(r,${preflightMs})); console.log(JSON.stringify(args.includes('--pure') ? [{name:'workflow-toolbox-allowed-sentinel'}] : [])); } else await new Promise(r=>setTimeout(r,1000));`)
  writeFileSync(join(root, 'bin', 'opencode'), `#!/bin/sh\nexec ${shellQuote(binary)} ${shellQuote(provider)} "$@"\n`)
  chmodSync(join(root, 'bin', 'opencode'), 0o755)
  writeFileSync(join(root, 'bin', 'opencode.cmd'), `@echo off\r\n"${binary}" "${provider}" %*\r\n`)
  for (let index = 0; index < count; index++) {
    const dir = join(root, `lane-${index}`); mkdirSync(dir)
    writeFileSync(join(dir, 'brief.md'), '# Dry admission probe\n## Gates\npnpm test\n')
  }
}

function environment(root) {
  return { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_PLUGIN_DATA: join(root, 'plugin-data'),
    XDG_STATE_HOME: join(root, 'xdg'), WT_LANE_HOST_STATE: join(root, 'state'),
    PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`, WT_LANE_SANDBOX: 'off', WT_LANE_SKILLS: '', WT_LANE_MODELS: 'openai/gpt-6.1-sol' }
}

function launch(root, index, env) {
  const start = performance.now()
  const worker = spawn(process.execPath, [self, '--child', root, String(index)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  worker.stdout.on('data', (data) => { stdout += data })
  worker.stderr.on('data', (data) => { stderr += data })
  return new Promise((resolve) => {
    worker.once('error', (error) => { stderr += error.message })
    worker.once('close', (code) => {
      const admitted = code === 0 && /^pid=\d+$/m.test(stdout)
      const warning = stderr.split('\n').find((line) => line.includes('NOT MEASURED'))
      const reason = admitted ? warning ?? 'worker-visible-or-completed' : stderr.trim().replace(/\s+/g, ' ') || `launcher exit ${code}`
      console.log(`launch=${index + 1} ${admitted ? 'admitted' : 'refused'} reason=${reason} wait_ms=${Math.round(performance.now() - start)}`)
      resolve(admitted)
    })
  })
}

async function finishDryWorkers(root, count) {
  const deadline = performance.now() + 60_000
  const running = () => Array.from({ length: count }, (_, index) => readCurrentSupervision(join(root, `lane-${index}`)))
    .some((state) => Number.isSafeInteger(state?.workerPid) && hostAdapter.readProcessExecutionState(state.workerPid).status !== 'gone')
  while (probeCounter(root, count).count || running()) {
    if (performance.now() >= deadline) throw Error('dry-worker completion NOT MEASURED within 60000ms; inspect the host process reader')
    await delay(25)
  }
}

async function probe(argv) {
  const count = Number(argv[0] ?? 4), preflightMs = Number(argv[1] ?? 250)
  if (!Number.isSafeInteger(count) || count < 1 || count > LANE_LAUNCH_CAP || !Number.isFinite(preflightMs) || preflightMs < 0) throw Error(`usage: node ${self} [N=4 (1..${LANE_LAUNCH_CAP})] [preflight-ms=250]`)
  const root = mkdtempSync(join(tmpdir(), 'lane-admission-burst-'))
  try {
    const env = environment(root)
    if (resolve(laneHostStateRoot({ env })) !== resolve(env.WT_LANE_HOST_STATE)) throw Error('isolated host state is unavailable in this sandbox; run the probe on the host')
    prepare(root, count, preflightMs)
    const admitted = await Promise.all(Array.from({ length: count }, (_, index) => launch(root, index, env)))
    // Observe workers as well as provider children before deleting open logs and records.
    await finishDryWorkers(root, count)
    return admitted.every(Boolean) ? 0 : 1
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

try {
  if (process.argv[2] === '--child') await child(process.argv[3], process.argv[4])
  else process.exitCode = await probe(process.argv.slice(2))
} catch (error) { console.error(error.message); process.exitCode = 2 }
