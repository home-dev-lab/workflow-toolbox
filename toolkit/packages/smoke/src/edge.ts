// edge.ts — pure pieces of the negative-case ("edge") canary: deterministic
// generators for the malformed/oversized workflow scripts, and the verdict over a
// launch ToolResult. NO I/O here; edge-canaries.ts writes these to temp files,
// launches them through the real runtime, and judges the result with judgeRejection.
//
// These re-verify the runtime facts that `pnpm smoke` does NOT cover — the
// *negative* surface (a valid-looking artifact that the tool layer must REJECT):
//   (a) a script over the 512 KB cap, and
//   (b) a statement placed before the `meta` literal.
// Both must be rejected synchronously (tool_result is_error). If a Claude Code
// upgrade ever ACCEPTS one of these, that is the regression this canary exists to
// catch — judgeRejection fails loudly in that case.

import { type CheckResult, launchVerdict, type ToolResult } from './lib.js'

/** The tool-layer script-size cap (`maxLength: 524288` in the Workflow schema,
 *  M0-verified to also apply to scriptPath files). */
export const SIZE_CAP = 524288

export interface EdgeCase {
  /** Stable check name shown in the report. */
  name: string
  /** Temp filename the runner writes the script to. */
  filename: string
  /** The script body to launch. */
  script: string
  /** The rejection reason must match this for the canary to PASS. */
  reasonPattern: RegExp
}

// A minimal, VALID dwt-shaped artifact: `meta` literal first, then a top-level
// `return`. Used as the base for the oversized case so SIZE is the only defect.
const VALID_META = (name: string): string =>
  `export const meta = { "name": "${name}", "description": "edge canary", "phases": [{ "title": "x" }] }`
const VALID_TAIL = `return await (async () => ({ ok: true }))()`

/** An otherwise-VALID workflow padded with a giant string literal so the ONLY
 *  reason it can be rejected is the 512 KB cap (not a parse/meta error). */
export function oversizeScript(): string {
  const head = `${VALID_META('dwt-edge-oversize')}\n`
  const tail = `\n${VALID_TAIL}\n`
  const prefix = 'const _pad = '
  // Pad comfortably past the cap; JSON.stringify keeps it a valid JS string literal.
  const padLen = SIZE_CAP + 4096 - head.length - tail.length - prefix.length - 4
  const pad = 'x'.repeat(Math.max(1, padLen))
  return `${head}${prefix}${JSON.stringify(pad)}\n${tail}`
}

/** A workflow with a statement BEFORE the `meta` literal — must be rejected
 *  synchronously at the tool layer (meta must be the first statement). */
export function metaOrderScript(): string {
  return `const before = 1\n${VALID_META('dwt-edge-metaorder')}\nvoid before\n${VALID_TAIL}\n`
}

/** Build the two edge cases. reasonPattern for the meta-order case is broad
 *  enough to survive minor wording drift but specific to a "meta/first/literal"
 *  complaint; the size case must cite the byte cap. */
export function edgeCases(): EdgeCase[] {
  return [
    {
      name: 'edge: 512 KB cap rejects an oversized scriptPath',
      filename: 'dwt-edge-oversize.js',
      script: oversizeScript(),
      reasonPattern: /524288|exceeds|too large|size/i,
    },
    {
      name: 'edge: a statement before meta is rejected',
      filename: 'dwt-edge-metaorder.js',
      script: metaOrderScript(),
      // Tight enough to avoid a generic parse error false-passing, loose enough
      // to survive minor wording drift: the real message cites both "meta" and
      // "FIRST statement".
      reasonPattern: /meta\b.*first|first statement/i,
    },
  ]
}

/** Normalize a rejection reason for run-to-run comparison: strip the volatile
 *  bits (temp script paths, run/task ids) so only the stable wording remains.
 *  Lets the change-report flag genuine message DRIFT — a reworded or relocated
 *  rejection — instead of per-run noise. Semantic numbers (e.g. the byte cap) are
 *  kept on purpose: a cap value change is a meaningful drift worth surfacing. */
export function canonicalizeReason(text: string): string {
  return text
    .replace(/\/tmp\/\S+/g, '<path>')
    .replace(/\bwf_[0-9a-f-]+/gi, '<runid>')
    // Task ids are `w` + ≥8 base36 chars and ALWAYS contain a digit; the digit
    // lookahead spares real all-alpha words ("workflows", "wrongness", "windows").
    .replace(/\bw(?=[a-z0-9]*\d)[0-9a-z]{8,}\b/g, '<taskid>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A negative canary PASSES when the launch was REJECTED (is_error) for the
 *  expected reason. An ACCEPTED launch — or a rejection citing a different cause
 *  — FAILS: that is the runtime drift the canary is built to surface. */
export function judgeRejection(name: string, result: ToolResult, reasonPattern: RegExp): CheckResult {
  const verdict = launchVerdict(result)
  const canonicalReason = canonicalizeReason(verdict.reason)
  if (verdict.ok) {
    return { name, ok: false, detail: `expected REJECTION but the launch was ACCEPTED (taskId ${verdict.taskId})`, canonicalReason }
  }
  if (!reasonPattern.test(verdict.reason)) {
    return { name, ok: false, detail: `rejected, but the reason did not match ${reasonPattern}: ${verdict.reason}`, canonicalReason }
  }
  return { name, ok: true, detail: `correctly rejected: ${verdict.reason}`, canonicalReason }
}
