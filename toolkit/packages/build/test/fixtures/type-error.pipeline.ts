// type-error.pipeline.ts — fixture with a DELIBERATE type error, used by the
// `workflow-toolbox pipeline --typecheck` tests. esbuild strips types without checking, so a
// plain bundle succeeds on this file; --typecheck must reject it.
import { definePipeline } from '../../src/define-pipeline.js'

export default definePipeline({
  goal: 'type-error fixture',
  projectDir: '/repo',
  stages: [
    // DELIBERATE: StageSpecV2 has no `gateBefore` field — the exact plausible-but-wrong
    // shape the typecheck flag exists to catch.
    { name: 'a', workflow: 'a.js', gateBefore: true },
  ],
})
