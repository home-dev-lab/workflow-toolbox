// Runtime surface types for @workflow-toolbox/runtime.
// These are the ONLY coupling point to the Claude Code sandbox API.
// If the sandbox surface changes, update here and nowhere else.

/** Model aliases understood by Claude Code's resolver, plus pass-through for full model IDs. */
export type ModelAlias = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'inherit' | (string & {})

/** Minimal structural type for JSON Schema objects. Consumers derive TS types
 *  via json-schema-to-ts (FromSchema) on their side — this package does not
 *  depend on that library. */
export type JsonSchema = { readonly [k: string]: unknown }

/** Options accepted by agent(). All fields map 1-to-1 to the sandbox API (§6). */
export interface AgentOptions {
  /** Display name shown in /workflows. Not part of the resume cache key. */
  label?: string
  /** Assign this call to a named progress group. Overrides the current phase()
   *  for this single call only. Not part of the cache key. */
  phase?: string
  /** JSON Schema. Forces structured output; agent() returns the validated object. */
  schema?: JsonSchema
  /** Per-agent model alias or full model ID. Omit to inherit the session model. */
  model?: ModelAlias
  /** Run the agent in a fresh git worktree. Expensive — use only when parallel
   *  agents mutate files that would otherwise collide. */
  isolation?: 'worktree'
  /** Run as a registered subagent type instead of the default workflow subagent. */
  agentType?: string
  /** Override this agent's stall timeout (default 180 000 ms). */
  stallMs?: number
}

/** A single pipeline stage callback.
 *  Receives (prevResult, originalItem, index). A throw drops the item to null
 *  and skips remaining stages for that item. */
export type PipelineStage = (prev: unknown, originalItem: unknown, index: number) => unknown

/** agent() return type:
 *  - no schema → string (final text verbatim)
 *  - schema + T annotation → T (validated object)
 *  - skipped/failed → null
 *
 *  Generics stay one level deep per architecture §9. */
export type AgentFn = <T = string>(prompt: string, opts?: AgentOptions) => Promise<T | null>

/** pipeline() processes each item through all stages independently (no barrier
 *  between stages). Stage callbacks receive (prev, originalItem, index).
 *
 *  Deliberately untyped (unknown in/out): typing variadic stage chains would
 *  need conditional-type gymnastics banned by architecture §9. Patterns narrow
 *  at their own boundary; raw compositions cast at the consumption site. */
export type PipelineFn = (items: readonly unknown[], ...stages: readonly PipelineStage[]) => Promise<unknown[]>

/** parallel() runs all thunks concurrently. A thunk that throws resolves to
 *  null in the result array; the call itself never rejects. */
export type ParallelFn = <T>(thunks: ReadonlyArray<() => Promise<T>>) => Promise<Array<T | null>>

/** Token budget for the current turn. The target is a hard ceiling — agent()
 *  throws once spent() >= total. The pool is shared across all workflows
 *  running in the same turn. */
export interface Budget {
  /** The user-set token target, or null if none was set. */
  readonly total: number | null
  /** Output tokens spent this turn. */
  spent(): number
  /** max(0, total − spent()), or Infinity when total is null. */
  remaining(): number
}

/** workflow() runs another workflow inline and returns its result.
 *  One nesting level only — calling workflow() inside a child throws. */
export type WorkflowFn = (nameOrRef: string | { scriptPath: string }, args?: unknown) => Promise<unknown>

/** The rt object passed to every pattern function. Patterns never read
 *  ambient sandbox globals — they always receive rt explicitly.
 *
 *  NOTE: args is intentionally absent here. Input normalization is
 *  defineWorkflow's job (M3); patterns receive typed input separately. */
export interface WorkflowRuntime {
  agent: AgentFn
  parallel: ParallelFn
  pipeline: PipelineFn
  phase(title: string): void
  log(message: string): void
  budget: Budget
  workflow: WorkflowFn
}
