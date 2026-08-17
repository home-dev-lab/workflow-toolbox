export const DEFAULT_MAX_TASKS = 256

function templateValue(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function valueAtPath(item, fieldPath) {
  if (fieldPath === undefined) return item
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`{{item.${fieldPath}}} requires a JSON object element`)
  }
  let value = item
  for (const field of fieldPath.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, field)) {
      throw new Error(`template field not found: ${fieldPath}`)
    }
    value = value[field]
  }
  return value
}

export function applyItemTemplate(template, item) {
  let substitutions = 0
  const rendered = template.replace(/\{\{item(?:\.([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*))?\}\}/g, (_match, fieldPath) => {
    substitutions++
    return templateValue(valueAtPath(item, fieldPath))
  })
  if (substitutions === 0) throw new Error('template must contain {{item}} or {{item.field}}')
  return rendered
}

export function parseEachSource(sourceText, mode) {
  if (mode === 'json') {
    const parsed = JSON.parse(sourceText)
    if (!Array.isArray(parsed)) throw new Error('--each-json source must be a JSON array')
    for (const item of parsed) {
      if (typeof item !== 'string' && (item === null || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error('--each-json elements must be strings or JSON objects')
      }
    }
    return parsed
  }
  if (mode === 'lines') return sourceText.split(/\r?\n/).filter((line) => line.trim().length > 0)
  throw new Error(`unknown each-source mode: ${mode}`)
}

export function generateEachTasks({ items, promptTemplate, idTemplate, maxTasks = DEFAULT_MAX_TASKS }) {
  if (!Number.isInteger(maxTasks) || maxTasks < 1) throw new Error('--max-tasks must be a positive integer')
  const selected = items.slice(0, maxTasks)
  return {
    tasks: selected.map((item) => ({
      id: applyItemTemplate(idTemplate, item),
      prompt: applyItemTemplate(promptTemplate, item),
    })),
    sourceCount: items.length,
    dropped: items.length - selected.length,
  }
}
