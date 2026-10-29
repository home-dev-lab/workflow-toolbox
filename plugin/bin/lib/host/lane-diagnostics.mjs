import { appendFileSync } from 'node:fs'

const stderr = process.stderr
// Writable failures can emit asynchronously, outside the write's synchronous try/catch.
stderr.on('error', () => { /* A diagnostic failure must leave supervision running. */ })
const reportedLabels = new Set()

// Diagnostic sinks must not change supervision decisions, including when stderr is unavailable.
export function bestEffortLaneDiagnostic(label, write) {
  try { return write() } catch (error) {
    // stderr feeds the lane log; repeating this message would look like continuing activity.
    if (reportedLabels.has(label)) return false
    reportedLabels.add(label)
    const reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
    try { stderr.write(`wt-lane: ${label} failed: ${reason}\n`) } catch { /* best effort diagnostic */ }
    return false
  }
}

export function appendLaneReceipt(fd, line) {
  return bestEffortLaneDiagnostic('lane receipt write', () => {
    appendFileSync(fd, `${line}\n`)
    return true
  })
}
