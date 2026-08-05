#!/usr/bin/env node
// wt-lane-saturation-hook.mjs — PreToolUse(Bash) advisory: an external executor lane is a
// SHARED resource that nobody reserves, and every arc can see only its own calls.
//
// The founding incident: two independent arcs of one session pulled on the same lane at
// once — a wave orchestrator running a cross-family review, and an unrelated analysis
// agent that emitted five parallel calls. 17 live lane processes were counted, twice,
// against a measured wall of 8-16. Four extraction batches died on timeout, a review was
// lost, and two agents spent twenty minutes waiting for results that were never coming.
//
// Neither arc could have diagnosed it. Each sees its own calls only, so both observe the
// same thing — "it's slow, nothing comes back" — and neither can reach the cause, because
// the cause is in the other one. The assembly made that failure inevitable rather than
// merely possible: nothing exposed current usage, so "check before launching" was not
// even a gesture available to anyone.
//
// ⚠ TWO MECHANISMS, DELIBERATELY NOT CONFLATED:
//   1. CONTENTION — past the wall every call is rate-limited and retried by the CLI
//      (latency x5-8). The lane itself does not fail here; it slows.
//   2. CONVERSION TO FAILURE — that slowdown crosses the CALLER's own timeout and the
//      call dies. So "an unbounded fan-out only slows down" is true of the CLI and FALSE
//      of the whole system, which is what made the incident expensive.
//
// WHY A HOOK RATHER THAN A COUNTER OR A QUEUE. The card offered two shapes: a shared
// counter every launcher reads before emitting, or a single queue that enforces the bound
// itself. A counter is a directive — it depends on each caller remembering, and a
// directive with no control point does not apply. A queue enforces properly but is
// infrastructure: a daemon, a protocol, a failure mode of its own. This hook has the
// queue's property (the bound does not depend on caller discipline) at the counter's cost
// (nothing to run, nothing to keep alive), because every launcher — main session,
// orchestrator, pilot, throwaway agent — reaches the lane through Bash, and none of them
// needs to know this exists.
//
// ⚠ IT WARNS, IT NEVER BLOCKS. A new guard's precision is measured on material it did not
// choose before it is allowed to refuse anything. Blocking a legitimate call here would
// cost more than the contention it prevents, and a guard that refuses correct work gets
// switched off — taking its real case with it.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** The bound is a NAMED parameter, never a buried constant: the 8-16 wall is empirical and
 *  moves with the subscribed plan. The default is the LOW end deliberately — being warned
 *  slightly early costs a line of text; being warned too late costs the batch. */
const DEFAULT_MAX = 8
/** Process names that ARE a lane call. Matched by exact process name (see below). */
const LANE_PROCESS_NAMES = ['opencode', 'codex']
/** Substrings that mean the command is trying to USE the lane, as opposed to merely
 *  mentioning it (a grep, a doc edit, this file). Narrow on purpose: a guard that fires on
 *  every command containing the word becomes noise within a day. */
const LANE_INVOCATIONS = [/\bopencode\s+run\b/, /\bcodex\s+exec\b/]

function readPayload() {
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
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
function countLaneProcesses() {
  let total = 0
  for (const name of LANE_PROCESS_NAMES) {
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

function boundFromEnv() {
  const raw = process.env['WT_LANE_MAX_CONCURRENT']
  if (raw === undefined || raw.trim() === '') return { bound: DEFAULT_MAX, source: 'default' }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return { bound: DEFAULT_MAX, source: 'default (env value unusable)' }
  return { bound: parsed, source: 'WT_LANE_MAX_CONCURRENT' }
}

const payload = readPayload()
const command = payload?.tool_input?.command
if (typeof command !== 'string' || !LANE_INVOCATIONS.some((re) => re.test(command))) process.exit(0)

const { bound, source } = boundFromEnv()
const live = countLaneProcesses()

if (live.state === 'unknown') {
  // Says what it could not do, never what it concluded.
  console.log(
    `[wt] lane usage NOT MEASURED before this call — ${live.reason}. ` +
      `This is not a report that the lane is free; it is a report that nothing was counted. ` +
      `If a batch dies on timeout shortly after, contention is the first hypothesis, not the last.`,
  )
  process.exit(0)
}

// The count EXCLUDES the call about to be made — it has not started yet.
if (live.count + 1 <= bound) process.exit(0)

console.log(
  [
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
)
process.exit(0)
