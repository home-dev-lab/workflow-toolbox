// @workflow-toolbox/scaffold — public API. Pure workflow + agentType scaffolders (the impure CLI lives in cli.ts).
export {
  scaffoldWorkflow,
  assertSpecShape,
  scaffoldAgent,
  assertAgentSpecShape,
  scaffoldObserver,
  assertObserverScaffoldSpec,
  observerLaunchHint,
  MINIMAL_TSCONFIG,
  PATTERN_NAMES,
} from './scaffold.js'
export type { ScaffoldSpec, ScaffoldStep, PatternName, AgentScaffoldSpec, ObserverScaffoldSpec } from './scaffold.js'
