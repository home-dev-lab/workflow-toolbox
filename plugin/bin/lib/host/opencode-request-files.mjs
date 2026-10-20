import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function renderEnvelopeRequests(tasks, outDir) {
  // Numeric prefixes keep distinct ids with the same sanitized spelling distinct.
  const request = path.resolve(outDir, 'requests')
  mkdirSync(request, { recursive: true })
  const taskfiles = tasks.map((task, index) => {
    const safeId = String(task.id).replace(/[^A-Za-z0-9_.-]/g, '_')
    const taskfile = path.join(request, `${index}-${safeId}.task.md`)
    writeFileSync(taskfile, String(task.prompt ?? ''), 'utf8')
    return taskfile
  })
  return { request, taskfiles }
}
