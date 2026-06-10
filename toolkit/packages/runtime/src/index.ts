// @workflow-toolbox/runtime — public API
// globals.d.ts is intentionally NOT re-exported here. It is an ambient opt-in:
// consumers include it in their own tsconfig to type-check raw workflow scripts.
export type {
  ModelAlias,
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

export { FakeRuntime } from './fake.js'
export type { AgentCall, FakeRuntimeOptions } from './fake.js'
