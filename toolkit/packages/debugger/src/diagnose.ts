// The diagnosis decision table. Pure: a parsed journal in, a Diagnosis out.
//
// Primary modes are TOTAL and MUTUALLY EXCLUSIVE — every journal routes to exactly
// one. `findings[]` are collected REGARDLESS of the primary mode (a completed-ok run
// can still surface schema-retry findings; a script-throw can still list dead agents).
//
// Three of the conditions below key off signals never observed on disk (a non-"done"
// agent state, attempt > 1, budget-exhaustion wording). They are classified by ROBUST
// structural signals where possible (enum/integer fields), and budget — which would
// key off unobserved free TEXT — is deliberately demoted to a Finding so a regex miss
// costs nothing and a false positive cannot mislabel a real arg-validation throw.

import {
  type WorkflowJournal,
  doneAgents,
  incompleteAgents,
  retriedAgents,
} from './journal.js'

export type DiagnosisMode =
  | 'completed-ok'
  | 'script-throw'
  | 'agent-died'
  | 'schema-retries'
  | 'in-progress'

export type FindingKind =
  | 'dead-agent'
  | 'schema-retry'
  | 'budget-hint'
  | 'launch-failure'
  | 'zombie-hint'

export interface Finding {
  kind: FindingKind
  detail: string
}

export interface ResumeRecommendation {
  recommended: boolean
  /** When true, resumeFromRunId only replays cached agents IN THE ORIGINATING SESSION;
   * read off disk in a different session, the cache is gone and everything re-runs. */
  sameSessionOnly: boolean
  rationale: string
}

export interface DiagnosisStats {
  runId: string
  status: string
  workflowName: string
  agentCount: number
  doneAgents: number
  incompleteAgents: number
  retriedAgents: number
  totalTokens: number
  totalToolCalls: number
  durationMs: number
}

export interface Diagnosis {
  mode: DiagnosisMode
  headline: string
  findings: Finding[]
  resume: ResumeRecommendation
  stats: DiagnosisStats
}

// Unobserved free-text signal — used ONLY to attach an advisory Finding, never to pick
// a primary mode. Broad on purpose (informational); a miss degrades to plain script-throw.
const BUDGET_HINT = /budget|token target|\bfloor\b|remaining|exhaust/i

export function diagnoseRun(j: WorkflowJournal): Diagnosis {
  const done = doneAgents(j)
  const incomplete = incompleteAgents(j)
  const retried = retriedAgents(j)
  const status = j.status
  const isCompleted = status === 'completed'
  const isFailed = status === 'failed'
  const isLaunchFail = status === 'async_launched'

  const findings: Finding[] = []
  for (const a of incomplete) {
    findings.push({
      kind: 'dead-agent',
      detail: `agent "${a.label ?? a.agentId ?? '?'}" ended in state "${a.state ?? '?'}" (expected "done")`,
    })
  }
  for (const a of retried) {
    findings.push({
      kind: 'schema-retry',
      detail: `agent "${a.label ?? a.agentId ?? '?'}" needed ${a.attempt} attempts (StructuredOutput schema retries)`,
    })
  }

  let mode: DiagnosisMode
  let headline: string

  if (isCompleted) {
    if (incomplete.length > 0) {
      mode = 'agent-died'
      headline = `Run completed but ${incomplete.length} agent(s) did not — partial result.`
    } else if (retried.length > 0) {
      mode = 'schema-retries'
      headline = `Run completed; ${retried.length} agent(s) needed schema retries — wasted latency/tokens.`
    } else {
      mode = 'completed-ok'
      headline = 'Run completed cleanly — no dead agents, no retries.'
    }
  } else if (isFailed || isLaunchFail) {
    if (isLaunchFail) {
      findings.push({
        kind: 'launch-failure',
        detail:
          'status "async_launched" — the script failed its pre-run syntax/meta check and never executed (no agents ran).',
      })
    }
    if (j.error && BUDGET_HINT.test(j.error)) {
      findings.push({
        kind: 'budget-hint',
        detail:
          'error text may indicate budget-floor exhaustion; if so, resume with a higher (or no) token target.',
      })
    }
    // A dead agent is the actionable cause; the script throw is its symptom (precedence).
    if (incomplete.length > 0) {
      mode = 'agent-died'
      headline = `Run failed with ${incomplete.length} incomplete agent(s) — the throw is likely a symptom of the dead agent.`
    } else {
      mode = 'script-throw'
      headline = isLaunchFail
        ? `Run never executed — ${firstErrorLine(j.error)}`
        : `Run threw before completing — ${firstErrorLine(j.error)}`
    }
  } else {
    // No terminal status (undefined / null / unknown): still running, aborted, or a zombie.
    mode = 'in-progress'
    headline = 'Run has no terminal status — still active, aborted, or a zombie.'
    findings.push({
      kind: 'zombie-hint',
      detail:
        'no terminal status recorded — the run may still be active, or a zombie (a dead agent the web UI still lists as running). Check the web UI before resuming.',
    })
  }

  return {
    mode,
    headline,
    findings,
    resume: recommendResume(mode, done.length, isLaunchFail),
    stats: {
      runId: j.runId,
      status: status ?? '(none)',
      workflowName: j.workflowName ?? '(unknown)',
      agentCount: j.agentCount ?? 0,
      doneAgents: done.length,
      incompleteAgents: incomplete.length,
      retriedAgents: retried.length,
      totalTokens: j.totalTokens ?? 0,
      totalToolCalls: j.totalToolCalls ?? 0,
      durationMs: j.durationMs ?? 0,
    },
  }
}

const SAME_SESSION = ' This only replays cached agents IN THE SESSION that produced the run; read off disk in a different session, the cache is gone and everything re-runs — prefer fixing and re-running.'

function recommendResume(
  mode: DiagnosisMode,
  doneCount: number,
  isLaunchFail: boolean,
): ResumeRecommendation {
  switch (mode) {
    case 'agent-died':
      return {
        recommended: true,
        sameSessionOnly: true,
        rationale: `${doneCount} agent(s) completed and are cached; resumeFromRunId replays them and only the incomplete agent(s) re-run.${SAME_SESSION}`,
      }
    case 'script-throw':
      if (isLaunchFail || doneCount === 0) {
        return {
          recommended: false,
          sameSessionOnly: false,
          rationale:
            'nothing ran before the failure — no cached agents to replay. Fix the script/args and run fresh; resumeFromRunId would save no work.',
        }
      }
      return {
        recommended: true,
        sameSessionOnly: true,
        rationale: `fix the script first, then resumeFromRunId replays the ${doneCount} cached agent(s) and the failing call onward re-runs.${SAME_SESSION}`,
      }
    case 'schema-retries':
    case 'completed-ok':
      return {
        recommended: false,
        sameSessionOnly: false,
        rationale: 'the run completed — nothing to resume.',
      }
    case 'in-progress':
      return {
        recommended: false,
        sameSessionOnly: false,
        rationale:
          'the run has no terminal status — do not resume a live run; wait for it to finish, or if it is a zombie, start fresh.',
      }
  }
}

function firstErrorLine(error: string | undefined): string {
  if (!error) return 'no error text recorded.'
  const line = error.split('\n')[0]?.trim() ?? ''
  return line.length > 0 ? line : 'no error text recorded.'
}
