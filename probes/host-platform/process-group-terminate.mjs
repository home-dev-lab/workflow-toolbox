import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { delay, outputPath, provenance, runToFile, writeEvidence } from './probe-lib.mjs'

const mode = process.argv[2]
const scriptPath = fileURLToPath(import.meta.url)

const installReceiptHandlers = (receipt) => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      appendFileSync(receipt, `${JSON.stringify({ signal, at: new Date().toISOString() })}\n`, 'utf8')
      process.exit(0)
    })
  }
}

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file).length > 0) return
    await delay(50)
  }
  throw new Error(`fixture did not write ${file}`)
}

const processStatus = (pid, scratch) => {
  if (platform() === 'win32') {
    const result = runToFile('tasklist', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], scratch)
    const present = result.raw.includes(`"${String(pid)}"`)
    return { status: present ? 'survived' : 'died', observation: result }
  }
  const result = runToFile('ps', ['-o', 'state=', '-p', String(pid)], scratch)
  const state = result.raw.trim()
  return { status: state === '' || state.startsWith('Z') ? 'died' : 'survived', processState: state || null, observation: result }
}

const receipt = (file) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []

async function runProbe() {
  const destination = outputPath('process-group-terminate')
  const scratch = `${destination}.fixture`
  const files = {
    state: `${scratch}.state`,
    childReceipt: `${scratch}.child-receipt`,
    grandchildReceipt: `${scratch}.grandchild-receipt`,
    grandchildReady: `${scratch}.grandchild-ready`,
  }
  mkdirSync(dirname(destination), { recursive: true })
  for (const file of Object.values(files)) rmSync(file, { force: true })
  const startedAt = Date.now()
  const child = spawn(process.execPath, [scriptPath, '--fixture-child', files.state, files.childReceipt, files.grandchildReceipt, files.grandchildReady], {
    detached: true,
    stdio: 'ignore',
  })
  const childExit = new Promise((resolveExit) => child.once('close', (code, signal) => resolveExit({ code, signal })))
  await waitForFile(files.state)
  await waitForFile(files.grandchildReady)
  const pids = JSON.parse(readFileSync(files.state, 'utf8'))
  let termination
  if (platform() === 'win32') {
    termination = runToFile('taskkill', ['/PID', String(pids.childPid), '/T', '/F'], `${scratch}.taskkill`)
  } else {
    const sentAt = Date.now()
    try {
      process.kill(-pids.childPid, 'SIGTERM')
      termination = { command: `process.kill(-${String(pids.childPid)}, SIGTERM)`, exitCode: 0, signal: null, error: null, raw: '', sentAt }
    } catch (error) {
      termination = { command: `process.kill(-${String(pids.childPid)}, SIGTERM)`, exitCode: null, signal: null, error: String(error.message), raw: '', sentAt }
    }
  }
  const exit = await Promise.race([childExit, delay(5_000).then(() => ({ code: null, signal: null, timeout: true }))])
  await delay(500)
  const childObserved = processStatus(pids.childPid, `${scratch}.child-status`)
  const grandchildObserved = processStatus(pids.grandchildPid, `${scratch}.grandchild-status`)
  for (const [pid, observed] of [[pids.childPid, childObserved], [pids.grandchildPid, grandchildObserved]]) {
    if (observed.status === 'survived') {
      try { process.kill(pid, 'SIGKILL') } catch { /* The process can exit between observation and cleanup. */ }
    }
  }
  const childReceipts = receipt(files.childReceipt)
  const grandchildReceipts = receipt(files.grandchildReceipt)
  for (const file of Object.values(files)) rmSync(file, { force: true })
  const unobservableSignal = {
    status: 'unobservable',
    reason: platform() === 'win32'
      ? 'forced Windows process-tree termination does not expose a catchable signal'
      : 'the fixture wrote no signal receipt before it exited',
  }
  const command = platform() === 'win32' ? `taskkill /PID ${String(pids.childPid)} /T /F` : `process.kill(-${String(pids.childPid)}, SIGTERM)`
  writeEvidence(destination, {
    provenance: provenance('process-group-terminate', command, `${scratch}.provenance`),
    operation: platform() === 'win32'
      ? { kind: 'process_tree', note: 'Windows has no POSIX process group; taskkill /T is the nearest native concept.' }
      : { kind: 'posix_process_group', pgid: pids.childPid },
    pids,
    termination,
    outcome: {
      child: { ...childObserved, exitCode: exit.code, observerSignal: exit.signal, signalObserved: childReceipts.length > 0 ? childReceipts : unobservableSignal },
      grandchild: { ...grandchildObserved, exitCode: { status: 'unobservable', reason: 'the probe parent is not the grandchild parent' }, observerSignal: null, signalObserved: grandchildReceipts.length > 0 ? grandchildReceipts : unobservableSignal },
      elapsedMilliseconds: Date.now() - startedAt,
    },
  })
}

if (mode === '--fixture-grandchild') {
  installReceiptHandlers(process.argv[3])
  writeFileSync(process.argv[4], String(process.pid), 'utf8')
  setInterval(() => {}, 60_000)
} else if (mode === '--fixture-child') {
  const [, , , stateFile, childReceipt, grandchildReceipt, grandchildReady] = process.argv
  installReceiptHandlers(childReceipt)
  const grandchild = spawn(process.execPath, [scriptPath, '--fixture-grandchild', grandchildReceipt, grandchildReady], { stdio: 'ignore' })
  writeFileSync(stateFile, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), 'utf8')
  setInterval(() => {}, 60_000)
} else {
  await runProbe()
}
