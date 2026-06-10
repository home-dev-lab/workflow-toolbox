// lib.test.ts — unit tests for the pure smoke-harness logic, run against REAL
// SDK messages captured from live `query()` runs against wt-smoke.js
// (test/fixtures/). The only edits to the captured JSON: the local home-dir
// username was neutralized to `user` (these ship in a public repo) and one
// fixture's `is_error`/content was flipped to model a syntax-rejected launch.
// These run inside `pnpm test` (no agent runs, no auth). The live runner
// (src/run.ts) is integration-verified separately by `pnpm smoke`.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  annotateAuth,
  checkSmokeResult,
  isAbortError,
  launchPrompt,
  launchVerdict,
  parseLaunchText,
  readInitVersion,
  readTaskNotification,
  readToolResult,
  readWorkflowToolUse,
  summarize,
} from '../src/lib.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

const SUCCESS = fixture('user-tool-result-success.json')
const SYNTAX_ERROR = fixture('user-tool-result-syntax-error.json')
const TOOL_USE = fixture('assistant-workflow-tool-use.json')
const NOTIFICATION = fixture('task-notification-completed.json')
const OUTPUT = fixture('output-completed.json') as { result: unknown }

describe('readWorkflowToolUse', () => {
  it('extracts the Workflow tool_use id + scriptPath from a real assistant message', () => {
    const tu = readWorkflowToolUse(TOOL_USE)
    expect(tu).not.toBeNull()
    expect(tu?.id).toMatch(/^toolu_/)
    expect(tu?.scriptPath).toMatch(/wt-smoke\.js$/)
  })

  it('returns null for a non-assistant message', () => {
    expect(readWorkflowToolUse(SUCCESS)).toBeNull()
  })

  it('returns null for unrecognized / drifted shapes', () => {
    expect(readWorkflowToolUse(null)).toBeNull()
    expect(readWorkflowToolUse({ type: 'assistant' })).toBeNull()
    expect(readWorkflowToolUse({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })).toBeNull()
  })
})

describe('readToolResult', () => {
  it('reads a successful launch tool_result (is_error false, string content)', () => {
    const r = readToolResult(SUCCESS)
    expect(r).not.toBeNull()
    expect(r?.isError).toBe(false)
    expect(r?.text).toContain('Task ID:')
    expect(r?.toolUseId).toMatch(/^toolu_/)
  })

  it('reads a syntax-error tool_result (is_error true)', () => {
    const r = readToolResult(SYNTAX_ERROR)
    expect(r?.isError).toBe(true)
    expect(r?.text).toContain('Invalid workflow script')
  })

  it('returns null when no tool_result block is present', () => {
    expect(readToolResult(TOOL_USE)).toBeNull()
    expect(readToolResult({ type: 'user', message: { content: [] } })).toBeNull()
  })
})

describe('readTaskNotification', () => {
  it('reads a real completed task_notification', () => {
    const n = readTaskNotification(NOTIFICATION)
    expect(n).not.toBeNull()
    expect(n?.status).toBe('completed')
    expect(n?.taskId).toMatch(/^w/)
    expect(n?.outputFile).toMatch(/\.output$/)
    expect(n?.toolUseId).toMatch(/^toolu_/)
  })

  it('returns null for non-notification system messages and other types', () => {
    expect(readTaskNotification({ type: 'system', subtype: 'init' })).toBeNull()
    expect(readTaskNotification(SUCCESS)).toBeNull()
  })
})

describe('parseLaunchText', () => {
  it('pulls Task ID and Run ID out of the formatted launch text', () => {
    const text = 'Workflow launched in background. Task ID: w71kc0tlj\nSummary: x\nRun ID: wf_89363eba-692\n'
    expect(parseLaunchText(text)).toEqual({ taskId: 'w71kc0tlj', runId: 'wf_89363eba-692' })
  })

  it('returns nulls when the markers are absent', () => {
    expect(parseLaunchText('nothing here')).toEqual({ taskId: null, runId: null })
  })
})

describe('launchVerdict', () => {
  it('passes a real successful launch and surfaces the taskId', () => {
    const r = readToolResult(SUCCESS)!
    const v = launchVerdict(r)
    expect(v.ok).toBe(true)
    expect(v.taskId).not.toBeNull()
  })

  it('fails a syntax-error launch and reports the stripped message', () => {
    const r = readToolResult(SYNTAX_ERROR)!
    const v = launchVerdict(r)
    expect(v.ok).toBe(false)
    expect(v.taskId).toBeNull()
    expect(v.reason).toContain('Invalid workflow script')
    expect(v.reason).not.toContain('<tool_use_error>')
  })

  it('fails when the launch is accepted but carries no Task ID', () => {
    const v = launchVerdict({ toolUseId: null, isError: false, text: 'launched, but weird' })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('no Task ID')
  })
})

describe('checkSmokeResult', () => {
  it('accepts a real completed envelope (no problems)', () => {
    expect(checkSmokeResult(OUTPUT.result, 'wt-smoke-ok')).toEqual([])
  })

  it('flags a wrong marker', () => {
    const problems = checkSmokeResult(OUTPUT.result, 'WRONG')
    expect(problems.some((p) => p.includes('marker'))).toBe(true)
  })

  it('flags a missing envelope', () => {
    expect(checkSmokeResult({ marker: 'wt-smoke-ok' }, 'wt-smoke-ok')).toContain(
      'result.envelope is missing or not an object',
    )
  })

  it('flags missing stats counters', () => {
    const broken = { marker: 'wt-smoke-ok', envelope: { value: [], warnings: [], trail: [{ stage: 's', outcome: 'ok' }], stats: { itemsIn: 1 } } }
    const problems = checkSmokeResult(broken, 'wt-smoke-ok')
    expect(problems.some((p) => p.includes('agentsSpawned'))).toBe(true)
  })

  it('flags an empty trail', () => {
    const broken = { marker: 'wt-smoke-ok', envelope: { value: [], warnings: [], trail: [], stats: { itemsIn: 0, itemsOut: 0, agentsSpawned: 0, dropped: 0, truncated: 0 } } }
    expect(checkSmokeResult(broken, 'wt-smoke-ok')).toContain('envelope.trail is missing, not an array, or empty')
  })

  it('rejects a non-object result', () => {
    expect(checkSmokeResult('nope', 'wt-smoke-ok')[0]).toContain('not an object')
  })
})

describe('summarize', () => {
  it('passes only when every check passed', () => {
    const ok = summarize([{ name: 'a', ok: true, detail: '' }, { name: 'b', ok: true, detail: 'x' }])
    expect(ok.passed).toBe(true)
    expect(ok.report).toContain('All 2 smoke check(s) passed.')
  })

  it('fails when any check failed and counts failures', () => {
    const bad = summarize([{ name: 'a', ok: true, detail: '' }, { name: 'b', ok: false, detail: 'boom' }])
    expect(bad.passed).toBe(false)
    expect(bad.report).toContain('1 of 2 smoke check(s) FAILED.')
    expect(bad.report).toContain('FAIL  b — boom')
  })

  it('is not vacuously green on an empty result set', () => {
    expect(summarize([]).passed).toBe(false)
  })
})

describe('readInitVersion', () => {
  it('reads claude_code_version from the SDK init system message', () => {
    expect(readInitVersion({ type: 'system', subtype: 'init', claude_code_version: '2.1.168' })).toBe('2.1.168')
  })

  it('returns null for non-init messages and missing version', () => {
    expect(readInitVersion({ type: 'system', subtype: 'task_notification' })).toBeNull()
    expect(readInitVersion({ type: 'system', subtype: 'init' })).toBeNull()
    expect(readInitVersion(SUCCESS)).toBeNull()
    expect(readInitVersion(null)).toBeNull()
  })
})

describe('live-runner helpers', () => {
  it('launchPrompt embeds the exact scriptPath and a single-call instruction', () => {
    const p = launchPrompt('/abs/path/wf.js')
    expect(p).toContain('scriptPath set to "/abs/path/wf.js"')
    expect(p).toContain('exactly once')
  })

  it('isAbortError recognizes AbortError by name and by message', () => {
    const named = new Error('whatever')
    named.name = 'AbortError'
    expect(isAbortError(named)).toBe(true)
    expect(isAbortError(new Error('The operation was aborted'))).toBe(true)
    expect(isAbortError(new Error('network down'))).toBe(false)
    expect(isAbortError('abort')).toBe(false)
  })

  it('annotateAuth augments auth/binary failures and passes others through', () => {
    const auth = annotateAuth(new Error('authentication_failed'))
    expect(auth.message).toMatch(/~\/\.claude credentials/)
    const other = new Error('some unrelated failure')
    expect(annotateAuth(other)).toBe(other)
  })
})
