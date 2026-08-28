#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { handleHelpFlag } from './lib/cli-help.mjs'

const HELP = `wt-check-observer-pairing — did a spawned agent actually get the read-only
watchdog its definition declares via \`observer:\`? Reads meta.json files under a session's
subagents directory and reports paired / declared-but-unresolved / not-applicable, per agent.

Usage:
  node wt-check-observer-pairing.mjs --subagents-dir <dir> (--agent-id <rawId> | --name <observedAgentName>)
    [--window-sec 300] [--capture-dir <dir>] [--retry-ms 1500] [--retry-interval-ms 500]
    --subagents-dir     the session's subagents/ directory (required)
    --agent-id          the raw agent id to check (or --name)
    --name              the declared spawn name to check (or --agent-id)
    --window-sec        mtime-fallback correlation window in seconds (default 300)
    --capture-dir       opt-in: archive the two meta.json files of an unresolved pairing here
    --retry-ms          bounded retry window (ms) before an observerTaskId conflict is
                         reported as 'unknown' (default 1500). Only catches the FAST edge
                         of the race — the observer's own meta.json write is measured to
                         land minutes after the observed agent's, median ~463s on this
                         machine's 2026-08-08 sample — a longer retry would block the
                         calling hook, not fix the verdict. Set 0 to disable.
    --retry-interval-ms poll interval (ms) within the retry window (default 500)

Exit codes carried on stdout JSON (\`status\`), never inferred from the process exit code alone.
`

function emit(statusCode, payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(statusCode)
}

// Synchronous, cross-platform, no subprocess: blocks the current thread for `ms`
// milliseconds via Atomics.wait on a throwaway SharedArrayBuffer. Node >= 20 (this
// repo's floor) supports Atomics.wait on the main thread; no `sleep` binary dependency,
// so this works identically on Linux, macOS and Windows.
function sleepMs(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function parseArgs(argv) {
  handleHelpFlag(argv, HELP)
  const out = {
    subagentsDir: null,
    agentId: null,
    name: null,
    windowSec: 300,
    captureDir: null,
    retryMs: 1500,
    retryIntervalMs: 500,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--subagents-dir') out.subagentsDir = argv[index + 1] ?? null
    else if (arg === '--agent-id') out.agentId = argv[index + 1] ?? null
    else if (arg === '--name') out.name = argv[index + 1] ?? null
    else if (arg === '--window-sec') out.windowSec = argv[index + 1] ?? null
    // Opt-in by design: with no --capture-dir nothing is ever written, so an existing
    // caller's behaviour is unchanged byte for byte.
    else if (arg === '--capture-dir') out.captureDir = argv[index + 1] ?? null
    else if (arg === '--retry-ms') out.retryMs = argv[index + 1] ?? null
    else if (arg === '--retry-interval-ms') out.retryIntervalMs = argv[index + 1] ?? null
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

const { subagentsDir, agentId, name, windowSec, captureDir, retryMs: rawRetryMs, retryIntervalMs: rawRetryIntervalMs } =
  parseArgs(process.argv.slice(2))

if (!subagentsDir || (!agentId && !name)) {
  emit(2, {
    status: 'unknown',
    failureClass: 'usage',
    reason: 'usage: wt-check-observer-pairing.mjs --subagents-dir <dir> (--agent-id <rawId> | --name <observedAgentName>) [--window-sec 300]',
  })
}

const parsedWindowSec = parseWindowSec(windowSec)
if (parsedWindowSec === null) {
  emit(2, {
    status: 'unknown',
    failureClass: 'usage',
    reason: `invalid --window-sec: ${String(windowSec)}`,
  })
}

function parseNonNegativeMs(value, flagName) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    emit(2, { status: 'unknown', failureClass: 'usage', reason: `invalid ${flagName}: ${String(value)}` })
  }
  return parsed
}
const retryMs = parseNonNegativeMs(rawRetryMs, '--retry-ms')
const retryIntervalMs = Math.max(1, parseNonNegativeMs(rawRetryIntervalMs, '--retry-interval-ms'))

let filenames
try {
  filenames = readdirSync(subagentsDir)
} catch (error) {
  // A LOCATION failure, not a fact about the observed agent: the checker itself could
  // not find/read the directory it was told to look in. Kept as its own failureClass so
  // a caller (the guard hook) can say "I couldn't work out where to look" instead of
  // dressing a path bug in the vocabulary of a safety property ("your observer may be
  // missing"). See card 1835862067 — the two read the same to a user without this field.
  emit(2, {
    status: 'unknown',
    failureClass: 'path-resolution',
    reason: `could not read subagents dir: ${error instanceof Error ? error.message : String(error)}`,
  })
}

const records = filenames
  .filter((filename) => filename.endsWith('.meta.json'))
  .map((filename) => readMeta(join(subagentsDir, filename)))

let malformed = records.filter((record) => !record.ok).map((record) => ({
  file: record.filePath,
  reason: record.reason ?? 'unreadable',
}))

function resolveObserverTaskRecords(rawId) {
  const resolvedSubagentsDir = resolve(subagentsDir)
  const projectDir = dirname(dirname(resolvedSubagentsDir))
  const filename = `agent-${rawId}.meta.json`
  const currentCandidate = resolve(resolvedSubagentsDir, filename)
  if (dirname(currentCandidate) !== resolvedSubagentsDir) return { records: [], complete: false }
  const candidatePaths = [currentCandidate]
  let complete = true

  try {
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      // Session symlinks are deliberately excluded: following one could escape the
      // project directory, while direct child directories keep this lookup bounded.
      if (!entry.isDirectory()) continue
      const candidatePath = join(projectDir, entry.name, 'subagents', filename)
      if (candidatePath !== candidatePaths[0]) candidatePaths.push(candidatePath)
    }
  } catch {
    // Keep the supplied session usable on its own when the wider project cannot be read.
    complete = false
  }

  const foundRecords = []
  for (const candidatePath of candidatePaths) {
    try {
      lstatSync(candidatePath)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      complete = false
      foundRecords.push({
        ok: false,
        filePath: candidatePath,
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    const record = readMeta(candidatePath)
    if (!record.ok) complete = false
    foundRecords.push(record)
  }
  return { records: foundRecords, complete }
}

function addMalformed(foundRecords) {
  for (const record of foundRecords) {
    if (record.ok || malformed.some((item) => item.file === record.filePath)) continue
    malformed.push({ file: record.filePath, reason: record.reason ?? 'unreadable' })
  }
}

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
  // The checker DID resolve its own directory (readdirSync above succeeded) — this is a
  // fact about the OBSERVED AGENT's own record, distinct from the path-resolution
  // failure above even though both surface as the same 'unknown' status upstream.
  emit(2, {
    status: 'unknown',
    failureClass: 'meta-lookup',
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
  let pairingResolution = resolveObserverTaskRecords(observerTaskId)
  let pairedRecords = pairingResolution.records
  addMalformed(pairedRecords)
  let paired = pairedRecords.find((record) => record.ok && record.parsed?.isObserver === true)
    ?? pairedRecords.find((record) => record.ok)
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

  // ⚠ SHORT, BOUNDED RETRY — catches only the FAST edge of the race, never the whole of it.
  // This checker runs synchronously inside a PostToolUse hook, at essentially the same
  // instant the observed agent's own .meta.json is written (measured delta: single-digit
  // milliseconds). The observer is a SEPARATE spawn whose own .meta.json write lands
  // whenever the harness actually starts running it — measured across 387 real
  // observerTaskId→isObserver pairs on this machine on 2026-08-08: deltas ranged from
  // -12735s to +6031s, MEDIAN ~463s, p90 ~1870s. Only ~6% of real pairs resolved within 2s
  // of the observed write. A retry long enough to catch most of that distribution would
  // block this hook — and the spawning turn behind it — for MINUTES, which is worse than
  // the false 'unknown' it would prevent. So this retry is kept deliberately small: it
  // buys back the free, sub-2s fraction of cases for near-zero added latency, and is not
  // pretending to close the gap for the rest. The rest is handled by wording, not timing —
  // see the comment on the emitted reason below.
  if (retryMs > 0 && !(paired && paired.parsed?.isObserver === true)) {
    const deadline = Date.now() + retryMs
    while (Date.now() < deadline) {
      sleepMs(Math.min(retryIntervalMs, deadline - Date.now()))
      pairingResolution = resolveObserverTaskRecords(observerTaskId)
      pairedRecords = pairingResolution.records
      addMalformed(pairedRecords)
      const retryMeta = pairedRecords.find((record) => record.ok && record.parsed?.isObserver === true)
      paired = retryMeta ?? pairedRecords.find((record) => record.ok)
      if (retryMeta) {
        emit(0, {
          status: 'pass',
          reason: 'observerTaskId field present and resolves to an isObserver:true sibling — resolved during the bounded retry window',
          matchedBy,
          attachedBy: 'observerTaskId',
          observerFile: resolve(retryMeta.filePath),
          malformed,
        })
      }
    }
  }

  if (!paired && !pairingResolution.complete) {
    emit(2, {
      status: 'unknown',
      failureClass: 'observer-resolution',
      reason: `observerTaskId points to ${observerTaskId}, but the project-wide sibling lookup could not read every candidate location`,
      matchedBy,
      attachedBy: 'observerTaskId-conflict',
      malformed,
    })
  }

  // ⚠ TWO DIFFERENT SHAPES BELOW — established 2026-08-09, do not collapse them back
  // into one 'unknown'/'observer-conflict' bucket.
  //
  // The deciding question was: does a spawn that genuinely DROPS its observer write an
  // observerTaskId at all? Measured by construction (a named, non-isolated
  // spawn's own meta.json, captured live): it writes NONE. So once we are inside this
  // `if (observerTaskId)` block, an observer WAS created — the only open question is
  // whether its own write has landed yet. That makes "no sibling file at all" a
  // fundamentally different, and safe, shape from "a sibling exists but is not the
  // observer" — the latter is the one case that still evidences a real anomaly.
  if (paired) {
    // ⚠ THE ONE CASE WORTH PRESERVING. A sibling file EXISTS at the pointed-at id but is
    // not isObserver:true — id collision, wrong ownership, or a genuinely malformed
    // observer record. This is the only shape that ever evidences a real problem; a
    // hand-written fixture could not close the gap on whether it happens (it would be
    // authored from the same understanding as the code), so the mechanism is to KEEP the
    // artefact the first time reality produces one rather than fabricate it.
    const capture = captureConflict({
      captureDir,
      observedFile: observed.filePath,
      pairedFile: paired.filePath,
      pairedExists: true,
      observerTaskId,
    })
    emit(2, {
      status: 'unknown',
      failureClass: 'observer-conflict',
      reason: `observerTaskId points to ${observerTaskId}, but that sibling is not isObserver:true yet — usually still starting (median ~8 min on this machine's measured history), not a confirmed loss`,
      matchedBy,
      attachedBy: 'observerTaskId-conflict',
      malformed,
      ...capture,
    })
  }

  // ⚠ PENDING, not unknown. No sibling file exists yet at the pointed-at id. The
  // observed agent's own write (this record) happens synchronously, single-digit ms
  // after the spawn call; the observer is a SEPARATE spawn whose own .meta.json write
  // lands whenever the harness actually starts it — measured across 387 real pairs on
  // 2026-08-08: median ~463s, p90 ~1870s, 0 of 387 ever failed to resolve eventually.
  // Reporting this as 'unknown' was the exact shape the pairing guard fired on ~19 times
  // a week, every one a false alarm (per the measured guard journal). Since a genuinely
  // dropped observer writes no observerTaskId at all (see the block comment above), this
  // branch can ONLY mean "not written yet" — never a loss. No capture here: capture
  // exists to preserve evidence of a loss, and this is no longer that.
  emit(2, {
    status: 'pending',
    failureClass: 'observer-pending',
    reason: `observerTaskId points to ${observerTaskId}, but no matching sibling file exists yet — the observer is a separately spawned agent whose own write lands later (median ~8 min on this machine's measured history); this resolves on its own, it is not a confirmed loss`,
    matchedBy,
    attachedBy: 'observerTaskId-pending',
    malformed,
  })
}

const taskKind = observed.parsed?.taskKind
// ⚠ STRUCTURAL, not a fault — established 2026-08-09: a
// NAMED spawn without isolation runs as an in-process teammate, and the harness never
// creates an observer for it at all (measured by construction: its own meta.json
// carries no observerTaskId field, full stop — confirmed against a real captured
// record). On this same path the harness also rewrites `agentType` to the spawn's own
// NAME and demotes the real requested type under `customAgentType` — so a reader (or a
// checker) hunting for `agentType: "pilot"` finds the spawn's name instead and misreads
// this as a lookup failure, when it is a fact about the spawn SHAPE.
// This gets its OWN status, distinct from `pass`/`watched` (the observer really is
// absent here — reporting it silently would mask exactly the case this guard exists to
// name) and distinct from `unknown` (nothing here is uncertain; the absence is expected
// and permanent for this shape, not a race to wait out).
if (taskKind === 'in_process_teammate') {
  emit(0, {
    status: 'not-applicable',
    reason: 'in_process_teammate spawn (named, no isolation) — this agent structurally has no observer; the harness never creates one on this spawn path, so this is expected, not a lookup failure',
    matchedBy,
    attachedBy: 'structural-no-observer',
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
      failureClass: 'mtime-ambiguous',
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
  failureClass: 'unrecognized-taskkind',
  reason: `unrecognized taskKind: ${String(taskKind)}`,
  matchedBy,
  malformed,
})
