// cache-warm.ts — prompt-cache warm-up for concurrent fan-out bursts (each
// pattern defaults its own `cacheWarm` option to true — opt OUT with `false`).
//
// WHY THIS EXISTS: N agents launched simultaneously each write the (identical)
// system/tools prefix to the provider's prompt cache before the first agent's
// write is reusable by the others — a fan-out burns N redundant cache WRITES
// instead of 1 write + (N-1) reads. This is a HEURISTIC latency/cost lever
// (provider-side cache behavior, not verified end-to-end by this module — see
// each pattern's `cacheWarm` doc comment) — never a correctness fix. These
// helpers themselves are neutral (a plain `enabled: boolean`, no baked-in
// default); ON-by-default is a decision each PATTERN makes at its own
// `cacheWarm ?? true` resolution. Passing `enabled: false` is byte-identical
// to a pattern's pre-cacheWarm behavior (see the early-return below).
//
// Two mechanisms, picked per pattern by its burst shape (rationale at each
// call site, not repeated here):
//
// (a) parallelWithCacheWarm / pipelineWithCacheWarm — "first-completes-then-
//     burst": run the FIRST real task alone to completion, then launch the
//     rest concurrently. Zero extra agents; costs +1 agent's latency on the
//     critical path (amortizes well when the burst is large). Model-agnostic:
//     works even when different items in the same burst resolve to different
//     models (e.g. scoreAndRank's per-dimension model override), because the
//     peeled-out call IS one of the real agents, never a stand-in.
//
// (b) runCacheWarmup — "warmup-agent": fire one throwaway agent with a
//     trivial prompt, await it, THEN launch all N real agents concurrently —
//     keeps the real burst's full concurrency (no latency stolen from a real
//     agent). Requires a single uniform model for the whole burst it primes (a
//     warmup agent on a DIFFERENT model does not share the prefix cache) — so
//     it is only used where a pattern's stage has one pattern-level model for
//     every agent in the burst, and where the burst is typically small enough
//     that mechanism (a)'s "-1 real slot" would materially hurt wall-clock
//     latency (e.g. a 3-vote verifier panel).
//
// Degradation (mechanism b): a null/failed warmup only warns via the shared
// warn() helper — the real burst always proceeds unaffected. A THROW from the
// warmup call (e.g. budget exhausted) is deliberately NOT caught here — it
// propagates exactly like any other direct (non-rt.parallel/rt.pipeline)
// rt.agent() call already used by these patterns (the planner/synthesis calls
// follow the same convention: a direct call's exception is a genuine resource
// ceiling, not a per-item degradation).

import type {
  WorkflowRuntime,
  AgentOptions,
  ModelAlias,
  EffortAlias,
  PipelineStage,
} from '@workflow-toolbox/runtime'
import { warn, makeRecord } from './envelope.js'
import type { TrailRecord } from './envelope.js'
import { externalGateExpectation } from './provenance-gate.js'

/** Trivial, cheap-to-answer prompt — the response is discarded; only the
 *  provider-side cache write from the shared system/tools prefix matters. */
const WARMUP_PROMPT = 'Reply with a single word: ready.'

/** External lanes need CLI output so a wrapper cannot claim a warmup without invoking it. */
function cliProofPrompt(cli: string): string {
  return (
    `You are being warmed on the "${cli}" external CLI lane. Run \`${cli} --version\` in the shell ` +
    `and reply with its EXACT stdout, then on a new line state the modelID you are running as. ` +
    `Do not answer from memory or guess. A reply without the real \`${cli} --version\` output does not count.`
  )
}

/** Reject self-answers while keeping this check independent of CLI-specific version formats. */
function hasPlausibleVersion(reply: string): boolean {
  // A self-answer carries no version string and fails; shape-only is deliberate (defeats the trivial self-answer, not a motivated forgery — accepted residual).
  return /\b\d+\.\d+\.\d+\b/.test(reply)
}

// ---------------------------------------------------------------------------
// Mechanism (a) — first-completes-then-burst, over rt.parallel
// ---------------------------------------------------------------------------

/**
 * Byte-identical to `rt.parallel(thunks)` when `enabled` is false or
 * `thunks.length <= 1` (nothing to warm ahead of). Otherwise runs `thunks[0]`
 * alone to completion first — mirroring rt.parallel's own never-rejects
 * contract for that call (a synchronously throwing thunk resolves to null,
 * never rejects) — then `rt.parallel(thunks.slice(1))`, and concatenates the
 * results back in the original order.
 */
export async function parallelWithCacheWarm<T>(
  rt: WorkflowRuntime,
  thunks: ReadonlyArray<() => Promise<T>>,
  enabled: boolean,
): Promise<Array<T | null>> {
  if (!enabled || thunks.length <= 1) {
    return rt.parallel(thunks)
  }

  const [first, ...rest] = thunks

  // `thunks.length > 1` is already guaranteed by the early return above, so
  // `first` is always defined — the assertion satisfies noUncheckedIndexedAccess
  // (array destructuring is treated like indexed access under this tsconfig).
  const firstResult = await Promise.resolve()
    .then(() => first!())
    .then((v): T | null => v)
    .catch((): null => null)

  const restResults = await rt.parallel(rest)

  return [firstResult, ...restResults]
}

// ---------------------------------------------------------------------------
// Mechanism (a) — first-completes-then-burst, over rt.pipeline
//
// rt.pipeline's `index` argument is POSITIONAL within the array passed to
// THAT call, not a global index into the caller's original items — splitting
// `items` naively into two rt.pipeline calls would reindex items[1..] starting
// from 0 again, breaking labels and trail attribution. offsetStages() re-bases
// each stage's `index` back to its position in the ORIGINAL `items` array.
// ---------------------------------------------------------------------------

function offsetStages(stages: readonly PipelineStage[], offset: number): PipelineStage[] {
  return stages.map((stage): PipelineStage =>
    (prev: unknown, originalItem: unknown, localIndex: number) =>
      stage(prev, originalItem, localIndex + offset),
  )
}

/**
 * Byte-identical to `rt.pipeline(items, ...stages)` when `enabled` is false or
 * `items.length <= 1`. Otherwise runs `items[0]` through the full stage chain
 * alone first, then the rest concurrently, preserving each item's original
 * index (see offsetStages above) so labels/trail are unaffected by the split.
 */
export async function pipelineWithCacheWarm(
  rt: WorkflowRuntime,
  items: readonly unknown[],
  stages: readonly PipelineStage[],
  enabled: boolean,
): Promise<unknown[]> {
  if (!enabled || items.length <= 1) {
    return rt.pipeline(items, ...stages)
  }

  const [first, ...rest] = items

  const firstResult = await rt.pipeline([first], ...offsetStages(stages, 0))
  const restResults = await rt.pipeline(rest, ...offsetStages(stages, 1))

  return [...firstResult, ...restResults]
}

// ---------------------------------------------------------------------------
// Mechanism (b) — warmup-agent
// ---------------------------------------------------------------------------

export interface CacheWarmupAgentOptions {
  phase?: string
  model?: ModelAlias
  effort?: EffortAlias
  agentType?: string
}

/**
 * Fire one throwaway warmup agent, mirroring the burst's own model/effort/
 * agentType exactly — model is the CONFIRMED cache-relevant dimension (a
 * different model never shares the prefix cache); effort/agentType are
 * matched defensively since they may also alter the cached system/tools
 * prefix (agentType changes the tool set; effort's effect on the cached
 * prefix is unconfirmed) — matching all three removes any risk of warming
 * the wrong cache entry.
 *
 * Returns the TrailRecord for the call; the CALLER pushes it onto its own
 * trail and does `agentsSpawned++` first — kept explicit at the call site,
 * matching the convention every other agent() call in this package already
 * follows (never buried inside a shared helper).
 *
 * Degrades gracefully: a null/failed warmup only warns (shared warn() helper)
 * — it never blocks or fails the real burst that follows.
 */
export async function runCacheWarmup(
  rt: WorkflowRuntime,
  warnings: string[],
  label: string,
  patternName: string,
  opts: CacheWarmupAgentOptions,
): Promise<TrailRecord> {
  const agentOpts: AgentOptions = {
    label,
    ...(opts.phase !== undefined ? { phase: opts.phase } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.agentType !== undefined ? { agentType: opts.agentType } : {}),
  }

  const lane = externalGateExpectation(opts.agentType)

  if (lane === null) {
    const result = await rt.agent(WARMUP_PROMPT, agentOpts)

    if (result === null) {
      warn(
        rt, warnings,
        `${patternName}: cache-warm agent (${label}) returned null — proceeding without a warmed cache`,
      )
    }

    return makeRecord(label, result !== null, {
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    })
  }

  const prompt = cliProofPrompt(lane.id)
  let reply = await rt.agent(prompt, agentOpts)
  let proven = typeof reply === 'string' && hasPlausibleVersion(reply)
  if (!proven) {
    reply = await rt.agent(prompt, agentOpts)
    proven = typeof reply === 'string' && hasPlausibleVersion(reply)
  }

  if (!proven) {
    warn(
      rt, warnings,
      `${patternName}: cache-warm ${lane.id} lane (${label}) SKIPPED — no real ${lane.id} --version came back after one retry (self-answer or CLI unavailable); proceeding without a warmed/proven lane`,
    )
  }

  return makeRecord(label, proven, {
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
  })
}
