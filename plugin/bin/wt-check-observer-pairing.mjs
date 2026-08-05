#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

function emit(statusCode, payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(statusCode)
}

function parseArgs(argv) {
  const out = { subagentsDir: null, agentId: null, name: null, windowSec: 300, captureDir: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--subagents-dir') out.subagentsDir = argv[index + 1] ?? null
    else if (arg === '--agent-id') out.agentId = argv[index + 1] ?? null
    else if (arg === '--name') out.name = argv[index + 1] ?? null
    else if (arg === '--window-sec') out.windowSec = argv[index + 1] ?? null
    // Opt-in by design: with no --capture-dir nothing is ever written, so an existing
    // caller's behaviour is unchanged byte for byte.
    else if (arg === '--capture-dir') out.captureDir = argv[index + 1] ?? null
    if (arg.startsWith('--')) index += 1
  }
  return out
}

/** Archive the two meta.json files of a DECLARED-but-unresolved pairing, so the losing
 *  direction stops being a memory and becomes a versioned artefact.
 *
 *  ⚠ THIS NEVER CHANGES THE VERDICT AND NEVER THROWS. It is evidence collection bolted
 *  beside the check, not part of it: a full disk, a read-only directory, or a racing
 *  writer must not turn "the pairing did not resolve" into a crash — that would lose
 *  both the finding AND the evidence, which is strictly worse than losing the evidence
 *  alone. Every failure is reported as a `captureError` string in the payload instead.
 *
 *  Returns a fragment merged into the emitted payload: `{}` when no capture was asked
 *  for, `{ captured }` on success, `{ captureError }` on failure. The reader can then
 *  tell "evidence archived at <path>" from "evidence NOT archived, because <reason>" —
 *  a distinction that silence would destroy. */
function captureConflict({ captureDir, observedFile, pairedFile, pairedExists, observerTaskId }) {
  if (!captureDir) return {}
  try {
    // A stamp, not a random name: two conflicts on the same agent are two events worth
    // keeping side by side, and a name that collides would overwrite the first one.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(captureDir, `${stamp}-${basename(observedFile, '.meta.json')}`)
    mkdirSync(dest, { recursive: true })
    copyFileSync(observedFile, join(dest, `observed-${basename(observedFile)}`))
    if (pairedExists && existsSync(pairedFile)) {
      copyFileSync(pairedFile, join(dest, `pointed-at-${basename(pairedFile)}`))
    }
    // The inputs alone do not say what was concluded from them, and a later reader has
    // no way to recover that. Archive the verdict beside the evidence, per the same
    // discipline that requires a measurement to carry the command that produced it.
    writeFileSync(
      join(dest, 'conflict.json'),
      `${JSON.stringify(
        {
          capturedAt: stamp,
          observerTaskId,
          observedFile: resolve(observedFile),
          pointedAtFile: resolve(pairedFile),
          pointedAtExists: pairedExists,
          finding: pairedExists
            ? 'the pointed-at sibling exists but is not isObserver:true'
            : 'the pointed-at sibling does not exist',
          why: 'A declared-but-unresolved observer pairing. This is the direction the pairing guard has never been able to prove, and the reason a hand-written fixture was refused.',
        },
        null,
        2,
      )}\n`,
    )
    return { captured: resolve(dest) }
  } catch (error) {
    const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
    return { captureError: `could not archive the conflicting pair: ${message}` }
  }
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

const { subagentsDir, agentId, name, windowSec, captureDir } = parseArgs(process.argv.slice(2))

if (!subagentsDir || (!agentId && !name)) {
  emit(2, {
    status: 'unknown',
    reason: 'usage: wt-check-observer-pairing.mjs --subagents-dir <dir> (--agent-id <rawId> | --name <observedAgentName>) [--window-sec 300]',
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

// ⚠ Read observerTaskId FIRST, before any timing heuristic. It is written into the
// observed agent's own .meta.json and points directly at its observer's raw agent id
// (agent-<observerTaskId>.meta.json) — an explicit, static ownership link, not an
// inference. Confirmed against real harness output (2026-08-03): a { observerTaskId:
// "ac7f39a67a5aefa87", ... } record paired with a sibling
// agent-ac7f39a67a5aefa87.meta.json carrying { isObserver: true }. This field predates
// this script's own fix and was previously never read at all (grep -c observerTaskId
// on this file returned 0) — the mtime heuristic below then flagged real, correctly
// attached observers as missing because the sibling's write landed outside the
// (then 30s) window. Measured across 182 real observerTaskId→isObserver pairs on this
// machine on 2026-08-03: mtime deltas ranged from -12735s to +6031s (median ~398s,
// p90 ~1870s) — no fixed window can bound that tail, which is exactly why the field is
// checked first instead of ever being inferred from timing.
const observerTaskId = observed.parsed?.observerTaskId
if (typeof observerTaskId === 'string' && observerTaskId.length > 0) {
  const pairedFilePath = join(subagentsDir, `agent-${observerTaskId}.meta.json`)
  const paired = records.find((record) => record.ok && record.filePath === pairedFilePath)
  if (paired && paired.parsed?.isObserver === true) {
    emit(0, {
      status: 'pass',
      reason: 'observerTaskId field present and resolves to an isObserver:true sibling — direct ownership link, no timing heuristic needed',
      matchedBy,
      attachedBy: 'observerTaskId',
      observerFile: resolve(paired.filePath),
      malformed,
    })
  }
  // ⚠ THE ONE CASE WORTH PRESERVING. Everything else this script reports is either a
  // healthy pairing or a record too old to carry the link. THIS branch is a pairing that
  // was DECLARED and did not resolve — the only shape that evidences a real loss.
  //
  // It has never been observed on this machine. 182 real pairs were measured, all of
  // them resolving; the losing direction exists only as prose. That is why a guard built
  // on this cannot be credited: its silent half is proven, its speaking half is not.
  //
  // A hand-written fixture would NOT close that gap — it would be authored from the same
  // understanding as the code, so it could only ever prove the code matches its author's
  // belief. So the answer is not to fabricate the artefact but to KEEP it the first time
  // reality produces one. Waiting to notice is luck; archiving on sight is a mechanism.
  const capture = captureConflict({
    captureDir,
    observedFile: observed.filePath,
    pairedFile: paired ? paired.filePath : join(subagentsDir, `agent-${observerTaskId}.meta.json`),
    pairedExists: Boolean(paired),
    observerTaskId,
  })
  emit(2, {
    status: 'unknown',
    reason: paired
      ? `observerTaskId points to ${observerTaskId}, but that sibling is not isObserver:true`
      : `observerTaskId points to ${observerTaskId}, but no matching sibling file exists`,
    matchedBy,
    attachedBy: 'observerTaskId-conflict',
    malformed,
    ...capture,
  })
}

const taskKind = observed.parsed?.taskKind
if (taskKind === 'in_process_teammate') {
  emit(0, {
    status: 'pass',
    reason: 'in_process_teammate spawn — observer pairing not expected for this mode',
    matchedBy,
    attachedBy: 'not-required',
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
  // FALLBACK ONLY — for records that predate the observerTaskId field (or whose field
  // didn't resolve, handled above). This correlates by file mtime, which is NOT a direct
  // ownership link: it is a heuristic that the real distribution above shows to be
  // genuinely unreliable (deltas spanning over three hours in both directions on this
  // machine). windowSec default is a JUDGMENT CALL, not a measured guarantee — it is set
  // above the single 211s gap that surfaced this defect and near, but below, the ~398s
  // median of the measured distribution, to limit false "ambiguous" collisions in busy
  // directories; it cannot bound the tail. A single matching isObserver:true sibling in
  // the window is treated as evidence of pairing; MORE THAN ONE candidate means the
  // correlation is ambiguous (e.g. a concurrent unrelated async agent's own observer
  // landed in the same window) and this reports `unknown` rather than guessing which one
  // paired — a false "pass" here would be worse than an honest "can't tell".
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
      reason: `async spawn — exactly one isObserver sibling found within ${parsedWindowSec}s window (mtime fallback correlation, not a direct ownership link)`,
      matchedBy,
      attachedBy: 'mtime-fallback',
      observerFile: resolve(observerCandidates[0].filePath),
      malformed,
    })
  }
  if (observerCandidates.length > 1) {
    emit(2, {
      status: 'unknown',
      reason: `async spawn — ${observerCandidates.length} isObserver siblings found within ${parsedWindowSec}s window, mtime fallback correlation is ambiguous`,
      matchedBy,
      attachedBy: 'mtime-fallback',
      candidates: observerCandidates.map((record) => resolve(record.filePath)),
      malformed,
    })
  }
  emit(1, {
    status: 'flag',
    reason: `no observerTaskId link and no isObserver sibling within the ${parsedWindowSec}s mtime fallback window — none found`,
    matchedBy,
    attachedBy: 'mtime-fallback',
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
