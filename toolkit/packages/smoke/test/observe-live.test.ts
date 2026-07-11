// observe-live.test.ts — unit tests for readWorkflowCompletion, the pure
// task_notification → WorkflowCompletion mapper (batch 4, the live-settle truth fix).
// observe-live.ts's own observeLiveRun() is deliberately untested here (it drives the real
// SDK query() and needs ~/.claude auth) — but this one helper is pure (one TaskNotification
// in, one WorkflowCompletion out, the only I/O a single readFileSync) and is exactly the
// spot the bug lived in: a non-'completed' status used to collapse into the SAME
// `result: undefined` shape a legitimately-empty SUCCESSFUL result produces, so a caller
// had no way to tell "ran and returned nothing" from "failed".

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkflowCompletion } from '../src/observe-live.js'
import type { TaskNotification } from '../src/lib.js'

let dir: string | null = null
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function outputFile(contents: string): string {
  dir = mkdtempSync(join(tmpdir(), 'wt-observe-live-test-'))
  const p = join(dir, 'output.json')
  writeFileSync(p, contents, 'utf8')
  return p
}

function notification(overrides: Partial<TaskNotification> = {}): TaskNotification {
  return { taskId: 't1', toolUseId: 'tu1', status: 'completed', outputFile: null, ...overrides }
}

describe('readWorkflowCompletion', () => {
  it('a completed run with a readable outputFile reports status + the script result', () => {
    const file = outputFile(JSON.stringify({ result: { artifact: 'plan-v1' } }))
    const outcome = readWorkflowCompletion(notification({ status: 'completed', outputFile: file }))
    expect(outcome).toEqual({ status: 'completed', result: { artifact: 'plan-v1' } })
  })

  it('a FAILED run reports status "failed" with result undefined — WITHOUT reading outputFile', () => {
    // outputFile deliberately points at a real, readable file with a valid `result` — if the
    // function read it anyway for a non-completed status, this test would see that result
    // leak through instead of undefined. It must not: a failed run's status is authoritative
    // regardless of what (if anything) sits in outputFile.
    const file = outputFile(JSON.stringify({ result: 'should never surface' }))
    const outcome = readWorkflowCompletion(notification({ status: 'failed', outputFile: file }))
    expect(outcome).toEqual({ status: 'failed', result: undefined })
  })

  it('a "stopped" run reports its own status with result undefined', () => {
    const outcome = readWorkflowCompletion(notification({ status: 'stopped', outputFile: null }))
    expect(outcome).toEqual({ status: 'stopped', result: undefined })
  })

  it('an unrecognized runtime status string passes through verbatim (never assumed to be a success)', () => {
    const outcome = readWorkflowCompletion(notification({ status: 'errored', outputFile: null }))
    expect(outcome).toEqual({ status: 'errored', result: undefined })
  })

  it('a completed run with outputFile: null reports result undefined', () => {
    const outcome = readWorkflowCompletion(notification({ status: 'completed', outputFile: null }))
    expect(outcome).toEqual({ status: 'completed', result: undefined })
  })

  it('a completed run whose outputFile is missing/unreadable degrades to result undefined, status preserved', () => {
    const outcome = readWorkflowCompletion(notification({ status: 'completed', outputFile: '/nonexistent/path/output.json' }))
    expect(outcome).toEqual({ status: 'completed', result: undefined })
  })

  it('a completed run whose outputFile is not valid JSON degrades to result undefined, status preserved', () => {
    const file = outputFile('{not json')
    const outcome = readWorkflowCompletion(notification({ status: 'completed', outputFile: file }))
    expect(outcome).toEqual({ status: 'completed', result: undefined })
  })

  it('a completed run whose outputFile has no "result" key reports result undefined', () => {
    const file = outputFile(JSON.stringify({ somethingElse: true }))
    const outcome = readWorkflowCompletion(notification({ status: 'completed', outputFile: file }))
    expect(outcome).toEqual({ status: 'completed', result: undefined })
  })
})
