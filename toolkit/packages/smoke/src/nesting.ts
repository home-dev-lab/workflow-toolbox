// nesting.ts — pure pieces of canary C1: re-verifies the claim "the sandbox
// `workflow()` primitive throws when called inside a child workflow (one nesting
// level only)". Manually verified once (2026-06-05); the whole multi-level
// pipeline architecture (dev-full's workflow()-composition pattern) rests on it —
// see docs/public/architecture.md §2.2/§2.3 and
// plugin/skills/workflow-composer/references/api-reference.md ("workflow()
// nesting"). This canary pins it so a Claude Code upgrade that changes the
// behavior is caught automatically instead of relying on the one manual check.
//
// Unlike edge.ts's two negative cases (rejected SYNCHRONOUSLY at the tool layer,
// before any agent runs — a bad `scriptPath` never launches), workflow() nesting
// is enforced DURING execution: the parent's launch is accepted and runs fine
// (depth-1, parent → child, is valid), and it is the CHILD's OWN `workflow()`
// call (depth-2, child → grandchild) that throws. Observing that requires a full
// round trip — waiting for the run's task_notification + reading its output file,
// the same completion path `run.ts`'s tier-2 round trip uses — NOT just the
// launch's immediate tool_result. See nesting-canaries.ts for the live runner.
//
// Design: the CHILD itself try/catches its own workflow() call and returns a
// marker object describing the outcome, rather than relying on the exception
// propagating cleanly through the PARENT's own `await workflow(child)` call too.
// This makes the observable robust to exactly how far up an inner throw
// propagates — the fact under test is pinned at the point it actually occurs.

import { canonicalizeReason } from './edge.js'
import { type CheckResult, isRecord } from './lib.js'

export const PARENT_NAME = 'wt-canary-nest-parent'
export const CHILD_NAME = 'wt-canary-nest-child'
export const GRANDCHILD_NAME = 'wt-canary-nest-grandchild'

/** The trivial grandchild: only reached if depth-2 nesting is ever (wrongly)
 *  allowed. Returns a constant so a regression is unambiguous to spot. */
export function grandchildScript(): string {
  return (
    `export const meta = { "name": "${GRANDCHILD_NAME}", "description": "nesting canary — trivial grandchild, should never run", "phases": [{ "title": "x" }] }\n` +
    `return await (async () => ({ marker: "${GRANDCHILD_NAME}" }))()\n`
  )
}

/** The child: attempts a depth-2 `workflow()` call and catches it itself, so the
 *  observable (did it throw, and what did it say) is captured at the exact point
 *  the claim is about — regardless of how a throw would otherwise propagate
 *  through the parent's own `workflow()` await. `grandchildScriptPath` is
 *  embedded as a JSON string literal (the temp file the runner writes it to). */
export function childScript(grandchildScriptPath: string): string {
  return (
    `export const meta = { "name": "${CHILD_NAME}", "description": "nesting canary — attempts a depth-2 workflow() call", "phases": [{ "title": "x" }] }\n` +
    `return await (async () => {\n` +
    `  let grandchildRejected = false\n` +
    `  let rejectionMessage = null\n` +
    `  let grandchildResult = null\n` +
    `  try {\n` +
    `    grandchildResult = await workflow({ scriptPath: ${JSON.stringify(grandchildScriptPath)} })\n` +
    `  } catch (err) {\n` +
    `    grandchildRejected = true\n` +
    `    rejectionMessage = err && err.message ? err.message : String(err)\n` +
    `  }\n` +
    `  return { marker: "${CHILD_NAME}", grandchildRejected, rejectionMessage, grandchildResult }\n` +
    `})()\n`
  )
}

/** The parent: depth-1 nesting, the positive control. A plain (uncaught)
 *  `workflow()` call — if depth-1 itself were ever broken, the parent script
 *  throws and the run fails outright (no readable result), which the runner
 *  reports as its own distinct failure rather than masquerading as "rejected".
 *  `childScriptPath` is embedded as a JSON string literal. */
export function parentScript(childScriptPath: string): string {
  return (
    `export const meta = { "name": "${PARENT_NAME}", "description": "nesting canary — depth-1 positive control, runs the child", "phases": [{ "title": "x" }] }\n` +
    `const _child = await workflow({ scriptPath: ${JSON.stringify(childScriptPath)} })\n` +
    // A deliberate, deterministic pad (sandbox-legal: setTimeout is not one of the
    // banned non-deterministic calls). Without it, this workflow can complete so
    // fast (no agent() calls anywhere) that it races the SDK's own task_notification
    // delivery against the CLI closing the driving session — observed live: the
    // completion notification sometimes never arrives within the same session,
    // making the canary flake FAIL for a timing reason unrelated to the claim under
    // test. Padding wall-clock time to roughly what a real agent()-based workflow
    // takes made the notification arrive reliably.
    `await new Promise((resolve) => setTimeout(resolve, 4000))\n` +
    `return _child\n`
  )
}

// Exported so nesting-canaries.ts can name its OWN failure CheckResults (launch
// rejected, run never completed) with the exact same identifiers judgeNesting
// uses — one name per check, defined once.
export const DEPTH1_NAME = 'edge: workflow() nesting depth-1 (parent→child) still runs [positive control]'
export const DEPTH2_NAME = 'edge: workflow() nesting depth-2 (child→grandchild) is rejected'

/** Verdict over the PARENT's completed round-trip result (the child's returned
 *  marker object, surfaced as the parent's own result). Two checks from one
 *  launch, in this order:
 *
 *   1. depth-1 (positive control) — the child actually ran and returned its
 *      marker. Checked FIRST and independently of the depth-2 outcome: a broken
 *      workflow() that never reaches the child would otherwise masquerade as
 *      "nesting rejected" (the claim under test needs the child to genuinely
 *      run before its own rejection means anything).
 *   2. depth-2 (the claim) — the child's OWN nested `workflow()` call was
 *      rejected, with a reason that still reads as a nesting-depth complaint
 *      (loose enough to survive wording drift, tight enough that an unrelated
 *      error doesn't false-pass). An ACCEPTED depth-2 call is the regression
 *      this canary exists to catch. */
export function judgeNesting(result: unknown): CheckResult[] {
  if (!isRecord(result)) {
    const detail = `result is not an object (got ${typeof result}) — the parent produced no readable result`
    return [
      { name: DEPTH1_NAME, ok: false, detail },
      { name: DEPTH2_NAME, ok: false, detail: 'skipped — depth-1 positive control failed first' },
    ]
  }

  const depth1Ok = result['marker'] === CHILD_NAME
  const depth1: CheckResult = depth1Ok
    ? { name: DEPTH1_NAME, ok: true, detail: 'the child ran and returned its marker' }
    : {
        name: DEPTH1_NAME,
        ok: false,
        detail: `the child's marker did not come back (got ${JSON.stringify(result['marker'])}) — depth-1 nesting itself looks broken`,
      }

  if (!depth1Ok) {
    return [depth1, { name: DEPTH2_NAME, ok: false, detail: 'skipped — depth-1 positive control failed first' }]
  }

  if (result['grandchildRejected'] !== true) {
    return [
      depth1,
      {
        name: DEPTH2_NAME,
        ok: false,
        detail: `expected the depth-2 workflow() call to be REJECTED but it was ACCEPTED (grandchildResult ${JSON.stringify(result['grandchildResult'])}) — nesting beyond one level is now ALLOWED, a runtime regression`,
      },
    ]
  }

  const reason = typeof result['rejectionMessage'] === 'string' ? result['rejectionMessage'] : ''
  // Feed the SAME wording-drift detector edge.ts's judgeRejection feeds
  // (canonicalizeReason → version.ts's diffSnapshot reasonDrift) — without this,
  // canary C1 is silently opted out of drift detection entirely.
  const canonicalReason = canonicalizeReason(reason)
  const reasonPattern = /nest|one level|workflow\(\)/i
  if (!reasonPattern.test(reason)) {
    return [
      depth1,
      {
        name: DEPTH2_NAME,
        ok: false,
        detail: `rejected, but the reason did not look like a nesting-depth complaint: ${reason}`,
        canonicalReason,
      },
    ]
  }

  return [depth1, { name: DEPTH2_NAME, ok: true, detail: `correctly rejected: ${reason}`, canonicalReason }]
}
