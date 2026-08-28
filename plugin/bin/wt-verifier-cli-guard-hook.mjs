#!/usr/bin/env node
// wt-verifier-cli-guard-hook.mjs — a two-event guard (PreToolUse + PostToolUse), plugin-level,
// SELF-SCOPED to the external cross-family verifier wrappers (opencode-verifier / codex-rescue).
// It is the mechanical fail-fast for the SELF-ANSWER failure mode: a wrapper is a THIN RELAY
// that must shell out to the external CLI (`opencode run` / `codex-companion task`) and
// transcribe its verdict — but it can silently SELF-ANSWER (reason from its own priors and emit
// the verdict tool call) without ever invoking the CLI (sonnet ~37%, codex 16/16 — see the
// provenance gate below). The provenance gate DISQUALIFIES such a vote
// post-hoc, but only AFTER the wrapper has spent its full budget. This hook DENIES the terminal
// verdict tool (`StructuredOutput`) until a REAL external-CLI invocation is proven for this
// wrapper, so a self-answer cannot emit a verdict.
//
// ── HOW IT PROVES "the CLI ran" (fixed 23/07 after probe wf_0b6cfa3f-f7a) ──────────────────
// FIRST DESIGN (transcript-scan only) FALSE-REFUSED at scale in the DELEGATED (Path-B) run: the
// wrapper ran `opencode run` successfully, THEN emitted StructuredOutput — but at the SO
// PreToolUse moment the just-completed Bash `tool_use` line was NOT YET FLUSHED to the
// per-subagent transcript file, so the mid-flight scan saw zero invocations and refused every
// legitimate verdict (0/38 credited → probe VOID). ROOT CAUSE = flush timing (the regex + parser
// are correct — proven: they detect the call in 32/32 of the run's FINAL transcripts; and the
// path is the per-subagent transcript — proven: a shared/parent transcript would false-ALLOW,
// not the observed massive false-DENY). FIX = a flush-immune signal:
//   • PostToolUse (Bash): when a real CLI invocation COMPLETES, write a MARKER FILE keyed by
//     `transcript_path` (a documented hook field, present in BOTH events, and per-subagent in a
//     Path-B run — so it is a safe per-vote key with NO dependence on the undocumented `agent_id`
//     in PostToolUse). PostToolUse fires when the Bash tool finishes — BEFORE the model even
//     generates the SO call — so the marker is guaranteed present at the later SO PreToolUse.
//   • PreToolUse (StructuredOutput): ALLOW if the marker exists (primary, flush-immune) OR the
//     transcript-scan finds a call (secondary, works once the transcript is flushed). DENY only
//     when BOTH are absent — strong evidence of a genuine self-answer (no CLI ever ran).
//
// AGENT-SCOPED, so every OTHER agent (leaf / lean / …) stays effectively BARE — two layers:
//  (1) REGISTRATION is matcher-narrowed (PreToolUse→StructuredOutput, PostToolUse→Bash) in both
//      manifests, so the hook process never spawns on unrelated tool calls.
//  (2) the SCRIPT self-scopes: a StructuredOutput from a NON-wrapper agent returns at the
//      agent-type check (a ~ms silent no-op) and emits its verdict untouched; a PostToolUse Bash
//      writes a marker ONLY for a real external-CLI command (the specific regex is the scope).
//
// Scope (fail-OPEN by construction — it only ever DENIES a narrow, named case):
// - PreToolUse acts ONLY on tool_name === 'StructuredOutput' from an opencode/codex wrapper
//   subagent (agent_id present + agentType matches an external signature). Any uncertainty
//   (no agent_id, wrong agentType, no transcript_path) → ALLOW (silent). It must NEVER
//   blanket-deny: a false-closed deny nulls every vote of a working wrapper (the bug just fixed).
// - PostToolUse acts ONLY on a Bash command that matches an external-CLI signature; it only ever
//   WRITES a marker (never denies/blocks anything) — a no-op on every other command.
//
// Allow path is SILENT exit 0 (no JSON). Deny path = exit 0 + stdout JSON with
// hookSpecificOutput.permissionDecision:"deny". Any internal error is swallowed → exit 0.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { recordGuardEvent } from './lib/guard-journal.mjs'

// The external-CLI delegation signatures — a DELIBERATE byte-identical COPY of
// @workflow-toolbox/patterns' provenance-gate EXTERNAL_CLI_SIGNATURES (itself a copy of the
// shipped @workflow-toolbox/debugger registry). This hook is a plugin .mjs run by bare node
// (no bundler, no TS), so it cannot import the TS registry; a drift-lock test asserts these
// stay byte-identical (id + typeRe + commandRe source/flags, AND the matchesOpencodeRun body) so
// any divergence fails a gate.

// A two-step LINEAR opencode-run matcher — replaces the catastrophic single regex (its BIN= arm
// `[\s\S]*?` backtracked ~30s on a 200KB opencode-but-no-run command) and the 20k scan cap (which
// hid a real `run` past position 20k → the a50c1510/aafb024d false-refuse, measured and
// fixed together). head(20k)+tail(20k) bounds the work AND co-locates
// a `BIN=` in the head with its `"$BIN" run` in the tail; the two-step scan is indexOf-based (no
// `[\s\S]*?` bridge) → O(n). SELF-CONTAINED (helpers inlined) so the provenance checker's scanner
// embeds its source verbatim via `.toString()`. indexOf('opencode')/('BIN=') are case-SENSITIVE
// (the real binary + the wrapper's BIN= are exactly cased); a case-variant is not a real call.
// Residual (documented, never observed): a `run` in the MIDDLE of a command longer than 2*WIN.
// --- wt-drift-lock:matchesOpencodeRun START (byte-identical: debugger+patterns+hook) ---
function matchesOpencodeRun(cmd = '') {
  if (typeof cmd !== 'string' || cmd.length === 0) return false
  const WIN = 20000
  const s = cmd.length <= 2 * WIN ? cmd : cmd.slice(0, WIN) + '\n' + cmd.slice(-WIN)
  const AFTER_QUOTED = /^(?:\.exe|\.cmd)?["']\s+run\b/
  const AFTER_BARE = /^(?:\.exe|\.cmd)?\s+run\b/
  const AFTER_BIN = /^["']?\s+run\b/
  const BEFORE_OK = /[\s;|&(=/'"]/
  for (let i = s.indexOf('opencode'); i !== -1; i = s.indexOf('opencode', i + 1)) {
    const before = i === 0 ? '' : s[i - 1]
    if (before && !BEFORE_OK.test(before)) continue
    const after = s.slice(i + 8, i + 8 + 16)
    // Case A — a real QUOTED invocation: a CLOSING quote right after the opencode token, then run
    // (`"opencode" run`, `"/path/opencode" run`).
    if (AFTER_QUOTED.test(after)) return true
    // Case B — a real UNQUOTED invocation: run right after (no quote), and opencode was NOT opened
    // by a quote — rejects the string arg `"opencode run"` (quote-before pairs with run inside).
    if (before !== '"' && before !== "'" && AFTER_BARE.test(after)) return true
  }
  let hasBinOpencode = false
  for (let i = s.indexOf('BIN='); i !== -1; i = s.indexOf('BIN=', i + 1)) {
    const nl = s.indexOf('\n', i)
    const end = Math.min(nl === -1 ? s.length : nl, i + 4 + 256)
    if (s.slice(i + 4, end).indexOf('opencode') !== -1) {
      hasBinOpencode = true
      break
    }
  }
  if (hasBinOpencode) {
    for (const m of s.matchAll(/\$\{?[A-Za-z_]*BIN\}?/g)) {
      const at = m.index ?? 0
      const tok = m[0] ?? ''
      if (AFTER_BIN.test(s.slice(at + tok.length, at + tok.length + 16))) return true
    }
  }
  return false
}
// --- wt-drift-lock:matchesOpencodeRun END ---

export const EXTERNAL_CLI_SIGNATURES = [
  {
    id: 'opencode',
    typeRe: /opencode/i,
    commandRe:
      /(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?opencode(?:\.exe|\.cmd)?\s+run\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?opencode(?:\.exe|\.cmd)?["']\s+run\b|[A-Za-z_]*BIN=[^\n]*opencode[\s\S]*?"?\$\{?[A-Za-z_]*BIN\}?"?\s+run\b/im,
    matchCommand: matchesOpencodeRun,
  },
  {
    id: 'codex',
    typeRe: /codex/i,
    commandRe:
      /codex-companion\.mjs["']?\s+task\b|(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?codex(?:\.exe)?\s+exec\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?codex(?:\.exe)?["']\s+exec\b/im,
  },
]

// Cap on how much of one Bash command string we scan — parity with the provenance gate's
// SCANNER_COMMAND_SCAN_MAX (a real invocation buried past this is missed; accepted for a
// best-effort early guard, and identical to what the shipped scanner would see).
const COMMAND_SCAN_MAX = 20_000

// Marker files prove a real CLI invocation across the PostToolUse→PreToolUse gap, immune to
// transcript flush timing. Dir is os.tmpdir() (shared by both hook processes of the same
// delegated session), overridable via WT_VERIFIER_MARKER_DIR for isolated tests.
const MARKER_PREFIX = 'wt-verifier-cli-seen-'
const MARKER_TTL_MS = 6 * 60 * 60 * 1000 // opportunistically reap markers older than this
const STREAM_PREFIX = 'wt-opencode-json-stream-'
const STREAM_TTL_MS = 6 * 60 * 60 * 1000

// Per-subagent DENY counter: a sibling file (SAME key family as the
// cli-seen marker — sha1(transcript_path + ':' + agent_id)) holding how many verdicts THIS wrapper
// has had refused with no CLI provenance. At DENY_TERMINAL_AT the refusal becomes TERMINAL (stop
// retrying, return text). After the step-1 matcher fix a real-CLI vote is ALLOWED on its first
// post-run StructuredOutput, so it never accrues a count — the counter only bites a PERSISTENT
// no-CLI self-answer. Cap = 3 (aafb024d recovered on its 3rd attempt; a lower cap would cut
// legitimate short-retry recoveries).
const DENY_COUNTER_PREFIX = 'wt-verifier-denies-'
const DENY_TERMINAL_AT = 3

export function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** The external-CLI signature this agent_type is a wrapper for, or null. Mirrors the gate's
 *  externalGateExpectation: match the (namespace-stripped) agent_type against each typeRe. */
export function signatureForAgentType(agentType) {
  const bare = String(agentType || '').split(':').pop()
  if (!bare) return null
  for (const sig of EXTERNAL_CLI_SIGNATURES) if (sig.typeRe.test(bare)) return sig
  return null
}

/** Route one Bash command to the right matcher for `sig`: opencode's linear self-bounded
 *  `matchCommand` given the FULL command (a pre-cap would drop the tail where a long-heredoc `run`
 *  lives — the a50c1510/aafb024d false-refuse this fix removes); or a direct/linear signature's
 *  capped `commandRe` (codex). */
function matchesCli(command, sig) {
  if (sig.matchCommand) return sig.matchCommand(command)
  const scan = command.length > COMMAND_SCAN_MAX ? command.slice(0, COMMAND_SCAN_MAX) : command
  return sig.commandRe.test(scan)
}

/** The first external-CLI signature whose matcher accepts this Bash command (a REAL invocation),
 *  or null. */
export function signatureForCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return null
  for (const sig of EXTERNAL_CLI_SIGNATURES) if (matchesCli(command, sig)) return sig
  return null
}

/** Count REAL external-CLI invocations in one transcript's Bash tool_use commands (the flushed
 *  fallback signal). Mirrors the provenance gate's scanner (parseTranscriptExternalCalls shape).
 *  Routes each command through `matchesCli(cmd, sig)` — the FULL command for opencode's linear
 *  matcher, so a `run` past 20k in a long heredoc is still counted. */
export function countCliInvocations(transcriptText, sig) {
  let n = 0
  for (const raw of transcriptText.split('\n')) {
    const t = raw.trim()
    if (!t) continue
    let o
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    const m = o && o.message
    if (!m || typeof m !== 'object') continue
    const c = m.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (!b || b.type !== 'tool_use' || b.name !== 'Bash') continue
      const cmd = b.input && b.input.command
      if (typeof cmd !== 'string') continue
      if (matchesCli(cmd, sig)) n++
    }
  }
  return n
}

/** True when `candidate` is (or is an ancestor of) `cwd` — the exact shape of the bug found
 *  2026-07-27 (root-hygiene guard, toolkit/scripts/test/wt-suite-root-hygiene.test.ts): a
 *  process whose `os.tmpdir()` resolved to a PROJECT directory instead of a real system temp
 *  location, so every marker file it wrote landed in the repo/umbrella root instead of /tmp. A
 *  genuine system temp dir is never an ancestor of a project working directory under
 *  ~/projects/…, so this is a safe, platform-agnostic tripwire — no OS-specific path pattern
 *  to keep in sync. */
export function looksLikeProjectDir(candidate, cwd = process.cwd()) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  try {
    if (candidate === cwd) return true
    const withSep = candidate.endsWith(path.sep) ? candidate : candidate + path.sep
    return cwd.startsWith(withSep)
  } catch {
    return false
  }
}

/** `os.tmpdir()`, guarded: if it resolves to (or above) the current working directory — never
 *  a real system temp location — fall back to the OS-conventional temp dir instead of trusting
 *  it blindly. `WT_VERIFIER_MARKER_DIR` (test override) always wins, unchecked. */
export function safeTmpDir() {
  const candidate = os.tmpdir()
  if (looksLikeProjectDir(candidate)) {
    return process.platform === 'win32' ? (process.env['SystemRoot'] ? path.join(process.env['SystemRoot'], 'Temp') : 'C:\\Windows\\Temp') : '/tmp'
  }
  return candidate
}

function markerDir() {
  return process.env['WT_VERIFIER_MARKER_DIR'] || safeTmpDir()
}

/** Deterministic PER-SUBAGENT marker path. Keyed by (transcript_path + agent_id): in Path B
 *  transcript_path is the SHARED delegated-session transcript (re-probe wf: identical for all 66
 *  agents), so transcript_path ALONE would be ONE run-global marker — a sibling's CLI run would
 *  then allow-marker every self-answer (6 leaked in the re-probe). Folding agent_id in makes the
 *  marker per-VOTE (and per-run). Both hook events derive the SAME path for the SAME subagent
 *  (same transcript_path + same agent_id). agent_id is present in both events (re-probe census:
 *  60 distinct agent_ids on marker-writes). */
/** The RUN directory a delegated session's agent transcripts live in, derived from the session's own
 *  transcript path: `…/<session>.jsonl` → `…/<session>/subagents/workflows/<runId>/`.
 *
 *  ⚠ `transcript_path` names the SESSION, never the agent — the doc above `markerPathFor` says so,
 *  and folding `agent_id` into the marker key exists precisely because of it. No hook input carries
 *  a run id (`BaseHookInput` is session_id · transcript_path · cwd · prompt_id? · permission_mode? ·
 *  agent_id?), so the run has to be found on disk.
 *
 *  ⚠⚠ Returns null unless EXACTLY ONE run dir exists. That is not caution for its own sake: it is
 *  only ever one because app.ts's anti-runaway guard aborts a second Workflow launch in one session.
 *  **If that guard is relaxed, this must keep returning null rather than guess** — picking the
 *  newest would write a run's artefacts into another run's directory, silently, since both paths
 *  exist and both are writable. Never sort by mtime here.
 *
 *  Returns null on anything unexpected; the caller treats that as "nothing to write". */
export function runDirForSessionTranscript(transcriptPath, readdir = (d) => fs.readdirSync(d, { withFileTypes: true })) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null
  const sessionDir = transcriptPath.replace(/\.jsonl$/, '')
  const workflowsDir = path.join(sessionDir, 'subagents', 'workflows')
  let entries
  try {
    entries = readdir(workflowsDir)
  } catch {
    return null // no delegated-run layout here — an ordinary session, nothing to do
  }
  const runs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  if (runs.length !== 1) return null // zero, or an ambiguity we refuse to resolve — see above
  return path.join(workflowsDir, runs[0])
}

/** The model an external-CLI command targets, read off the command itself (`--model <x>` or
 *  `--model=<x>`). Returns null when the command names none — the lane's own default then applies
 *  and we must not invent a name for it, because a wrong model label on a cost figure is worse
 *  than an absent one. */
export function modelFromCommand(command) {
  if (typeof command !== 'string') return null
  const m = command.match(/--model[=\s]+["']?([A-Za-z0-9._\-]+\/[A-Za-z0-9._\-]+)["']?/)
  return m === null ? null : (m[1] ?? null)
}

/** The external lane's own token counts and session id, parsed from a `--format json` stream.
 *
 *  ⚠ Returns null when the output is NOT that stream — the ordinary case today, since the command
 *  is written by whoever authored the workflow. A null here means "not measured" and must travel
 *  as such: a zero would render as a measurement, which is the exact failure the cost-split card
 *  names (a lane whose cost cannot be read shows a labelled unknown, never a zero).
 *
 *  ⚠ The LAST tokens object wins: the stream reports cumulative usage as it goes, so an earlier
 *  line carries a partial count. Taking the first would under-report, silently and plausibly. */
export function laneUsageFromOutput(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  let tokens = null
  let sessionId = null
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.length === 0 || t[0] !== '{') continue
    let parsed
    try {
      parsed = JSON.parse(t)
    } catch {
      continue // a non-JSON line in a JSON stream is not an error worth failing a run over
    }
    const found = findUsage(parsed)
    if (found.tokens !== null) tokens = found.tokens
    if (found.sessionId !== null) sessionId = found.sessionId
  }
  if (tokens === null && sessionId === null) return null
  return { tokens, sessionId }
}

/** The model's ACTUAL ANSWER, pulled out of a `--format json` event stream.
 *
 *  ⚠ Without this the transcript of an external call is the raw stream — every `step_start`,
 *  `step_finish`, every id and timestamp — so a reader opening that node meets a wall of JSON
 *  instead of what the model said. The tokens are the reason the command asks for JSON; the answer
 *  is the reason a human opens the transcript. Both have to survive.
 *
 *  Returns null when the output is not that stream (an ordinary text call) or carries no text part
 *  at all — the caller then keeps the raw output, because dropping it would trade a noisy
 *  transcript for an empty one. */
export function laneTextFromOutput(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const parts = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.length === 0 || t[0] !== '{') continue
    let parsed
    try {
      parsed = JSON.parse(t)
    } catch {
      continue
    }
    const part = parsed?.part
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      parts.push(part.text)
    }
  }
  return parts.length === 0 ? null : parts.join('\n')
}

export function observeStateRootForEnv(env = process.env, home = os.homedir(), platform = process.platform) {
  const xdg = typeof env['XDG_STATE_HOME'] === 'string' && env['XDG_STATE_HOME'].length > 0 ? env['XDG_STATE_HOME'] : null
  const base =
    xdg !== null
      ? xdg
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : platform === 'win32'
          ? (typeof env['LOCALAPPDATA'] === 'string' && env['LOCALAPPDATA'].length > 0
              ? env['LOCALAPPDATA']
              : path.join(home, 'AppData', 'Local'))
          : path.join(home, '.local', 'state')
  return path.join(base, 'wt-observe')
}

export function verifierStreamDirForEnv(env = process.env, home = os.homedir(), platform = process.platform) {
  return path.join(observeStateRootForEnv(env, home, platform), 'external-lane-streams')
}

function stripQuoted(value) {
  if (typeof value !== 'string' || value.length < 2) return value
  const q = value[0]
  if ((q === '"' || q === "'") && value[value.length - 1] === q) return value.slice(1, -1)
  return value
}

function shellValueFor(name, assignments, depth = 0) {
  if (depth > 8) return null
  const raw = assignments.get(name)
  if (typeof raw !== 'string' || raw.length === 0) return null
  const home = os.homedir()
  const value = stripQuoted(raw)
  return value
    .replace(/\$HOME\b/g, home)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)\b/g, (_, ref) => shellValueFor(ref, assignments, depth + 1) ?? process.env[ref] ?? '')
}

export function streamFilePathFromCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return null
  const assignments = new Map()
  for (const m of command.matchAll(/(?:^|\n)([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
    assignments.set(m[1], m[2])
  }
  const redirect = command.match(/>\s*"\$STREAMFILE"(?:\s|$)/)
  if (redirect === null) return null
  const streamFile = shellValueFor('STREAMFILE', assignments)
  return typeof streamFile === 'string' && path.isAbsolute(streamFile) ? streamFile : null
}

/** Walk a parsed line for the two fields worth having. Shallow-recursive by design: the stream
 *  nests them under varying parents and pinning a path would break on the next CLI version. */
function findUsage(node, depth = 0) {
  const out = { tokens: null, sessionId: null }
  if (node === null || typeof node !== 'object' || depth > 6) return out
  for (const [key, value] of Object.entries(node)) {
    if (key === 'tokens' && value !== null && typeof value === 'object' && typeof value.input === 'number') {
      out.tokens = {
        input: value.input ?? 0,
        output: value.output ?? 0,
        reasoning: value.reasoning ?? 0,
        cacheRead: value.cache?.read ?? 0,
        cacheWrite: value.cache?.write ?? 0,
      }
    } else if (key === 'sessionID' && typeof value === 'string' && value.length > 0) {
      out.sessionId = value
    } else if (value !== null && typeof value === 'object') {
      const deeper = findUsage(value, depth + 1)
      if (deeper.tokens !== null) out.tokens = deeper.tokens
      if (deeper.sessionId !== null) out.sessionId = deeper.sessionId
    }
  }
  return out
}

/** The text a Bash tool_response carries, whatever shape the harness used. `tool_response` is typed
 *  `unknown` in the SDK, so every shape is narrowed rather than assumed: a bare string, or an object
 *  with stdout (the observed shape), or neither — in which case there is nothing to write and the
 *  caller skips rather than writing an empty transcript that would render as a silent node. */
export function bashOutputText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse
  if (toolResponse !== null && typeof toolResponse === 'object') {
    const out = toolResponse.stdout
    if (typeof out === 'string') return out
    const content = toolResponse.content
    if (typeof content === 'string') return content
  }
  return ''
}

export function writeLaneArtefacts({
  runDir,
  laneId,
  askedContent,
  answerContent,
  rawStreamText = null,
  sig,
  parentAgentId,
  model = null,
  durationMs,
  usage = null,
  status = 'answer',
  phaseIndex = null,
}) {
  // The call's own two turns are NOT simultaneous, but writeLaneArtefacts only ever runs once,
  // at PostToolUse — after the call has already finished. There is no observed absolute START
  // instant on disk anywhere (the manifest carries a DURATION per task, never a start timestamp),
  // so the write-time instant is the only real anchor available, and it is anchored as the
  // FINISH: `durationMs`, when present, is subtracted from it to place the ask strictly before
  // the answer. Without a usable `durationMs` there is nothing truthful to subtract — asserting a
  // spread would be inventing a number nobody measured — so a minimal 1ms floor is used instead,
  // just enough to keep the ask ordered before the answer (the one fact that is always true of a
  // question and its own reply) without asserting any particular elapsed time.
  const finishedAt = new Date()
  const askOffsetMs = typeof durationMs === 'number' && durationMs > 0 ? durationMs : 1
  const askedAt = new Date(finishedAt.getTime() - askOffsetMs).toISOString()
  const at = finishedAt.toISOString()
  const askedLine = JSON.stringify({
    type: 'user',
    timestamp: askedAt,
    message: { role: 'user', content: askedContent },
    uuid: crypto.randomUUID(),
    agentId: laneId,
    isSidechain: true,
  })
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: { role: 'assistant', content: answerContent },
    uuid: crypto.randomUUID(),
    agentId: laneId,
    isSidechain: true,
  })
  fs.appendFileSync(path.join(runDir, `agent-${laneId}.jsonl`), `${askedLine}\n${line}\n`, 'utf8')

  if (typeof rawStreamText === 'string' && laneTextFromOutput(rawStreamText) !== null) {
    fs.writeFileSync(path.join(runDir, `agent-${laneId}.opencode.jsonl`), rawStreamText.endsWith('\n') ? rawStreamText : `${rawStreamText}\n`, 'utf8')
  }

  const meta = {
    agentType: `scripted:${sig}`,
    description:
      status === 'error'
        ? `call FAILED — ${String(answerContent).split('\n')[0]?.slice(0, 160) ?? 'no message'}`
        : model === null
          ? `external CLI call by ${parentAgentId}`
          : `${model} — called by ${parentAgentId}`,
    parentAgentId,
    lane: sig,
  }
  if (status === 'error') meta.status = 'error'
  if (model !== null) meta.model = model
  if (typeof phaseIndex === 'number') meta.phaseIndex = phaseIndex
  if (typeof durationMs === 'number') meta.durationMs = durationMs
  if (usage !== null && usage.tokens !== null) meta.laneTokens = usage.tokens
  if (usage !== null && usage.sessionId !== null) meta.laneSessionId = usage.sessionId

  fs.writeFileSync(path.join(runDir, `agent-${laneId}.meta.json`), JSON.stringify(meta), 'utf8')
}

export function markerPathFor(transcriptPath, agentId) {
  const key = crypto
    .createHash('sha1')
    .update(`${String(transcriptPath)}:${String(agentId)}`)
    .digest('hex')
    .slice(0, 40)
  return path.join(markerDir(), MARKER_PREFIX + key)
}

/** Per-subagent deny-counter path — SAME per-vote key as markerPathFor, different prefix, so a
 *  wrapper's deny count and its cli-seen marker live side by side and never collide with a
 *  sibling's. */
export function denyCounterPathFor(transcriptPath, agentId) {
  const key = crypto
    .createHash('sha1')
    .update(`${String(transcriptPath)}:${String(agentId)}`)
    .digest('hex')
    .slice(0, 40)
  return path.join(markerDir(), DENY_COUNTER_PREFIX + key)
}

/** Opportunistic cleanup so markers don't accumulate forever (best-effort, never throws). */
function reapOldMarkers() {
  try {
    const dir = markerDir()
    const now = Date.now()
    for (const f of fs.readdirSync(dir)) {
      if (f.indexOf(MARKER_PREFIX) !== 0 && f.indexOf(DENY_COUNTER_PREFIX) !== 0) continue
      const fp = path.join(dir, f)
      try {
        if (now - fs.statSync(fp).mtimeMs > MARKER_TTL_MS) fs.rmSync(fp, { force: true })
      } catch {
        /* ignore a single unstattable/unremovable marker */
      }
    }
  } catch {
    /* dir unreadable ⇒ skip cleanup */
  }
}

function reapOldStreamFiles() {
  try {
    const dir = verifierStreamDirForEnv()
    const now = Date.now()
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(STREAM_PREFIX)) continue
      const fp = path.join(dir, f)
      try {
        if (now - fs.statSync(fp).mtimeMs > STREAM_TTL_MS) fs.rmSync(fp, { force: true })
      } catch {
        /* ignore one stale/unremovable stream */
      }
    }
  } catch {
    /* dir unreadable ⇒ skip cleanup */
  }
}

/** DEBUG-ONLY instrumentation (gated by `WT_VERIFIER_DEBUG=<logfile>`) — appends one JSON line per
 *  decision (marker-written / allow-marker / allow-scan / deny / deny-terminal / deny-no-agentid).
 *  `transcript` is the EXACT `transcript_path` the hook received, UNTRUNCATED, at BOTH events — the
 *  evidence that grounds the checker's marker-key reconstruction (step-3 follow-up). `extra` carries
 *  the event-specific fields (`matcher_hit` on a write, `deny_count`/`terminal` on a deny). PURE
 *  side-effect: never reads a return value, never alters a decision. Absent env ⇒ immediate no-op,
 *  so a shipped provenance guard writes NOTHING in normal operation. */
function dbg(event, input, decision, extra = {}) {
  const p = process.env['WT_VERIFIER_DEBUG']
  if (!p) return
  try {
    const tp = String((input && input.transcript_path) || '')
    const aid = (input && input.agent_id) || ''
    let transcriptLen = -1
    try {
      if (tp) transcriptLen = fs.statSync(tp).size
    } catch {
      /* transcript not yet on disk ⇒ -1 */
    }
    fs.appendFileSync(
      p,
      JSON.stringify({
        ts: Date.now(),
        event,
        decision,
        agent_type: (input && input.agent_type) || null,
        agent_id: aid || null,
        transcript: tp,
        transcriptLen,
        markerPath: tp && aid ? markerPathFor(tp, aid) : null,
        ...extra,
      }) + '\n',
    )
  } catch {
    /* debug logging must NEVER affect the hook */
  }
}

/** DEBUG-ONLY: which arm of the opencode matcher would hit — 'head' | 'tail' | 'indirect-BIN' | null
 *  — purely to annotate the WT_VERIFIER_DEBUG log. A read-only MIRROR of matchesOpencodeRun that
 *  NEVER feeds a decision (the guard always calls the drift-locked matchesOpencodeRun). Kept in sync
 *  by hand: if the matcher's arms change, update this label helper. */
function matcherHitArm(command) {
  if (typeof command !== 'string' || command.length === 0) return null
  const WIN = 20000
  const windowed = command.length > 2 * WIN
  const s = windowed ? command.slice(0, WIN) + '\n' + command.slice(-WIN) : command
  const headEnd = windowed ? WIN : s.length
  const AFTER_QUOTED = /^(?:\.exe|\.cmd)?["']\s+run\b/
  const AFTER_BARE = /^(?:\.exe|\.cmd)?\s+run\b/
  const BEFORE_OK = /[\s;|&(=/'"]/
  for (let i = s.indexOf('opencode'); i !== -1; i = s.indexOf('opencode', i + 1)) {
    const before = i === 0 ? '' : s[i - 1]
    if (before && !BEFORE_OK.test(before)) continue
    const after = s.slice(i + 8, i + 8 + 16)
    if (AFTER_QUOTED.test(after) || (before !== '"' && before !== "'" && AFTER_BARE.test(after))) {
      return i < headEnd ? 'head' : 'tail'
    }
  }
  let hasBinOpencode = false
  for (let i = s.indexOf('BIN='); i !== -1; i = s.indexOf('BIN=', i + 1)) {
    const nl = s.indexOf('\n', i)
    const end = Math.min(nl === -1 ? s.length : nl, i + 4 + 256)
    if (s.slice(i + 4, end).indexOf('opencode') !== -1) {
      hasBinOpencode = true
      break
    }
  }
  if (hasBinOpencode) {
    for (const m of s.matchAll(/\$\{?[A-Za-z_]*BIN\}?/g)) {
      const at = m.index ?? 0
      const tok = m[0] ?? ''
      if (/^["']?\s+run\b/.test(s.slice(at + tok.length, at + tok.length + 16))) return 'indirect-BIN'
    }
  }
  return null
}

export function handlePostToolUse(input, writeMarker = (p) => fs.writeFileSync(p, String(Date.now()))) {
  if (input.tool_name !== 'Bash') return
  const command = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : ''
  const sig = signatureForCommand(command)
  if (sig === null) return // not a real external-CLI invocation
  // If agent_type IS present, only a wrapper marks (avoid stray markers); if absent (undocumented
  // in PostToolUse), the specific command regex above is the scope. Any wrapper agentType
  // containing "opencode" passes this same check, which is deliberate.
  if (input.agent_type !== undefined && signatureForAgentType(input.agent_type) === null) return
  const transcriptPath = input.transcript_path
  const agentId = input.agent_id
  // Need BOTH transcript_path AND agent_id to form the PER-SUBAGENT key. Without agent_id a marker
  // would be run-global (the re-probe bleed) — so skip writing rather than write an unkeyed marker
  // that a sibling self-answer could ride.
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return
  if (!agentId) return

  try {
    writeMarker(markerPathFor(transcriptPath, agentId))
    dbg('PostToolUse', input, 'marker-written', { matcher_hit: sig.id === 'opencode' ? matcherHitArm(command) : null })
  } catch {
    /* best-effort: a marker we couldn't write just falls back to the transcript scan */
  }

  // Make a WORKFLOW's lane call VISIBLE. Until now an `opencode run`
  // made by the wrapper agent left nothing on disk, so the observatory had nothing to draw: a
  // workflow surfaced its Claude agents (from the run journal) and never its external work.
  //
  // This is the only place that sees the call: hooks are PER SESSION, so neither the launcher's
  // hooks nor anything outside observes a workflow agent's tool calls — measured, both zero. A
  // plugin hook does, because it is loaded INTO the delegated session. That is why this lives here
  // and not in the server.
  //
  // ⚠ Writes the two files a node is built from, and nothing else — no journal entry. A journal is
  // the harness's artefact; producing one here would put a second writer on a file we do not own,
  // and the next reader could not tell which entries were real.
  //
  // ⚠ TRANSCRIPT ONLY, no tokens: the wrapper's command omits `--format json`, so its output
  // carries no per-step totals. Adding them is a separate decision with an unsolved attribution
  // question — writing a zero here would be worse than writing nothing, because a zero renders.
  //
  // ⚠⚠ A DERIVED id (`<agentId>-lane`), never `agentId` itself — measured, run wf_aa4fb03d-e90:
  // the harness writes the CALLING AGENT's own transcript and meta at `agent-<agentId>.*` in this
  // very directory. Writing there does two silent damages at once: `writeFileSync` TRUNCATES, so
  // the agent's own turns are destroyed, and the meta overwrite RELABELS the agent's node as the
  // external one. The point is a SECOND node beside the agent's, never a node replacing it.
  //
  // ⚠ ONE NODE PER CALL, keyed by `tool_use_id`. A single agent making N external calls is the
  // shape that makes batching worth anything (the ~27k system-prompt cost is paid per AGENT, not
  // per call) — but only if each call still renders as its OWN node. A single accumulating node
  // holding N transcripts is precisely what a reader cannot use.
  //
  // ⚠⚠ Keyed by id, never by a COUNTER over existing files. The calls of one batch are issued in a
  // single message and therefore complete CONCURRENTLY: two hook processes counting the same
  // directory at the same instant both see the same number and pick the same index, so one node
  // silently absorbs the other. `tool_use_id` is unique per call and needs no coordination.
  //
  // ⚠ APPEND, not write: cheap insurance if the same call is ever reported twice. The meta is a
  // constant, so rewriting it is harmless.
  try {
    const runDir = runDirForSessionTranscript(transcriptPath)
    const streamPath = streamFilePathFromCommand(command)
    let text = bashOutputText(input.tool_response)
    if (streamPath !== null) {
      try {
        const streamed = fs.readFileSync(streamPath, 'utf8')
        if (streamed.length > 0) text = streamed
      } catch {
        /* fall back to the tool response text */
      }
      try {
        fs.unlinkSync(streamPath)
      } catch {
        /* best-effort cleanup: the age sweep below is the backstop */
      }
    }
    if (runDir !== null && text.length > 0) {
      const callKey =
        typeof input.tool_use_id === 'string' && input.tool_use_id.length > 0
          ? crypto.createHash('sha1').update(input.tool_use_id).digest('hex').slice(0, 6)
          : null
      const laneId = callKey === null ? `${agentId}-lane` : `${agentId}-lane-${callKey}`
      // What a HUMAN opens this node to read: the model's answer, not the transport. A
      // `--format json` call (the one that carries the tokens) would otherwise leave a stream of
      // step markers and ids here. Falls back to the raw output when nothing text-shaped is in it,
      // because an empty transcript is worse than a noisy one.
      const usage = laneUsageFromOutput(text)
      const model = modelFromCommand(command)
      const content = laneTextFromOutput(text) ?? text
      writeLaneArtefacts({
        runDir,
        laneId,
        askedContent: command,
        answerContent: content,
        rawStreamText: text,
        sig: sig.id,
        parentAgentId: agentId,
        model,
        durationMs: input.duration_ms,
        usage,
      })
      dbg('PostToolUse', input, 'lane-artefacts-written', {
        runDir,
        laneId,
        chars: text.length,
        model,
        measuredTokens: usage !== null && usage.tokens !== null,
      })
    }
  } catch {
    /* best-effort, exactly like the marker above: a run must never fail because a hook could not
       write an observability artefact. */
  }

  reapOldMarkers()
  reapOldStreamFiles()
}

/** The refusal reason for one wrapper signature. */
function denyReason(sig) {
  return (
    `[workflow-toolbox verifier CLI guard] Refused to emit a verdict: no real ${sig.id} CLI ` +
    `invocation is proven for this verifier yet. You are a RELAY — you must actually run the ` +
    `${sig.id} CLI (e.g. \`${sig.id} run …\`) and transcribe ITS output, never answer from your ` +
    `own knowledge. Invoke the CLI now, then emit the verdict from its result; if the CLI is ` +
    `unavailable or failed, return its OPENCODE_UNAVAILABLE / error text verbatim (text mode) ` +
    `instead of a fabricated verdict.`
  )
}

/** Nudge appended to a non-terminal deny (denies 1..N-1): the model often just finished the CLI
 *  and needs to re-emit its verdict rather than re-run. */
function retryHintLine(sig) {
  return ` If your ${sig.id} CLI just finished, re-emit StructuredOutput now — its result is what unblocks you.`
}

/** The TERMINAL refusal at DENY_TERMINAL_AT: stop retrying, return the CLI's own output as TEXT. A
 *  PreToolUse deny is technically retryable by the model, so this is a strong MESSAGE (the ratified
 *  mechanism (i)); the retry loop is bounded by maxTurns regardless. */
function terminalDenyReason(sig, count) {
  return (
    `[workflow-toolbox verifier CLI guard] TERMINAL (refused ${count}×): no real ${sig.id} CLI ` +
    `invocation has EVER been proven for this verifier. STOP retrying — further StructuredOutput ` +
    `calls will keep being refused. Return your FINAL answer as TEXT now: the ${sig.id} CLI's ` +
    `OPENCODE_UNAVAILABLE / error output verbatim if it failed or is unavailable, otherwise state ` +
    `plainly that you could not run it. Do NOT emit a verdict from your own knowledge.`
  )
}

/** Count THIS deny per-subagent and escalate to a TERMINAL refusal at the cap. Pure over injected
 *  fs so unit tests can drive it; the child-process tests exercise the real files. Without a
 *  per-vote key (no transcript_path / agent_id, or a non-wrapper agent_type) it cannot count and
 *  returns the base reason unchanged — still a deny, just no escalation. */
export function escalateDeny(
  input,
  baseReason,
  readCount = (p) => fs.readFileSync(p, 'utf8'),
  writeCount = (p, v) => fs.writeFileSync(p, v),
) {
  const sig = signatureForAgentType(input.agent_type)
  const transcriptPath = input.transcript_path
  const agentId = input.agent_id
  if (sig === null || typeof transcriptPath !== 'string' || transcriptPath.length === 0 || !agentId) {
    dbg('PreToolUse', input, 'deny-no-agentid', { deny_count: null, terminal: false })
    return baseReason
  }
  const counterPath = denyCounterPathFor(transcriptPath, agentId)
  let count = 0
  try {
    const n = parseInt(readCount(counterPath), 10)
    if (Number.isFinite(n) && n > 0) count = n
  } catch {
    /* no prior count on disk */
  }
  count += 1
  try {
    writeCount(counterPath, String(count))
  } catch {
    /* best-effort: a count we couldn't persist just doesn't escalate */
  }
  const terminal = count >= DENY_TERMINAL_AT
  dbg('PreToolUse', input, terminal ? 'deny-terminal' : 'deny', { deny_count: count, terminal })
  return terminal ? terminalDenyReason(sig, count) : baseReason + retryHintLine(sig)
}

/** PreToolUse decision on a StructuredOutput call: deny-reason string, or null to ALLOW.
 *  Order matters (fixed after the re-probe bleed): the WRAPPER-SIG check is FIRST so a non-wrapper
 *  agent (leaf/lean, or the main session with no agent_type) is never guarded; then, for a wrapper,
 *  a missing per-vote key must NEVER widen allow — an external wrapper with no agent_id is
 *  DENIED (fail-CLOSED), because the marker is keyed per-subagent by agent_id and a shared/absent
 *  key would let a self-answer ride a sibling's CLI run. Otherwise ALLOW on the flush-immune
 *  per-subagent marker (primary) OR the flushed transcript scan (secondary); DENY when both absent. */
export function decidePreToolUse(
  input,
  readTranscript = (p) => fs.readFileSync(p, 'utf8'),
  markerExists = (p) => fs.existsSync(p),
) {
  if (input.tool_name !== 'StructuredOutput') return null
  // Wrapper-sig FIRST: a non-wrapper agent (leaf/lean, or the main session which carries no
  // agent_type) is NEVER guarded — its verdict passes untouched.
  const sig = signatureForAgentType(input.agent_type)
  if (sig === null) return null
  // It IS an external verifier wrapper. A missing agent_id means no per-subagent key can be formed,
  // and a shared/absent key would let a self-answer ride a sibling's marker (the re-probe bleed) →
  // FAIL-CLOSED. (agent_id is present in both hook events in practice — re-probe census: 60 distinct.)
  const agentId = input.agent_id
  if (!agentId) return denyReason(sig)
  const transcriptPath = input.transcript_path
  // No transcript_path ⇒ no key AND no scan possible. transcript_path is THE core hook field and is
  // always present in practice; fail-OPEN here (rather than deny) so a hypothetical missing field
  // never reincarnates the round-1 catastrophic deny-ALL. (agent_id, the undocumented field, is the
  // one that fails CLOSED above.)
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null
  // PRIMARY: flush-immune PER-SUBAGENT marker written by THIS subagent's own CLI PostToolUse.
  try {
    if (markerExists(markerPathFor(transcriptPath, agentId))) {
      dbg('PreToolUse', input, 'allow-marker')
      return null // real CLI proven ⇒ allow
    }
  } catch {
    /* marker check failed ⇒ fall through to the transcript scan */
  }
  // SECONDARY: the transcript scan (works once the CLI Bash line is flushed). In Path B this reads
  // the SHARED delegated-session transcript, which carries 0 opencode calls (the calls live in
  // per-subagent files) — so it CANNOT false-allow there; in an interactive spawn transcript_path
  // is the agent's own transcript, where it is per-agent-correct.
  let text
  try {
    text = readTranscript(transcriptPath)
  } catch {
    return null // unreadable ⇒ fail-OPEN
  }
  if (typeof text === 'string' && text.length > 0 && countCliInvocations(text, sig) > 0) {
    dbg('PreToolUse', input, 'allow-scan')
    return null // real CLI seen in the (flushed) transcript ⇒ allow
  }
  // Neither signal present: a verdict with NO real CLI invocation = a self-answer.
  return denyReason(sig)
}

/** Back-compat alias: the PreToolUse decision. */
export const decide = decidePreToolUse

export function run() {
  const input = readInput()
  if (input.hook_event_name === 'PostToolUse') {
    handlePostToolUse(input) // records provenance; never emits a decision
    return
  }
  const reason = decidePreToolUse(input)
  if (!reason) return // allow: SILENT exit 0, so normal permission flow is untouched
  // A deny was decided → count it per-subagent and escalate to a TERMINAL refusal at the cap.
  const finalReason = escalateDeny(input, reason)
  recordGuardEvent({
    guard: 'wt-verifier-cli-guard-hook.mjs',
    decision: 'blocked',
    reason: finalReason,
  })
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: finalReason,
      },
    }),
  )
}

// Entry-guard: run only when invoked directly as a hook, so the module is importable by the
// drift-lock / decision unit tests without executing (and blocking on) stdin.
const invokedPath = process.argv[1]
const isEntry = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href
if (isEntry) {
  try {
    run()
  } catch {
    // Never block a tool call because the guard itself hit a bug: emit nothing, exit 0.
  }
}
