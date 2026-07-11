// PURE per-agent external-delegation COMPLIANCE scanner. When a workflow routes a role to an
// external-model agentType (e.g. `agentTypes: { verify: 'workflow-toolbox:opencode-verifier' }`),
// the spawned agent is a Claude HOST that must shell out to the external CLI (opencode / codex).
// A wrapper can silently SELF-ANSWER instead — read the sources and emit the verdict itself —
// and the output looks identical: the run then reports same-family verdicts as external.
// The entry availability probe cannot catch this (it proves the route CAN work, not that each
// call TOOK it). Proven 2026-07-10: 16/17 codex-rescue verifier wrappers self-answered under
// grounding prompts in a 3-arm eval — caught only by reading one transcript. This module reads
// one agent transcript (`agent-<id>.jsonl`) and counts REAL external-CLI `tool_use` invocations
// so the audit report + Stop hook can warn "requested external, but N/M routed agents show no
// external CLI call — verdicts may be same-family".
//
// The signature set is a CLOSED registry grounded on the real invocation shapes:
//   - opencode : `opencode … run` on one line, OR the two-line resolver shape
//                `BIN=$(command -v opencode …)` + `"$BIN" run …` (the bundled
//                opencode-verifier bridge's own procedure). The regex is MULTILINE-SAFE
//                (`[\s\S]`, never `.`) — a `BIN=…\n"$BIN" run` two-liner produced a false
//                negative under `.` during the manual 2026-07-10 check.
//   - codex    : `codex-companion.mjs` (the codex plugin's companion wrapper) OR a direct
//                `codex exec`.
// Only Bash `tool_use` INPUT COMMANDS are matched — never whole-transcript text. An injected
// skill/agent definition QUOTES the CLI path (the codex plugin's skill text contains
// `codex-companion.mjs`), so a substring scan over the full transcript is invalid — that exact
// contamination produced a false 17/17-compliant reading during the manual check.
//
// Scope limits (documented, deliberate): a matched command proves the agent INVOKED the CLI,
// not that the invocation succeeded (the bridge's own gate markers cover failure honestly) —
// hence the result field is named `cliSeen`, never "compliant"/"verified"; an agentType with
// no registered signature is reported as UNKNOWN, never flagged — precision over recall, same
// contract as tool-denial.ts. The signal targets ACCIDENTAL self-answering: a deliberately
// gamed wrapper can spoof it by shelling out to a matching no-op command, which only a real
// round-trip verification could catch. Report-only: this signal never gates a run.
//
// Tolerant by contract (parses an untrusted on-disk file): malformed lines and odd shapes are
// skipped; it never throws. Reuses the @workflow-toolbox/std narrowers — no local redefinition.

import { isRecord, strOrNull } from '@workflow-toolbox/std'

/** One entry of the closed signature registry: which agentType names it covers and what a
 *  real CLI invocation of it looks like inside a Bash command string. */
export interface DelegationExpectation {
  /** Stable id, also the display name of the external CLI (e.g. "opencode"). */
  id: string
  /** Matches agentType names routed to this CLI (e.g. anything containing "opencode"). */
  typeRe: RegExp
  /** Matches a REAL invocation inside one Bash `input.command` (multiline-safe). */
  commandRe: RegExp
}

/** The closed registry. Adding a new external bridge = adding one grounded entry here;
 *  both the audit report and the observe-ui delegation panel pick it up. */
// The regexes require an INVOCATION SHAPE, not token presence (pr-review HIGH on the first
// cut: `test -f ./opencode-verifier.md && echo run` and `grep codex-companion.mjs README.md`
// scored as CLI calls — same-line incidental mentions must never count):
//   - direct arms put the binary in COMMAND POSITION (line start / after a separator,
//     optionally a path prefix) IMMEDIATELY followed by its subcommand. A QUOTED binary
//     (`"/path/opencode" run` — a real shape from run wf_f512a38e-14c's verify:1:1) needs
//     BOTH quotes around the path with the subcommand OUTSIDE: that closing-quote-between
//     is what separates a real invocation from a quoted STRING argument like
//     `grep "codex exec" SKILL.md` (both words inside one quote pair — never a call);
//   - the opencode resolver arm requires a real `…BIN=` ASSIGNMENT naming opencode before
//     the `"$BIN" run` call (a bare mention on an earlier line no longer arms it).
// Residual, accepted: text that embeds the exact invocation shape (`echo "opencode run"`)
// still matches — that is the deliberate-spoof case the header rules out of scope.
export const DELEGATION_EXPECTATIONS: readonly DelegationExpectation[] = [
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

/** agentTypes the runtime stamps on DEFAULT spawns (grounded: every agent of a plain
 *  pr-review run's sidecars reads `workflow-subagent`) — a default spawn is NOT a
 *  delegation, so every consumer must skip these BEFORE reasoning about delegation at all
 *  (without this, the panel chip and the report's "unknown" list light up on every agent
 *  of every ordinary run). */
const DEFAULT_AGENT_TYPES = new Set(['workflow-subagent'])

/** Whether an agentType found in a sidecar denotes a real routing choice (vs the runtime's
 *  default spawn type). Shared by the audit scanner and the observe-ui panel. */
export function isDelegatedAgentType(agentType: string): boolean {
  return !DEFAULT_AGENT_TYPES.has(agentType)
}

/** Resolve the expectation for an agentType, or null when no registered signature covers it
 *  (an UNKNOWN delegation — reported informationally, never flagged). */
export function expectationForAgentType(agentType: string): DelegationExpectation | null {
  for (const e of DELEGATION_EXPECTATIONS) if (e.typeRe.test(agentType)) return e
  return null
}

/** Cap on how much of one command string the regexes scan. Transcript command strings are
 *  agent-influenced content of unbounded size (a heredoc payload can be huge); the match cost
 *  must not scale with it. A real invocation buried past this many chars is missed — accepted
 *  for a report-only signal. */
const COMMAND_SCAN_MAX = 20_000

/** Whether one Bash command string is a real invocation of the expected external CLI.
 *  Exposed for the observe-ui panel, which scans already-parsed ToolInteractions
 *  (it never re-parses the raw transcript). */
export function isExternalCliCommand(command: string, expectation: DelegationExpectation): boolean {
  const text = command.length > COMMAND_SCAN_MAX ? command.slice(0, COMMAND_SCAN_MAX) : command
  return expectation.commandRe.test(text)
}

/** Cap for the stored first-command preview (display-only, mirrors tool-denial's DETAIL_MAX).
 *  Exported so the observe-ui view keeps the same cap without redefining it. */
export const COMMAND_PREVIEW_MAX = 120

export interface ExternalCallScan {
  /** How many Bash tool_use commands matched the expectation (invocations SEEN, success not
   *  implied — the bridge's own gate markers cover failure). */
  cliCalls: number
  /** The first matching command, single-lined and capped for display; null when none. */
  firstCommand: string | null
}

/**
 * Scan one agent transcript (`agent-<id>.jsonl` text) for real external-CLI invocations of
 * `expectation`. Only assistant `tool_use` blocks named "Bash" are inspected — see the file
 * header for why whole-transcript matching is invalid. Never throws; a malformed/empty
 * transcript yields zero calls.
 */
export function parseTranscriptExternalCalls(jsonl: string, expectation: DelegationExpectation): ExternalCallScan {
  let cliCalls = 0
  let firstCommand: string | null = null

  for (const raw of jsonl.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const message = parsed['message']
    if (!isRecord(message)) continue
    const content = message['content']
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_use') continue
      if (strOrNull(block['name']) !== 'Bash') continue
      const input = block['input']
      if (!isRecord(input)) continue
      const command = strOrNull(input['command'])
      if (command === null || !isExternalCliCommand(command, expectation)) continue
      cliCalls++
      if (firstCommand === null) firstCommand = command.replace(/\s+/g, ' ').trim().slice(0, COMMAND_PREVIEW_MAX)
    }
  }
  return { cliCalls, firstCommand }
}

/** One delegated agent's compliance row. */
export interface AgentDelegation {
  /** The agent whose sidecar meta carried the agentType (the `agent-<id>` id). */
  agentId: string
  /** The run-phase label, resolved from the journal by the report builder. Absent here
   *  (the sidecar alone doesn't carry it) and filled in downstream. */
  label?: string
  /** The requested agentType (e.g. "workflow-toolbox:opencode-verifier"). */
  agentType: string
  /** The matched expectation id ("opencode" / "codex"). */
  expectation: string
  /** External-CLI invocations seen in this agent's transcript. */
  cliCalls: number
  /** First matching command (capped preview), null when none. */
  firstCommand: string | null
  /** True iff at least one real CLI invocation was SEEN. Deliberately not named
   *  "compliant" — a seen invocation proves the CLI was called, not that it succeeded
   *  (see the header's scope limits). Same vocabulary as the observe-ui panel. */
  cliSeen: boolean
}

/** A delegation the registry has no signature for: shown informationally, never flagged. */
export interface UnknownDelegation {
  agentId: string
  label?: string
  agentType: string
}

/** A run-level rollup of external-delegation compliance across its agents. */
export interface ExternalDelegationReport {
  /** Agents whose agentType matched a registered external signature (the audited set). */
  delegatedAgents: number
  /** Audited agents with NO external-CLI invocation — the self-answer suspects. */
  withoutCli: AgentDelegation[]
  /** Every audited agent's row (CLI seen or not), for the report table. */
  agents: AgentDelegation[]
  /** Delegations to agentTypes with no registered signature (reported, not judged). */
  unknown: UnknownDelegation[]
  /** True when any audited agent shows no CLI call — the alarm bit (mirrors denials.degraded).
   *  Equals `withoutCli.length > 0` by construction; `buildExternalDelegationReport` is the
   *  sole constructor and keeps them in sync. */
  flagged: boolean
}

export function emptyExternalDelegationReport(): ExternalDelegationReport {
  return { delegatedAgents: 0, withoutCli: [], agents: [], unknown: [], flagged: false }
}

/** One agent's delegation as read off disk by the impure scanner: the sidecar's agentType +
 *  the transcript's external-call scan. Named once here — audit-folder's TranscriptScan map
 *  and report.ts's BuildReportOptions both carry it (they duplicated the tuple inline). */
export interface DelegationScan {
  agentType: string
  /** The external-CLI scan, or null when the agentType has no registered signature — the
   *  sole current producer (audit-folder's scanTranscripts) only reaches this map for agents
   *  whose transcript it could read, so null here never means "unreadable transcript". */
  scan: ExternalCallScan | null
}

export interface DelegationScanInput {
  agentId: string
  /** The run-phase label when the caller (the report builder) resolved it from the journal. */
  label?: string
  agentType: string
  /** The transcript scan for this agent, or null when its transcript was absent/unreadable
   *  (an absent transcript can prove nothing — the agent is left OUT of the audited set,
   *  same posture as the usage/denial scans). */
  scan: ExternalCallScan | null
}

/** Roll per-agent delegation scans into one report. Inputs whose agentType has no registered
 *  signature land in `unknown`; inputs with no readable transcript are dropped (see
 *  DelegationScanInput.scan). */
export function buildExternalDelegationReport(perAgent: Iterable<DelegationScanInput>): ExternalDelegationReport {
  const agents: AgentDelegation[] = []
  const unknown: UnknownDelegation[] = []
  for (const input of perAgent) {
    const expectation = expectationForAgentType(input.agentType)
    if (expectation === null) {
      unknown.push({
        agentId: input.agentId,
        ...(input.label !== undefined ? { label: input.label } : {}),
        agentType: input.agentType,
      })
      continue
    }
    if (input.scan === null) continue
    agents.push({
      agentId: input.agentId,
      ...(input.label !== undefined ? { label: input.label } : {}),
      agentType: input.agentType,
      expectation: expectation.id,
      cliCalls: input.scan.cliCalls,
      firstCommand: input.scan.firstCommand,
      cliSeen: input.scan.cliCalls > 0,
    })
  }
  const withoutCli = agents.filter((a) => !a.cliSeen)
  return {
    delegatedAgents: agents.length,
    withoutCli,
    agents,
    unknown,
    flagged: withoutCli.length > 0,
  }
}
