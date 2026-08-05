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

import { readFileSync } from 'node:fs'
import { evaluateLaneCall } from './lib/wt-lane-saturation-core.mjs'

function readPayload() {
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const payload = readPayload()
const result = evaluateLaneCall(payload)
if (!result.silent) console.log(result.message)
process.exit(0)
