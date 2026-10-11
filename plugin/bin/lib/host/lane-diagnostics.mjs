import { appendFileSync } from 'node:fs'

// Diagnostic sinks must not change supervision decisions, including when stderr is unavailable.
export function bestEffortLaneDiagnostic(label, write) {
  try { return write() } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
    try { process.stderr.write(`wt-lane: ${label} failed: ${reason}\n`) } catch { /* best effort diagnostic */ }
    return false
  }
}

export function appendLaneReceipt(fd, line) {
  return bestEffortLaneDiagnostic('lane receipt write', () => {
    appendFileSync(fd, `${line}\n`)
    return true
  })
}
