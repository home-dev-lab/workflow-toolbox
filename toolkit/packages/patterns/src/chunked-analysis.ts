// chunked-analysis.ts — deterministic chunked map-analyze + synthesis barrier.
//
// The RLM-like shape: content too large for one context (a big diff, a long log,
// a CSV) is split by a PURE deterministic chunker (plain code — no agent, no
// tokenizer), each chunk is analyzed by its own fresh-context agent in parallel,
// then ONE synthesis agent folds the per-chunk analyses into the final answer.
//
// Why chars, not tokens (deliberate): a real tokenizer would be a heavy runtime
// dependency AND non-portable across models. Characters are a coarse but STABLE,
// dependency-free proxy — the chunker stays pure and unit-testable in isolation,
// and the sandbox's determinism bans (no Date/Math.random) hold trivially. Size
// `maxChars` conservatively for the model you route the analyze agents to.
//
// Why rt.parallel (not rt.pipeline) for the map stage:
//   The synthesis barrier IS this pattern's reason to exist — it genuinely needs
//   ALL chunk analyses before synthesizing. rt.parallel provides that barrier.
//   Per-chunk flows that DON'T need a barrier should use rt.pipeline instead.
//
// Conventions (same as all patterns):
// - Config errors throw synchronously at entry (bad chunker config, empty input,
//   maxChunks < 1, blank analyzeType/synthesizeType).
// - Agent failures degrade (dropped), never throw out. Budget exhaustion during
//   the fan-out degrades a chunk to null via rt.parallel (counted in dropped),
//   exactly like fanOutAndSynthesize; the synthesis await surfaces it like the
//   other barrier patterns.
// - If every chunk analysis is null → value null, synthesis NOT spawned.
// - If synthesis returns null → value null + warning.
// - opts.phase per-call, never rt.phase() (avoids global-state races).
// - Labels: chunkedAnalysis:chunk:<i> / chunkedAnalysis:synthesize — distinct per
//   chunk, so under defineWorkflow's prompt-tag wrapper each call salts to its own
//   resume cache key.

import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { warn, applyCap, makeRecord, emitDigest, assertAgentTypeOption } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'
import { parallelWithCacheWarm } from './cache-warm.js'

const STAGE = 'chunkedAnalysis'

// ---------------------------------------------------------------------------
// Chunker — a PURE, exported, unit-testable-in-isolation function.
// ---------------------------------------------------------------------------

export interface ChunkingOptions {
  /** Hard upper bound on a chunk's length in characters. A single line longer
   *  than this is hard-cut at the limit (line-boundary preference cannot help). */
  maxChars: number
  /** Characters carried from the previous chunk's tail into the next chunk's
   *  head (context continuity across a cut). Must be < maxChars so every step
   *  makes forward progress. Default 0 (no overlap). Overlap is applied WITHIN a
   *  string, never carried ACROSS the elements of a string[] input — those
   *  elements are the caller's own pre-chunks and may be unrelated. */
  overlapChars?: number
}

/**
 * Split `input` into deterministic character-bounded chunks, preferring to cut
 * at line boundaries.
 *
 * Semantics:
 * - Each chunk is at most `maxChars` characters.
 * - When a hard cut would fall mid-line, the cut moves back to the last '\n'
 *   at/before the limit (the newline stays at the END of the earlier chunk), so
 *   whole lines stay together — UNLESS a single line exceeds `maxChars`, which
 *   is hard-cut at the limit.
 * - `overlapChars` > 0 starts each next chunk `overlapChars` characters before
 *   the previous cut, so the previous chunk's tail repeats at the next chunk's
 *   head. When a (short, line-boundary) chunk is no longer than the overlap, the
 *   overlap is skipped for that step to guarantee forward progress.
 * - `string[]` input is treated as caller-supplied pre-chunks: each element is
 *   independently re-split by the SAME rules and the results are concatenated in
 *   element order. Empty strings contribute no chunks.
 *
 * Pure and deterministic: identical inputs always yield identical output, no
 * clocks, no randomness — safe to run inside the Workflow sandbox.
 *
 * @throws if `maxChars` is not an integer >= 1, or `overlapChars` is not an
 * integer in [0, maxChars) — thrown synchronously with an actionable message.
 */
export function chunkText(
  input: string | readonly string[],
  options: ChunkingOptions,
): string[] {
  const { maxChars, overlapChars = 0 } = options

  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error(
      `chunkText: maxChars must be an integer >= 1, got ${String(maxChars)}`,
    )
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0) {
    throw new Error(
      `chunkText: overlapChars must be an integer >= 0, got ${String(overlapChars)}`,
    )
  }
  if (overlapChars >= maxChars) {
    throw new Error(
      `chunkText: overlapChars (${overlapChars}) must be < maxChars (${maxChars}) — ` +
      `an overlap >= the chunk size makes no forward progress`,
    )
  }

  const pieces = typeof input === 'string' ? [input] : input
  const out: string[] = []
  for (const piece of pieces) {
    chunkOnePiece(piece, maxChars, overlapChars, out)
  }
  return out
}

// Split ONE string, appending its chunks to `out` in reading order.
function chunkOnePiece(
  text: string,
  maxChars: number,
  overlapChars: number,
  out: string[],
): void {
  if (text.length === 0) return

  let start = 0
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length)

    // Line-boundary preference: only when this is NOT the final chunk (a mid-text
    // cut). Look back for the last '\n' at/before the limit; cut just after it so
    // the newline ends the earlier chunk. `nl > start` keeps the chunk non-empty
    // and guarantees progress (a lone '\n' at `start` falls back to the hard cut).
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1)
      if (nl > start) end = nl + 1
    }

    out.push(text.slice(start, end))
    if (end >= text.length) break

    // Advance, carrying the overlap tail. Guard: if the just-emitted chunk is no
    // longer than the overlap, dropping the overlap for this step is the only way
    // to keep `start` strictly increasing (no stall / infinite loop).
    let next = end - overlapChars
    if (next <= start) next = end
    start = next
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChunkedAnalysisOptions<TChunk> {
  /** Content to analyze. A string is chunked by the chunker; a string[] is
   *  treated as caller pre-chunks, each still re-split to respect maxChars. */
  input: string | readonly string[]
  /** Hard per-chunk character bound (see ChunkingOptions.maxChars). */
  maxChars: number
  /** Characters of previous-chunk tail carried into each next chunk (see
   *  ChunkingOptions.overlapChars). Omit for no overlap. */
  overlapChars?: number
  /** Prompt the analyzer for one chunk. `total` is the number of chunks that
   *  will actually be analyzed (post-cap), so a prompt can say "chunk i of N". */
  analyzePrompt: (chunk: string, index: number, total: number) => string
  analyzeSchema?: JsonSchema
  analyzeModel?: ModelAlias
  /** Per-chunk-analysis reasoning effort. Omit to inherit the session effort. */
  analyzeEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the chunk analyzer agents
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  analyzeType?: string
  /** Prompt the synthesis agent over the surviving (non-null) chunk analyses. */
  synthesizePrompt: (chunkResults: ReadonlyArray<TChunk>) => string
  synthesizeSchema?: JsonSchema
  synthesizeModel?: ModelAlias
  /** Per-synthesis reasoning effort. Omit to inherit the session effort. */
  synthesizeEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the synthesis agent
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  synthesizeType?: string
  phase?: string
  /** Cap on how many chunks are analyzed at all (truncation reported in
   *  stats.truncated; the first `maxChunks` chunks are kept, in reading order).
   *  The guard against an unbounded fan-out on a huge input. */
  maxChunks?: number
  /** Opt-in: stagger the chunk map stage so the first chunk agent completes
   *  (and writes the shared system/tools prefix to the provider's prompt
   *  cache) BEFORE the remaining chunks launch, instead of all N writing that
   *  prefix redundantly at once. Heuristic cost lever, not a correctness
   *  change — costs +1 chunk's latency on the critical path, which amortizes
   *  well when there are many chunks; default false = today's behavior,
   *  byte-identical. See @workflow-toolbox/patterns' cache-warm.ts. */
  cacheWarm?: boolean
}

export interface ChunkedAnalysisResult<TChunk, TOut> extends PatternResult<TOut | null> {
  /**
   * Per-chunk analyses that survived (non-null), in chunk order. Empty when
   * every chunk analyzer returned null (synthesis skipped). The synthesized
   * value is the nullable `value`; this carries the intermediate map results
   * so a caller can inspect or re-fold them without re-running the agents.
   */
  chunkResults: TChunk[]
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Chunk oversized `input` deterministically, analyze every chunk with its own
 * parallel agent (the map stage), barrier on all analyses, then run one
 * synthesis agent over the surviving analyses (the reduce stage).
 *
 * Config errors throw synchronously at entry (bad chunker config, input that
 * produces no chunks, maxChunks < 1, blank analyzeType/synthesizeType). Agent
 * failures degrade, never throw: null analyses are dropped (counted in
 * `stats.dropped` + warned). `value` is NULLABLE — null when every chunk
 * dropped (synthesis skipped) or when the synthesis agent itself returns null;
 * consumers must branch on it. `chunkResults` carries the surviving per-chunk
 * analyses in chunk order (like planAndExecute's workerResults).
 *
 * @example
 * ```ts
 * import { chunkedAnalysis } from '@workflow-toolbox/patterns'
 * import { FakeRuntime } from '@workflow-toolbox/runtime'
 *
 * // FIFO: one response per chunk agent, then the synthesis.
 * const rt = new FakeRuntime({ responses: ['errs in [0,999]', 'errs in [1000,1999]', 'clusters: OOM x2'] })
 *
 * const result = await chunkedAnalysis(rt, {
 *   input: hugeLog,               // e.g. a 200 KB log string
 *   maxChars: 1000,
 *   analyzePrompt: (chunk, i, total) => `Chunk ${i + 1}/${total}. List error signatures:\n${chunk}`,
 *   synthesizePrompt: (parts) => `Cluster these per-chunk error lists:\n${parts.join('\n')}`,
 * })
 *
 * if (result.value === null) {
 *   rt.log(`no synthesis: ${result.warnings.join('; ')}`)
 * } else {
 *   const { itemsIn, itemsOut, agentsSpawned, dropped, truncated } = result.stats
 *   rt.log(`synthesized ${itemsOut}/${itemsIn} chunks (${agentsSpawned} agents, ${dropped} dropped, ${truncated} truncated)`)
 *   rt.log(result.value)
 * }
 * ```
 */
export async function chunkedAnalysis<TChunk = string, TOut = string>(
  rt: WorkflowRuntime,
  options: ChunkedAnalysisOptions<TChunk>,
): Promise<ChunkedAnalysisResult<TChunk, TOut>> {
  const {
    input,
    maxChars,
    overlapChars,
    analyzePrompt,
    analyzeSchema,
    analyzeModel,
    analyzeEffort,
    analyzeType,
    synthesizePrompt,
    synthesizeSchema,
    synthesizeModel,
    synthesizeEffort,
    synthesizeType,
    phase,
    maxChunks,
    cacheWarm,
  } = options

  // -------------------------------------------------------------------------
  // Synchronous validation — throw with actionable messages
  // -------------------------------------------------------------------------

  assertAgentTypeOption(STAGE, 'analyzeType', analyzeType)
  assertAgentTypeOption(STAGE, 'synthesizeType', synthesizeType)

  if (maxChunks !== undefined && maxChunks < 1) {
    throw new Error(`chunkedAnalysis: maxChunks must be >= 1, got ${maxChunks}`)
  }

  // chunkText validates maxChars/overlapChars and throws synchronously here.
  const chunks = chunkText(input, {
    maxChars,
    ...(overlapChars !== undefined ? { overlapChars } : {}),
  })

  if (chunks.length === 0) {
    throw new Error(
      'chunkedAnalysis: input produced no chunks (empty input) — provide non-empty content to analyze',
    )
  }

  // -------------------------------------------------------------------------
  // Mutable counters
  // -------------------------------------------------------------------------

  let agentsSpawned = 0
  const warnings: string[] = []
  const trail: TrailRecord[] = []

  // -------------------------------------------------------------------------
  // Apply cap on chunk count (truncation reported, not silent)
  // -------------------------------------------------------------------------

  const { kept: keptChunks, truncated } = applyCap(chunks, maxChunks)
  const total = keptChunks.length

  if (truncated > 0) {
    warn(
      rt, warnings,
      `chunkedAnalysis: ${truncated} of ${chunks.length} chunks truncated by maxChunks=${maxChunks ?? '?'}`,
    )
  }

  // -------------------------------------------------------------------------
  // Map stage — fan out one analyzer agent per chunk via rt.parallel.
  // The barrier is justified: synthesis genuinely needs all analyses.
  // -------------------------------------------------------------------------

  const keptArray = keptChunks as readonly string[]

  const analyzeThunks = keptArray.map((chunk, i) => async (): Promise<TChunk | null> => {
    const opts: {
      label: string
      phase?: string
      schema?: JsonSchema
      model?: ModelAlias
      effort?: EffortAlias
      agentType?: string
    } = {
      label: `${STAGE}:chunk:${i}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(analyzeSchema !== undefined ? { schema: analyzeSchema } : {}),
      ...(analyzeModel !== undefined ? { model: analyzeModel } : {}),
      ...(analyzeEffort !== undefined ? { effort: analyzeEffort } : {}),
      ...(analyzeType !== undefined ? { agentType: analyzeType } : {}),
    }

    agentsSpawned++
    return rt.agent<TChunk>(analyzePrompt(chunk, i, total), opts)
  })

  const analyzeResults = await parallelWithCacheWarm(rt, analyzeThunks, cacheWarm ?? false)

  // -------------------------------------------------------------------------
  // Collect non-null analyses and append trail records in chunk-index order
  // AFTER the rt.parallel barrier (determinism: never completion order).
  // -------------------------------------------------------------------------

  const chunkResults: TChunk[] = []
  let dropped = 0

  for (let i = 0; i < analyzeResults.length; i++) {
    const r = analyzeResults[i]
    // One record per agentsSpawned++ in the map thunks above, in index order.
    trail.push(makeRecord(`${STAGE}:chunk:${i}`, r !== null, {
      ...(analyzeModel !== undefined ? { model: analyzeModel } : {}),
      ...(analyzeEffort !== undefined ? { effort: analyzeEffort } : {}),
    }))

    if (r !== null) {
      chunkResults.push(r as TChunk)
    } else {
      dropped++
    }
  }

  if (dropped > 0) {
    warn(
      rt, warnings,
      `chunkedAnalysis: ${dropped} of ${keptArray.length} chunk analyzers returned null`,
    )
  }

  // -------------------------------------------------------------------------
  // Reduce stage — synthesis only if we have at least one analysis
  // -------------------------------------------------------------------------

  let value: TOut | null = null

  if (chunkResults.length === 0) {
    warn(rt, warnings, 'chunkedAnalysis: every chunk analysis was null; synthesis skipped')
  } else {
    const synthOpts: {
      label: string
      phase?: string
      schema?: JsonSchema
      model?: ModelAlias
      effort?: EffortAlias
      agentType?: string
    } = {
      label: `${STAGE}:synthesize`,
      ...(phase !== undefined ? { phase } : {}),
      ...(synthesizeSchema !== undefined ? { schema: synthesizeSchema } : {}),
      ...(synthesizeModel !== undefined ? { model: synthesizeModel } : {}),
      ...(synthesizeEffort !== undefined ? { effort: synthesizeEffort } : {}),
      ...(synthesizeType !== undefined ? { agentType: synthesizeType } : {}),
    }

    agentsSpawned++
    const synthesis = await rt.agent<TOut>(synthesizePrompt(chunkResults), synthOpts)

    // Trail record for synthesis — adjacent to agentsSpawned++ above.
    trail.push(makeRecord(`${STAGE}:synthesize`, synthesis !== null, {
      ...(synthesizeModel !== undefined ? { model: synthesizeModel } : {}),
      ...(synthesizeEffort !== undefined ? { effort: synthesizeEffort } : {}),
    }))

    if (synthesis === null) {
      warn(rt, warnings, 'chunkedAnalysis: synthesis agent returned null')
    } else {
      value = synthesis
    }
  }

  // -------------------------------------------------------------------------
  // Stats (documented):
  // - itemsIn   = chunks produced BEFORE the cap (the chunker's full output)
  // - itemsOut  = surviving chunk analyses (NOT the synthesis: itemsOut > 0 with
  //   value === null means analyses survived but synthesis failed — the warning
  //   carries that signal, same convention as fanOutAndSynthesize/planAndExecute)
  // - dropped   = null chunk analyzers
  // - truncated = cap-cut chunks
  // - agentsSpawned = kept chunk analyzers + 1 synthesis (if attempted)
  // -------------------------------------------------------------------------

  const stats: PatternStats = {
    itemsIn: chunks.length,
    itemsOut: chunkResults.length,
    agentsSpawned,
    dropped,
    truncated,
  }

  // Phase digest: the map→reduce funnel. `chunks` is the PRE-cap count, so the
  // funnel balances: chunks === analyzed + dropped + truncated (the invariant
  // observe's loss chips render against).
  emitDigest(rt, {
    stage: STAGE,
    output: value === null ? 'synthesis: none' : `synthesis from ${chunkResults.length}/${chunks.length} chunks`,
    counts: { chunks: chunks.length, analyzed: chunkResults.length, dropped, truncated },
  })

  return { value, stats, warnings, trail, chunkResults }
}
