// PURE completion-detection for the Stop hook. Reads the (verified) shape of a Stop
// payload's background_tasks[] and runs the diff state machine that decides which
// workflow runs just finished. No IO — fully unit-tested; the impure entry
// (stop-hook.ts) feeds it the parsed payload and persisted pending set.
//
// Verified payload shape (live probe, CLI 2.1.167): background_tasks is an array of
// { id, type:'workflow', status, name, description }, where `id` is the background-task
// handle == the journal's `taskId` (NOT the wf_<runId> filename). A finished workflow
// either DISAPPEARS from the array on the next Stop, or (when it launched + finished
// within one turn) first appears already carrying a terminal status.

import { isRecord, strOrNull } from '@dwt/std'

export interface WorkflowTask {
  id: string
  status: string | null
  name: string | null
}

export interface StopPayload {
  sessionId: string | null
  cwd: string | null
  stopHookActive: boolean
  workflows: WorkflowTask[]
}

/** A status that means the run is over. Anything else (incl. an unknown value) is
 * treated as still in-flight, so we wait for a disappearance rather than resolve early. */
function isTerminalStatus(status: string | null): boolean {
  return status === 'completed' || status === 'failed'
}

/** Tolerant parse of a raw Stop-hook stdin object. Never throws; unknown / malformed
 * fields degrade to null / [] / false. Only `type === 'workflow'` tasks are kept. */
export function parseStopPayload(input: unknown): StopPayload {
  if (!isRecord(input)) {
    return { sessionId: null, cwd: null, stopHookActive: false, workflows: [] }
  }
  const raw = input['background_tasks']
  const workflows: WorkflowTask[] = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) continue
      if (entry['type'] !== 'workflow') continue
      const id = strOrNull(entry['id'])
      if (id === null) continue
      workflows.push({ id, status: strOrNull(entry['status']), name: strOrNull(entry['name']) })
    }
  }
  return {
    sessionId: strOrNull(input['session_id']),
    cwd: strOrNull(input['cwd']),
    stopHookActive: input['stop_hook_active'] === true,
    workflows,
  }
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)]
}

/**
 * The diff state machine. Given the previously-pending workflow ids and the workflow
 * tasks present in THIS Stop, decide:
 *  - `running`: ids still in-flight (the next pending set).
 *  - `toResolve`: ids that just finished — either previously pending and now gone, or
 *    first seen carrying a terminal status (the launched-and-finished-in-one-turn case).
 * Pure: dedup only; the impure caller filters out already-reported ids and resolves
 * each journal.
 */
export function planStopActions(
  prevPending: string[],
  tasks: WorkflowTask[],
): { toResolve: string[]; running: string[] } {
  const running = unique(tasks.filter((t) => !isTerminalStatus(t.status)).map((t) => t.id))
  const terminal = unique(tasks.filter((t) => isTerminalStatus(t.status)).map((t) => t.id))
  const disappeared = prevPending.filter((id) => !running.includes(id))
  return { toResolve: unique([...disappeared, ...terminal]), running }
}
