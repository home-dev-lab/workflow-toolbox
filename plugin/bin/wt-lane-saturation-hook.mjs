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
// infrastructure: a daemon, a protocol, a failure mode of its own. This hook does NOT
// depend on caller discipline (the counter's weakness) at the counter's cost (nothing to
// run, nothing to keep alive) — but it is NOT a true queue either, and the difference is a
// real, disclosed limitation, not a rounding error:
//
// ⚠ CHECK-THEN-ACT, NOT ATOMIC. Counting live processes and deciding are two separate
// steps with no lock or reservation between them. Two Bash calls dispatched close enough
// together — genuinely parallel tool calls in one turn, or two different agents' hooks
// running as separate OS processes at nearly the same instant — can both observe the same
// live count, both see themselves as the one call that would land exactly at the bound,
// and both be allowed, jointly landing one over. This does not defeat the guard: it
// narrows the race window to roughly the time between two hook invocations rather than the
// unbounded, unmeasured window that existed before this guard shipped, and a call that
// slips through the race is still counted (and refused) by the NEXT call a few hundred
// milliseconds later once its process is actually visible to pgrep. A real fix (a file
// lock or reservation ticket) is exactly the "queue" the card weighed and rejected as
// infrastructure with its own failure modes — not built here, named instead.
//
// ⚠ IT WARNED, IT NEVER BLOCKED — RETIRED. Shipped advisory-only in 161dfa8 on the reasoning
// that a new guard's precision must be measured before it is allowed to refuse anything.
// Measured the same day, on this exact card: an informed caller reads the advisory and can
// still proceed anyway — the founding incident was never a lack of information, it was two
// arcs with no reason to stop. So DEFAULT is now `permissionDecision:'deny'` on the
// over-bound branch (same JSON contract wt-pilot-guard-hook.mjs already uses, and the
// contract already measured to reach subagent Bash calls, not just the main session). The
// counting/regex logic is UNCHANGED — only the action taken on an already-correct
// measurement changed. `WT_LANE_ENFORCE_MODE=warn` reverts to the old print-only behavior
// instantly, without a code change, if this proves too aggressive under real usage — see
// wt-lane-saturation-core.mjs. The "unknown" (pgrep unavailable) branch NEVER denies: a
// measurement failure must never be treated as grounds to block.
//
// ⚠ NOW THAT THIS CAN DENY, an uncaught exception here must fail OPEN (allow), never
// closed — a broken entry path in a DENYING guard would otherwise silently block every
// lane call on the machine, which is a worse outcome than the contention this guard exists
// to prevent. Wrapped in runFailOpenHook (the same seam every other deny-capable guard in
// this directory already uses); wt-lane-saturation-core.mjs's OWN failure paths (pgrep
// unavailable) are handled separately, inside evaluateLaneCall, and never reach here.

import { readFileSync } from 'node:fs'
import { evaluateLaneCall } from './lib/wt-lane-saturation-core.mjs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

function readPayload() {
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function main() {
  const payload = readPayload()
  const result = evaluateLaneCall(payload)

  if (result.silent) return

  if (result.deny) {
    // Built inline (not via a shared helper) deliberately: this project's own
    // refusal-message-invariant gate audits each deny guard's OWN source for the literal
    // `permissionDecisionReason:` field, so the reason it delivers is never one
    // indirection away from the file that claims to deny.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.message,
        },
      }),
    )
    return
  }

  // Advisory path (warn mode, or the unknown-measurement branch): print and allow.
  console.log(result.message)
}

runFailOpenHook('wt-lane-saturation-hook.mjs', main)
