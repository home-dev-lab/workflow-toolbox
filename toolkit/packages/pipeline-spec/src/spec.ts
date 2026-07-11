// spec.ts — the declarative PipelineSpec authoring/validation surface: pure data shapes plus
// synchronous structural validation, shared verbatim between the observe-ui pipeline runner
// (apps/observe-ui/server/pipeline.ts, which owns everything RUNTIME — gates, manifests,
// launch orchestration) and definePipeline() (@workflow-toolbox/build), so an authored spec and
// a live-launched spec are validated by the EXACT SAME rules. Extracted from
// apps/observe-ui/server/pipeline.ts + pipeline-manifest.ts (I5 authoring increment) —
// single source of truth; the app now imports this instead of defining it locally.
//
// Zero dependencies (same leaf-package posture as @workflow-toolbox/std) — every check here is
// a plain `typeof`/`Array.isArray` guard; this module never needed `isRecord`.

/** The single source of truth for InputRef's `from` values — parseInputRef validates against
 *  this SAME array (imported, not hand-duplicated), so adding a source is a one-place change
 *  the compiler enforces via InputRef's derived type. */
export const INPUT_REF_SOURCES = ['artifactPath', 'goal', 'projectDir'] as const

/** A declarative reference to a runtime value a stage's args template pulls in at launch —
 *  never a function, so the whole spec round-trips through JSON untouched. */
export type InputRef = { from: (typeof INPUT_REF_SOURCES)[number] }

/** The single source of truth for the named extractor keys a StageSpecV2 can select —
 *  parseStageSpecV2 validates against this SAME array (imported, not hand-duplicated), so
 *  adding an extractor is a one-place change the compiler enforces via ExtractorKey's derived
 *  type. The extraction FUNCTION itself (what actually pulls a handoff artifact out of a
 *  stage's result) is a runtime concern and stays in apps/observe-ui/server/extract-artifact.ts
 *  — only the key enumeration is shared here, since an author only ever CHOOSES a key, never
 *  runs one. */
export const EXTRACTOR_KEYS = ['plan-artifact', 'raw'] as const

export type ExtractorKey = (typeof EXTRACTOR_KEYS)[number]

// MAINTAINER NOTE (pr-review I5, batch 6): adding a field to PipelineSpec/StageSpecV2 below
// requires updating parsePipelineSpec/parseStageSpecV2 (this file, further down) IN LOCKSTEP —
// definePipeline() (@workflow-toolbox/build) round-trips every authored spec through this SAME
// parser at author time and will fail consumers' builds otherwise (a type-only field addition
// compiles fine but throws at the very next `workflow-toolbox pipeline` build).

/** One stage in a v2 pipeline spec: which workflow to run, how to build its args from prior
 *  state (`input`), how to extract its handoff artifact for the NEXT stage (`artifact`,
 *  default 'raw'), and whether a human gate follows it before the next stage launches
 *  (`gateAfter`). */
export interface StageSpecV2 {
  name: string
  /** Exactly one of `workflow`/`pipeline` (validateStageList enforces this — a stage either
   *  launches a single workflow directly, or recurses into a nested sub-pipeline). */
  workflow?: string
  /** An INLINE (v1: no by-reference child specs) nested pipeline this stage
   *  recurses into via the SAME runner, as a full first-class pipeline (own pipelineId, own
   *  manifest). Mutually exclusive with `workflow`. `gateAfter` is disallowed on a
   *  pipeline-stage in v1 (a design decision, not a technical limit — gates INSIDE the child
   *  work unchanged); `artifact.extract` must be 'raw' or omitted (the handoff is always the
   *  child's own raw final output — see the runner's settlePipelineStage / PipelineRecord.parent
   *  doc for why a non-'raw' extractor would silently diverge between live and reconciled
   *  paths). */
  pipeline?: PipelineSpec
  input?: Record<string, InputRef>
  gateAfter?: boolean
  /** Named extractor key into the server-side registry (extract-artifact.ts) — NOT a
   *  function, so the spec stays JSON-serializable. Applies to every non-last stage
   *  (whether gated or not) since a later stage's `input` may reference `artifactPath`;
   *  ignored on the last stage (nothing downstream to hand off to). Default 'raw'. */
  artifact?: { extract: ExtractorKey }
}

/** The full declarative pipeline definition — goal/projectDir/workspace once, then an
 *  ordered stage list. Persisted verbatim as manifest.spec so a recalled/resumed pipeline
 *  can be re-driven without the caller re-supplying it. */
export interface PipelineSpec {
  goal: string
  projectDir: string
  workspaceId?: string
  /** The pipeline's PATTERN name, symmetric to a workflow's own `meta.name` (card
   *  #1813065099577918566, "pipelines become first-class citizens with a type"):
   *  `workflow-toolbox pipeline` derives it from the entry filename when the author doesn't
   *  set one (mirroring how a workflow artifact's name comes from its own filename
   *  convention), and the runner persists it onto the manifest (`PipelineManifest.type` — see
   *  pipeline-core.ts) so a pipeline run is recognizable by TYPE the same way a workflow run
   *  always has been, not just by its one-off `goal` string. Optional: a spec authored/
   *  submitted before this change (or a bare `{goal, projectDir}` legacy start() call) simply
   *  has none — the runner then falls back to the parent's own type for a nested
   *  pipeline-stage, or `null` for a top-level one (see startInternal's doc in
   *  apps/observe-ui/server/pipeline.ts). */
  name?: string
  stages: StageSpecV2[]
}

/** Hard cap on stages per spec: one POST must not auto-chain an unbounded number of
 *  unattended launches — the human-gate safety property depends on a human eventually
 *  being reachable in the loop for any long spec, not an indefinitely deep auto-chain. */
export const MAX_STAGES = 12

/** Hard cap on pipeline NESTING depth — a child's ancestor chain (root = depth 0) must never
 *  exceed this before instantiation refuses it. Enforced in TWO places: validateStageList below
 *  rejects a spec whose OWN STATIC nesting (fully computable from the submitted spec alone,
 *  before anything is minted) already exceeds this cap — a clean, zero-mutation failure at the
 *  validation boundary; apps/observe-ui/server/pipeline.ts's runner ALSO still checks the
 *  CUMULATIVE ancestors chain at instantiation (today's v1 inline-only child specs make the two
 *  checks always agree; the cumulative check is what will still matter once by-reference child
 *  specs land — a shallow SUBMITTED spec could reference an externally, already-deeply-nested
 *  child that no static read of the current spec alone could see). */
export const MAX_PIPELINE_DEPTH = 8

/** The spec's OWN internal nesting depth, fully computable from its `stage.pipeline` chains
 *  alone — 0 for a spec with no pipeline-stages, N for one nested N levels deep. Deliberately
 *  separate from the CUMULATIVE ancestors-chain check (the runner's startChildPipeline). */
function staticNestingDepth(stages: readonly StageSpecV2[]): number {
  let max = 0
  for (const stage of stages) {
    if (stage.pipeline !== undefined) max = Math.max(max, 1 + staticNestingDepth(stage.pipeline.stages))
  }
  return max
}

/** Structural validation of a spec's stage list — shared by parsePipelineSpec (untrusted JSON
 *  parse), definePipeline() (author-time TS validation), and the observe-ui runner's start()
 *  (defense in depth for a directly-constructed spec that bypassed that parse, e.g. a non-HTTP
 *  caller). Returns a human-readable reason, or null if well-formed. Does NOT validate
 *  individual stage fields (name/workflow/input shapes — parseStageSpecV2's job) or
 *  workflow-allowlist membership (the runner's own isKnownWorkflow loop, which needs the app's
 *  runtime allowlist).
 *
 *  Recurses into every pipeline-stage's OWN nested stage list, applying the SAME rules
 *  independently at each level (duplicate-name uniqueness is PER-LEVEL, never global — a
 *  child's stageAttempts lives in its own separate manifest, so a child stage sharing a name
 *  with a PARENT stage cannot collide). */
export function validateStageList(stages: readonly StageSpecV2[]): string | null {
  if (stages.length === 0) return 'a pipeline spec must have at least one stage'
  if (stages.length > MAX_STAGES) return `a pipeline spec may have at most ${MAX_STAGES} stages (got ${stages.length})`
  // Checked ONCE, up front, on the FULL stage list: a recursive call for a nested sub-spec
  // would only ever re-check a strictly SMALLER sub-problem (redundant, never a missed case) —
  // the outermost call's depth already covers the whole tree, so this rejects before the
  // per-stage loop below (and every caller's own minting/persisting) ever runs.
  const staticDepth = staticNestingDepth(stages)
  if (staticDepth > MAX_PIPELINE_DEPTH) {
    return `this pipeline nests ${staticDepth} levels deep on its own — exceeding MAX_PIPELINE_DEPTH (${MAX_PIPELINE_DEPTH}); rejected before minting or persisting anything`
  }
  const seen = new Set<string>()
  for (const stage of stages) {
    if (seen.has(stage.name)) return `duplicate stage name "${stage.name}" — stageAttempts is keyed by name and would silently clobber its attempt history`
    seen.add(stage.name)

    const hasWorkflow = stage.workflow !== undefined
    const hasPipeline = stage.pipeline !== undefined
    if (hasWorkflow === hasPipeline) {
      return `stage "${stage.name}" must set exactly one of "workflow" or "pipeline" (got ${hasWorkflow ? 'both' : 'neither'})`
    }
    if (hasPipeline) {
      if (stage.gateAfter === true) {
        return `stage "${stage.name}" is a sub-pipeline stage and has gateAfter:true — a human gate after a nested pipeline is disallowed in v1 (gates INSIDE the child work unchanged; a design decision, not a technical limitation)`
      }
      // A pipeline-stage's handoff is always the child's own already-durable finalArtifactPath,
      // passed straight through — no extraction ever runs at this boundary (the runner's
      // settlePipelineStage doc), so an `artifact` config here would silently never be
      // consulted. Disallow it outright rather than accept-and-ignore.
      if (stage.artifact !== undefined) {
        return `stage "${stage.name}" is a sub-pipeline stage — "artifact" is disallowed here (its handoff is always the child's own raw final output, passed through verbatim; no extractor ever runs at this boundary)`
      }
      const nestedError = validateStageList(stage.pipeline!.stages)
      if (nestedError !== null) return `stage "${stage.name}"'s nested pipeline is invalid: ${nestedError}`
    }
  }
  const last = stages[stages.length - 1]!
  if (last.gateAfter === true) {
    return `stage "${last.name}" is the LAST stage and has gateAfter:true — a trailing gate has no downstream stage to launch (exit-gate/sign-off semantics are a deliberate later design decision)`
  }
  return null
}

// Derived from the single source of truth (INPUT_REF_SOURCES / EXTRACTOR_KEYS above) rather
// than hand-duplicated — adding a member to either array is a one-place change the compiler
// enforces (InputRef/ExtractorKey's types are themselves derived from these same arrays).
const VALID_INPUT_FROM = new Set<string>(INPUT_REF_SOURCES)
const VALID_EXTRACTOR_KEYS = new Set<string>(EXTRACTOR_KEYS)

function parseInputRef(v: unknown): InputRef | null {
  if (typeof v !== 'object' || v === null) return null
  const from = (v as Record<string, unknown>)['from']
  return typeof from === 'string' && VALID_INPUT_FROM.has(from) ? { from: from as InputRef['from'] } : null
}

function parseStageSpecV2(v: unknown): StageSpecV2 | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  if (typeof s['name'] !== 'string') return null
  const name = s['name']

  // Exactly one of workflow/pipeline; validateStageList (called from parsePipelineSpec below,
  // both for this level and recursively for a nested one) re-checks this structurally, but a
  // stage missing/duplicating either must already fail HERE, at shape-parsing, same as any
  // other malformed field.
  const hasWorkflow = typeof s['workflow'] === 'string'
  const hasPipelineField = s['pipeline'] !== undefined
  if (hasWorkflow === hasPipelineField) return null

  let stage: StageSpecV2
  if (hasWorkflow) {
    stage = { name, workflow: s['workflow'] as string }
  } else {
    const nested = parsePipelineSpec(s['pipeline'])
    if (nested === null) return null
    stage = { name, pipeline: nested }
  }

  if (s['input'] !== undefined) {
    if (typeof s['input'] !== 'object' || s['input'] === null) return null
    // Object.create(null): `key` is a network-supplied input-template name — a plain `{}`
    // would let a "__proto__" key hit the inherited setter via bracket assignment instead of
    // becoming a normal own property (the object is only ever read via Object.entries/[key]
    // downstream, never relied on for prototype methods).
    const input: Record<string, InputRef> = Object.create(null) as Record<string, InputRef>
    for (const [key, rawRef] of Object.entries(s['input'] as Record<string, unknown>)) {
      const ref = parseInputRef(rawRef)
      if (ref === null) return null // one bad entry invalidates the whole stage (all-or-nothing, like spec below)
      input[key] = ref
    }
    stage.input = input
  }
  if (s['gateAfter'] !== undefined) {
    if (typeof s['gateAfter'] !== 'boolean') return null
    stage.gateAfter = s['gateAfter']
  }
  if (s['artifact'] !== undefined) {
    if (typeof s['artifact'] !== 'object' || s['artifact'] === null) return null
    const extract = (s['artifact'] as Record<string, unknown>)['extract']
    if (typeof extract !== 'string' || !VALID_EXTRACTOR_KEYS.has(extract)) return null
    stage.artifact = { extract: extract as ExtractorKey }
  }
  return stage
}

// MAINTAINER NOTE (pr-review I5, batch 6): this parser must stay in lockstep with
// PipelineSpec/StageSpecV2 above — a field added to those types but not here still compiles
// (TypeScript can't see this runtime check), but definePipeline() (@workflow-toolbox/build)
// round-trips every authored spec through parsePipelineSpec at author time, so the very next
// `workflow-toolbox pipeline` build of an otherwise-valid spec throws.

/** Parse untrusted JSON (an HTTP body, a disk-persisted manifest's `spec` field, an emitted
 *  definePipeline() artifact re-read as a round-trip check) into a validated PipelineSpec, or
 *  null on any malformed shape. */
export function parsePipelineSpec(v: unknown): PipelineSpec | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  if (typeof s['goal'] !== 'string' || typeof s['projectDir'] !== 'string') return null
  if (!Array.isArray(s['stages'])) return null
  const stages: StageSpecV2[] = []
  for (const rawStage of s['stages']) {
    const stage = parseStageSpecV2(rawStage)
    if (stage === null) return null
    stages.push(stage)
  }
  // Structural checks shared with the runner's start() defense-in-depth guard: empty, over the
  // MAX_STAGES cap, duplicate names, or a trailing gateAfter all fail here, at the
  // untrusted-JSON boundary — never reaching a persisted, orphaned record.
  if (validateStageList(stages) !== null) return null
  const spec: PipelineSpec = { goal: s['goal'], projectDir: s['projectDir'], stages }
  if (s['workspaceId'] !== undefined) {
    if (typeof s['workspaceId'] !== 'string') return null
    spec.workspaceId = s['workspaceId']
  }
  if (s['name'] !== undefined) {
    // Non-empty string when present, else absent — an empty "" name would defeat the whole
    // point (a manifest's `type` derived from it would be an empty-but-truthy value, never
    // falling back to a parent's own type via `??`), so it's rejected the same all-or-nothing
    // way as every other malformed optional field here, not silently coerced to absent.
    if (typeof s['name'] !== 'string' || s['name'].length === 0) return null
    spec.name = s['name']
  }
  return spec
}
