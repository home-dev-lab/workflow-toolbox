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

const DEFAULT_THRESHOLDS = '80,90,95'
const DEFAULT_POLL_SECONDS = 300
const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024
const MAX_TIMER_SECONDS = Math.floor(0x7fffffff / 1000)
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
let testCyclesCompleted = 0

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
    if (testCyclesCompleted >= TEST_MAX_CYCLES) process.exit(0)
  }
  return new Promise((resolve) => {
    setTimeout(resolve, TEST_SLEEP_LOG ? 0 : ms)
  })
}

const { poll, timeout, probe, thresholds } = parseArgs(process.argv.slice(2))

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
}

writeLine(`QUOTA WATCH ARMED: thresholds=${thresholds.join(',')} poll=${poll}s probe=${basename(probe.path)} source=${probe.source}`)

while (true) {
  try {
    let windows = {}
    let sourceData = null
    let viaCache = false

    // Cache-first: a fresh reading already on disk (ours from a previous poll, another
    // watcher's, or the per-turn hook's) is used as-is — no network call at all. This is
    // what stops N independent watchers/sessions from each hitting the live endpoint on
    // their own schedule.
    const cachedReading = await readQuotaCache(CACHE_PATH)
    if (cachedReading && cachedReading.fresh) {
      const cachedWindows = extractWindows(cachedReading.data)
      if (Object.keys(cachedWindows).length > 0) {
        windows = cachedWindows
        sourceData = cachedReading.data
        viaCache = true
      }
      // A fresh-but-unusable cache (foreign shape, no recognizable window) is NOT trusted
      // as a reading — falls through to a live probe just like a cold cache would.
    }

    if (!viaCache) {
      const { stdout: rawJson, stderr: probeStderr, spawnError, timedOut } = await runProbe(probe.path, timeout * 1000)

      if (timedOut) {
        state.consecutiveFailures += 1
        if (!state.probeTimeoutSignaled) {
          state.probeTimeoutSignaled = true
          writeLine(`QUOTA WATCH DEGRADED: probe exceeded its ${timeout}s timeout and was stopped (reported once)`)
        }
        await sleep(computeBackoffMs(poll, state.consecutiveFailures))
        continue
      }

      if (spawnError) {
        state.consecutiveFailures += 1
        if (!state.probeKoSignaled) {
          state.probeKoSignaled = true
          writeLine(`QUOTA WATCH DEGRADED: probe could not START: ${spawnError} (reported once)`)
        }
        await sleep(computeBackoffMs(poll, state.consecutiveFailures))
        continue
      }

      if (rawJson.length === 0) {
        state.consecutiveFailures += 1
        if (!state.probeKoSignaled) {
          state.probeKoSignaled = true
          const reason = probeStderr.length > 0 ? redact(probeStderr.split('\n')[0]).slice(0, 200) : 'no reason given'
          writeLine(`QUOTA WATCH DEGRADED: probe returned nothing (${reason}) (reported once)`)
        }
        await sleep(computeBackoffMs(poll, state.consecutiveFailures))
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
        await sleep(computeBackoffMs(poll, state.consecutiveFailures))
        continue
      }

      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        state.consecutiveFailures += 1
        if (!state.probeKoSignaled) {
          state.probeKoSignaled = true
          writeLine('QUOTA WATCH DEGRADED: probe output INVALID (expected a JSON object with a usable window) (reported once)')
        }
        await sleep(computeBackoffMs(poll, state.consecutiveFailures))
        continue
      }

      const liveWindows = extractWindows(parsed)

      if (Object.keys(liveWindows).length === 0) {
        state.consecutiveFailures += 1
        if (!state.probeKoSignaled) {
          state.probeKoSignaled = true
          writeLine('QUOTA WATCH DEGRADED: probe output INVALID (no usable window) (reported once)')
        }
        await sleep(computeBackoffMs(poll, state.consecutiveFailures))
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

    // Notices only re-arm after a structurally valid response (cached or live), and a
    // successful cycle — via cache or a live probe — resets the backoff to normal cadence.
    state.probeKoSignaled = false
    state.probeTimeoutSignaled = false
    state.consecutiveFailures = 0

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
    await sleep(poll * 1000)
  }
}
