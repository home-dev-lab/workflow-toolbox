// observer.ts — pure message-shape readers + attachment-verdict logic for the
// observer-agent-pairing canary (src/observer-canaries.ts).
//
// The card asks one empirical question: does the SDK's experimental
// `observer:` field (an AgentDefinition names another agent type as its
// read-only observer — gated behind `CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS=1`,
// undocumented, read at process start) actually attach at runtime, and does it
// stay attached across the shapes this toolkit relies on (anonymous spawn,
// named spawn, headless/query()) — so a future SDK upgrade that silently drops
// it is caught instead of rediscovered by whichever pilot/orchestrator hits it
// next.
//
// Detection does NOT read subagent transcript files off disk. The parent
// session's own SDK message stream already tags subagent-attributed messages
// with `subagent_type` (proven by sdk-agent-probe.ts's `subagentToolUses`
// collection), and observer traffic additionally carries a harness-emitted
// ENVELOPE via `origin.kind`: 'observer-activity' on the digest delivered TO an
// observer, 'observer' on a report delivered FROM one (see the SDK's own
// `SDKMessageOrigin` type). Matching the envelope — never the payload TEXT —
// is what the manual PoC's own postmortem called out: a detector that greps
// for a literal string it also PLANTED produces a guaranteed false positive;
// an envelope tag cannot be forged by an ordinary tool call.
//
// Every reader takes `unknown` and narrows defensively (lib.ts's convention):
// an SDK upgrade that renames a field must degrade this canary to NOT_MEASURED,
// never throw an opaque TypeError.

import { isRecord, strOrNull } from '@workflow-toolbox/std'
import type { CheckResult } from './lib.js'

// ---------------------------------------------------------------------------
// Message-shape readers
// ---------------------------------------------------------------------------

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (isRecord(c) && typeof c['text'] === 'string' ? c['text'] : '')).join('')
  }
  return ''
}

/** One observer-relevant signal extracted from a single raw SDK stream message:
 *  either a subagent-attributed tool_use (assistant message) or a
 *  subagent-attributed tool_result (user message), each carrying the
 *  harness-emitted `origin.kind` when present. `null` fields mean "this
 *  message carried that dimension but it was absent/malformed", not
 *  "unreadable" — `readObserverSignal` itself returns `null` for messages that
 *  carry NEITHER a subagent tag nor an origin kind (nothing to fold). */
export interface ObserverSignal {
  subagentType: string | null
  originKind: string | null
  toolUse: { id: string; name: string } | null
  toolResult: { toolUseId: string | null; isError: boolean; text: string } | null
}

/** Read EVERY observer-relevant signal off a raw SDK message — a message can
 *  carry MULTIPLE tool_use (or tool_result) blocks in one content array when
 *  the model batches calls, and an early-return-on-first-match here would
 *  silently undercount (measured live 2026-08-03: a 3-call observed-agent
 *  prompt initially read back as "1 tool call" because two of the three calls
 *  landed in the same batched message). Returns an empty array when the
 *  message is not a type this probe cares about, or carries neither a
 *  subagent tag, an origin-kind envelope, nor any tool_use/tool_result block. */
export function readObserverSignals(msg: unknown): ObserverSignal[] {
  if (!isRecord(msg)) return []
  const type = msg['type']
  if (type !== 'assistant' && type !== 'user') return []

  const subagentType = strOrNull(msg['subagent_type'])
  const origin = msg['origin']
  const originKind = isRecord(origin) ? strOrNull(origin['kind']) : null

  const inner = isRecord(msg['message']) ? msg['message'] : null
  const content = inner && Array.isArray(inner['content']) ? inner['content'] : []

  const signals: ObserverSignal[] = []
  if (type === 'assistant') {
    for (const block of content) {
      if (isRecord(block) && block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        const id = strOrNull(block['id'])
        signals.push({ subagentType, originKind, toolUse: id !== null ? { id, name: block['name'] } : null, toolResult: null })
      }
    }
  } else {
    for (const block of content) {
      if (isRecord(block) && block['type'] === 'tool_result') {
        signals.push({
          subagentType,
          originKind,
          toolUse: null,
          toolResult: {
            toolUseId: strOrNull(block['tool_use_id']),
            isError: block['is_error'] === true,
            text: normalizeContent(block['content']),
          },
        })
      }
    }
  }
  // No tool_use/tool_result block found — still worth folding once if the
  // message carries a subagent tag or an origin kind (e.g. a bare text digest turn).
  if (signals.length === 0 && (subagentType !== null || originKind !== null)) {
    signals.push({ subagentType, originKind, toolUse: null, toolResult: null })
  }
  return signals
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/** Running tally folded across one whole session's message stream. Immutable
 *  fold (foldObserverSignal returns a new tally) so the live runner and the
 *  unit tests share the exact same reduction, message by message. */
export interface RunTally {
  /** tool_use blocks tagged with the OBSERVED agent's subagent type — the
   *  "did it take enough turns to even produce a digest" guard. */
  observedToolUseCount: number
  /** signals tagged with the OBSERVER's subagent type AND originKind === 'observer-activity'. */
  observerActivityDigests: number
  /** tool_use blocks tagged with the OBSERVER's subagent type. */
  observerToolUses: { id: string; name: string }[]
  /** tool_result blocks tagged with the OBSERVER's subagent type. */
  observerToolResults: { toolUseId: string | null; isError: boolean; text: string }[]
  /** any signal anywhere carrying originKind === 'observer' (a report envelope). */
  observerEnvelopeSeen: boolean
}

export function emptyTally(): RunTally {
  return {
    observedToolUseCount: 0,
    observerActivityDigests: 0,
    observerToolUses: [],
    observerToolResults: [],
    observerEnvelopeSeen: false,
  }
}

/** Fold one ObserverSignal into a tally. Pure — returns a new tally, never
 *  mutates `tally`. `observedType`/`observerType` are the two AgentDefinition
 *  names the live run provisioned (see observer-canaries.ts). */
export function foldObserverSignal(tally: RunTally, signal: ObserverSignal, observedType: string, observerType: string): RunTally {
  const next: RunTally = {
    ...tally,
    observerToolUses: [...tally.observerToolUses],
    observerToolResults: [...tally.observerToolResults],
  }
  if (signal.subagentType === observedType && signal.toolUse !== null) {
    next.observedToolUseCount++
  }
  if (signal.subagentType === observerType) {
    if (signal.originKind === 'observer-activity') next.observerActivityDigests++
    if (signal.toolUse !== null) next.observerToolUses.push(signal.toolUse)
    if (signal.toolResult !== null) next.observerToolResults.push(signal.toolResult)
  }
  if (signal.originKind === 'observer') next.observerEnvelopeSeen = true
  return next
}

// ---------------------------------------------------------------------------
// Three-state verdicts
// ---------------------------------------------------------------------------

/** ATTACHED / NOT_ATTACHED / NOT_MEASURED — never a boolean. For the two
 *  mechanical assertions (observerReportAssertion, sendMessageRefusalAssertion)
 *  the meaning is repurposed slightly: ATTACHED means "behaves as documented",
 *  NOT_ATTACHED means "regressed from the documented contract" — kept as the
 *  same three-state shape rather than a fourth type, since both are still
 *  "measured this undocumented surface and it does/doesn't hold". */
export type LegState = 'ATTACHED' | 'NOT_ATTACHED' | 'NOT_MEASURED'

export interface LegVerdict {
  name: string
  state: LegState
  reason: string
  /** Set on the positive control only: a NOT_ATTACHED here makes every other
   *  leg's result uninterpretable (indistinguishable from a broken fixture, an
   *  unset flag the earlier check somehow missed, or too few observed turns —
   *  see the module header). The runner fails loudly and skips the rest. */
  hard?: boolean
}

/** The minimum number of observed-agent tool calls before a "no digest seen"
 *  result can be trusted as a genuine NOT_ATTACHED rather than "too few turns
 *  to produce one" — the manual PoC's own documented trap. */
export const MIN_OBSERVED_TOOL_CALLS = 3

/** Classify attachment from a folded tally.
 *
 *  `pathHasWorkingBaseline` is the crux of the 2026-08-03 correction: a clean
 *  negative (enough observed turns, zero attach signal) is NOT_ATTACHED —
 *  loud, gating, "this is a regression" — ONLY on a launch shape that has
 *  independent, out-of-band confirmation it can attach an observer at all.
 *  Confirmed today: this session's own `pilot-watchdog` transcripts prove the
 *  INTERACTIVE Agent-tool spawn path attaches observers in production, right
 *  now, on this SDK version. This probe's positive/named-headless legs drive a
 *  DIFFERENT path — a headless SDK `query()` session in which the model calls
 *  the `Agent`/`Task` tool to spawn a NESTED subagent — which nothing (not the
 *  card, not the observer-agents-matrix fiche, not this probe itself) has ever
 *  independently shown CAN attach. A clean negative on a path with no known-
 *  working baseline cannot be told apart from "this launch shape never
 *  attaches, by design or by an untested gap" — so it reports NOT_MEASURED,
 *  not NOT_ATTACHED, until/unless a baseline for that specific path exists.
 *  `hard` only takes effect when `pathHasWorkingBaseline` is true — it is kept
 *  (not removed) for that future case, e.g. a canary built against the
 *  interactive spawn path itself. */
export function classifyAttachment(
  tally: RunTally,
  legName: string,
  opts: { hard: boolean; pathHasWorkingBaseline: boolean },
): LegVerdict {
  const attached = tally.observerActivityDigests > 0 || tally.observerToolUses.length > 0 || tally.observerEnvelopeSeen
  if (attached) {
    return {
      name: legName,
      state: 'ATTACHED',
      reason: `observer received ${tally.observerActivityDigests} activity digest(s), made ${tally.observerToolUses.length} tool_use call(s), envelope seen=${tally.observerEnvelopeSeen}`,
    }
  }
  if (tally.observedToolUseCount < MIN_OBSERVED_TOOL_CALLS) {
    return {
      name: legName,
      state: 'NOT_MEASURED',
      reason: `observed agent made only ${tally.observedToolUseCount} tool call(s) (< ${MIN_OBSERVED_TOOL_CALLS}) — cannot distinguish "not attached" from "too few turns to produce a digest"`,
    }
  }
  if (!opts.pathHasWorkingBaseline) {
    return {
      name: legName,
      state: 'NOT_MEASURED',
      reason:
        `no observer-activity digest/tool_use/envelope seen after ${tally.observedToolUseCount} confirmed observed ` +
        'tool call(s), via a headless SDK query() + nested Agent-tool spawn — this specific launch path has no ' +
        'independent confirmation it can attach an observer at all (distinct from the interactive Agent-tool spawn ' +
        "path, which demonstrably works today — see this session's own pilot-watchdog transcripts). This probe " +
        'cannot currently distinguish "this path never attaches" from "attachment broke" — that is the acknowledged ' +
        'gap, not a defect finding.',
    }
  }
  return {
    name: legName,
    state: 'NOT_ATTACHED',
    reason: `observed agent made ${tally.observedToolUseCount} tool call(s); no activity digest, no observer tool_use, no observer envelope seen`,
    hard: opts.hard,
  }
}

/** Mechanical assertion: did the observer's ObserverReport tool_use succeed
 *  (no matching error tool_result)? NOT_MEASURED if the observer never called
 *  it in this run (its own choice, or the digest never reached it). */
export function observerReportAssertion(tally: RunTally): LegVerdict {
  const uses = tally.observerToolUses.filter((t) => t.name === 'ObserverReport')
  if (uses.length === 0) {
    return {
      name: 'observer-report-tool',
      state: 'NOT_MEASURED',
      reason: 'observer never called ObserverReport in this run',
    }
  }
  const ids = uses.map((t) => t.id)
  const failed = tally.observerToolResults.some((r) => r.toolUseId !== null && ids.includes(r.toolUseId) && r.isError)
  return failed
    ? { name: 'observer-report-tool', state: 'NOT_ATTACHED', reason: 'ObserverReport tool_use returned is_error=true — REGRESSION' }
    : { name: 'observer-report-tool', state: 'ATTACHED', reason: `ObserverReport tool_use succeeded (${uses.length} call(s), no error tool_result)` }
}

/** Mechanical assertion: SendMessage is expected to be refused for an observer
 *  ("No such tool available") even when declared in its `tools:`. This is the
 *  DOCUMENTED, correct contract ("an observer must never participate in the
 *  task") — only an unexpected SUCCESS is a regression; a correct refusal, or
 *  no attempt at all, is not a failure. */
export function sendMessageRefusalAssertion(tally: RunTally): LegVerdict {
  const attempts = tally.observerToolUses.filter((t) => t.name === 'SendMessage')
  if (attempts.length === 0) {
    return {
      name: 'observer-sendmessage-refused',
      state: 'NOT_MEASURED',
      reason: 'observer never attempted SendMessage in this run',
    }
  }
  const ids = attempts.map((t) => t.id)
  const results = tally.observerToolResults.filter((r) => r.toolUseId !== null && ids.includes(r.toolUseId))
  const anySucceeded = results.some((r) => !r.isError)
  if (anySucceeded) {
    return {
      name: 'observer-sendmessage-refused',
      state: 'NOT_ATTACHED',
      reason: 'REGRESSION: the observer\'s SendMessage call SUCCEEDED — expected a refusal ("No such tool available")',
      hard: true,
    }
  }
  const refusedAsExpected = results.some((r) => r.isError && /no such tool available/i.test(r.text))
  return {
    name: 'observer-sendmessage-refused',
    state: 'ATTACHED',
    reason: refusedAsExpected
      ? 'SendMessage correctly refused with "No such tool available" — expected, correct behavior, not a regression'
      : `SendMessage errored but not with the expected wording (${results.length} result(s)): ${results.map((r) => JSON.stringify(r.text.slice(0, 100))).join(' | ')}`,
  }
}

// ---------------------------------------------------------------------------
// CheckResult adapters
// ---------------------------------------------------------------------------

/** Fold a LegVerdict into the shared CheckResult shape (composes with
 *  lib.ts's summarize()) while keeping the raw three-state verdict VISIBLE in
 *  the detail text — a NOT_MEASURED must never collapse into "it doesn't
 *  work" just because it also folds to ok:true. */
export function legVerdictToCheckResult(v: LegVerdict): CheckResult {
  return { name: v.name, ok: v.state !== 'NOT_ATTACHED', detail: `[${v.state}] ${v.reason}` }
}

/** A CheckResult for a leg that was never run (flag absent, or skipped after a
 *  hard positive-control failure). Always ok:true — "I could not measure this"
 *  is never a failure by itself. */
export function notMeasuredResult(name: string, reason: string): CheckResult {
  return { name, ok: true, detail: `[NOT_MEASURED] ${reason}` }
}

const FLAG_NAME = 'CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS'

/** Whether the experimental-observer-agents feature gate is enabled in `env`.
 *  Checks PRESENCE + a non-empty, non-"0" value — never the value itself is
 *  printed anywhere (this machine keeps real secrets in env; the discipline is
 *  kept even though this particular variable is a harmless boolean flag). */
export function flagEnabled(env: Record<string, string | undefined>): boolean {
  const v = env[FLAG_NAME]
  return v !== undefined && v !== '' && v !== '0'
}

/** The flag-presence leg's own CheckResult — always ok:true (presence/absence
 *  is informational, not a pass/fail by itself; it decides whether the other
 *  legs can run at all). */
export function flagCheckResult(env: Record<string, string | undefined>): CheckResult {
  const enabled = flagEnabled(env)
  return {
    name: 'observer-flag-present',
    ok: true,
    detail: enabled
      ? `${FLAG_NAME} is set — live legs will run`
      : `${FLAG_NAME} is NOT set — every other leg reports NOT_MEASURED, zero live launches spent`,
  }
}
