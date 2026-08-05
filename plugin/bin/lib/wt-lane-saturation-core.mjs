import { spawnSync } from 'node:child_process'

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

export function evaluateLaneCall(
  payload,
  { countLaneProcesses = countLaneProcessesReal, boundFromEnv = boundFromEnvReal, env = process.env } = {},
) {
  const command = payload?.tool_input?.command
  if (typeof command !== 'string' || !LANE_INVOCATIONS.some((re) => re.test(command))) return { silent: true }

  const { bound, source } = boundFromEnv(env)
  const live = countLaneProcesses()

  if (live.state === 'unknown') {
    return {
      silent: false,
      message:
        `[wt] lane usage NOT MEASURED before this call — ${live.reason}. ` +
        `This is not a report that the lane is free; it is a report that nothing was counted. ` +
        `If a batch dies on timeout shortly after, contention is the first hypothesis, not the last.`,
    }
  }

  // The count EXCLUDES the call about to be made — it has not started yet.
  if (live.count + 1 <= bound) return { silent: true }

  return {
    silent: false,
    message: [
      `[wt] the external lane is at or past its bound: ${live.count} call(s) already live, ` +
        `this one would make ${live.count + 1}, bound ${bound} (${source}).`,
      `  What happens past the bound is NOT a clean refusal: the lane rate-limits and retries, ` +
        `latency goes up roughly 5-8x, and then YOUR OWN timeout converts that slowdown into a ` +
        `dead call. Four batches were lost that way in the incident this guard comes from.`,
      `  ⚠ A 0-byte output file while the process is alive does NOT distinguish "queued" from ` +
        `"about to expire" — both look identical until the last second, so do not read silence ` +
        `as progress.`,
      `  Options: wait for the live calls to drain, size this call's timeout for latency UNDER ` +
        `LOAD rather than in isolation, or raise the bound deliberately via WT_LANE_MAX_CONCURRENT ` +
        `if the subscribed plan supports it.`,
      `  This is advisory — the call is NOT blocked.`,
    ].join('\n'),
  }
}
