// define-pipeline.ts — pipeline declaration helper for @workflow-toolbox/build (I5 authoring
// increment). definePipeline() is defineWorkflow's counterpart for the ORCHESTRATOR pipeline
// (the observe-ui multi-stage/human-gated runner's declarative PipelineSpec) — do not confuse
// with the sandbox `pipeline()` primitive a defineWorkflow-bundled script calls INSIDE a run.
// See docs/public/adr/0008 for the "in-run pipeline pattern" vs "orchestrator pipeline"
// vocabulary convention this increment introduces.
//
// UNLIKE defineWorkflow, a pipeline spec is NEVER bundled into a Workflow-tool sandbox artifact
// — a PipelineSpec is a plain JSON document the observe-ui pipeline runner consumes over
// POST /api/pipeline {spec}, so there is no SANDBOX-PURE constraint here: this file (and
// pipeline entry files that import it) may freely use Node APIs and the full
// @workflow-toolbox/pipeline-spec validation surface. No separate sandbox-pure subpath is
// needed (unlike defineWorkflow's '@workflow-toolbox/build/define') — bundlePipeline.ts bundles
// a pipeline entry with `platform: 'node'`, so node:vm/esbuild resolve fine even when dragged
// in transitively through this package's root export.
//
// Design: definePipeline() validates the spec SYNCHRONOUSLY at call time — validatePipelineSpec
// (the STAGE LIST shape plus the spec-level `loop` rules, at every nesting level — it wraps the
// same validateStageList the runner shares) PLUS a JSON.stringify → parsePipelineSpec round-trip (batch 5, item 5)
// — the exact same two checks bundlePipeline's own Step 2/3 apply to the BUNDLED output, now
// ALSO run at the raw call site. This makes the claim below literally true: an authored spec
// and a live-launched spec ARE validated by the exact same rules, so a bad spec fails at
// author time (immediately, with the author's own stack trace, before any bundling/emission),
// not once it reaches the server. Before this, only validateStageList ran here — a field that
// bypassed TypeScript via a cast (`as PipelineSpec`) with a value parsePipelineSpec rejects
// (e.g. `goal: 42`) passed definePipeline() silently and was only caught later, inside
// bundlePipeline's OWN round-trip (see bad-roundtrip.pipeline.ts's fixture/test) — a real gap
// between this file's own documented promise and what the code actually checked.
//
// bundlePipeline's round-trip check (bundle-pipeline.ts, Step 3) stays — defense in depth for
// an author who bypasses definePipeline() entirely (`export default { spec: badSpec }`,
// skipping this function outright); see the dedicated bypass fixture/test.

import { validatePipelineSpec, parsePipelineSpec, type PipelineSpec } from '@workflow-toolbox/pipeline-spec'

/** A declared pipeline: just the validated spec, wrapped so bundlePipeline's node:vm
 *  extraction has a stable, greppable shape to read — `export default definePipeline({...})`,
 *  mirroring defineWorkflow's `export default defineWorkflow({...})` contract exactly. */
export interface DefinedPipeline {
  spec: PipelineSpec
}

/** Declare a pipeline. Validates the stage list AND round-trips the spec through
 *  parsePipelineSpec immediately — config errors throw before `workflow-toolbox pipeline` (or
 *  any other caller) ever tries to bundle/emit it. `name` (card #1813065099577918566) is
 *  OPTIONAL here: an orchestrator still mints its own `pl_<hex>` id at launch regardless, and
 *  an author who doesn't set one gets it derived from the entry filename instead — see the
 *  CLI's `runPipeline` (cli.ts), which injects it into the emitted JSON only when the spec's
 *  own `name` is absent. Returns the ORIGINAL spec reference (not the round-tripped copy) —
 *  the round-trip here is VALIDATION only, same posture as bundlePipeline's own Step 3:
 *  preserving the author's own key order in the emitted JSON (bundlePipeline builds `json`
 *  from the raw `default.spec` it reads, not from its own round-tripped copy either) rather
 *  than churning committed artifacts' diffs on a behavior-neutral internal reconstruction. */
export function definePipeline(spec: PipelineSpec): DefinedPipeline {
  const error = validatePipelineSpec(spec)
  if (error !== null) {
    throw new Error(`definePipeline: invalid spec — ${error}`)
  }
  let json: string
  try {
    json = JSON.stringify(spec)
  } catch (e) {
    throw new Error(`definePipeline: spec is not JSON-serializable: ${String(e)}`)
  }
  if (parsePipelineSpec(JSON.parse(json)) === null) {
    throw new Error(
      `definePipeline: the spec failed the parsePipelineSpec round-trip check — this usually ` +
        `means a field bypassed TypeScript's checks (e.g. an \`as PipelineSpec\` cast) with a ` +
        `value the runtime parser rejects (wrong type, an unrecognized artifact/extractor key, ` +
        `etc.); check the spec against PipelineSpec's shape. Raw spec (after JSON round-trip): ${json}`,
    )
  }
  return { spec }
}
