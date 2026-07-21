// provenance-gate.ts — provenance-gating for EXTERNAL-routed adversarialVerification votes.
//
// THE PROBLEM (card #1823504956762621933, lived 2026-07-21 run wf_3fd19c91-273): when a
// verifier is routed to an external-model agentType (a Claude HOST that must shell out to
// `opencode`/`codex`), the wrapper can silently SELF-ANSWER — read the sources and emit a
// verdict itself, never invoking the CLI — and the output is a valid {verdict,reason} object
// indistinguishable from a real external verdict. A same-family weak vote is then credited as
// a decorrelated external vote (false "confirmed" on stale docs). The entry availability probe
// cannot catch this (it proves the route CAN work, not that each call TOOK it).
//
// THE FIX (this module): after the vote burst, a cheap CHECKER agent reads each external
// vote's on-disk transcript and reports whether a REAL external-CLI invocation is present.
// A vote with no provenance is DISQUALIFIED (nullified → the existing unverifiable/salvage
// path), never credited. The gate arms ONLY when the verifier was routed to a REGISTERED
// external agentType — a plain Claude verifier is NEVER gated.
//
// WHY A CHECKER AGENT (the seam): a workflow script runs in a sandbox with NO filesystem
// access, and the runtime exposes NO per-agent transcript/provenance metadata
// (WorkflowRuntime is agent/parallel/pipeline/phase/log/budget/workflow — grounded in
// runtime/src/types.ts). The only actor that can read a sibling agent's transcript is
// another spawned agent. The checker is a PLAIN subagent (no agentType) so it resolves in
// Path B server-launched runs, where plugin-registered agent types do not load.
//
// SINGLE SOURCE OF TRUTH for the CLI signature: the checker's scanner reuses the SHIPPED
// `DelegationExpectation.commandRe` from @workflow-toolbox/debugger/external-delegation
// VERBATIM (via .source/.flags) — the same regex the observe-ui provenance panel and the
// post-hoc audit report consume. The scanner's transcript-parsing mirrors
// parseTranscriptExternalCalls; a fixture drift-lock test asserts the two agree on real
// transcript shapes, so any divergence fails a gate.
//
// Sandbox contract: this module is bundled INTO the workflow artifact, so it stays pure —
// the scanner SOURCE it builds is a STRING (data handed to the checker agent), never executed
// in the sandbox. `expectationForAgentType` is pure (regex + array), safe to bundle.

import type { WorkflowRuntime, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'

// One external-CLI delegation signature — same shape as
// @workflow-toolbox/debugger/external-delegation's DelegationExpectation.
export interface DelegationExpectation {
  /** Stable id, also the display name of the external CLI (e.g. "opencode"). */
  id: string
  /** Matches agentType names routed to this CLI. */
  typeRe: RegExp
  /** Matches a REAL invocation inside one Bash command string (multiline-safe). */
  commandRe: RegExp
}

// The external-CLI signature registry. This is a DELIBERATE byte-identical COPY of
// @workflow-toolbox/debugger/external-delegation's DELEGATION_EXPECTATIONS: `patterns` is a
// PUBLISHED package and `debugger` is PRIVATE, so patterns cannot depend on it at runtime.
// A drift-lock test (test/provenance-gate-drift.test.ts, devDep on debugger) asserts these
// entries stay byte-identical (id + typeRe + commandRe source/flags) to the shipped registry,
// so any divergence fails a gate. Root fix (out of scope for this card): hoist the registry
// into a PUBLISHED shared package (@workflow-toolbox/std) that patterns, debugger, and the
// cross-repo observe-ui panel all import — tracked as a follow-up.
export const EXTERNAL_CLI_SIGNATURES: readonly DelegationExpectation[] = [
  {
    id: 'opencode',
    typeRe: /opencode/i,
    commandRe:
      /(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?opencode(?:\.exe|\.cmd)?\s+run\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?opencode(?:\.exe|\.cmd)?["']\s+run\b|[A-Za-z_]*BIN=[^\n]*opencode[\s\S]*?"?\$\{?[A-Za-z_]*BIN\}?"?\s+run\b/im,
  },
  {
    id: 'codex',
    typeRe: /codex/i,
    commandRe:
      /codex-companion\.mjs["']?\s+task\b|(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?codex(?:\.exe)?\s+exec\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?codex(?:\.exe)?["']\s+exec\b/im,
  },
]

/** Label suffix for the provenance checker's own agent call — deliberately NOT under the
 *  `:verify:` prefix so a caller filtering real verifier calls by
 *  `startsWith('adversarialVerification:verify:')` never sweeps it in (same posture as the
 *  `:warm` cache-warm call). */
export const PROVENANCE_CHECK_SUFFIX = 'provenance-check'

/** Cap on how much of one Bash command string the scanner regex scans — parity with
 *  external-delegation.ts's COMMAND_SCAN_MAX (a real invocation buried past this is missed;
 *  accepted for a report-only signal, and identical to what the shipped scanner would see). */
const SCANNER_COMMAND_SCAN_MAX = 20_000

/** Recency window (ms) the scanner uses to bound its transcript-dir search — the vote and
 *  checker transcripts are all seconds old. Wide enough for a slow burst, narrow enough to
 *  keep the readdir walk cheap. */
const SCANNER_RECENCY_MS = 30 * 60 * 1000

/** Derive a DETERMINISTIC anchor nonce from the (salted) vote labels AND the rendered claim
 *  content. Deterministic is REQUIRED, not merely sandbox-forced: a random nonce would change
 *  the checker prompt every run and defeat the Workflow resume cache (labels and claim content
 *  are both stable across resumes). The salted labels make the nonce unique per invocation
 *  within a run; folding the claim content makes two runs with the same vote SHAPE but
 *  different claims differ too. A 32-bit FNV-1a hash is plenty to make the string improbable
 *  in an unrelated transcript.
 *
 *  RESIDUAL (cross-family review 2026-07-21, MED — a known LIMIT, not a fixable bug): two
 *  CONCURRENT runs with byte-identical claims AND vote shape would still share a nonce. A
 *  fully run-unique nonce is INFEASIBLE here — the sandbox runtime exposes no run identifier
 *  (WorkflowRuntime is agent/parallel/pipeline/phase/log/budget/workflow). Bounded by: (a) the
 *  scanner anchors on the NEWEST-mtime transcript carrying the nonce, favoring the live
 *  checker; (b) the "one external run at a time" operating discipline; (c) the collision needs
 *  two identical concurrent audits. Real fix (follow-up): a run-scoped token from the runtime. */
export function deriveProvenanceNonce(labels: readonly string[], claimSeed = ''): string {
  let h = 0x811c9dc5
  const seed = `${labels.join(' ')}${claimSeed}`
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `wtprov-${(h >>> 0).toString(16).padStart(8, '0')}`
}

/** Resolve the external CLI expectation a verifierType is routed to, or null when the gate
 *  must NOT arm: verifierType is undefined (plain Claude verifier) OR is a registered type
 *  with no external-CLI signature (e.g. a specialist Claude reviewer). This reuses the
 *  shipped registry so "is this external, and which CLI" has ONE source of truth. */
export function externalGateExpectation(verifierType: string | undefined): DelegationExpectation | null {
  if (verifierType === undefined) return null
  for (const sig of EXTERNAL_CLI_SIGNATURES) if (sig.typeRe.test(verifierType)) return sig
  return null
}

/** Build the self-contained CommonJS scanner the checker agent runs. It:
 *   1. anchors on `nonce` (present in the checker's own prompt) to find THIS run's transcript
 *      dir among recent `subagents/workflows/<runId>/` dirs — no dependence on knowing the
 *      config dir / slug / session / runId;
 *   2. for each target label, finds the sibling vote transcript carrying that wt-meta label
 *      and counts REAL external-CLI Bash `tool_use` invocations with the SHIPPED regex;
 *   3. prints one JSON line: {"anchored":bool,"results":[{"label","cliSeen"}]}.
 *  The regex is interpolated from `expectation.commandRe` verbatim — no second copy. The
 *  transcript-parse mirrors parseTranscriptExternalCalls (drift-locked by fixture test). */
export function buildProvenanceScannerSource(
  expectation: DelegationExpectation,
  nonce: string,
  labels: readonly string[],
): string {
  // JSON.stringify is the ONLY escaping needed — nonce/labels are safe-charset pattern
  // strings and the regex source is embedded as a JS string literal reconstructed with
  // new RegExp(...). Available in the checker's plain Node runtime.
  const reSource = JSON.stringify(expectation.commandRe.source)
  const reFlags = JSON.stringify(expectation.commandRe.flags)
  const nonceLit = JSON.stringify(nonce)
  const labelsLit = JSON.stringify(labels)
  return [
    `'use strict';`,
    `const fs=require('fs'),path=require('path'),os=require('os');`,
    `const NONCE=${nonceLit},LABELS=${labelsLit};`,
    `const RE=new RegExp(${reSource},${reFlags});`,
    `const SCAN_MAX=${SCANNER_COMMAND_SCAN_MAX},RECENCY=${SCANNER_RECENCY_MS},now=Date.now();`,
    // Candidate config roots: the running session's CLAUDE_CONFIG_DIR plus the standard pair.
    `const roots=[process.env.CLAUDE_CONFIG_DIR,path.join(os.homedir(),'.claude'),path.join(os.homedir(),'.claude-work')].filter(Boolean);`,
    `function ls(d){try{return fs.readdirSync(d)}catch(e){return[]}}`,
    // Enumerate recent agent-*.jsonl under */projects/*/*/subagents/workflows/*/.
    `function transcripts(){const out=[];for(const r of roots){const pj=path.join(r,'projects');for(const slug of ls(pj)){const sd=path.join(pj,slug);for(const sess of ls(sd)){const wf=path.join(sd,sess,'subagents','workflows');for(const run of ls(wf)){const rd=path.join(wf,run);for(const f of ls(rd)){if(f.indexOf('agent-')!==0||!f.endsWith('.jsonl'))continue;const fp=path.join(rd,f);let st;try{st=fs.statSync(fp)}catch(e){continue}if(now-st.mtimeMs>RECENCY)continue;out.push(fp)}}}}}return out}`,
    `function read(fp){try{return fs.readFileSync(fp,'utf8')}catch(e){return''}}`,
    // Anchor: run dir = dirname of the NEWEST transcript containing NONCE. Newest favors THIS
    // run's live checker over any stale prior run that shared the (deterministic) nonce.
    `const cands=transcripts();let runDir=null,best=-1;for(const fp of cands){if(read(fp).indexOf(NONCE)===-1)continue;let st;try{st=fs.statSync(fp)}catch(e){continue}if(st.mtimeMs>best){best=st.mtimeMs;runDir=path.dirname(fp)}}`,
    `if(runDir===null){process.stdout.write(JSON.stringify({anchored:false,results:[]}));return}`,
    // wt-meta label marker as it appears escaped inside the jsonl: label=\"<label>\".
    `function labelMarker(l){return 'label=\\\\"'+l+'\\\\"'}`,
    // Count real external-CLI invocations in one transcript's Bash tool_use commands.
    `function cliCalls(text){let n=0;for(const raw of text.split('\\n')){const t=raw.trim();if(!t)continue;let o;try{o=JSON.parse(t)}catch(e){continue}const m=o&&o.message;if(!m||typeof m!=='object')continue;const c=m.content;if(!Array.isArray(c))continue;for(const b of c){if(!b||b.type!=='tool_use'||b.name!=='Bash')continue;const cmd=b.input&&b.input.command;if(typeof cmd!=='string')continue;const scan=cmd.length>SCAN_MAX?cmd.slice(0,SCAN_MAX):cmd;if(RE.test(scan))n++}}return n}`,
    `const files=ls(runDir).filter(f=>f.indexOf('agent-')===0&&f.endsWith('.jsonl')).map(f=>path.join(runDir,f));`,
    `const cache=new Map();function txt(fp){if(!cache.has(fp))cache.set(fp,read(fp));return cache.get(fp)}`,
    `const results=LABELS.map(function(label){const marker=labelMarker(label);let seen=false,found=false;for(const fp of files){const tx=txt(fp);if(tx.indexOf(marker)===-1)continue;found=true;if(cliCalls(tx)>0){seen=true}break}return{label:label,cliSeen:found?seen:null}});`,
    `process.stdout.write(JSON.stringify({anchored:true,results:results}));`,
  ].join('\n')
}

/** Build the checker agent prompt. It carries the anchor nonce (so the scanner can locate
 *  this run's transcript dir) and ONE Bash command that writes+runs the scanner and prints a
 *  JSON line, which the agent must return verbatim. Deliberately schema-less: the scanner
 *  prints the exact JSON, so a free-text verbatim echo (parsed tolerantly by the pattern)
 *  avoids per-label transcription error a many-field StructuredOutput reconstruction invites. */
export function buildProvenanceCheckerPrompt(
  expectation: DelegationExpectation,
  nonce: string,
  labels: readonly string[],
): string {
  const scanner = buildProvenanceScannerSource(expectation, nonce, labels)
  // A single-quoted heredoc delimiter makes the scanner body literal — no shell interpolation
  // of its $, quotes, or backslashes — so arbitrary scanner text embeds safely.
  const command =
    `SCAN="$(mktemp --suffix=.cjs)"; cat > "$SCAN" <<'WT_PROVENANCE_EOF'\n` +
    `${scanner}\n` +
    `WT_PROVENANCE_EOF\n` +
    `node "$SCAN"; RC=$?; rm -f "$SCAN"; exit $RC`
  return (
    `PROVENANCE_ANCHOR: ${nonce}\n\n` +
    `You are a mechanical provenance checker. Do exactly this, nothing else:\n\n` +
    `1. Run this EXACT Bash command (it writes a temporary script, runs it, and removes it):\n\n` +
    '```bash\n' +
    command +
    '\n```\n\n' +
    `2. The command prints ONE line of JSON of the shape ` +
    `{"anchored":true,"results":[{"label":"…","cliSeen":true|false|null}]}.\n` +
    `Return that JSON line VERBATIM as your entire reply — no prose, no code fence, no edits. ` +
    `If the command prints nothing or errors, reply with exactly {"anchored":false,"results":[]}.\n\n` +
    `Do NOT analyze the ${expectation.id} verdicts yourself. Do NOT read or reason about the ` +
    `claims. Your only job is to run the command and relay its JSON output.`
  )
}

/** Provenance verdict for one vote label. */
export type Provenance = 'seen' | 'absent' | 'undetermined'

/** Parse the checker's free-text reply into a label→Provenance map. Tolerant: extracts the
 *  first balanced JSON object, ignores prose around it; a missing/garbled reply or a label
 *  the checker did not resolve yields 'undetermined' (the caller fails CLOSED on that). */
export function parseProvenanceReply(
  reply: string | null,
  labels: readonly string[],
): Map<string, Provenance> {
  const map = new Map<string, Provenance>()
  const perLabel = extractLabelSeen(reply)
  for (const label of labels) {
    const seen = perLabel.get(label)
    map.set(label, seen === true ? 'seen' : seen === false ? 'absent' : 'undetermined')
  }
  return map
}

/** Extract {label → cliSeen bool} from the checker reply. cliSeen is trusted ONLY when it is
 *  a strict boolean; null/absent → the label is left out (→ 'undetermined' upstream). */
function extractLabelSeen(reply: string | null): Map<string, boolean> {
  const out = new Map<string, boolean>()
  if (typeof reply !== 'string') return out
  const obj = firstJsonObject(reply)
  if (obj === null) return out
  const results = (obj as { results?: unknown }).results
  if (!Array.isArray(results)) return out
  for (const row of results) {
    if (row === null || typeof row !== 'object') continue
    const label = (row as { label?: unknown }).label
    const cliSeen = (row as { cliSeen?: unknown }).cliSeen
    if (typeof label === 'string' && typeof cliSeen === 'boolean') out.set(label, cliSeen)
  }
  return out
}

/** Find the first balanced top-level JSON object in `text` (brace-matched, string-aware).
 *  Returns the parsed value or null. Tolerant of prose/fences around the object. */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const slice = text.slice(start, i + 1)
        try {
          return JSON.parse(slice)
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Spawn the provenance checker and return per-label verdicts. The checker is a PLAIN
 *  subagent (no agentType) so it resolves in Path B; failure (null reply / no result for a
 *  label) surfaces as 'undetermined', on which the caller fails CLOSED (nullifies the vote).
 *  Returns { map, spawned, replyOk } — `spawned` is always 1 (one checker call), `replyOk`
 *  is whether a usable JSON reply came back (for the trail record's outcome bit). */
export async function runProvenanceChecker(
  rt: WorkflowRuntime,
  expectation: DelegationExpectation,
  labels: readonly string[],
  opts: { label: string; phase?: string; model?: ModelAlias; effort?: EffortAlias; nonce: string },
): Promise<{ map: Map<string, Provenance>; replyOk: boolean }> {
  const prompt = buildProvenanceCheckerPrompt(expectation, opts.nonce, labels)
  let reply: string | null = null
  try {
    const raw = await rt.agent(prompt, {
      label: opts.label,
      ...(opts.phase !== undefined ? { phase: opts.phase } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    })
    // The agent() contract is string | null with no schema, but a FakeRuntime handler or an
    // odd sandbox return could yield a non-string — normalize so downstream parsing is total.
    reply = typeof raw === 'string' ? raw : null
  } catch {
    // A checker failure must not crash the run — fail CLOSED (all labels undetermined).
    reply = null
  }
  const map = parseProvenanceReply(reply, labels)
  const replyOk = reply !== null && [...map.values()].some((p) => p !== 'undetermined')
  return { map, replyOk }
}
