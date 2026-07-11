// missing-spec.pipeline.ts — negative fixture: default export lacks `spec`.
//
// A default export that is not a DefinedPipeline (here: a plain object with a `goal` field but
// no `spec` — i.e. the author forgot definePipeline) must be rejected with the actionable
// export-default message, mirroring missing-run.workflow.ts.
export default {
  goal: 'negative fixture — no spec wrapper',
}
