// @workflow-toolbox/scaffold — public API. Pure workflow + agentType scaffolders (the impure CLI lives in cli.ts).
export {
  scaffoldWorkflow,
  assertSpecShape,
  scaffoldAgent,
  assertAgentSpecShape,
  MINIMAL_TSCONFIG,
  PATTERN_NAMES,
} from './scaffold.js'
export type { ScaffoldSpec, ScaffoldStep, PatternName, AgentScaffoldSpec } from './scaffold.js'
