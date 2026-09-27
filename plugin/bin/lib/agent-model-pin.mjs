import { resolveAgentDefinition } from './agent-definitions.mjs'

const BUILTIN_TYPES = new Set(['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup'])

/** Resolve a spawn's effective model without turning uncertain definitions into warnings. */
export function resolveAgentModelPin(type, { cwd, requestedModel, resolve = resolveAgentDefinition } = {}) {
  if (type == null || type === '') type = 'general-purpose'
  else if (typeof type !== 'string') return { status: 'unknown', type }
  else type = type.trim() || 'general-purpose'

  if (type === 'fork') return { status: 'exempt', type }
  const requested = typeof requestedModel === 'string' ? requestedModel.trim().toLowerCase() : ''
  if (requested && requested !== 'inherit') return { status: 'pinned', type }

  let definition
  try { definition = resolve(type, { cwd }) } catch { return { status: 'unknown', type } }
  if (definition && Object.hasOwn(definition, 'unresolved')) return { status: 'unknown', type }
  if (definition) {
    if (requested === 'inherit') return { status: 'unpinned', type }
    const model = definition.data?.model
    if (model === undefined) return { status: 'unpinned', type }
    if (typeof model !== 'string') return { status: 'unknown', type }
    return { status: !model.trim() || ['inherit', 'null'].includes(model.trim().toLowerCase()) ? 'unpinned' : 'pinned', type }
  }
  return { status: BUILTIN_TYPES.has(type) ? 'unpinned' : 'unknown', type }
}
