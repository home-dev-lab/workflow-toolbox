#!/usr/bin/env node
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

function emit(statusCode, payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(statusCode)
}

function parseArgs(argv) {
  const out = { subagentsDir: null, agentId: null, name: null, windowSec: 30 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--subagents-dir') out.subagentsDir = argv[index + 1] ?? null
    else if (arg === '--agent-id') out.agentId = argv[index + 1] ?? null
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

const { subagentsDir, agentId, name, windowSec } = parseArgs(process.argv.slice(2))

if (!subagentsDir || (!agentId && !name)) {
  emit(2, {
    status: 'unknown',
    reason: 'usage: wt-check-observer-pairing.mjs --subagents-dir <dir> (--agent-id <rawId> | --name <observedAgentName>) [--window-sec 30]',
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

let observed = null
let matchedBy = null

if (agentId) {
  const expectedFilePath = join(subagentsDir, `agent-${agentId}.meta.json`)
  const byId = records.find((record) => record.ok && record.filePath === expectedFilePath)
  if (byId) {
    observed = byId
    matchedBy = 'id'
  }
}

if (!observed && name) {
  const observedMatches = records.filter((record) => record.ok && record.parsed?.name === name)
  if (observedMatches.length === 1) {
    observed = observedMatches[0]
    matchedBy = 'name'
  }
}

if (!observed) {
  emit(2, {
    status: 'unknown',
    reason: 'observed agent meta not found or ambiguous',
    triedAgentId: agentId,
    triedName: name,
    malformed,
  })
}

const taskKind = observed.parsed?.taskKind
if (taskKind === 'in_process_teammate') {
  emit(0, {
    status: 'pass',
    reason: 'in_process_teammate spawn — observer pairing not expected for this mode',
    matchedBy,
    malformed,
  })
}

// Grounded fact, not a guess: on 2026-08-02, every real .meta.json under
// ~/.claude/projects/*/*/subagents/ was checked on this machine (1687 files total).
// 546 had taskKind === 'in_process_teammate'; zero had taskKind === 'async'; the
// remaining 1141 had no taskKind field at all. So the mtime-correlation branch must
// treat absent taskKind as the async-shaped case, while still accepting the literal
// 'async' for harness fixtures and any future explicit writer.
if (taskKind === undefined || taskKind === 'async') {
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
      matchedBy,
      observerFile: resolve(observerCandidates[0].filePath),
      malformed,
    })
  }
  if (observerCandidates.length > 1) {
    emit(2, {
      status: 'unknown',
      reason: `async spawn — ${observerCandidates.length} isObserver siblings found within ${parsedWindowSec}s window, correlation is ambiguous`,
      matchedBy,
      candidates: observerCandidates.map((record) => resolve(record.filePath)),
      malformed,
    })
  }
  emit(1, {
    status: 'flag',
    reason: `async spawn expected an attached observer (isObserver:true sibling within ${parsedWindowSec}s) — none found`,
    matchedBy,
    checked: candidates.length,
    malformed,
  })
}

emit(2, {
  status: 'unknown',
  reason: `unrecognized taskKind: ${String(taskKind)}`,
  matchedBy,
  malformed,
})
