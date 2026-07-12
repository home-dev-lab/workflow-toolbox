// log-cluster-analysis.workflow.ts — chunkedAnalysis over an oversized log.
//
// PEDAGOGY: this example teaches 4 lessons about the chunkedAnalysis pattern:
//
//  (1) CONTENT IS PASSED IN, NOT READ BY THE ORCHESTRATOR — the sandbox denies
//      the workflow body filesystem access, and the whole point of chunking is
//      that the content is too big for ONE agent context. So the launching
//      session reads the log and hands the STRING to the workflow via
//      `args.log`; the in-code chunker splits it, and each chunk agent sees only
//      its slice. (Contrast doc-rewrite, where each agent re-reads a small doc.)
//
//  (2) CHARS ARE A DELIBERATE TOKEN PROXY — chunkedAnalysis splits by characters,
//      not tokens: a real tokenizer is a heavy, model-specific dependency, while
//      characters keep the chunker pure and deterministic (sandbox-safe). Size
//      `maxChars` conservatively for the model the analyze agents run on.
//
//  (3) MAP → REDUCE WITH A REAL BARRIER — each chunk is analyzed in parallel
//      (the map), then ONE synthesis agent clusters the per-chunk findings (the
//      reduce). The barrier is correct here: clustering genuinely needs every
//      chunk's error list before it can merge them.
//
//  (4) HARDENED STRUCTURED OUTPUT — both schemas put a SHORT decision field
//      first and BOUND every array/string (maxItems / maxLength). The analyze
//      schema leads with a `hasErrors` gate so the model commits to "are there
//      errors here?" before enumerating — the anti-capitulation guard that keeps
//      a retried agent from inventing signatures to fill a required array.
//
//  ON LAUNCH: ALWAYS check WorkflowOutput.error. On partial failure, relaunch
//  with resumeFromRunId — completed chunk agents replay from cache, only the
//  missing work re-runs.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import type { WorkflowRuntime, JsonSchema, EffortAlias } from '@workflow-toolbox/runtime'
import { resolveEffort } from '@workflow-toolbox/std'
import { chunkedAnalysis, collectTrail } from '@workflow-toolbox/patterns'
import type { TrailRecord } from '@workflow-toolbox/patterns'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Per-stage effort defaults (Class B/C launch-time tuning — see parseConfig).
// A launch-time `args.effort.<role>` override retunes either without a source
// edit. The per-chunk analyze is a cheap extraction sweep (map); the synthesis
// is the terminal reduce that merges every chunk's findings.
// ---------------------------------------------------------------------------
const ANALYZE_EFFORT: EffortAlias = 'medium'   // Map: extract error signatures from one chunk
const SYNTHESIZE_EFFORT: EffortAlias = 'high'  // Reduce: cluster all per-chunk findings

// Default chunk size in characters — conservative for a mid-size model context.
const DEFAULT_MAX_CHARS = 4000

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface LogClusterInput {
  /** The full log text to analyze. The launcher reads the file and passes the
   *  string — the sandboxed workflow body cannot read the filesystem itself. */
  log: string
  /** Per-chunk character bound. Default DEFAULT_MAX_CHARS. */
  maxChars: number
  /** Characters of previous-chunk tail carried into each next chunk (context
   *  continuity for a signature that straddles a cut). Default 0. */
  overlapChars: number
  /** Optional hard cap on how many chunks are analyzed (guards a giant log). */
  maxChunks: number | null
  /** Optional per-role effort overrides ('analyze' | 'synthesize'). null = none. */
  effort: Readonly<Record<string, EffortAlias | 'auto'>> | null
}

// ---------------------------------------------------------------------------
// JSON Schemas — hardened: short decision field first, every array/string bounded
// ---------------------------------------------------------------------------

// Per-chunk analysis: a `hasErrors` gate leads (anti-capitulation guard), then a
// BOUNDED list of short signatures. Bounds keep a retried agent from inventing
// junk to satisfy a required array.
const CHUNK_SCHEMA = {
  type: 'object',
  properties: {
    hasErrors: { type: 'boolean' },
    signatures: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', maxLength: 80 },
          count: { type: 'integer', minimum: 1 },
        },
        required: ['kind', 'count'],
        additionalProperties: false,
      },
    },
  },
  required: ['hasErrors', 'signatures'],
  additionalProperties: false,
} as const satisfies JsonSchema

type ChunkAnalysis = FromSchema<typeof CHUNK_SCHEMA>

// Synthesis: merge per-chunk signatures into clusters. Arrays + prose bounded.
const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', maxLength: 120 },
          totalCount: { type: 'integer', minimum: 1 },
        },
        required: ['label', 'totalCount'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string', maxLength: 2000 },
  },
  required: ['clusters', 'summary'],
  additionalProperties: false,
} as const satisfies JsonSchema

type ClusterReport = FromSchema<typeof CLUSTER_SCHEMA>

// ---------------------------------------------------------------------------
// Final workflow output
// ---------------------------------------------------------------------------

interface LogClusterOutput {
  /** The clustered report, or null when every chunk analysis failed / the
   *  synthesis agent returned null (see warnings). */
  report: ClusterReport | null
  chunksAnalyzed: number
  chunksTotal: number
  dropped: number
  truncated: number
  envelope: { trail: TrailRecord[] }
  warnings: string[]
}

// ---------------------------------------------------------------------------
// parseInput — fail fast with actionable errors
// ---------------------------------------------------------------------------

function parseInput(raw: unknown): LogClusterInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'log-cluster-analysis: input must be an object with a "log" string — ' +
      'received: ' + (raw === null ? 'null' : typeof raw),
    )
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj['log'] !== 'string' || obj['log'].length === 0) {
    throw new Error(
      'log-cluster-analysis: "log" must be a non-empty string — the launcher reads the ' +
      'log file and passes its contents (the sandboxed workflow cannot read files itself)',
    )
  }

  let maxChars = DEFAULT_MAX_CHARS
  if (obj['maxChars'] !== undefined) {
    if (typeof obj['maxChars'] !== 'number' || !Number.isInteger(obj['maxChars']) || obj['maxChars'] < 1) {
      throw new Error('log-cluster-analysis: "maxChars" must be an integer >= 1')
    }
    maxChars = obj['maxChars']
  }

  let overlapChars = 0
  if (obj['overlapChars'] !== undefined) {
    if (typeof obj['overlapChars'] !== 'number' || !Number.isInteger(obj['overlapChars']) || obj['overlapChars'] < 0) {
      throw new Error('log-cluster-analysis: "overlapChars" must be an integer >= 0')
    }
    overlapChars = obj['overlapChars']
  }
  if (overlapChars >= maxChars) {
    throw new Error(
      `log-cluster-analysis: "overlapChars" (${overlapChars}) must be < "maxChars" (${maxChars})`,
    )
  }

  let maxChunks: number | null = null
  if (obj['maxChunks'] !== undefined) {
    if (typeof obj['maxChunks'] !== 'number' || !Number.isInteger(obj['maxChunks']) || obj['maxChunks'] < 1) {
      throw new Error('log-cluster-analysis: "maxChunks" must be an integer >= 1')
    }
    maxChunks = obj['maxChunks']
  }

  const effort = parseConfig(obj).effort ?? null

  return { log: obj['log'], maxChars, overlapChars, maxChunks, effort }
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

async function run(rt: WorkflowRuntime, input: LogClusterInput): Promise<LogClusterOutput> {
  const analyzeEffort = resolveEffort(input.effort?.['analyze'], ANALYZE_EFFORT)
  const synthesizeEffort = resolveEffort(input.effort?.['synthesize'], SYNTHESIZE_EFFORT)

  rt.phase('Analyze')

  const analysis = await chunkedAnalysis<ChunkAnalysis, ClusterReport>(rt, {
    input: input.log,
    maxChars: input.maxChars,
    overlapChars: input.overlapChars,
    ...(input.maxChunks !== null ? { maxChunks: input.maxChunks } : {}),
    analyzeSchema: CHUNK_SCHEMA,
    analyzeEffort,
    analyzePrompt: (chunk, index, total) =>
      `You are analyzing chunk ${index + 1} of ${total} of a larger log.\n` +
      `Identify distinct ERROR/exception signatures in THIS chunk only.\n` +
      `First decide whether this chunk contains any errors at all (hasErrors).\n` +
      `If it does, list each distinct signature as a short "kind" label plus how many ` +
      `times it appears in this chunk. Do NOT invent signatures — if there are none, ` +
      `return hasErrors=false and an empty signatures array.\n\n` +
      `--- chunk ${index + 1}/${total} ---\n${chunk}`,
    synthesizeSchema: CLUSTER_SCHEMA,
    synthesizeEffort,
    synthesizePrompt: (chunkReports) =>
      `Merge these per-chunk error findings into clusters across the WHOLE log.\n` +
      `Group signatures that are the same underlying error, sum their counts into ` +
      `totalCount, and give each cluster a concise label. Then write a short summary ` +
      `of the dominant failure modes.\n\n` +
      `Per-chunk findings (JSON):\n${JSON.stringify(chunkReports)}`,
    phase: 'Analyze',
  })

  rt.phase('Report')

  return {
    report: analysis.value,
    chunksAnalyzed: analysis.stats.itemsOut,
    chunksTotal: analysis.stats.itemsIn,
    dropped: analysis.stats.dropped,
    truncated: analysis.stats.truncated,
    envelope: { trail: collectTrail(analysis) },
    warnings: analysis.warnings,
  }
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'log-cluster-analysis',
    description:
      'Clusters the error signatures in an oversized log by chunking the text deterministically, ' +
      'analyzing each chunk in parallel for error signatures, then synthesizing the per-chunk ' +
      'findings into cross-log clusters with counts and a summary.',
    whenToUse:
      'Use when a log (or any large text) is too big for a single agent context and you need a ' +
      'map-analyze-then-synthesize pass — e.g. finding error clusters, extracting entities, or ' +
      'summarizing a huge diff. The launcher passes the text as args.log.',
    phases: [
      { title: 'Analyze', detail: 'Chunk the log, analyze each chunk in parallel, synthesize clusters' },
      { title: 'Report', detail: 'Surface the clustered report with honest chunk/drop/truncate counts' },
    ],
  },
  parseInput,
  run,
})
