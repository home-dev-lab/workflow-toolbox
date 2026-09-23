import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { basename, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { delay, outputPath, provenance, runToFile, writeEvidence } from './probe-lib.mjs'

const mode = process.argv[2]
const scriptPath = fileURLToPath(import.meta.url)

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file).length > 0) return
    await delay(50)
  }
  throw new Error(`fixture did not write ${file}`)
}

const errorRecord = (error) => ({
  message: String(error.message),
  code: error.code ?? null,
  errno: error.errno ?? null,
  syscall: error.syscall ?? null,
})

const nativeListing = (pids, scratch) => {
  if (platform() === 'win32') {
    const wanted = pids.map((pid) => `ProcessId=${String(pid)}`).join(' OR ')
    const script = `Get-CimInstance Win32_Process -Filter '${wanted}' | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`
    return runToFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], scratch)
  }
  return runToFile('ps', ['-o', 'pid=,ppid=,pgid=,sid=', '-p', pids.join(',')], scratch)
}

const processRows = (scratch) => {
  if (platform() === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'
    const observation = runToFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], scratch)
    try {
      const parsed = JSON.parse(observation.raw || '[]')
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId) }))
      return { status: 'measured', observation, rows }
    } catch (error) {
      return { status: 'measurement_failed', observation, error: errorRecord(error), rows: [] }
    }
  }
  const observation = runToFile('ps', ['-axo', 'pid=,ppid=,pgid=,sid='], scratch)
  const rows = observation.raw.split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 4 && row.every(Number.isFinite)).map(([pid, ppid, pgid, sid]) => ({ pid, ppid, pgid, sid }))
  return { status: observation.exitCode === 0 ? 'measured' : 'measurement_failed', observation, rows }
}

const descendantsOf = (rows, rootPid) => {
  const descendants = []
  const parents = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (parents.has(row.ppid) && !parents.has(row.pid)) {
        parents.add(row.pid)
        descendants.push(row)
        changed = true
      }
    }
  }
  return descendants
}

const statusFromRows = (rows, pid) => rows.some((row) => row.pid === pid) ? 'present' : 'absent'

const terminate = (pid, signal) => {
  try {
    process.kill(pid, signal)
    return { status: 'sent', pid, signal }
  } catch (error) {
    return { status: error.code === 'ESRCH' ? 'already_absent' : 'measurement_failed', pid, signal, error: errorRecord(error) }
  }
}

async function runProbe() {
  const destination = outputPath('detached-grandchild')
  const scratch = `${destination}.fixture`
  const files = { a: `${scratch}.a`, b: `${scratch}.b` }
  mkdirSync(dirname(destination), { recursive: true })
  for (const file of Object.values(files)) rmSync(file, { force: true })

  let a
  let pids
  let evidence
  try {
    a = spawn(process.execPath, [scriptPath, '--fixture-a', files.a, files.b], { detached: true, stdio: 'ignore' })
    let launchError = null
    a.once('error', (error) => { launchError = errorRecord(error) })
    const aExit = new Promise((resolve) => a.once('close', (code, signal) => resolve({ code, signal })))
    await Promise.race([
      waitForFile(files.a),
      aExit.then(() => { throw new Error(`fixture A exited before becoming ready${launchError === null ? '' : `: ${launchError.message}`}`) }),
    ])
    await waitForFile(files.b)
    pids = { ...JSON.parse(readFileSync(files.a, 'utf8')), ...JSON.parse(readFileSync(files.b, 'utf8')) }

    const beforeRows = processRows(`${scratch}.before-tree`)
    const before = {
      relevantProcesses: nativeListing([pids.aPid, pids.bPid, pids.cPid], `${scratch}.before`),
      treeWalkFromA: descendantsOf(beforeRows.rows, pids.aPid),
      processTable: beforeRows.observation,
    }

    let termination
    if (platform() === 'win32') {
      termination = runToFile('taskkill', ['/T', '/PID', String(pids.aPid)], `${scratch}.taskkill`)
    } else {
      const started = process.hrtime.bigint()
      try {
        process.kill(-pids.aPid, 'SIGTERM')
        termination = { command: `process.kill(-${String(pids.aPid)}, SIGTERM)`, exitCode: 0, signal: null, error: null, raw: '', durationMilliseconds: Number(process.hrtime.bigint() - started) / 1_000_000 }
      } catch (error) {
        termination = { command: `process.kill(-${String(pids.aPid)}, SIGTERM)`, exitCode: null, signal: null, error: errorRecord(error), raw: '', durationMilliseconds: Number(process.hrtime.bigint() - started) / 1_000_000 }
      }
    }

    const aExitResult = await Promise.race([aExit, delay(5_000).then(() => ({ code: null, signal: null, timeout: true }))])
    await delay(750)
    const afterRows = processRows(`${scratch}.after-tree`)
    const afterDescendants = descendantsOf(afterRows.rows, pids.aPid)
    evidence = {
      status: 'measured',
      pids,
      concepts: platform() === 'win32'
        ? { processGroup: 'unsupported', session: 'unsupported', nearestConcept: 'process tree rooted at a PID' }
        : { processGroupAndSessionColumns: ['pid', 'ppid', 'pgid', 'sid'] },
      before,
      termination,
      aExit: aExitResult,
      afterTermination: {
        relevantProcesses: nativeListing([pids.aPid, pids.bPid, pids.cPid], `${scratch}.after`),
        treeWalkFromA: afterDescendants,
        processTable: afterRows.observation,
        reached: {
          a: statusFromRows(afterRows.rows, pids.aPid) === 'absent',
          b: statusFromRows(afterRows.rows, pids.bPid) === 'absent',
          c: statusFromRows(afterRows.rows, pids.cPid) === 'absent',
        },
        knownPidStatus: {
          a: statusFromRows(afterRows.rows, pids.aPid),
          b: statusFromRows(afterRows.rows, pids.bPid),
          c: statusFromRows(afterRows.rows, pids.cPid),
        },
      },
    }
  } catch (error) {
    evidence = { status: 'measurement_failed', error: errorRecord(error), pids: pids ?? null }
  } finally {
    if (pids !== undefined) {
      if (platform() === 'win32') {
        runToFile('taskkill', ['/T', '/F', '/PID', String(pids.bPid)], `${scratch}.cleanup-tree`)
        for (const pid of [pids.cPid, pids.bPid, pids.aPid]) runToFile('taskkill', ['/F', '/PID', String(pid)], `${scratch}.cleanup-${String(pid)}`)
      } else {
        terminate(-pids.bPid, 'SIGKILL')
        terminate(-pids.aPid, 'SIGKILL')
        for (const pid of [pids.cPid, pids.bPid, pids.aPid]) terminate(pid, 'SIGKILL')
      }
    } else if (a?.pid !== undefined) {
      terminate(platform() === 'win32' ? a.pid : -a.pid, 'SIGKILL')
    }
    await delay(500)
    if (pids !== undefined) {
      const finalRows = processRows(`${scratch}.final-tree`)
      evidence.cleanup = {
        relevantProcesses: nativeListing([pids.aPid, pids.bPid, pids.cPid], `${scratch}.final`),
        knownPidStatus: {
          a: statusFromRows(finalRows.rows, pids.aPid),
          b: statusFromRows(finalRows.rows, pids.bPid),
          c: statusFromRows(finalRows.rows, pids.cPid),
        },
        noneRemain: [pids.aPid, pids.bPid, pids.cPid].every((pid) => statusFromRows(finalRows.rows, pid) === 'absent'),
      }
    }
    for (const file of Object.values(files)) rmSync(file, { force: true })
  }

  const command = `node ${basename(import.meta.filename)} ${destination}`
  writeEvidence(destination, {
    provenance: provenance('detached-grandchild', command, `${scratch}.provenance`),
    ...evidence,
  })
}

if (mode === '--fixture-c') {
  setInterval(() => {}, 60_000)
} else if (mode === '--fixture-b') {
  const c = spawn(process.execPath, [scriptPath, '--fixture-c'], { stdio: 'ignore' })
  writeFileSync(process.argv[3], JSON.stringify({ bPid: process.pid, cPid: c.pid }), 'utf8')
  setInterval(() => {}, 60_000)
} else if (mode === '--fixture-a') {
  const b = spawn(process.execPath, [scriptPath, '--fixture-b', process.argv[4]], { detached: true, stdio: 'ignore' })
  b.unref()
  writeFileSync(process.argv[3], JSON.stringify({ aPid: process.pid, bPid: b.pid }), 'utf8')
  setInterval(() => {}, 60_000)
} else {
  await runProbe()
}
