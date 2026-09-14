// Composition root for the public lifecycle MCP server. It must not contain lifecycle policy.
export {
  AWAITING_FIDELITY_RESULT,
  LIFECYCLE_MCP_KEY,
  LIFECYCLE_SERVER_NAME,
  lifecycleToolName,
} from './lifecycle-state-machine.mjs'
export { createLifecycleStateMachine as createLifecycleServer } from './lifecycle-state-machine.mjs'
