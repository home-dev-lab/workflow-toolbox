#!/usr/bin/env node
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
    const linkStat = lstatSync(filePath)
    if (linkStat.isSymbolicLink()) {
      return { ok: false, filePath, reason: 'symlink (not followed — could point outside the subagents dir)' }
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    const mtimeMs = statSync(filePath).mtimeMs
    return { ok: true, filePath, parsed, mtimeMs }
  } catch (error) {
    return { ok: false, filePath, reason: error instanceof Error ? error.message : String(error) }
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

const malformed = records.filter((record) => !record.ok).map((record) => ({
  file: record.filePath,
  reason: record.reason ?? 'unreadable',
}))

const observedMatches = records.filter((record) => record.ok && record.parsed?.name === name)
if (observedMatches.length !== 1) {
  emit(2, {
    status: 'unknown',
    reason: 'observed agent meta not found or ambiguous',
    malformed,
  })
}

const observed = observedMatches[0]
const taskKind = observed.parsed?.taskKind
if (taskKind === 'in_process_teammate') {
  emit(0, {
    status: 'pass',
    reason: 'in_process_teammate spawn — observer pairing not expected for this mode',
    malformed,
  })
}

if (taskKind === 'async') {
  // ⚠ This correlates by file mtime, never a direct ownership link — no field in the
  // harness's meta.json ties an observer to the specific agent it observes (see
  // measure-in-metadata-not-content.md). A single matching isObserver:true sibling in the
  // window is treated as evidence of pairing; MORE THAN ONE candidate means the correlation
  // is ambiguous (e.g. a concurrent unrelated async agent's own observer landed in the same
  // window) and this reports `unknown` rather than guessing which one paired — a false
  // "pass" here would be worse than an honest "can't tell".
  const windowMs = parsedWindowSec * 1000
  const candidates = records.filter((record) => record.ok && record.filePath !== observed.filePath)
  const observerCandidates = candidates.filter((record) => {
    if (record.parsed?.isObserver !== true) return false
    const delta = record.mtimeMs - observed.mtimeMs
    return delta >= 0 && delta <= windowMs
  })
  if (observerCandidates.length === 1) {
    emit(0, {
      status: 'pass',
      reason: `async spawn — exactly one isObserver sibling found within ${parsedWindowSec}s window (mtime correlation, not a direct ownership link)`,
      observerFile: resolve(observerCandidates[0].filePath),
      malformed,
    })
  }
  if (observerCandidates.length > 1) {
    emit(2, {
      status: 'unknown',
      reason: `async spawn — ${observerCandidates.length} isObserver siblings found within ${parsedWindowSec}s window, correlation is ambiguous`,
      candidates: observerCandidates.map((record) => resolve(record.filePath)),
      malformed,
    })
  }
  emit(1, {
    status: 'flag',
    reason: `async spawn expected an attached observer (isObserver:true sibling within ${parsedWindowSec}s) — none found`,
    checked: candidates.length,
    malformed,
  })
}

emit(2, {
  status: 'unknown',
  reason: `unrecognized taskKind: ${String(taskKind)}`,
  malformed,
})
