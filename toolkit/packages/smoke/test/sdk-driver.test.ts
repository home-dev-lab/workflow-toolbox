// sdk-driver.test.ts — unit tests for the extracted `driveLoop` state machine
// behind runDriverSession (src/sdk-driver.ts). Fake, list-backed AsyncIterators
// stand in for a real query() session — mirroring lib.test.ts's `peelLaunch`
// tests — so this whole 200+-line loop is covered without spending an agent run.
// `runDriverSession` itself (the thin query()-constructing wrapper) stays
// integration-verified by the live canaries (`pnpm smoke` / `canary:edge` /
// `canary:nesting`); only `driveLoop` is unit-tested here.

import { describe, expect, it, vi } from 'vitest'
import { driveLoop, type DriveLoopDeps } from '../src/sdk-driver.js'

// ---------------------------------------------------------------------------
// Fake SDK-shaped message builders + a finite fake AsyncIterator (same shape as
// lib.test.ts's peelLaunch fakes: driveLoop only needs `.next()`, not the full
// AsyncIterable protocol).
// ---------------------------------------------------------------------------

const assistantToolUse = (id: string, scriptPath: string): unknown => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'Workflow', input: { scriptPath } }] },
})

const userToolResult = (toolUseId: string | null, text: string, isError = false): unknown => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: text }] },
})

const taskNotification = (
  toolUseId: string | null,
  status: string,
  outputFile: string | null,
): unknown => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: 'w1',
  tool_use_id: toolUseId,
  status,
  output_file: outputFile,
})

const initMessage = (version: string): unknown => ({
  type: 'system',
  subtype: 'init',
  claude_code_version: version,
})

const resultMessage = (): unknown => ({ type: 'result' })

/** A finite async iterator over a fixed list (mimics the SDK stream iterator). */
function iterOf(items: readonly unknown[]): AsyncIterator<unknown> {
  let i = 0
  return {
    next: () => Promise.resolve(i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true }),
  }
}

/** An iterator whose first `next()` rejects with an abort-shaped error — models
 *  the AbortController-driven timeout runDriverSession's timer triggers. */
function abortingIter(): AsyncIterator<unknown> {
  return {
    next: () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    },
  }
}

const LAUNCH_TEXT =
  'Workflow launched in background. Task ID: real-task\n' +
  'Transcript dir: /tmp/subagents/workflows/wf_1\nRun ID: wf_1\n'
const MISMATCHED_LAUNCH_TEXT =
  'Workflow launched in background. Task ID: wrong-task\n' +
  'Transcript dir: /tmp/subagents/workflows/wf_wrong\nRun ID: wf_wrong\n'

function noopDeps(overrides: Partial<DriveLoopDeps> = {}): DriveLoopDeps {
  return {
    readOutputFile: vi.fn(() => '{}'),
    stopTask: vi.fn(() => Promise.resolve()),
    ...overrides,
  }
}

describe('driveLoop — toolUseId filter', () => {
  it('ignores a tool_result whose tool_use_id does not match the launched tool_use, and accepts the matching one', async () => {
    const it = iterOf([
      assistantToolUse('toolu_1', '/wf.js'),
      userToolResult('toolu_other', MISMATCHED_LAUNCH_TEXT), // mismatched — must be ignored
      userToolResult('toolu_1', LAUNCH_TEXT), // matching — must be accepted
    ])
    const deps = noopDeps()
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: false }, deps)
    expect(result.sawToolResult).toBe(true)
    expect(result.toolResult?.toolUseId).toBe('toolu_1')
    expect(result.verdict?.taskId).toBe('real-task')
    expect(deps.stopTask).toHaveBeenCalledWith('real-task')
    expect(deps.stopTask).not.toHaveBeenCalledWith('wrong-task')
  })

  it('accepts the first tool_result when no tool_use was ever observed (expectedToolUseId stays null)', async () => {
    const it = iterOf([userToolResult('toolu_anything', LAUNCH_TEXT)])
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: false }, noopDeps())
    expect(result.sawToolResult).toBe(true)
    expect(result.verdict?.taskId).toBe('real-task')
  })
})

describe('driveLoop — waitForCompletion branch difference', () => {
  it('false: stops right after the tool_result, stops the task, and never reaches a later notification', async () => {
    const it = iterOf([
      assistantToolUse('toolu_1', '/wf.js'),
      userToolResult('toolu_1', LAUNCH_TEXT),
      taskNotification('toolu_1', 'completed', '/out.json'), // must never be reached
    ])
    const deps = noopDeps()
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: false }, deps)
    expect(result.sawToolResult).toBe(true)
    expect(result.notification).toBeNull()
    expect(deps.stopTask).toHaveBeenCalledWith('real-task')
    expect(deps.readOutputFile).not.toHaveBeenCalled()
  })

  it('true: keeps iterating past the tool_result for the task_notification', async () => {
    const it = iterOf([
      assistantToolUse('toolu_1', '/wf.js'),
      userToolResult('toolu_1', LAUNCH_TEXT),
      taskNotification('toolu_1', 'completed', '/out.json'),
    ])
    const deps = noopDeps({ readOutputFile: vi.fn(() => '{"result":{"ok":true}}') })
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: true }, deps)
    expect(result.sawToolResult).toBe(true)
    expect(result.notification?.status).toBe('completed')
    expect(result.result).toEqual({ ok: true })
    expect(deps.stopTask).not.toHaveBeenCalled()
  })
})

describe('driveLoop — 3-way noResultReason diagnosis', () => {
  it('"timed out" when the iterator rejects with an abort error', async () => {
    const result = await driveLoop(abortingIter(), { scriptPath: '/wf.js', timeoutMs: 5000, waitForCompletion: false }, noopDeps())
    expect(result.sawToolResult).toBe(false)
    expect(result.abortedByTimeout).toBe(true)
    expect(result.noResultReason).toBe('timed out after 5000 ms before the Workflow launch resolved')
  })

  it('"invoked but no result" when the tool was called but the stream ends before a tool_result', async () => {
    const it = iterOf([initMessage('2.99.0'), assistantToolUse('toolu_1', '/wf.js')])
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: false }, noopDeps())
    expect(result.sawToolResult).toBe(false)
    expect(result.abortedByTimeout).toBe(false)
    expect(result.ccVersion).toBe('2.99.0')
    expect(result.noResultReason).toBe('the Workflow tool was invoked but no tool result arrived before the turn ended')
  })

  it('"never called" when the stream ends without ever seeing a Workflow tool_use', async () => {
    const it = iterOf([initMessage('2.99.0')])
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: false }, noopDeps())
    expect(result.sawToolResult).toBe(false)
    expect(result.abortedByTimeout).toBe(false)
    expect(result.noResultReason).toBe('the model never called the Workflow tool')
  })

  it('fire-and-forget: a "result" message with no tool_result ends the loop early (never called)', async () => {
    let calls = 0
    const it: AsyncIterator<unknown> = {
      next: () => {
        calls++
        if (calls === 1) return Promise.resolve({ value: resultMessage(), done: false })
        // A second call would only happen if the loop kept draining past the
        // early-stop branch — fail loudly if that regresses.
        throw new Error('driveLoop kept iterating past the fire-and-forget result message')
      },
    }
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: false }, noopDeps())
    expect(result.noResultReason).toBe('the model never called the Workflow tool')
    expect(calls).toBe(1)
  })
})

describe('driveLoop — notification-null handling under waitForCompletion', () => {
  it('launched fine, stream ends gracefully with no notification: notification null, noResultReason stays null (sawToolResult is true)', async () => {
    const it = iterOf([assistantToolUse('toolu_1', '/wf.js'), userToolResult('toolu_1', LAUNCH_TEXT)])
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: true }, noopDeps())
    expect(result.sawToolResult).toBe(true)
    expect(result.verdict?.ok).toBe(true)
    expect(result.notification).toBeNull()
    expect(result.abortedByTimeout).toBe(false)
    expect(result.noResultReason).toBeNull() // callers (nesting-canaries.ts) diagnose this themselves
  })

  it('launched fine, then the session aborts before a notification: notification null, abortedByTimeout true, noResultReason still null', async () => {
    let calls = 0
    const it: AsyncIterator<unknown> = {
      next: () => {
        calls++
        if (calls === 1) return Promise.resolve({ value: assistantToolUse('toolu_1', '/wf.js'), done: false })
        if (calls === 2) return Promise.resolve({ value: userToolResult('toolu_1', LAUNCH_TEXT), done: false })
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        return Promise.reject(err)
      },
    }
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: true }, noopDeps())
    expect(result.sawToolResult).toBe(true)
    expect(result.notification).toBeNull()
    expect(result.abortedByTimeout).toBe(true)
    expect(result.noResultReason).toBeNull()
  })
})

describe('driveLoop — validateScriptPath', () => {
  it('sets scriptMismatch and stops before any tool_result when the model launches a different script', async () => {
    const it = iterOf([
      assistantToolUse('toolu_1', '/wrong.js'),
      userToolResult('toolu_1', LAUNCH_TEXT), // must never be reached
    ])
    const result = await driveLoop(
      it,
      { scriptPath: '/expected.js', timeoutMs: 1000, waitForCompletion: false, validateScriptPath: true },
      noopDeps(),
    )
    expect(result.scriptMismatch).toBe('model launched the wrong script: /wrong.js')
    expect(result.sawToolResult).toBe(false)
  })

  it('does not check scriptPath when validateScriptPath is left off (edge/nesting canaries)', async () => {
    const it = iterOf([assistantToolUse('toolu_1', '/whatever.js'), userToolResult('toolu_1', LAUNCH_TEXT)])
    const result = await driveLoop(it, { scriptPath: '/expected.js', timeoutMs: 1000, waitForCompletion: false }, noopDeps())
    expect(result.scriptMismatch).toBeNull()
    expect(result.sawToolResult).toBe(true)
  })
})

describe('driveLoop — output file reading', () => {
  it('parses the output file via the injected readOutputFile and unwraps its `result` key', async () => {
    const it = iterOf([userToolResult('toolu_1', LAUNCH_TEXT), taskNotification('toolu_1', 'completed', '/out.json')])
    const readOutputFile = vi.fn(() => '{"result":{"marker":"ok"},"other":1}')
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: true }, noopDeps({ readOutputFile }))
    expect(readOutputFile).toHaveBeenCalledWith('/out.json')
    expect(result.rawOutput).toEqual({ result: { marker: 'ok' }, other: 1 })
    expect(result.result).toEqual({ marker: 'ok' })
    expect(result.outputReadError).toBeNull()
  })

  it('records outputReadError when readOutputFile throws or the content is not valid JSON', async () => {
    const it = iterOf([userToolResult('toolu_1', LAUNCH_TEXT), taskNotification('toolu_1', 'completed', '/missing.json')])
    const readOutputFile = vi.fn(() => {
      throw new Error('ENOENT: no such file')
    })
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: true }, noopDeps({ readOutputFile }))
    expect(result.outputReadError).toBe('ENOENT: no such file')
    expect(result.result).toBeUndefined()
  })

  it('does not attempt to read the output file for a non-completed notification', async () => {
    const it = iterOf([userToolResult('toolu_1', LAUNCH_TEXT), taskNotification('toolu_1', 'failed', null)])
    const readOutputFile = vi.fn(() => '{}')
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: true }, noopDeps({ readOutputFile }))
    expect(readOutputFile).not.toHaveBeenCalled()
    expect(result.notification?.status).toBe('failed')
  })
})

describe('driveLoop — launch rejection under waitForCompletion', () => {
  it('a syntax-rejected launch stops the loop without waiting for a notification', async () => {
    const it = iterOf([
      userToolResult('toolu_1', '<tool_use_error>Invalid workflow script</tool_use_error>', true),
      taskNotification('toolu_1', 'completed', '/out.json'), // must never be reached
    ])
    const result = await driveLoop(it, { scriptPath: '/wf.js', timeoutMs: 1000, waitForCompletion: true }, noopDeps())
    expect(result.sawToolResult).toBe(true)
    expect(result.verdict?.ok).toBe(false)
    expect(result.notification).toBeNull()
  })
})
