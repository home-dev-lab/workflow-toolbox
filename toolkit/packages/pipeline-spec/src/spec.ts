// spec.ts — the declarative PipelineSpec authoring/validation surface: pure data shapes plus
// synchronous structural validation, shared verbatim with the Workflow Observatory pipeline
// runner (the companion repo's server/pipeline.ts, which owns everything RUNTIME — gates,
// manifests, launch orchestration) and definePipeline() (@workflow-toolbox/build), so an
// authored spec and a live-launched spec are validated by the EXACT SAME rules. Extracted
// from that runner (I5 authoring increment) — single source of truth; the companion app
// imports this instead of defining it locally.
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
 *  stage's result) is a runtime concern and stays in the companion app’s server (extract-artifact)
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

/** What decides "done" at each iteration boundary of a looped spec — a loop always names
 *  its stop condition. Exactly one flavor:
 *  - `{ gate: true }` — a human "loop gate" at EVERY iteration boundary (continue = run
 *    another iteration, stop = settle the pipeline). Distinct from a stage's own
 *    `gateAfter`, which re-arms every iteration INSIDE the body; the loop gate sits on top,
 *    at the boundary. The literal is `true` — `gate: false` has no meaning and is rejected.
 *  - `{ criterion: '<key>' }` — a named key into the RUNNER's predicate registry, evaluated
 *    against the last stage's settled handoff artifact (e.g. the seed predicate
 *    `artifact-empty`: stop when the handoff is empty — "no findings left"). Launch-time
 *    validated by the runner, exactly like a workflow name against its allowlist — this
 *    package checks SHAPE only (non-empty string), never key membership. */
export type LoopUntil = { gate: true } | { criterion: string }

/** Re-run the owning spec's WHOLE stage list until `until` says stop, hard-capped by
 *  `maxIterations` — a SAME-MANIFEST re-entry at the iteration boundary (each iteration's
 *  runs are new runs; stage-attempt history appends). Valid on the ROOT spec and on any
 *  nested pipeline-stage's child spec (each level's loop is independent; a pipeline-stage
 *  inside a looped body still mints a FRESH child pipeline per iteration — the existing
 *  per-launch semantics, unchanged). The loop's execution lives in the Workflow Observatory
 *  runner; a runner whose bundled parser predates this field silently drops it (the
 *  pipeline runs once). */
export interface PipelineLoopSpec {
  /** What decides "done" at each iteration boundary (REQUIRED — see LoopUntil). */
  until: LoopUntil
  /** Hard iteration ceiling (REQUIRED safety net), integer 1..the owning spec's resolved
   *  `limits.maxLoopIterations` (default MAX_LOOP_ITERATIONS). Hitting it settles the run
   *  (runner vocabulary: stoppedBy 'maxIterations', mirroring the in-run loopUntilDone pattern). */
  maxIterations: number
}

/** Per-spec overrides for the safe structural defaults. Each present key must be an integer
 *  in the documented range for that key. */
export interface PipelineLimits {
  /** Overrides MAX_STAGES; validated as an integer in [1, MAX_STAGES_CEILING]. */
  maxStages?: number
  /** Overrides MAX_PIPELINE_DEPTH; validated as an integer in [1, MAX_PIPELINE_DEPTH_CEILING]. */
  maxPipelineDepth?: number
  /** Overrides MAX_LOOP_ITERATIONS; validated as an integer in [1, MAX_LOOP_ITERATIONS_CEILING]. */
  maxLoopIterations?: number
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
   *  the companion app’s pipeline runner). */
  name?: string
  stages: StageSpecV2[]
  /** Re-run the whole stage list until done (see PipelineLoopSpec). Absent = run once —
   *  every pre-loop spec keeps today's behavior untouched. */
  loop?: PipelineLoopSpec
  /** Per-spec structural cap overrides. Omitted uses the safe defaults; a nested
   *  pipeline-stage's child spec may set its own limits independently and inherits none.
   *  CAVEAT (maxPipelineDepth only, found in review): depth is checked TOP-DOWN — an
   *  ancestor's OWN resolved maxPipelineDepth is checked against the FULL remaining subtree
   *  beneath it (staticNestingDepth counts the whole descendant chain), and that check runs
   *  BEFORE recursion ever reaches a deeper child's own (possibly more permissive) `limits`.
   *  So a child spec's raised maxPipelineDepth only takes effect for depth occurring entirely
   *  beneath specs that themselves already permit reaching it — to allow deeper nesting
   *  ANYWHERE in a tree, raise maxPipelineDepth on the ANCESTOR whose own default would
   *  otherwise reject that depth (typically the root), not merely on the nested spec that
   *  needs the room. True per-branch independence (a child's override rescuing depth an
   *  ancestor's own default would otherwise reject) is a known gap, not yet implemented. */
  limits?: PipelineLimits
}

/** DEFAULT cap on stages per spec: one POST must not auto-chain an unbounded number of
 *  unattended launches — the human-gate safety property depends on a human eventually
 *  being reachable in the loop for any long spec, not an indefinitely deep auto-chain.
 *  See MAX_STAGES_CEILING for the absolute hard limit. */
export const MAX_STAGES = 12

/** DEFAULT cap on pipeline NESTING depth; see MAX_PIPELINE_DEPTH_CEILING for the absolute
 *  hard limit. Enforced in TWO places: validateStageList below rejects a spec whose OWN
 *  STATIC nesting (fully computable from the submitted spec alone, before anything is minted)
 *  exceeds its resolved cap — a clean, zero-mutation failure at the validation boundary; the
 *  companion app’s runner ALSO still checks the CUMULATIVE ancestors chain at instantiation
 *  (today's v1 inline-only child specs make the two checks always agree; the cumulative check
 *  is what will still matter once by-reference child specs land — a shallow SUBMITTED spec
 *  could reference an externally, already-deeply-nested child that no static read of the
 *  current spec alone could see). */
export const MAX_PIPELINE_DEPTH = 8

/** DEFAULT cap on a loop's `maxIterations` — same order of magnitude as the in-run
 *  loopUntilDone pattern's defaults. Bounds EVERY loop, gated or not, against its spec's
 *  resolved limit — the gate exemption below only lifts the resolved maxStages product cap,
 *  never this. See MAX_LOOP_ITERATIONS_CEILING for the absolute hard limit. */
export const MAX_LOOP_ITERATIONS = 10

/** Absolute ceiling for `limits.maxStages` — never overridable beyond this, regardless of what a spec's `limits` field requests. */
export const MAX_STAGES_CEILING = 100

/** Absolute ceiling for `limits.maxPipelineDepth` — never overridable beyond this, regardless of what a spec's `limits` field requests. */
export const MAX_PIPELINE_DEPTH_CEILING = 20

/** Absolute ceiling for `limits.maxLoopIterations` — never overridable beyond this, regardless of what a spec's `limits` field requests. */
export const MAX_LOOP_ITERATIONS_CEILING = 100

function resolveLimits(limits: PipelineLimits | undefined): { maxStages: number; maxPipelineDepth: number; maxLoopIterations: number } {
  return {
    maxStages: limits?.maxStages ?? MAX_STAGES,
    maxPipelineDepth: limits?.maxPipelineDepth ?? MAX_PIPELINE_DEPTH,
    maxLoopIterations: limits?.maxLoopIterations ?? MAX_LOOP_ITERATIONS,
  }
}

/** Validate a caller-supplied PipelineLimits override (or its absence): each PRESENT key must be
 *  an integer in [1, its documented absolute ceiling] — returns a human-readable reason NAMING the
 *  offending knob, or null when the object (or its absence) is fine. Shared by the untrusted-JSON
 *  parse path and the trusted validate*-on-an-already-built-spec path (defense in depth, same
 *  posture as every other check in this file). */
function validateLimitsShape(limits: PipelineLimits | undefined): string | null {
  if (limits === undefined) return null
  const ceilings = { maxStages: MAX_STAGES_CEILING, maxPipelineDepth: MAX_PIPELINE_DEPTH_CEILING, maxLoopIterations: MAX_LOOP_ITERATIONS_CEILING } as const
  for (const key of ['maxStages', 'maxPipelineDepth', 'maxLoopIterations'] as const) {
    const v = limits[key]
    if (v === undefined) continue
    const ceiling = ceilings[key]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > ceiling) {
      return `limits.${key} must be an integer between 1 and its documented absolute ceiling (${ceiling}), got ${String(v)}`
    }
  }
  return null
}

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
export function validateStageList(stages: readonly StageSpecV2[], limits?: PipelineLimits): string | null {
  const limitsError = validateLimitsShape(limits)
  if (limitsError !== null) return limitsError
  const resolved = resolveLimits(limits)
  if (stages.length === 0) return 'a pipeline spec must have at least one stage'
  if (stages.length > resolved.maxStages) {
    return `a pipeline spec may have at most ${resolved.maxStages} stages (got ${stages.length}) — raise via limits.maxStages, up to the documented absolute ceiling of ${MAX_STAGES_CEILING}`
  }
  // Checked ONCE, up front, on the FULL stage list: a recursive call for a nested sub-spec
  // would only ever re-check a strictly SMALLER sub-problem (redundant, never a missed case) —
  // the outermost call's depth already covers the whole tree, so this rejects before the
  // per-stage loop below (and every caller's own minting/persisting) ever runs.
  const staticDepth = staticNestingDepth(stages)
  if (staticDepth > resolved.maxPipelineDepth) {
    const defaultLimitNote = limits?.maxPipelineDepth === undefined ? `; default MAX_PIPELINE_DEPTH (${MAX_PIPELINE_DEPTH})` : ''
    return `this pipeline nests ${staticDepth} levels deep on its own — exceeding limits.maxPipelineDepth (${resolved.maxPipelineDepth}); raise via limits.maxPipelineDepth, up to the documented absolute ceiling of ${MAX_PIPELINE_DEPTH_CEILING}; rejected before minting or persisting anything${defaultLimitNote}`
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
      const nestedError = validateStageList(stage.pipeline!.stages, stage.pipeline!.limits)
      if (nestedError !== null) return `stage "${stage.name}"'s nested pipeline is invalid: ${nestedError}`
    }
  }
  const last = stages[stages.length - 1]!
  if (last.gateAfter === true) {
    return `stage "${last.name}" is the LAST stage and has gateAfter:true — a trailing gate has no downstream stage to launch (exit-gate/sign-off semantics are a deliberate later design decision)`
  }
  return null
}

/** Total workflow LAUNCHES one pass over `stages` can trigger, loops expanded: a
 *  workflow-stage counts 1; a pipeline-stage counts its child's own expanded total × the
 *  child's loop ceiling (each parent pass launches a fresh child, and that child re-runs its
 *  own list up to child.loop.maxIterations times). Static — fully computable from the
 *  submitted spec alone, mirroring staticNestingDepth's recursion. */
function expandedLaunches(stages: readonly StageSpecV2[]): number {
  let total = 0
  for (const stage of stages) {
    if (stage.pipeline !== undefined) {
      total += expandedLaunches(stage.pipeline.stages) * (stage.pipeline.loop?.maxIterations ?? 1)
    } else {
      total += 1
    }
  }
  return total
}

/** True when a human is reachable ANYWHERE in this stage list's expanded subtree — a
 *  stage-level `gateAfter` at any nesting level, or a nested child loop whose own `until`
 *  is the gate flavor. This is what exempts a criterion-loop from the MAX_STAGES product
 *  cap: the cap protects the "one POST must not auto-chain unbounded unattended launches"
 *  property, and a gate anywhere in the subtree puts a human back in the loop. */
function hasGateInSubtree(stages: readonly StageSpecV2[]): boolean {
  for (const stage of stages) {
    if (stage.gateAfter === true) return true
    if (stage.pipeline !== undefined) {
      const childLoop = stage.pipeline.loop
      if (childLoop !== undefined && 'gate' in childLoop.until) return true
      if (hasGateInSubtree(stage.pipeline.stages)) return true
    }
  }
  return false
}

/** Validate ONE level's `loop` against its own stage list — until shape, maxIterations
 *  bounds, and the ungated-criterion expanded budget. Shared by parsePipelineSpec (applied
 *  to each level right after that level parses) and validatePipelineSpec (defense in depth
 *  for a directly-constructed spec, where a cast can bypass TypeScript exactly like
 *  everywhere else in this file — hence the runtime re-checks of typed fields). Returns a
 *  human-readable reason, or null. */
function validateLoop(spec: PipelineSpec): string | null {
  const limitsError = validateLimitsShape(spec.limits)
  if (limitsError !== null) return limitsError
  const resolved = resolveLimits(spec.limits)
  const loop = spec.loop
  if (loop === undefined) return null
  const until = loop.until as unknown
  let flavor: 'gate' | 'criterion' | null = null
  if (typeof until === 'object' && until !== null) {
    const u = until as Record<string, unknown>
    const hasGate = u['gate'] !== undefined
    const hasCriterion = u['criterion'] !== undefined
    if (hasGate !== hasCriterion) {
      if (hasGate && u['gate'] === true) flavor = 'gate'
      if (hasCriterion && typeof u['criterion'] === 'string' && u['criterion'].length > 0) flavor = 'criterion'
    }
  }
  if (flavor === null) {
    return `a pipeline loop's "until" must be exactly one of { gate: true } or { criterion: "<key>" } — a loop always names its stop condition`
  }
  const max = loop.maxIterations
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > resolved.maxLoopIterations) {
    return `a pipeline loop's maxIterations must be an integer between 1 and limits.maxLoopIterations (${resolved.maxLoopIterations}), got ${String(max)} — raise via limits.maxLoopIterations, up to the documented absolute ceiling of ${MAX_LOOP_ITERATIONS_CEILING}`
  }
  if (flavor === 'criterion' && !hasGateInSubtree(spec.stages)) {
    const perPass = expandedLaunches(spec.stages)
    const product = perPass * max
    if (product > resolved.maxStages) {
      const defaultLimitNote = spec.limits?.maxStages === undefined ? `; default MAX_STAGES (${MAX_STAGES})` : ''
      return (
        `an ungated criterion-loop may auto-chain at most limits.maxStages (${resolved.maxStages}) launches: this spec expands to ` +
        `${perPass} launches per iteration × ${max} iterations = ${product} — add a human gate (a stage gateAfter, ` +
        `or until: { gate: true }), lower maxIterations, or raise limits.maxStages up to the documented absolute ceiling of ${MAX_STAGES_CEILING}${defaultLimitNote}`
      )
    }
  }
  return null
}

/** This level's loop plus, recursively, every nested pipeline-stage child's own loop —
 *  the loop-side twin of validateStageList's per-level recursion. */
function validateLoopsDeep(spec: PipelineSpec): string | null {
  const own = validateLoop(spec)
  if (own !== null) return own
  for (const stage of spec.stages) {
    if (stage.pipeline !== undefined) {
      const nested = validateLoopsDeep(stage.pipeline)
      if (nested !== null) return `stage "${stage.name}"'s nested pipeline is invalid: ${nested}`
    }
  }
  return null
}

/** Full-spec structural validation: validateStageList over the stage list PLUS the loop
 *  rules (this level's `loop` and, recursively, every nested pipeline-stage child's).
 *  ADDITIVE — validateStageList's backwards-compatible stage-list-only call is shared with
 *  the Observatory runner's own callers; a caller holding a whole PipelineSpec (definePipeline,
 *  a runner's start() defense-in-depth path) should prefer this entry point, since a bare stage
 *  list cannot see the spec-level `loop`. Returns a human-readable reason, or null. */
export function validatePipelineSpec(spec: PipelineSpec): string | null {
  const limitsError = validateLimitsShape(spec.limits)
  if (limitsError !== null) return limitsError
  const stageError = validateStageList(spec.stages, spec.limits)
  if (stageError !== null) return stageError
  return validateLoopsDeep(spec)
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

/** Parse an untrusted `loop` value into a PipelineLoopSpec, or null. SHAPE only (field
 *  types + the exactly-one-flavor union) — bounds and the expanded budget are validateLoop's
 *  job, applied by parsePipelineSpec right after the assignment. Rebuilds the object from
 *  whitelisted keys (extra keys dropped, same posture as parseStageSpecV2). */
function parseLoopSpec(v: unknown): PipelineLoopSpec | null {
  if (typeof v !== 'object' || v === null) return null
  const l = v as Record<string, unknown>
  const rawUntil = l['until']
  if (typeof rawUntil !== 'object' || rawUntil === null) return null
  const u = rawUntil as Record<string, unknown>
  const hasGate = u['gate'] !== undefined
  const hasCriterion = u['criterion'] !== undefined
  if (hasGate === hasCriterion) return null // neither, or both — the union is exactly one flavor
  let until: LoopUntil
  if (hasGate) {
    if (u['gate'] !== true) return null // the union's literal is `true`; gate:false has no meaning
    until = { gate: true }
  } else {
    const criterion = u['criterion']
    if (typeof criterion !== 'string' || criterion.length === 0) return null
    until = { criterion }
  }
  const maxIterations = l['maxIterations']
  if (typeof maxIterations !== 'number') return null
  return { until, maxIterations }
}

function parseLimitsShape(v: unknown): PipelineLimits | null {
  if (typeof v !== 'object' || v === null) return null
  const l = v as Record<string, unknown>
  const limits: PipelineLimits = {}
  for (const key of ['maxStages', 'maxPipelineDepth', 'maxLoopIterations'] as const) {
    if (l[key] === undefined) continue
    const raw = l[key]
    if (typeof raw !== 'number') return null
    limits[key] = raw
  }
  return limits
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
  let limits: PipelineLimits | undefined
  if (s['limits'] !== undefined) {
    const parsed = parseLimitsShape(s['limits'])
    if (parsed === null) return null
    if (validateLimitsShape(parsed) !== null) return null
    limits = parsed
  }
  // Structural checks shared with the runner's start() defense-in-depth guard: empty, over the
  // resolved stage cap, duplicate names, or a trailing gateAfter all fail here, at the
  // untrusted-JSON boundary — never reaching a persisted, orphaned record.
  if (validateStageList(stages, limits) !== null) return null
  const spec: PipelineSpec = { goal: s['goal'], projectDir: s['projectDir'], stages }
  if (limits !== undefined) spec.limits = limits
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
  if (s['loop'] !== undefined) {
    const loop = parseLoopSpec(s['loop'])
    if (loop === null) return null
    // The ASSIGNMENT is load-bearing: this parser rebuilds objects from whitelisted keys, so
    // parsing without assigning would silently DROP `loop` from every round-tripped spec —
    // and a mere not-null round-trip test would never catch it (hence the deep-equality
    // tests). Key set only when defined (exactOptionalPropertyTypes idiom, same as above).
    spec.loop = loop
  }
  // This level's loop rules (until shape re-check, maxIterations bounds, the ungated-
  // criterion expanded budget). Nested children each ran this at their OWN parse (the
  // parseStageSpecV2 → parsePipelineSpec recursion), so one level-local call covers the tree.
  if (validateLoop(spec) !== null) return null
  return spec
}
