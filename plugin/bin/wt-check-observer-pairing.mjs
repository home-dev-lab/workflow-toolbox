#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

function emit(statusCode, payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(statusCode)
}

function parseArgs(argv) {
  const out = { subagentsDir: null, name: null, windowSec: 30 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--subagents-dir') out.subagentsDir = argv[index + 1] ?? null
    else if (arg === '--name') out.name = argv[index + 1] ?? null
    else if (arg === '--window-sec') out.windowSec = argv[index + 1] ?? null
    if (arg.startsWith('--')) index += 1
  }
  return out
}

function parseWindowSec(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

function readMeta(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    const mtimeMs = statSync(filePath).mtimeMs
    return { ok: true, filePath, parsed, mtimeMs }
  } catch {
    return { ok: false, filePath }
  }
}

const { subagentsDir, name, windowSec } = parseArgs(process.argv.slice(2))

if (!subagentsDir || !name) {
  emit(2, {
    status: 'unknown',
    reason: 'usage: wt-check-observer-pairing.mjs --subagents-dir <dir> --name <observedAgentName> [--window-sec 30]',
  })
}

const parsedWindowSec = parseWindowSec(windowSec)
if (parsedWindowSec === null) {
  emit(2, {
    status: 'unknown',
    reason: `invalid --window-sec: ${String(windowSec)}`,
  })
}

let filenames
try {
  filenames = readdirSync(subagentsDir)
} catch (error) {
  emit(2, {
    status: 'unknown',
    reason: `could not read subagents dir: ${error instanceof Error ? error.message : String(error)}`,
  })
}

const records = filenames
  .filter((filename) => filename.endsWith('.meta.json'))
  .map((filename) => readMeta(join(subagentsDir, filename)))

const observedMatches = records.filter((record) => record.ok && record.parsed?.name === name)
if (observedMatches.length !== 1) {
  emit(2, {
    status: 'unknown',
    reason: 'observed agent meta not found or ambiguous',
  })
}

const observed = observedMatches[0]
const taskKind = observed.parsed?.taskKind
if (taskKind === 'in_process_teammate') {
  emit(0, {
    status: 'pass',
    reason: 'in_process_teammate spawn — observer pairing not expected for this mode',
  })
}

if (taskKind === 'async') {
  const windowMs = parsedWindowSec * 1000
  const candidates = records.filter((record) => record.ok && record.filePath !== observed.filePath)
  const observer = candidates.find((record) => {
    if (record.parsed?.isObserver !== true) return false
    const delta = record.mtimeMs - observed.mtimeMs
    return delta >= 0 && delta <= windowMs
  })
  if (observer) {
    emit(0, {
      status: 'pass',
      reason: `async spawn — isObserver sibling found within ${parsedWindowSec}s window`,
      observerFile: resolve(observer.filePath),
    })
  }
  emit(1, {
    status: 'flag',
    reason: `async spawn expected an attached observer (isObserver:true sibling within ${parsedWindowSec}s) — none found`,
    checked: candidates.length,
  })
}

emit(2, {
  status: 'unknown',
  reason: `unrecognized taskKind: ${String(taskKind)}`,
})
