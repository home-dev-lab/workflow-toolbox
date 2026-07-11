// @workflow-toolbox/runtime — public API
// globals.d.ts is intentionally NOT re-exported here. It is an ambient opt-in:
// consumers include it in their own tsconfig to type-check raw workflow scripts.
export type {
  ModelAlias,
  EffortAlias,
  JsonSchema,
  AgentOptions,
  AgentFn,
  PipelineStage,
  PipelineFn,
  ParallelFn,
  Budget,
  WorkflowFn,
  WorkflowRuntime,
} from './types.js'

export { BEST_MODEL } from './constants.js'

export { DIGEST_PREFIX, LOOP_STAGE, LOOP_ITER_MARKER, isLoopIterLabel, formatDigest, parseDigest } from './digest.js'
export type { PhaseDigest, PatternName, PatternCounts, TypedPhaseDigest } from './digest.js'

export { FakeRuntime } from './fake.js'
export type { AgentCall, FakeRuntimeOptions } from './fake.js'

export { withAgentDefaults } from './with-agent-defaults.js'
export type { AgentDefaults } from './with-agent-defaults.js'

export { PROMPT_TAG_PREFIX, buildPromptTag, parsePromptTag, withPromptTags } from './prompt-tag.js'
export type { PromptTagFields } from './prompt-tag.js'
