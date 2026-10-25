import { randomUUID } from 'node:crypto'
import { supervisionPaths, writeJsonAtomic } from '../lane-supervisor-core.mjs'

export function handleNoDecisionPoint(options, state, status) {
  if (status !== 'running' || options.decision !== 'extend') {
    process.stderr.write(`wt-lane-control: refused: no current decision point (${status})\n`)
    return 1
  }
  writeJsonAtomic(supervisionPaths(options.dir, state.runId, options.slot).decision, {
    version: 1, runId: state.runId, decision: 'extend', preemptive: true,
    requestId: randomUUID(), extendSeconds: options.extendSeconds, reason: options.reason,
    decidedAt: new Date().toISOString(),
  })
  process.stdout.write(`decision=extend\nrun=${state.runId}\npending=deadline\n`)
  return 0
}
