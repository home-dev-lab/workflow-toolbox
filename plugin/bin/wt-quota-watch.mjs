#!/usr/bin/env node
// Quota watcher for the Monitor tool (persistent: true), shipped as a plugin monitor.
//
// WHAT IT WATCHES: the account's five-hour and seven-day usage windows, via a
// PROBE script. A probe is BUNDLED (`wt-quota-probe.mjs`, same directory); a
// user probe at `<configDir>/scripts/quota-usage.mjs` takes precedence when it
// exists, and `--probe` overrides both.
//
// WHY BUNDLING IT IS THE RIGHT CALL, AND WHAT IT COSTS. An earlier version of
// this header claimed the probe could not be shipped because reading real usage
// "depends on internal state that varies by install and by account". That was
// wrong, and wrong in the direction that makes a reader give up: what varies is
// read AT RUNTIME (the active `CLAUDE_CONFIG_DIR`, its credentials), which is
// exactly what makes the probe portable rather than what prevents it.
//
// The real cost is different and worth stating plainly: the usage endpoint is
// NOT publicly documented by Anthropic. It can change or disappear without
// notice, and bundled, it then breaks for every user at once instead of for one.
// That is the accepted trade — a watcher nobody can arm helps no one. The probe
// reads credentials, never writes them, and never prints the token.
//
// If the probe is missing, this
// script fails LOUD at startup (exit 1, one stdout line) rather than running
// silently with nothing to report — an armed-but-blind watcher is exactly the
// failure this file exists to avoid.
//
// WHY A MONITOR AND NOT A REMINDER: during a long delegated arc the main
// session takes almost no turns of its own, so any per-turn ambient quota
// line goes stale while subagents keep spending — the wall can arrive with no
// warning. This watcher polls independently of the session's own turns.
// Model-token cost: zero, it is a script.
//
// If `<configDir>/.claude.json` is unreadable, missing, invalid, or has no
// `oauthAccount.accountUuid`, this watcher cannot tell a window RESET apart
// from an ACCOUNT SWITCH. In that case a drop is reported as
// "QUOTA DROP ... cause undetermined (reset or account change)", and the
// state is simply re-baselined — it does not claim to know more than it does.
//
// SHARED CACHE + BACKOFF (added after a live 429 was observed on this
// machine). Before this, every poll hit the usage endpoint live, with no
// coordination between this watcher, other watchers (one per session), and
// the private per-turn hook that ALSO probes the same endpoint. Several of
// those running against the same account is enough independent traffic to
// trip the endpoint's own rate limit. Now: a fresh reading in the shared
// cache (`<configDir>/.quota-cache.json`, same file and format the per-turn
// hook already uses) is used instead of a live call, and a live call refills
// that cache for the next reader — see `lib/quota-cache.mjs`. A failed or
// rate-limited probe backs off with a growing, capped interval instead of
// retrying at the same cadence that got it rate-limited — see
// `lib/quota-backoff.mjs`. Neither change touches the property that already
// held: the watcher never goes permanently silent; it keeps polling and
// recovers on its own as soon as a probe (or the cache) succeeds again.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { readQuotaCache, writeQuotaCacheAtomic, defaultQuotaCachePath } from './lib/quota-cache.mjs'
import { computeBackoffMs } from './lib/quota-backoff.mjs'
import { computeWatcherCacheToleranceMs } from './lib/quota-cache-tolerance.mjs'
import { hasCompleteWindows } from './lib/quota-window-completeness.mjs'

const DEFAULT_THRESHOLDS = '80,90,95'
const DEFAULT_POLL_SECONDS = 300
const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024
const MAX_TIMER_SECONDS = Math.floor(0x7fffffff / 1000)
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DEGRADED_REMINDER_STEPS_MS = [5 * MINUTE_MS, 15 * MINUTE_MS, 45 * MINUTE_MS]
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const USER_PROBE = join(CONFIG_DIR, 'scripts', 'quota-usage.mjs')
const BUNDLED_PROBE = join(dirname(fileURLToPath(import.meta.url)), 'wt-quota-probe.mjs')
// Same path AND format the private per-turn hook (inject-context-quota.mjs) already
// reads/writes — see lib/quota-cache.mjs for the compatibility contract.
const CACHE_PATH = defaultQuotaCachePath(CONFIG_DIR)
const WINDOWS = [
  { key: 'five_hour', label: '5h' },
  { key: 'seven_day', label: '7d' },
]

function writeLine(line) {
  process.stdout.write(`${line}\n`)
}

process.stdout.on('error', (error) => {
  // The notification channel is gone: continuing can report nothing.
  if (error?.code === 'EPIPE') process.exit(0)
})

// The probe's stderr is ARBITRARY text: it can contain a token, a signed URL,
// an authorization header. Echoing it verbatim into a notification writes it
// into a transcript — to the model and to disk. Mask anything long enough to
// plausibly be a secret before displaying it.
function redact(text) {
  return String(text)
    // any 16+ character run of token-like characters, hyphens/dots included:
    // excluding them let the prefix through (`sk-ant-XXXX` -> `sk-ant-XXXX <redacted>`).
    .replace(/[A-Za-z0-9_.-]*[A-Za-z0-9][A-Za-z0-9_.-]{15,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<redacted>' : m))
    .replace(/(bearer|token|authorization|api[-_ ]?key|secret)\s*[:=]?\s*\S+/gi, '$1 <redacted>')
    .replace(/[\r\n]+/g, ' ')
}

function usageError(message) {
  writeSync(1, `${message}\n`)
  process.exit(2)
}

function resolveProbePath(probeOverride) {
  if (probeOverride) {
    return { path: probeOverride, source: '--probe override' }
  }
  if (existsSync(USER_PROBE)) {
    return { path: USER_PROBE, source: 'user config probe' }
  }
  return { path: BUNDLED_PROBE, source: 'bundled probe' }
}

function parseArgs(argv) {
  let thresholdsArg = DEFAULT_THRESHOLDS
  let poll = DEFAULT_POLL_SECONDS
  let timeout = DEFAULT_TIMEOUT_SECONDS
  let probeOverride = null

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--thresholds') {
      if (i + 1 >= argv.length) usageError('wt-quota-watch: missing value for --thresholds')
      thresholdsArg = argv[i + 1]
      i += 1
      continue
    }
    if (arg === '--poll') {
      if (i + 1 >= argv.length) usageError('wt-quota-watch: missing value for --poll')
      const parsed = Number.parseInt(argv[i + 1], 10)
      // poll=0 would spin a tight loop launching the probe process continuously.
      if (!Number.isFinite(parsed) || parsed < 5 || parsed > MAX_TIMER_SECONDS) usageError(`wt-quota-watch: invalid --poll (minimum 5s, maximum ${MAX_TIMER_SECONDS}s): ${argv[i + 1]}`)
      poll = parsed
      i += 1
      continue
    }
    if (arg === '--probe') {
      if (i + 1 >= argv.length) usageError('wt-quota-watch: missing value for --probe')
      probeOverride = argv[i + 1]
      i += 1
      continue
    }
    if (arg === '--timeout') {
      if (i + 1 >= argv.length) usageError('wt-quota-watch: missing value for --timeout')
      const parsed = Number.parseInt(argv[i + 1], 10)
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_TIMER_SECONDS) usageError(`wt-quota-watch: invalid --timeout (minimum 1s, maximum ${MAX_TIMER_SECONDS}s): ${argv[i + 1]}`)
      timeout = parsed
      i += 1
      continue
    }
    usageError(`wt-quota-watch: unknown option: ${arg}`)
  }

  const thresholds = thresholdsArg
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value))

  if (thresholds.length === 0) usageError(`wt-quota-watch: invalid --thresholds: ${thresholdsArg}`)

  if (timeout >= poll) usageError(`wt-quota-watch: invalid --timeout (${timeout}s must be lower than the ${poll}s poll)`)

  const probe = resolveProbePath(probeOverride)
  return { poll, timeout, probe, thresholds }
}

function runProbe(probePath, timeoutMs) {
  return new Promise((resolve) => {
    // stderr is CAPTURED, not discarded: the probe writes the real reason for
    // a failure there (missing or expired credentials). Discarding it turns a
    // named failure into a mystery, and the reader looks in the wrong place.
    const child = spawn(process.execPath, [probePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const appendCapped = (text, chunk) => {
      if (Buffer.byteLength(text) >= MAX_PROBE_OUTPUT_BYTES) return text
      const remaining = MAX_PROBE_OUTPUT_BYTES - Buffer.byteLength(text)
      return text + chunk.toString('utf8', 0, remaining)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout = appendCapped(stdout, chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderr = appendCapped(stderr, chunk)
    })

    child.on('error', (error) => {
      // The process could not even START — a third, distinct failure, invisible
      // if confused with an empty output.
      clearTimeout(timer)
      resolve({ stdout: '', stderr: '', spawnError: error.message, timedOut: false })
    })

    child.on('close', () => {
      clearTimeout(timer)
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), spawnError: null, timedOut })
    })
  })
}

function parseProbeWindow(windowValue) {
  if (windowValue === null || typeof windowValue !== 'object' || Array.isArray(windowValue) || typeof windowValue.pct !== 'number' || !Number.isFinite(windowValue.pct)) return null
  return {
    pct: windowValue.pct,
    resetLocal: typeof windowValue?.reset_local === 'string' && windowValue.reset_local.length > 0 ? windowValue.reset_local : '?',
  }
}

// Shared by both the cache-hit and the live-probe path: pull the two known windows out
// of a probe-shaped object (cached or fresh), ignoring anything else it may contain —
// a cache written by a newer/older probe version degrades gracefully to whatever
// windows it still recognizes, never to a crash or a fabricated zero.
function extractWindows(source) {
  const windows = {}
  for (const { key } of WINDOWS) {
    const windowData = parseProbeWindow(source?.[key])
    if (windowData) windows[key] = windowData
  }
  return windows
}

// FINDING 2 fix (cross-family review, 2026-07-31): hasCompleteWindows (imported above)
// requires EVERY window this watcher tracks to be present before a reading — cached or
// freshly probed — counts as usable. A partial reading (some non-empty subset) used to be
// accepted as success; see lib/quota-window-completeness.mjs for the full rationale.

function readAccountFingerprint(configDir) {
  try {
    if (typeof configDir !== 'string' || configDir.length === 0) return null
    const claudeJsonPath = join(configDir, '.claude.json')
    const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    const accountUuid = parsed?.oauthAccount?.accountUuid
    if (typeof accountUuid !== 'string' || accountUuid.length === 0) return null
    return createHash('sha256').update(accountUuid).digest('hex').slice(0, 8)
  } catch {
    return null
  }
}

function setBaseline(state, windows, thresholds) {
  for (const { key } of WINDOWS) {
    const windowData = windows[key]
    if (!windowData) continue
    state.lastPct.set(key, windowData.pct)
    const firedForWindow = new Set()
    for (const threshold of thresholds) {
      if (windowData.pct >= threshold) firedForWindow.add(threshold)
    }
    state.fired.set(key, firedForWindow)
  }
}

function clearWindowState(state, windowKey) {
  state.lastPct.delete(windowKey)
  state.fired.delete(windowKey)
}

function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(' ')
}

function nextDegradedReminderMs(currentReminderMs) {
  const stepIndex = DEGRADED_REMINDER_STEPS_MS.indexOf(currentReminderMs)
  if (stepIndex >= 0 && stepIndex < DEGRADED_REMINDER_STEPS_MS.length - 1) {
    return DEGRADED_REMINDER_STEPS_MS[stepIndex + 1]
  }
  if (stepIndex === DEGRADED_REMINDER_STEPS_MS.length - 1) {
    return currentReminderMs + HOUR_MS
  }
  return DEGRADED_REMINDER_STEPS_MS[0]
}

function maybeWriteDegradedReminder(state) {
  if (state.degradedElapsedMs < state.nextDegradedReminderMs) return
  writeLine(`QUOTA WATCH DEGRADED: still blind after ${formatDurationMs(state.degradedElapsedMs)} without a fresh reading`)
  state.nextDegradedReminderMs = nextDegradedReminderMs(state.nextDegradedReminderMs)
}

function noteDegradedSleep(state, sleepMs) {
  state.degradedElapsedMs += sleepMs
}

function resetDegradedVisibility(state) {
  state.degradedElapsedMs = 0
  state.nextDegradedReminderMs = DEGRADED_REMINDER_STEPS_MS[0]
}

function baselineWindow(state, windowKey, pct, thresholds) {
  state.lastPct.set(windowKey, pct)
  const firedForWindow = new Set()
  for (const threshold of thresholds) {
    if (pct >= threshold) firedForWindow.add(threshold)
  }
  state.fired.set(windowKey, firedForWindow)
}

function initialStateLine(windows, thresholds) {
  const parts = []
  for (const { key, label } of WINDOWS) {
    const windowData = windows[key]
    if (!windowData) continue
    const crossed = thresholds.filter((threshold) => windowData.pct >= threshold)
    if (crossed.length === 0) continue
    parts.push(`${label} ${windowData.pct}% (thresholds already crossed: ${crossed.join(',')}%) — reset ${windowData.resetLocal}`)
  }
  if (parts.length === 0) return null
  return `QUOTA STATUS: ${parts.join(' | ')}`
}

// TEST SEAM — never set outside the test suite; unset in every real deployment.
//
// WHY THIS EXISTS. The integration tests used to race a wall clock (spawn the real
// watcher, sleep N seconds, SIGKILL, count how many probe invocations happened in that
// window) — flagged flaky (2026-07-31): a test that passed alone failed once under the
// contention of the FULL suite running 159 files' worth of child processes concurrently,
// then passed again on a re-run. The window itself was never wrong; the assumption that a
// setTimeout fires within a fixed wall-clock margin under arbitrary system load was.
//
// Rather than widen the windows (a slower flake, same defect), the watcher's own `sleep`
// gets an injectable seam: WT_QUOTA_WATCH_TEST_SLEEP_LOG makes it log the millisecond
// value it was ACTUALLY asked to wait (the real backoff/poll math this file computed) and
// resolve near-instantly instead of waiting it out; WT_QUOTA_WATCH_TEST_MAX_CYCLES bounds
// the run to an exact number of loop iterations before a clean `process.exit(0)`. A test
// then awaits process EXIT (a real signal) instead of a wall-clock delay, and asserts on
// the logged durations directly — deterministic, fast, and no less real: the code path,
// the cache, the backoff math are all the genuine ones, only the WAITING is skipped.
const TEST_SLEEP_LOG = process.env.WT_QUOTA_WATCH_TEST_SLEEP_LOG || null
const TEST_MAX_CYCLES = (() => {
  const n = Number(process.env.WT_QUOTA_WATCH_TEST_MAX_CYCLES)
  return Number.isFinite(n) && n > 0 ? n : null
})()
const TEST_SEAM_ACTIVE = TEST_SLEEP_LOG !== null || TEST_MAX_CYCLES !== null
let testCyclesCompleted = 0

// The seam is discipline (an env var nobody but the test suite should set), not a
// mechanism that PREVENTS misuse — env vars leak: inherited by a subprocess, left in a
// shell profile, copied from a CI config. So "never set outside tests" is enforced by
// making it IMPOSSIBLE TO MISS when it fires, not by trusting the discipline. If either
// var is set, this line goes out on the SAME stream `QUOTA WATCH ARMED` uses — the one a
// monitor actually reads — so a leaked seam is loud, not silent. The single most dangerous
// shape this could take unannounced is the quiet one: an exit(0) after a few cycles that
// looks exactly like nothing to report, which is the whole failure family this file exists
// to remove. See the header above this constant block for what the seam does; this is
// what makes it safe to ship with the seam left in.
function testSeamBanner() {
  return `⚠ QUOTA WATCH TEST MODE — WT_QUOTA_WATCH_TEST_SLEEP_LOG=${TEST_SLEEP_LOG ?? '(unset)'} WT_QUOTA_WATCH_TEST_MAX_CYCLES=${TEST_MAX_CYCLES ?? '(unset)'} — sleeps are being LOGGED, NOT HONORED, and/or this run will SELF-EXIT after a fixed number of cycles. This must NEVER be set outside the test suite. If you see this in a real deployment, find what set these environment variables and unset them — quota is effectively NOT being watched while this is active.`
}

function sleep(ms) {
  if (TEST_SLEEP_LOG) {
    try {
      appendFileSync(TEST_SLEEP_LOG, `${ms}\n`)
    } catch {
      /* best effort — a logging failure must not change real watcher behavior */
    }
  }
  if (TEST_MAX_CYCLES !== null) {
    testCyclesCompleted += 1
    if (testCyclesCompleted >= TEST_MAX_CYCLES) {
      // The exact moment the danger described above materializes: about to exit(0),
      // quietly, with a success code. One more loud line right before it, so a leaked
      // seam's LAST output — not just its startup line, in case that scrolled away — says
      // plainly that this was a test exit, not a healthy watcher finding nothing to report.
      writeLine(`${testSeamBanner()} Exiting now (cycle ${testCyclesCompleted}/${TEST_MAX_CYCLES}).`)
      process.exit(0)
    }
  }
  return new Promise((resolve) => {
    setTimeout(resolve, TEST_SLEEP_LOG ? 0 : ms)
  })
}

const { poll, timeout, probe, thresholds } = parseArgs(process.argv.slice(2))
// This watcher's OWN staleness tolerance — deliberately larger than the per-turn hook's
// TTL. See lib/quota-cache-tolerance.mjs for the full reasoning; the short version: a poll
// interval equal to the hook's TTL made the watcher probe live on almost every cycle.
const WATCHER_CACHE_TOLERANCE_MS = computeWatcherCacheToleranceMs(poll)

if (!existsSync(probe.path)) {
  writeSync(1, `QUOTA WATCH FAILED: selected ${probe.source} not found: ${redact(probe.path)} — quota is NOT being watched\n`)
  process.exit(1)
}

const state = {
  fired: new Map(),
  lastPct: new Map(),
  probeKoSignaled: false,
  probeTimeoutSignaled: false,
  internalErrorSignaled: false,
  fingerprint: null,
  hasReading: false,
  consecutiveFailures: 0,
  degradedElapsedMs: 0,
  nextDegradedReminderMs: DEGRADED_REMINDER_STEPS_MS[0],
}

writeLine(`QUOTA WATCH ARMED: thresholds=${thresholds.join(',')} poll=${poll}s probe=${basename(probe.path)} source=${probe.source}`)
if (TEST_SEAM_ACTIVE) writeLine(testSeamBanner())

while (true) {
  try {
    let windows = {}
    let sourceData = null
    let viaCache = false

    // Cache-first: a reading already on disk (ours from a previous poll, another
    // watcher's, or the per-turn hook's) is used as-is when it is fresh enough BY THIS
    // WATCHER'S OWN TOLERANCE (WATCHER_CACHE_TOLERANCE_MS — deliberately looser than the
    // hook's own TTL, see lib/quota-cache-tolerance.mjs) — no network call at all. This is
    // what stops N independent watchers/sessions from each hitting the live endpoint on
    // their own schedule.
    //
    // FINDING 1 fix (cross-family review, 2026-07-31): the cache is NEVER consulted for
    // the very first reading (`!state.hasReading`) — the BASELINE always comes from a live
    // probe. That file lives at a fixed, predictable path any process on the machine can
    // write; "structurally valid JSON with the right shape" is not "authentic", and there
    // is no cheap way to authenticate it without breaking the hook's format (which stays
    // unsigned, unauthenticated by design). The danger is specific to the baseline: it
    // seeds `state.fired`, so a poisoned reading with pct=95 for every window would mark
    // every threshold as "already crossed" and PERMANENTLY suppress every real crossing at
    // that level for the rest of this process's life — a silent guard inversion, exactly
    // the failure class this whole change exists to remove. A poisoned reading consulted
    // only in STEADY STATE (after a genuine baseline) is lower-risk by comparison: it can
    // at worst produce one wrong-but-VISIBLE threshold line, self-correcting on the next
    // real reading — annoying, not silent. So only the baseline is hardened; steady-state
    // cache trust is unchanged. Argued explicitly, not left implicit: disabling the cache
    // entirely would defeat SUIVI 1/2 (the whole point of this change); requiring a live
    // probe for EVERY reading was rejected for the same reason.
    const cachedReading = state.hasReading ? await readQuotaCache(CACHE_PATH, WATCHER_CACHE_TOLERANCE_MS) : null
    if (cachedReading && cachedReading.fresh) {
      const cachedWindows = extractWindows(cachedReading.data)
      // FINDING 2 fix: completeness, not mere non-emptiness — see hasCompleteWindows.
      if (hasCompleteWindows(cachedWindows)) {
        windows = cachedWindows
        sourceData = cachedReading.data
        viaCache = true
      }
      // A fresh-but-unusable (partial or foreign-shaped) cache is NOT trusted as a
      // reading — falls through to a live probe just like a cold cache would.
    }

    if (!viaCache) {
      const { stdout: rawJson, stderr: probeStderr, spawnError, timedOut } = await runProbe(probe.path, timeout * 1000)

      if (timedOut) {
        state.consecutiveFailures += 1
        if (!state.probeTimeoutSignaled) {
          state.probeTimeoutSignaled = true
          writeLine(`QUOTA WATCH DEGRADED: probe exceeded its ${timeout}s timeout and was stopped (reported once)`)
        }
        maybeWriteDegradedReminder(state)
        const backoffMs = computeBackoffMs(poll, state.consecutiveFailures)
        await sleep(backoffMs)
        noteDegradedSleep(state, backoffMs)
        continue
      }

      if (spawnError) {
        state.consecutiveFailures += 1
        if (!state.probeKoSignaled) {
          state.probeKoSignaled = true
          writeLine(`QUOTA WATCH DEGRADED: probe could not START: ${spawnError} (reported once)`)
        }
        maybeWriteDegradedReminder(state)
        const backoffMs = computeBackoffMs(poll, state.consecutiveFailures)
        await sleep(backoffMs)
        noteDegradedSleep(state, backoffMs)
        continue
      }

      if (rawJson.length === 0) {
        state.consecutiveFailures += 1
        if (!state.probeKoSignaled) {
          state.probeKoSignaled = true
          const reason = probeStderr.length > 0 ? redact(probeStderr.split('\n')[0]).slice(0, 200) : 'no reason given'
          writeLine(`QUOTA WATCH DEGRADED: probe returned nothing (${reason}) (reported once)`)
        }
        maybeWriteDegradedReminder(state)
        const backoffMs = computeBackoffMs(poll, state.consecutiveFailures)
        await sleep(backoffMs)
        noteDegradedSleep(state, backoffMs)
        continue
      }

      let parsed
      try {
        parsed = JSON.parse(rawJson)
      } catch {
        state.consecutiveFailures += 1
        if (!state.probeKoSignaled) {
          state.probeKoSignaled = true
          writeLine('QUOTA WATCH DEGRADED: probe output UNPARSEABLE (invalid JSON) (reported once)')
        }
        maybeWriteDegradedReminder(state)
        const backoffMs = computeBackoffMs(poll, state.consecutiveFailures)
        await sleep(backoffMs)
        noteDegradedSleep(state, backoffMs)
        continue
      }

      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        state.consecutiveFailures += 1
        if (!state.probeKoSignaled) {
          state.probeKoSignaled = true
          writeLine('QUOTA WATCH DEGRADED: probe output INVALID (expected a JSON object with a usable window) (reported once)')
        }
        maybeWriteDegradedReminder(state)
        const backoffMs = computeBackoffMs(poll, state.consecutiveFailures)
        await sleep(backoffMs)
        noteDegradedSleep(state, backoffMs)
        continue
      }

      const liveWindows = extractWindows(parsed)

      // ⚠ THIS CHECK MUST PRECEDE the completeness gate below, and the ordering is the whole
      // point. An account with NO subscription quota (usage-billed / pay-per-token) has no
      // five-hour or seven-day window at all, so it looks EXACTLY like a malformed probe:
      // "missing window(s): five_hour,seven_day". Placed after the gate, this branch is
      // unreachable and the watcher instead reports a healthy account as a broken probe,
      // then polls forever — measured, before this line existed.
      //
      // Two states, identical shape, opposite meanings: "cannot measure" and "nothing to
      // measure". Only the probe can tell them apart, which is why the decision is made on
      // the explicit `quota_model` it states, never inferred from an absent percentage.
      //
      // Stopping (rather than idling quietly) is deliberate: a watcher that stays armed while
      // watching nothing has silence indistinguishable from "quota is fine".
      if (parsed?.quota_model === 'none') {
        writeLine(
          'QUOTA WATCH STOPPING: this account has no subscription quota (usage-billed), so there ' +
            'is no five-hour or seven-day window to watch. Nothing is wrong — there is simply ' +
            'nothing to report, and a watcher that kept polling would look armed while watching ' +
            'nothing.',
        )
        process.exit(0)
      }

      // FINDING 2 fix, extended to this door too (not cited by the review, but the SAME
      // defect shape: a probe returning only ONE window used to be accepted as success,
      // silently dropping the other — see hasCompleteWindows above). A malformed/legacy
      // probe script is a realistic way for this to happen even though the shipped probes
      // always return both windows together from one API response.
      if (!hasCompleteWindows(liveWindows)) {
        state.consecutiveFailures += 1
        if (!state.probeKoSignaled) {
          state.probeKoSignaled = true
          const missing = WINDOWS.filter(({ key }) => !(key in liveWindows)).map(({ key }) => key)
          writeLine(`QUOTA WATCH DEGRADED: probe output INVALID (missing window(s): ${missing.join(',')}) (reported once)`)
        }
        maybeWriteDegradedReminder(state)
        const backoffMs = computeBackoffMs(poll, state.consecutiveFailures)
        await sleep(backoffMs)
        noteDegradedSleep(state, backoffMs)
        continue
      }

      // Live probe succeeded: refill the shared cache so the per-turn hook and any other
      // watcher can use this reading instead of hitting the endpoint again inside the TTL
      // window. Best-effort — a cache write failure must never take the watcher down.
      try {
        await writeQuotaCacheAtomic(CACHE_PATH, parsed)
      } catch {
        /* best effort */
      }

      windows = liveWindows
      sourceData = parsed
    }

    // Probe-health state describes the PROBE, so ONLY a successful LIVE probe clears it.
    // Clearing it on a cache-sourced reading was wrong in two compounding ways, both
    // observed 2026-07-31 with several sessions running against one account:
    //   1. the shared cache alternates fresh/stale as any session takes a turn, so every
    //      stale-cache cycle re-armed the "reported once" notice — the DEGRADED line then
    //      repeats for the whole session instead of once;
    //   2. worse, it reset consecutiveFailures, so the exponential backoff could never
    //      grow past one — the watcher kept probing at full cadence precisely while the
    //      endpoint was rate-limiting it, sustaining the 429 it was backing off from.
    // A cache hit says nothing about whether the endpoint recovered; only a live probe does.
    if (!viaCache) {
      state.probeKoSignaled = false
      state.probeTimeoutSignaled = false
      state.consecutiveFailures = 0
      resetDegradedVisibility(state)
    }

    if (!state.hasReading) {
      const line = initialStateLine(windows, thresholds)
      setBaseline(state, windows, thresholds)
      state.fingerprint = readAccountFingerprint(sourceData?.configDir)
      state.hasReading = true
      if (line) writeLine(line)
      await sleep(poll * 1000)
      continue
    }

    const currentFingerprint = readAccountFingerprint(sourceData?.configDir)
    const previousFingerprint = state.fingerprint
    const fingerprintChanged = previousFingerprint !== null && currentFingerprint !== null && previousFingerprint !== currentFingerprint

    if (fingerprintChanged) {
      // Four hex chars kept: signals the change while limiting residual correlation.
      writeLine(`QUOTA ACCOUNT CHANGED: ${previousFingerprint.slice(0, 4)} -> ${currentFingerprint.slice(0, 4)}`)
      setBaseline(state, windows, thresholds)
      if (currentFingerprint !== null) state.fingerprint = currentFingerprint
      await sleep(poll * 1000)
      continue
    }

    const drops = []
    for (const { key, label } of WINDOWS) {
      const windowData = windows[key]
      const previousPct = state.lastPct.get(key)
      if (!windowData || previousPct === undefined) continue
      if (windowData.pct < previousPct) {
        drops.push({ key, label, currentPct: windowData.pct, previousPct, resetLocal: windowData.resetLocal })
      }
    }

    if (drops.length > 0 && (previousFingerprint === null || currentFingerprint === null)) {
      for (const drop of drops) {
        writeLine(`QUOTA DROP ${drop.label}: ${drop.currentPct}% (was ${drop.previousPct}%) — cause undetermined (reset or account change)`)
      }
      setBaseline(state, windows, thresholds)
      if (currentFingerprint !== null) state.fingerprint = currentFingerprint
      await sleep(poll * 1000)
      continue
    }

    if (drops.length > 0) {
      for (const drop of drops) {
        writeLine(`QUOTA RESET ${drop.label}: ${drop.currentPct}% (was ${drop.previousPct}%) — new window, capacity available`)
        baselineWindow(state, drop.key, drop.currentPct, thresholds)
      }
      for (const { key } of WINDOWS) {
        if (!windows[key] || drops.some((drop) => drop.key === key)) continue
        state.lastPct.set(key, windows[key].pct)
      }
      state.fingerprint = currentFingerprint
      await sleep(poll * 1000)
      continue
    }

    for (const { key, label } of WINDOWS) {
      const windowData = windows[key]
      if (!windowData) {
        // Defensive only: with hasCompleteWindows() gating both the cache and live-probe
        // paths above, `windows` always covers every WINDOWS key by the time we reach
        // here — this branch should be unreachable in normal operation. Kept as a
        // fail-safe (never a fabricated reading) rather than an assertion that would
        // crash the watcher on a future change to the gating logic above.
        clearWindowState(state, key)
        continue
      }

      let firedForWindow = state.fired.get(key)
      if (!firedForWindow) {
        firedForWindow = new Set()
        state.fired.set(key, firedForWindow)
      }

      for (const threshold of thresholds) {
        if (windowData.pct >= threshold && !firedForWindow.has(threshold)) {
          firedForWindow.add(threshold)
          writeLine(`QUOTA ${label}: ${windowData.pct}% — crossed the ${threshold}% threshold, resets ${windowData.resetLocal}`)
        }
      }

      state.lastPct.set(key, windowData.pct)
    }

    state.fingerprint = currentFingerprint
    await sleep(poll * 1000)
  } catch (error) {
    // ⚠ Without this net, a single unexpected probe output (`null`, a missing
    // field) kills the process. A DEAD watcher is indistinguishable from one
    // that has nothing to report — exactly the failure this whole file exists
    // to remove. Say so and continue.
    // ⚠ Once only: repeating every cycle would flood the channel and get the
    // monitor auto-stopped, manufacturing the very silence this net exists to avoid.
    if (!state.internalErrorSignaled) {
      state.internalErrorSignaled = true
      writeLine(`QUOTA WATCH DEGRADED: internal watcher error, cycles skipped: ${redact(error?.message ?? error)} (reported once)`)
    }
    maybeWriteDegradedReminder(state)
    const pollMs = poll * 1000
    await sleep(pollMs)
    noteDegradedSleep(state, pollMs)
  }
}
