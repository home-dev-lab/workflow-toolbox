// label-intent-runner.mjs — pure decision logic behind
// wt-label-intent-producer-hook.mjs (the label-intent-lens detector is
// correct but invoked by nothing except a skill line a model can silently
// skip). Kept separate from the hook itself (same
// discipline as actionability-planka-producer-core.mjs) so tests can drive
// the computation with an injected execFile implementation instead of a real
// child process, a real toolkit checkout, or a real Planka board.
//
// WHAT THIS FILE DOES NOT DO: read the Planka board, or judge what a card's
// labels SHOULD be. It only locates the real, already-shipped
// `toolkit/scripts/label-intent-lens.ts` and its `tsx` runtime inside a
// project's own vendored toolkit, runs it for real via the injected
// execFile, and parses ITS OWN printed summary line — the lens's verdict is
// never recomputed here, only relayed.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Matches label-intent-lens.ts's own printResult():
//   `TOTAL: ${totalFindings} finding(s), ${totalAdvisories} advisory/advisories, ${count} card(s)`
// The literal string "advisory/advisories" is NOT pluralization logic on the
// script's side — it prints unconditionally, so the parser matches it as a
// fixed literal rather than trying to predict either form.
const TOTAL_LINE = /^TOTAL: (\d+) finding\(s\), (\d+) advisory\/advisories, (\d+) card\(s\)$/m

export function locateTsxBinary(toolkitDir) {
  const candidate = join(toolkitDir, 'node_modules', '.bin', 'tsx')
  return existsSync(candidate) ? candidate : null
}

export function locateLensScript(toolkitDir) {
  const candidate = join(toolkitDir, 'scripts', 'label-intent-lens.ts')
  return existsSync(candidate) ? candidate : null
}

// Returns null (never throws) on anything that isn't the script's own summary
// shape — a caller treats null as "cannot trust this output", never as zero
// findings. A parse failure must never be read as a clean board.
export function parseLensOutput(stdout) {
  const match = TOTAL_LINE.exec(String(stdout ?? ''))
  if (!match) return null
  return {
    findings: Number(match[1]),
    advisories: Number(match[2]),
    cards: Number(match[3]),
  }
}

/**
 * @param {{
 *   toolkitDir: string,
 *   boardId: string | undefined,
 *   execFileImpl: (cmd: string, args: string[], opts: object) => string,
 *   timeoutMs?: number,
 * }} input
 * @returns {
 *   { ran: false, reason: string } |
 *   { ran: true, ok: boolean, findings: number, advisories: number, cards: number, stdout: string }
 * }
 */
export function runLabelIntentLens({ toolkitDir, boardId, execFileImpl, timeoutMs = 20000 }) {
  if (!boardId) return { ran: false, reason: 'no boardId' }

  const tsxBin = locateTsxBinary(toolkitDir)
  if (!tsxBin) return { ran: false, reason: 'toolkit/node_modules/.bin/tsx not found — toolkit not installed or not vendored' }

  const scriptPath = locateLensScript(toolkitDir)
  if (!scriptPath) return { ran: false, reason: 'toolkit/scripts/label-intent-lens.ts not found — toolkit not vendored here' }

  let stdout
  try {
    stdout = execFileImpl(tsxBin, [scriptPath, '--board', boardId], {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    // The script's OWN contract: exit 1 means findings exist, exit 0 means
    // clean — execFileSync throws on any non-zero exit either way, so a
    // thrown error is not by itself a failure to run. Discriminate by
    // whether the captured stdout still parses as the script's own summary
    // line: if it does, this was a legitimate FAIL(exit 1) run, not a crash.
    const out = typeof err?.stdout === 'string' ? err.stdout : ''
    const parsed = parseLensOutput(out)
    if (!parsed) {
      return { ran: false, reason: err instanceof Error ? err.message : String(err) }
    }
    return { ran: true, ok: parsed.findings === 0, ...parsed, stdout: out }
  }

  const parsed = parseLensOutput(stdout)
  if (!parsed) return { ran: false, reason: 'unrecognized label-intent-lens output' }
  return { ran: true, ok: parsed.findings === 0, ...parsed, stdout }
}
