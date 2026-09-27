import { resolveAgentDefinition } from './agent-definitions.mjs'

export function toolList(value) {
  if (Array.isArray(value)) return value.every((tool) => typeof tool === 'string') ? value : undefined
  if (typeof value !== 'string' || !value.trim() || value.trim() === '*') return null
  return value.split(',').map((tool) => tool.trim()).filter(Boolean)
}

/** A missing definition and an uncertain definition have different guard outcomes. */
export function resolveAgentTypeTools(type, cwd) {
  const definition = resolveAgentDefinition(type, { cwd })
  if (definition?.unresolved) return { resolved: false, tools: null, unresolved: definition.unresolved }
  if (!definition) return { resolved: false, tools: null, unresolved: null }
  const tools = toolList(definition.data.tools)
  if (tools === undefined || definition.data.tools !== undefined && definition.data.tools !== null && typeof definition.data.tools !== 'string' && !Array.isArray(definition.data.tools)) return { resolved: false, tools: null, unresolved: 'invalid tools definition' }
  const denied = toolList(definition.data.disallowedTools)
  if (denied === undefined || definition.data.disallowedTools !== undefined && typeof definition.data.disallowedTools !== 'string' && !Array.isArray(definition.data.disallowedTools)) return { resolved: false, tools: null, unresolved: 'invalid disallowedTools definition' }
  return { resolved: true, tools, denied, unresolved: null }
}
