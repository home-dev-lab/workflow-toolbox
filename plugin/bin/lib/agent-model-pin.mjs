import { resolveAgentDefinition } from './agent-definitions.mjs'

const INHERITING_BUILTINS = new Set(['Explore', 'Plan'])
const DEFAULTABLE_BUILTINS = new Set(['general-purpose', 'claude'])
const PINNED_BUILTINS = new Set(['claude-code-guide', 'statusline-setup'])

function environmentModel(env) {
  const value = typeof env?.CLAUDE_CODE_SUBAGENT_MODEL === 'string' ? env.CLAUDE_CODE_SUBAGENT_MODEL.trim() : ''
  return value && value.toLowerCase() !== 'inherit' ? value : ''
}

/** Resolve a spawn's effective model without turning uncertain definitions into warnings. */
export function resolveAgentModelPin(type, { cwd, requestedModel, resolve = resolveAgentDefinition, env = process.env } = {}) {
  if (type == null || type === '') type = 'general-purpose'
  else if (typeof type !== 'string') return { status: 'unknown', type }
  else type = type.trim() || 'general-purpose'

  if (type === 'fork') return { status: 'exempt', type }
  const defaultModel = environmentModel(env)
  if (env?.CLAUDE_CODE_SUBAGENT_MODEL_FORCE === '1') return { status: defaultModel ? 'pinned' : 'unpinned', type }
  const requested = typeof requestedModel === 'string' ? requestedModel.trim().toLowerCase() : ''
  if (requested && requested !== 'inherit') return { status: 'pinned', type }

  let definition
  try { definition = resolve(type, { cwd }) } catch { return { status: 'unknown', type } }
  if (definition && Object.hasOwn(definition, 'unresolved')) return { status: 'unknown', type }
  if (definition) {
    if (requested === 'inherit') return { status: 'unpinned', type }
    const model = definition.data?.model
    if (model == null) return { status: defaultModel ? 'pinned' : 'unpinned', type }
    if (typeof model !== 'string') return { status: 'unknown', type }
    const value = model.trim().toLowerCase()
    if (value === 'inherit') return { status: 'unpinned', type }
    return { status: !value || ['null', '~'].includes(value) ? (defaultModel ? 'pinned' : 'unpinned') : 'pinned', type }
  }
  if (INHERITING_BUILTINS.has(type)) return { status: 'unpinned', type }
  if (DEFAULTABLE_BUILTINS.has(type)) return { status: requested === 'inherit' || !defaultModel ? 'unpinned' : 'pinned', type }
  if (PINNED_BUILTINS.has(type)) return { status: requested === 'inherit' ? 'unpinned' : 'pinned', type }
  return { status: 'unknown', type }
}
