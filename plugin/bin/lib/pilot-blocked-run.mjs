// Blocked evidence is local and durable before the partial archive is attempted.
import { join } from 'node:path'

export function observeBlockedRun(runtime, current = null) {
  if (runtime.completed || runtime.awaitingFidelityReceipt) return false
  if (runtime.blockedStop) return true
  if (runtime.incompleteReason) return false
  const state = runtime.lifecycleServer.state()
  if (!state.blocked) return false
  const { cardId: card, refusal } = state.blocked
  runtime.blockedStop = { card, refusal: refusal.text }
  runtime.incompleteReason = `blocked: routed card ${card}: ${refusal.text}`
  const laneDir = join(runtime.options.dir, '.lane')
  const report = `# Blocked pilot run\n\nRouted card: ${card}\nRefusal: ${refusal.text}\nPhase: ${state.phase}\nTime: ${new Date(runtime.now()).toISOString()}\n`
  writeBlockedEvidence(runtime, join(laneDir, 'blocked-report.md'), report)
  persistBlockedSummary(runtime)
  runtime.log(runtime.incompleteReason)
  if (current) { current.ended_by = 'blocked'; current.abort() }
  return true
}

function writeBlockedEvidence(runtime, file, content) {
  try { runtime.writeBlockedFile(file, content) }
  catch (error) { runtime.log(`blocked evidence write failed: ${error instanceof Error ? error.message : String(error)}`) }
}

function persistBlockedSummary(runtime) {
  if (!runtime.blockedStop) return
  const file = join(runtime.options.dir, '.lane', 'summary.json')
  let summary = {}
  try { summary = JSON.parse(runtime.readBlockedFile(file) ?? '{}') } catch {}
  writeBlockedEvidence(runtime, file, `${JSON.stringify({ ...summary, completed: false, reason: runtime.incompleteReason, blocked_on: runtime.blockedStop }, null, 2)}\n`)
}

export function finalizePilotLifecycle(runtime, completedNormally) {
  const { lifecycleServer, readFile, options } = runtime
  let error = null
  if (!completedNormally) {
    try { lifecycleServer.finalizePartial(runtime.incompleteReason ?? 'stream ended without awaiting_fidelity lifecycle receipt') }
    catch (failure) { error = failure }
    finally { persistBlockedSummary(runtime) }
  }
  let summary = {}
  try { summary = JSON.parse(readFile(join(options.dir, '.lane', 'summary.json'), 'utf8')) } catch {}
  if (runtime.blockedStop) Object.assign(summary, { completed: false, reason: runtime.incompleteReason, blocked_on: runtime.blockedStop })
  return { error, summary }
}
