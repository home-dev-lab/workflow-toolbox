import { assertParentRegistry } from './host/pilot-parent-registry.mjs'
import { createParentWakeManager } from './pilot-parent-wake.mjs'

export function parentWakeEnvironment(options, env, dependencies, log) {
  if (options.parentSession) {
    assertParentRegistry(options.parentSession, env, dependencies.parentRegistryFs)
    if (options.parentSessionBareReason !== undefined) log(`parent session bare-name reason: ${options.parentSessionBareReason}`)
  }
  return env
}

export function configuredParentWakes(options, config, dependencies) {
  const settings = { parentSession: options.parentSession, parentMode: options.parentMode, parentSessionBareReason: options.parentSessionBareReason, ...config, wakeOptions: dependencies.parentWakeOptions }
  const create = dependencies.createParentWakeManager ?? createParentWakeManager
  return create(settings)
}

export function recordParentWakeSummary(summary, manager, options) {
  summary.parent_wakes = manager.receipts
  summary.parent_session_bare_reason = options.parentSessionBareReason ?? null
}
