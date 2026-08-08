#!/usr/bin/env node
// wt-lane-consent-gate-hook.mjs — PreToolUse(Bash): ENFORCES the executor-lane consent switch
// at the one place a lane call is actually about to execute, closing the gap this card is about
// — a stated routing policy ("the lane is opt-in, default OFF") that nothing mechanical read.
// The sibling `wt-lane-consent-check-hook.mjs` (SessionStart) only warns when auto-loaded RULES
// disagree with the switch; it never runs at call time and never refuses anything. This hook is
// the gate: it inspects the REAL Bash command about to run, and if it is a real external-lane
// invocation (`opencode run` / `codex exec`, quote/comment-stripped — same detection as the
// lane-saturation guard) that is not consented, it denies before the process ever starts.
//
// ⚠ FAILS CLOSED — the deliberate exception to every other guard in this directory. Every OTHER
// deny-capable guard here (lane saturation, verifier-cli self-answer, …) wraps its entry point in
// `runFailOpenHook`: those guards protect a command from being wrongly BLOCKED, so a broken entry
// path must never itself become a block. This hook protects the opposite property — an unreadable
// or malformed settings file must never be silently read as "yes", which is exactly the failure
// mode a consent switch exists to prevent (permissive, silent, indistinguishable from consent
// actually given). So both `evaluateConsentGate`'s own 'unknown' branch AND this wrapper's own
// top-level errors resolve to DENY, not allow — stated here so the asymmetry is not mistaken for
// a bug the next time someone reads this directory's guards side by side.

import { readFileSync } from 'node:fs'
import { evaluateConsentGate } from './lib/lane-consent-gate-core.mjs'

const HOOK_NAME = 'wt-lane-consent-gate-hook.mjs'

function readPayload() {
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function deny(message) {
  // Built inline (not via a shared helper): this project's own refusal-message-invariant gate
  // audits each deny guard's OWN source for the literal `permissionDecisionReason:` field, so the
  // reason it delivers is never one indirection away from the file that claims to deny.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
    }),
  )
}

function main() {
  // Self-test seam, mirroring the fail-open seam every OTHER guard here shares — but this one is
  // local and deliberately named after THIS hook, because the behaviour it proves is the inverse
  // (fails CLOSED): forcing this hook's own entry path to throw must still deny, not allow.
  if (process.env.WT_LANE_CONSENT_GATE_SELF_TEST === HOOK_NAME) {
    throw new Error(`forced fail-closed self-test for ${HOOK_NAME}`)
  }
  const payload = readPayload()
  const result = evaluateConsentGate(payload)
  if (!result.silent && result.deny) deny(result.message)
}

try {
  main()
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${HOOK_NAME}: FAILED CLOSED - ${detail}\n`)
  deny(
    [
      'Refused: the executor-lane consent gate hit an internal error and could not evaluate consent.',
      `  ${detail}`,
      '  This fails CLOSED, not open: an error while reading the switch is treated exactly like',
      '  "not consented" rather than silently letting an unconsented call through.',
      '  Fix: re-run once the underlying error is resolved, or inspect the switch by hand with',
      '  `wt-lane-consent`.',
    ].join('\n'),
  )
}
