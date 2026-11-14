import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Append-only record of light-scope firings: <lock root>/light-scope.jsonl. Many writers (every CLI and
// Vitest globalSetup process), one appendFileSync of one short line each; a torn or foreign line is skipped
// by the reader. A failing write never changes the run: warn mode lets it through, refuse mode has already
// decided. Lines: { event: 'fire', id, ts, route, mode, outcome, kind, fileCount, files, project, cwd } and
// { event: 'end', id, ts, holdS } once the ticket's hold ends. holdS is the covered command's run time under the
// lease (CLI) or grant-to-exit time (Vitest), in seconds; null when the run never ran under a local lease.
export function lightScopeLogPath(root) {
  return join(root, 'light-scope.jsonl')
}

function appendLine(root, entry) {
  try {
    mkdirSync(root, { recursive: true })
    appendFileSync(lightScopeLogPath(root), `${JSON.stringify(entry)}\n`)
    return true
  } catch { return false }
}

export function lightScopeLog(root, { cwd = process.cwd(), now = Date.now } = {}) {
  return {
    record(entry) {
      try {
        const id = randomUUID()
        return appendLine(root, { event: 'fire', id, ...entry, cwd }) ? id : null
      } catch { return null }
    },
    end(id, heldMs) {
      const holdS = Number.isFinite(heldMs) ? Math.round(heldMs) / 1000 : null
      try { appendLine(root, { event: 'end', id, ts: new Date(now()).toISOString(), holdS }) } catch { /* bad clock: the hold is lost */ }
    },
  }
}

function parseLine(line) {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' && typeof value.id === 'string' ? value : null
  } catch { return null }
}

// Firings in order, each with the hold of its ticket (null while held, or when the run never got one).
function readLogText(root) {
  try { return readFileSync(lightScopeLogPath(root), 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

export function readLightScopeFirings(root) {
  const text = readLogText(root)
  const firings = []
  const holds = new Map()
  for (const entry of text.split('\n').map(parseLine)) {
    if (entry?.event === 'fire') firings.push(entry)
    else if (entry?.event === 'end') holds.set(entry.id, entry.holdS ?? null)
  }
  return firings.map((firing) => ({ ...firing, holdS: holds.has(firing.id) ? holds.get(firing.id) : null }))
}
