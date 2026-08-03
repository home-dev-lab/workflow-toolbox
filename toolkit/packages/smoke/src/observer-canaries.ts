// observer-canaries.ts — `pnpm canary:observer`. The live runner for the
// experimental observer-agent-pairing canary (card
// "Probe: is the observer-agent pairing surface still there after upgrades").
//
// Standalone (NOT folded into canary-all.ts's per-runtime-target matrix loop),
// on the same precedent as sdk-agent-probe.ts (`pnpm canary:agents`): the
// nesting/edge/budget canaries in that matrix all drive a WORKFLOW launch and
// genuinely differ between the system and bundled CC binaries, which is what
// the matrix's per-target loop is FOR. This probe never launches a Workflow —
// it drives query() directly, spending its budget on the SDK's own
// agent-spawn + multi-turn overhead (spawn a subagent, force 3+ tool calls,
// let its paired observer receive digests and call ObserverReport), so
// running it twice per target would double the cost for no extra signal: the
// `observer:` field is an SDK-level Options/AgentDefinition contract, not a
// CC-binary behavior the two targets could plausibly diverge on the way
// nesting/budget genuinely can. Kept out of `pnpm test` too, like every other
// live canary here — it spends real SDK launches under the local subscription.
//
// Feature gate: CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS, read by the CLI at
// PROCESS START. Absent → the `observer:` field is silently ignored by the
// harness — this probe checks presence FIRST and, if absent, reports every
// other leg NOT_MEASURED without spending a single live launch.
//
// Legs (see observer.ts for the pure verdict logic):
//   1. flag-check              — env presence, zero-cost
//   2. positive-control        — ANONYMOUS spawn (no `name`), via a headless SDK
//                                 query() session in which the model calls the
//                                 Agent/Task tool to spawn a NESTED subagent.
//                                 ⚠ CORRECTED 2026-08-03: this launch shape has
//                                 NO independent confirmation it can attach an
//                                 observer at all — it is a DIFFERENT path from
//                                 the INTERACTIVE Agent-tool spawn this session's
//                                 own pilot-watchdog transcripts prove works in
//                                 production today. So a clean negative here
//                                 (enough observed turns, zero attach signal)
//                                 reports NOT_MEASURED, never a loud NOT_ATTACHED
//                                 — this probe cannot yet distinguish "this path
//                                 never attaches" from "attachment broke" (see
//                                 classifyAttachment's own doc in observer.ts).
//                                 The downstream legs still skip when this one is
//                                 not ATTACHED, because their own result would be
//                                 uninterpretable either way.
//   3. observer-report-tool    — mechanical assertion: ObserverReport succeeds
//                                 (folded from the SAME positive-control run).
//   4. observer-sendmessage    — mechanical assertion: SendMessage is REFUSED
//                                 for the observer even though declared in its
//                                 `tools:` (folded from the same run too).
//   5. named-headless          — a SEPARATE run, named spawn, in THIS headless/
//                                 query() harness — same "no known baseline"
//                                 caveat as the positive-control leg applies.
//                                 NOT a reproduction of the interactive-mode
//                                 "named spawn rebuilds its AgentDefinition and
//                                 drops the observer" bug — that mechanism is
//                                 specific to the in-process "teammate" path an
//                                 interactive CLI session takes for a named
//                                 Task/Agent spawn, which a headless SDK session
//                                 does not go through. Recorded and labeled as a
//                                 secondary signal.
//
// Known gap, explicitly out of scope for this pass: there is currently no
// automated canary for the INTERACTIVE Agent-tool spawn path — the one that
// demonstrably works (pilot-watchdog, today). Whether that path is even
// exercisable from an automated headless test harness at all is an open
// question, not a defect of this probe.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { pathToFileURL } from 'node:url'
import { annotateAuth, isAbortError, isRecord, summarize, type CheckResult } from './lib.js'
import {
  classifyAttachment,
  emptyTally,
  flagCheckResult,
  flagEnabled,
  foldObserverSignal,
  legVerdictToCheckResult,
  notMeasuredResult,
  observerReportAssertion,
  readObserverSignals,
  sendMessageRefusalAssertion,
  type RunTally,
} from './observer.js'

type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>

const REPO_ROOT = new URL('../../../..', import.meta.url).pathname // toolkit/packages/smoke/src → repo root
const OBSERVED_TYPE = 'wt-observer-canary-target'
const OBSERVER_TYPE = 'wt-observer-canary-watcher'
const SESSION_TIMEOUT_MS = 420_000 // generous: spawn + up to 90s of forced parent-side waiting + 3 forced tool calls + observer digests + ObserverReport

const OBSERVED_PROMPT =
  'You are a throwaway probe target with no other purpose. Do EXACTLY these three tool calls, ' +
  'in this order, then stop: (1) Read the file package.json in your working directory. ' +
  '(2) Use Glob to list *.md in your working directory. (3) Read the file README.md in your working ' +
  "directory. Do not skip, combine, or repeat a call. After all three finish, reply with the single word DONE."

const OBSERVER_PROMPT =
  'You are a READ-ONLY OBSERVER, auto-attached to another agent. You receive periodic activity digests ' +
  'about that agent; you never participate in its task. On receiving your FIRST digest, attempt to call ' +
  'the SendMessage tool exactly once (any short text, any recipient name) purely to record whether that ' +
  'tool is actually usable by you — a refusal is the expected, correct outcome, not an error on your part. ' +
  'After the observed agent finishes (or once you have received at least one digest and made your ' +
  'SendMessage attempt), call the ObserverReport tool exactly once with a short summary that states: how ' +
  'many digests you received, and whether the SendMessage call succeeded or was refused.'

function agentsMap(): NonNullable<QueryOptions['agents']> {
  return {
    [OBSERVED_TYPE]: {
      description: 'Probe target — forced multi-turn tool use, paired with an observer.',
      prompt: OBSERVED_PROMPT,
      tools: ['Read', 'Glob'],
      observer: OBSERVER_TYPE,
    },
    [OBSERVER_TYPE]: {
      description: 'Probe observer — read-only, reports via ObserverReport.',
      prompt: OBSERVER_PROMPT,
      // SendMessage is declared here DELIBERATELY: the mechanical assertion is
      // that it is refused EVEN THOUGH declared (see observer.ts's
      // sendMessageRefusalAssertion doc).
      tools: ['SendMessage'],
    },
  }
}

const BASE: QueryOptions = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  cwd: REPO_ROOT,
  settingSources: [],
  maxTurns: 40,
}

function spawnPrompt(named: boolean): string {
  const nameClause = named ? ' and name "wt-obs-named-target"' : ' — do NOT set a name (anonymous spawn)'
  // run_in_background:false is set explicitly (the Agent tool's own schema
  // defaults it to true) AND the prompt separately warns against trusting the
  // tool_result alone as "finished": empirically observed 2026-08-03 (see
  // observer-canaries.md notes in the card report) — the Agent tool_result can
  // arrive as an early acknowledgment BEFORE the spawned agent's own tool
  // calls appear in the stream, and a model told to "reply once the tool call
  // returns" replies immediately, ending the whole session (and, with it, the
  // still-running subagent + its observer) after only ~1 real tool call. The
  // actual completion is a later event the model must wait to actually see.
  return (
    `Use the Agent tool to spawn exactly ONE agent with subagent_type "${OBSERVED_TYPE}"${nameClause} and ` +
    'run_in_background set to false. IMPORTANT: the tool call may return an early acknowledgment before the ' +
    'spawned agent has actually finished its work — that acknowledgment is NOT completion. After the Agent tool ' +
    'call returns, call the Bash tool with `sleep 15` and repeat that Bash sleep call up to 6 times (90 seconds ' +
    'total), checking after each one whether you now have clear, explicit confirmation the spawned agent finished ' +
    '(its own final reply, or a task-completion notification about it). Only once you have that confirmation — or ' +
    'you have done all 6 sleeps without it — reply with the single word DONE. Do not do anything else.'
  )
}

function readResult(msg: unknown): string | null {
  if (!isRecord(msg) || msg['type'] !== 'result') return null
  return typeof msg['result'] === 'string' ? msg['result'] : null
}

interface SessionOutcome {
  tally: RunTally
  resultText: string | null
  error: string | null
}

/** Drive ONE query() session, folding every message through readObserverSignals
 *  into a RunTally. A single message can carry MULTIPLE signals (a batched
 *  tool-call turn) — fold all of them, not just the first (see readObserverSignals'
 *  own doc for the live miscount this fixed). Bounded by `timeoutMs` — a stuck
 *  session degrades to a recorded `error`, never a hang. */
async function runSession(options: QueryOptions, prompt: string, timeoutMs: number): Promise<SessionOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let tally = emptyTally()
  let resultText: string | null = null
  let error: string | null = null
  const q = query({ prompt, options: { ...options, abortController: controller } })
  try {
    for await (const message of q) {
      for (const signal of readObserverSignals(message)) {
        tally = foldObserverSignal(tally, signal, OBSERVED_TYPE, OBSERVER_TYPE)
      }
      const text = readResult(message)
      if (text !== null) {
        resultText = text
        break
      }
    }
  } catch (err) {
    error = isAbortError(err) ? `timed out after ${timeoutMs} ms` : (err as Error).message
  } finally {
    clearTimeout(timer)
  }
  return { tally, resultText, error }
}

const NAMED_HEADLESS_CAVEAT =
  " — NOTE: headless/query() spawns do not reproduce the INTERACTIVE teammate-mode drop (a named " +
  'Task/Agent spawn in an interactive CLI session rebuilds its AgentDefinition from scratch, losing the ' +
  'observer pairing). This leg is a secondary regression signal on the SDK\'s own named-spawn wiring in a ' +
  'headless harness, NOT a reproduction of the interactive bug — do not read an ATTACHED here as proof the ' +
  'interactive-mode issue is fixed, nor a NOT_ATTACHED here as confirming it (it would be a NEW, different finding).'

/** Run every leg and return their CheckResults. Pure w.r.t. env (takes it as a
 *  parameter) so the flag-absent early-return path is unit-testable without
 *  touching real process.env or spending a live launch. */
export async function runObserverCanaries(env: Record<string, string | undefined>): Promise<{ checks: CheckResult[] }> {
  const checks: CheckResult[] = [flagCheckResult(env)]

  if (!flagEnabled(env)) {
    const reason = 'CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS not set — zero live launches spent'
    checks.push(notMeasuredResult('observer-positive-control', reason))
    checks.push(notMeasuredResult('observer-report-tool', reason))
    checks.push(notMeasuredResult('observer-sendmessage-refused', reason))
    checks.push(notMeasuredResult('observer-named-headless', reason))
    return { checks }
  }

  const opts: QueryOptions = { ...BASE, agents: agentsMap() }

  // Leg 2: positive control (anonymous spawn). Also carries legs 3+4 (folded
  // from the same run — cheap, no extra launch).
  console.log('  ▶ observer-positive-control (anonymous spawn, forced 3+ tool calls)…')
  const pc = await runSession(opts, spawnPrompt(false), SESSION_TIMEOUT_MS)
  if (pc.error !== null) console.log(`    ⚠ run note: ${pc.error}`)
  // pathHasWorkingBaseline: false — this session's own pilot-watchdog transcripts
  // prove the INTERACTIVE Agent-tool spawn path attaches observers today, but that
  // is a DIFFERENT launch shape from this leg's headless query() + nested
  // Agent-tool spawn, which has no independent confirmation it ever attaches at
  // all (2026-08-03 correction — see classifyAttachment's own doc). A clean
  // negative here is therefore NOT_MEASURED, never a loud NOT_ATTACHED regression.
  const pcVerdict = classifyAttachment(pc.tally, 'observer-positive-control', { hard: true })
  checks.push(legVerdictToCheckResult(pcVerdict))
  console.log(`    → ${pcVerdict.state}: ${pcVerdict.reason}`)

  if (pcVerdict.state !== 'ATTACHED') {
    const reason =
      "skipped: the positive-control leg did not show ATTACHED (this launch path's own attachability is " +
      `unconfirmed — see its own reason above), so a downstream result would be uninterpretable: ${pcVerdict.reason}`
    checks.push(notMeasuredResult('observer-report-tool', reason))
    checks.push(notMeasuredResult('observer-sendmessage-refused', reason))
    checks.push(notMeasuredResult('observer-named-headless', reason))
    return { checks }
  }

  const reportVerdict = legVerdictToCheckResult(observerReportAssertion(pc.tally))
  checks.push(reportVerdict)
  console.log(`    → ${reportVerdict.detail}`)
  const sendMsgVerdict = legVerdictToCheckResult(sendMessageRefusalAssertion(pc.tally))
  checks.push(sendMsgVerdict)
  console.log(`    → ${sendMsgVerdict.detail}`)

  // Leg 5: named spawn, headless — secondary signal only, see the module doc.
  console.log('  ▶ observer-named-headless (named spawn, forced 3+ tool calls)…')
  const nm = await runSession(opts, spawnPrompt(true), SESSION_TIMEOUT_MS)
  if (nm.error !== null) console.log(`    ⚠ run note: ${nm.error}`)
  const nmVerdict = classifyAttachment(nm.tally, 'observer-named-headless', { hard: false })
  const nmResult = legVerdictToCheckResult(nmVerdict)
  checks.push({ ...nmResult, detail: nmResult.detail + NAMED_HEADLESS_CAVEAT })
  console.log(`    → ${nmVerdict.state}: ${nmVerdict.reason}`)

  return { checks }
}

async function main(): Promise<number> {
  console.log('── observer-agent pairing canary (CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS) ──')
  console.log(`repo root: ${REPO_ROOT}\n`)
  const { checks } = await runObserverCanaries(process.env)
  console.log('')
  for (const c of checks) console.log(`  ${c.ok ? '✔' : '✖'} ${c.name} — ${c.detail}`)
  const { passed, report } = summarize(checks)
  console.log(`\n${report}`)
  return passed ? 0 : 1
}

// Run main() only when executed directly (`pnpm canary:observer`), not when a
// test imports the pure surface from this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(annotateAuth(err).message)
      process.exit(2)
    },
  )
}
