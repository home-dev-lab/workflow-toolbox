import { spawnSync } from 'node:child_process'
import { stripHeredocs } from './shell-text.mjs'

/** The bound is a NAMED parameter, never a buried constant: the 8-16 wall is empirical and
 *  moves with the subscribed plan. The default is the LOW end deliberately — being warned
 *  slightly early costs a line of text; being warned too late costs the batch. */
export const DEFAULT_MAX = 8
/** Process names that ARE a lane call. Matched by exact process name (see below). */
export const LANE_PROCESS_NAMES = ['opencode', 'codex']
/** Substrings that mean the command is trying to USE the lane, as opposed to merely
 *  mentioning it (a grep, a doc edit, this file). Narrow on purpose: a guard that fires on
 *  every command containing the word becomes noise within a day. */
export const LANE_INVOCATIONS = [/\bopencode\s+run\b/, /\bcodex\s+exec\b/]

/** Strip quoted-string bodies and shell comments before testing LANE_INVOCATIONS — a
 *  command line MIXES code and data, and a textual guard that reads a heredoc or a quoted
 *  string as if the shell would execute it refuses correct work (this project's own
 *  documented gotcha). Without this, `echo 'opencode run x'`, `printf '%s' 'opencode run'`,
 *  or a `# opencode run` comment all read as a real invocation — harmless while this guard
 *  only warned, but a genuine false-deny now that it can refuse the call outright, for ANY
 *  Bash caller including the main session.
 *
 *  Deliberately simple, not a shell parser: strips '...'/"..." bodies (escaped quotes inside
 *  double quotes respected) and drops everything from an unquoted `#` to end of string. This
 *  narrows false positives (mention-only text) at essentially no cost to true positives: a
 *  real invocation is never itself wrapped in quotes or written after a comment marker. */
export function stripNonExecutedText(command) {
  // ⚠ Heredoc bodies FIRST, and this line is the whole point of the fix. The character loop below
  // removes quoted spans, which is what this function documented and did — but a heredoc body is
  // neither quoted nor commented, so an invocation string sitting inside one reached the matcher
  // intact and the lane gate REFUSED the command that merely wrote it (measured 2026-08-28, on a
  // test fixture). A guard that refuses correct work gets disabled, and takes its real case along.
  command = stripHeredocs(command)
  let out = ''
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (ch === "'") {
      const end = command.indexOf("'", i + 1)
      i = end === -1 ? command.length : end + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\') j += 1
        j += 1
      }
      i = j >= command.length ? command.length : j + 1
      continue
    }
    if (ch === '#') break // unquoted '#' starts a comment: nothing after it executes
    out += ch
    i += 1
  }
  return out
}

/** Count live lane processes by EXACT PROCESS NAME.
 *
 *  ⚠ THE OBVIOUS FORM IS WRONG AND INFLATES BY CONSTRUCTION. `pgrep -f 'opencode run'`
 *  matches any process whose COMMAND LINE contains that string — which includes the shell
 *  that is about to run it, this checker's own invocation if it were passed as an
 *  argument, and every unrelated shell carrying the text. Measured on this machine with
 *  ZERO lane calls running: `pgrep -c -f 'opencode run'` returned 2, `pgrep -c -x
 *  opencode` returned 0. A positive control (a real process named opencode) then moved the
 *  -x count 0 → 1 → 0 while the -f count stayed pinned at its own noise.
 *
 *  So: `-x`, which matches the kernel's process name and cannot match a shell that merely
 *  mentions it.
 *
 *  Returns `{ state: 'ok', count }` or `{ state: 'unknown', reason }` — NEVER a zero it
 *  could not measure. "pgrep is missing" and "nothing is running" are opposite facts, and
 *  reporting the first as the second would tell a caller the lane is free at exactly the
 *  moment nobody can tell. */
export function countLaneProcessesReal(names = LANE_PROCESS_NAMES) {
  let total = 0
  for (const name of names) {
    const res = spawnSync('pgrep', ['-c', '-x', name], { encoding: 'utf8' })
    if (res.error) return { state: 'unknown', reason: `pgrep is unavailable (${res.error.message})` }
    // pgrep exits 1 when nothing matched — that is a real zero, not an error.
    if (res.status !== 0 && res.status !== 1) {
      return { state: 'unknown', reason: `pgrep exited ${res.status} for "${name}"` }
    }
    const parsed = Number.parseInt(String(res.stdout ?? '').trim(), 10)
    total += Number.isFinite(parsed) ? parsed : 0
  }
  return { state: 'ok', count: total }
}

export function boundFromEnvReal(env = process.env) {
  const raw = env['WT_LANE_MAX_CONCURRENT']
  if (raw === undefined || raw.trim() === '') return { bound: DEFAULT_MAX, source: 'default' }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return { bound: DEFAULT_MAX, source: 'default (env value unusable)' }
  return { bound: parsed, source: 'WT_LANE_MAX_CONCURRENT' }
}

/** Enforcement mode is a NAMED, independent parameter from the bound itself — a rollback
 *  lever for the ACT of blocking, separate from the lever that sizes the bound. `deny` is
 *  the default: an advisory a caller can read and ignore does not meet the card's own
 *  closing criterion ("a second launcher genuinely bounds itself or waits"), which a
 *  README-only warning was measured, on this exact card, to fail — a caller who saw the
 *  message chose to proceed anyway, because nothing forced otherwise. `warn` reverts to
 *  print-only behavior instantly, without a code change, if this guard's false-positive
 *  rate under real usage turns out to be a problem: a guard that blocks correct work gets
 *  switched off and takes its real case with it, so the switch itself must be immediate. */
export function enforceModeFromEnvReal(env = process.env) {
  const raw = String(env['WT_LANE_ENFORCE_MODE'] ?? '').trim().toLowerCase()
  return raw === 'warn' ? 'warn' : 'deny'
}

export function evaluateLaneCall(
  payload,
  {
    countLaneProcesses = countLaneProcessesReal,
    boundFromEnv = boundFromEnvReal,
    enforceModeFromEnv = enforceModeFromEnvReal,
    env = process.env,
  } = {},
) {
  const command = payload?.tool_input?.command
  if (typeof command !== 'string' || !LANE_INVOCATIONS.some((re) => re.test(stripNonExecutedText(command)))) {
    return { silent: true }
  }

  const { bound, source } = boundFromEnv(env)
  const live = countLaneProcesses()

  if (live.state === 'unknown') {
    // NEVER deny on a measurement failure: "pgrep is missing" and "nothing is running" are
    // opposite facts, and the one clean thing a broken measurement can do is stay out of
    // the caller's way rather than block on a guess.
    return {
      silent: false,
      deny: false,
      message:
        `[wt] lane usage NOT MEASURED before this call — ${live.reason}. ` +
        `This is not a report that the lane is free; it is a report that nothing was counted. ` +
        `If a batch dies on timeout shortly after, contention is the first hypothesis, not the last.`,
    }
  }

  // The count EXCLUDES the call about to be made — it has not started yet.
  if (live.count + 1 <= bound) return { silent: true }

  const mode = enforceModeFromEnv(env)
  const deny = mode === 'deny'

  return {
    silent: false,
    deny,
    message: [
      `[wt] ${deny ? 'Refused: ' : ''}the external lane is at or past its bound: ${live.count} ` +
        `call(s) already live, this one would make ${live.count + 1}, bound ${bound} (${source}).`,
      `  What happens past the bound is NOT a clean refusal from the CLI itself: the lane ` +
        `rate-limits and retries, latency goes up roughly 5-8x, and then YOUR OWN timeout ` +
        `converts that slowdown into a dead call. Four batches were lost that way in the ` +
        `incident this guard comes from.`,
      `  ⚠ A 0-byte output file while the process is alive does NOT distinguish "queued" from ` +
        `"about to expire" — both look identical until the last second, so do not read silence ` +
        `as progress.`,
      deny
        ? `  This call is REFUSED, not merely flagged: an informed caller was measured choosing ` +
          `to proceed anyway on the advisory form, which is why this now blocks. Later readers ` +
          `cannot tell "queued" from "about to expire" from the output alone, so the refusal ` +
          `itself is the only reliable signal. Fix: wait for a live call to drain and retry, or ` +
          `raise the bound deliberately via WT_LANE_MAX_CONCURRENT if the subscribed plan ` +
          `supports it. To fall back to advisory-only, set WT_LANE_ENFORCE_MODE=warn.`
        : `  Options: wait for the live calls to drain, size this call's timeout for latency UNDER ` +
          `LOAD rather than in isolation, or raise the bound deliberately via WT_LANE_MAX_CONCURRENT ` +
          `if the subscribed plan supports it.\n  This is advisory (WT_LANE_ENFORCE_MODE=warn) — the ` +
          `call is NOT blocked.`,
    ].join('\n'),
  }
}
