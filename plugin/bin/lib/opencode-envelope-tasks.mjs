// ⚠ RETIRED as a default cap (2026-08-20). Kept only so an explicit `--max-tasks` still has a
// documented meaning; nothing applies it unless a caller passes the flag, and passing it now
// REFUSES an oversized source rather than silently dropping its tail.
export const DEFAULT_MAX_TASKS = undefined

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

/** Generate one task per source item.
 *
 * ⚠ THERE IS NO CAP, AND THAT IS DELIBERATE. This function used to slice the input to
 * `DEFAULT_MAX_TASKS = 256` and report the remainder as `dropped`. Truncating loses work that
 * nobody can recover: the calls are never made, the findings they would have produced never exist,
 * and the only trace is one stderr line in a log nobody re-reads. There is no counterweight — the
 * cap bought nothing, because a large batch is bounded by CONCURRENCY (how many run at once),
 * never by TOTAL (how many run at all). An envelope may issue ten thousand calls; it simply runs
 * them `concurrency` at a time.
 *
 * `maxTasks` is kept as an OPT-IN bound for a caller that genuinely wants one — and it now REFUSES
 * rather than truncating, so the "silently did less than asked" outcome is unreachable by any path.
 */
export function generateEachTasks({ items, promptTemplate, idTemplate, maxTasks }) {
  if (maxTasks !== undefined) {
    if (!Number.isInteger(maxTasks) || maxTasks < 1) throw new Error('--max-tasks must be a positive integer')
    if (items.length > maxTasks) {
      throw new Error(
        `--max-tasks=${maxTasks} but the source has ${items.length} items. Refusing to truncate: ` +
        `raise or drop --max-tasks. Batch size is bounded by --concurrency, not by the task count.`,
      )
    }
  }
  return {
    tasks: items.map((item) => ({
      id: applyItemTemplate(idTemplate, item),
      prompt: applyItemTemplate(promptTemplate, item),
    })),
    sourceCount: items.length,
    dropped: 0,
  }
}
