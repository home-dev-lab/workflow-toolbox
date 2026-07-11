// with-agent-defaults.ts — wrap a WorkflowRuntime so every agent() call inherits
// a set of per-agent defaults, UNLESS the call sets that option explicitly.
//
// This is the Class-A "one wiring point" for launch-time agent tuning: wrap rt
// once at the top of run(), pass the wrapped rt to patterns, and every agent in
// every pattern downstream inherits model / effort / agentType / isolation /
// stallMs — WITHOUT each pattern wiring a per-role knob. Per-call opts always
// WIN (these are DEFAULTS, not overrides), so a pattern that pins, say,
// judgeModel:'opus' keeps 'opus'.
//
// Why wrapping `agent` alone is sufficient: parallel()/pipeline() merely execute
// the thunks/stages handed to them, and those close over THIS wrapped runtime's
// agent (the pattern calls rt.agent inside them). So the defaults propagate
// through parallel/pipeline automatically — no need to wrap them too.
//
// SANDBOX-PURE: type-only imports from runtime, no Node APIs — safe to bundle
// into workflow artifacts (a workflow author calls this at the top of run()).

import type { AgentFn, AgentOptions, WorkflowRuntime } from './types.js'

/** The per-agent options withAgentDefaults can pre-fill: the universal per-agent
 *  knobs only. Deliberately excludes `label`/`phase`/`schema` — those are
 *  per-call-meaningful (a display name or output schema is never a sensible
 *  blanket default). */
export type AgentDefaults = Pick<AgentOptions, 'model' | 'effort' | 'agentType' | 'isolation' | 'stallMs'>

/** Return a WorkflowRuntime whose agent() merges `defaults` UNDER each call's
 *  own opts (explicit per-call opts win). `parallel`/`pipeline`/`budget`/
 *  `workflow` are carried through by reference; `phase`/`log` are re-exposed as
 *  thin arrow wrappers that call back through the source rt.
 *
 *  Why arrow wrappers and NOT `{ ...rt }` or `.bind`: a plain spread copies only
 *  OWN enumerable props, dropping `phase`/`log` when they are prototype methods
 *  (e.g. on FakeRuntime); but `.bind(rt)` ALSO fails — in the real Workflow
 *  sandbox the runtime members are host-provided functions whose `.bind` is not
 *  usable (`rt.phase.bind` is undefined). `(t) => rt.phase(t)` sidesteps both: it
 *  invokes `phase` as a method on rt (so `this` is correct for class runtimes)
 *  without ever touching `.bind` — the exact call shape patterns already use in
 *  production. The thunks run by parallel/pipeline close over this wrapped agent,
 *  so the defaults reach them too.
 *
 *  Composable: wrapping twice stacks with OUTER (last-applied) precedence — the
 *  outer wrap's defaults arrive as the inner wrap's per-call `opts` and therefore
 *  win on conflicting keys; each wrap fills only the keys the outer ones left
 *  unset. An empty `defaults` yields an equivalent runtime. */
export function withAgentDefaults(rt: WorkflowRuntime, defaults: AgentDefaults): WorkflowRuntime {
  const agent: AgentFn = <T = string>(prompt: string, opts?: AgentOptions): Promise<T | null> =>
    rt.agent<T>(prompt, { ...defaults, ...opts })
  return {
    agent,
    parallel: rt.parallel,
    pipeline: rt.pipeline,
    phase: (title: string): void => rt.phase(title),
    log: (message: string): void => rt.log(message),
    budget: rt.budget,
    workflow: rt.workflow,
  }
}
