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
  classifyAgentFile,
  isAbortError,
  LaunchTimeoutError,
  launchPrompt,
  launchVerdict,
  parseLaunchText,
  peelLaunch,
  readInitVersion,
  readTaskNotification,
  readToolResult,
  readWorkflowToolUse,
  resumePrompt,
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
  it('pulls Task ID, Run ID and Transcript dir out of the formatted launch text', () => {
    const text =
      'Workflow launched in background. Task ID: w71kc0tlj\nSummary: x\n' +
      'Transcript dir: /home/u/.claude/projects/slug/sess/subagents/workflows/wf_89363eba-692\nRun ID: wf_89363eba-692\n'
    expect(parseLaunchText(text)).toEqual({
      taskId: 'w71kc0tlj',
      runId: 'wf_89363eba-692',
      transcriptDir: '/home/u/.claude/projects/slug/sess/subagents/workflows/wf_89363eba-692',
    })
  })

  it('returns null for transcriptDir when only that marker is absent (fields are independent)', () => {
    const text = 'Task ID: w71kc0tlj\nRun ID: wf_89363eba-692\n'
    expect(parseLaunchText(text)).toEqual({ taskId: 'w71kc0tlj', runId: 'wf_89363eba-692', transcriptDir: null })
  })

  it('returns nulls when the markers are absent', () => {
    expect(parseLaunchText('nothing here')).toEqual({ taskId: null, runId: null, transcriptDir: null })
  })
})

describe('classifyAgentFile', () => {
  it('returns the agentId for a valid agent transcript filename', () => {
    expect(classifyAgentFile('agent-abc123.jsonl')).toBe('abc123')
    expect(classifyAgentFile('agent-wf_89363eba-692.jsonl')).toBe('wf_89363eba-692')
    expect(classifyAgentFile('agent-A_B-C.jsonl')).toBe('A_B-C')
  })

  it('returns null for non-transcript siblings', () => {
    expect(classifyAgentFile('journal.jsonl')).toBeNull()
    expect(classifyAgentFile('agent-abc123.meta.json')).toBeNull()
    expect(classifyAgentFile('agent-abc123.json')).toBeNull()
    expect(classifyAgentFile('agent-.jsonl')).toBeNull() // empty id
    expect(classifyAgentFile('agent-abc 123.jsonl')).toBeNull() // space not in charset
    expect(classifyAgentFile('other.jsonl')).toBeNull()
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

  it('launchPrompt omits the args clause when no args are given', () => {
    expect(launchPrompt('/abs/path/wf.js')).not.toContain('args set to')
  })

  it('launchPrompt embeds args as an exact JSON literal when provided', () => {
    const p = launchPrompt('/abs/path/wf.js', { topic: 'x', n: 3 })
    expect(p).toContain('args set to this exact JSON value: {"topic":"x","n":3}')
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

  it('resumePrompt embeds scriptPath + resumeFromRunId as one exact JSON literal', () => {
    const p = resumePrompt('/abs/path/wf.js', 'wf_abc123-def')
    expect(p).toContain(JSON.stringify({ scriptPath: '/abs/path/wf.js', resumeFromRunId: 'wf_abc123-def' }))
  })

  it('resumePrompt omits the args field entirely when no args are given', () => {
    const p = resumePrompt('/abs/path/wf.js', 'wf_abc123-def')
    expect(p).not.toContain('"args"')
  })

  it('resumePrompt embeds args as an exact JSON literal when provided', () => {
    const p = resumePrompt('/abs/path/wf.js', 'wf_abc123-def', { topic: 'x', n: 3 })
    expect(p).toContain(JSON.stringify({ scriptPath: '/abs/path/wf.js', resumeFromRunId: 'wf_abc123-def', args: { topic: 'x', n: 3 } }))
  })

  it('resumePrompt instructs a single Workflow call, same posture as launchPrompt', () => {
    const p = resumePrompt('/abs/path/wf.js', 'wf_abc123-def')
    expect(p).toMatch(/exactly once/)
  })
})

describe('peelLaunch', () => {
  // Build a user tool_result message the way readToolResult expects it.
  const toolResultMsg = (text: string, isError = false): unknown => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_peel', is_error: isError, content: text }] },
  })
  // A finite async iterator over a fixed list (mimics the SDK stream iterator).
  const iterOf = (items: readonly unknown[]): AsyncIterator<unknown> => {
    let i = 0
    return { next: () => Promise.resolve(i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true }) }
  }
  const LAUNCH_TEXT =
    'Workflow launched in background. Task ID: w1\n' +
    'Transcript dir: /tmp/subagents/workflows/wf_peel-1\nRun ID: wf_peel-1\n'

  it('returns the runId + transcriptDir + toolUseId from the launch tool_result, skipping leading non-results', async () => {
    const it = iterOf([
      // The init is SKIPPED as a non-result but its session_id is CAPTURED — the
      // identity a server needs to resume this session after its process dies
      // (resume-parity canary 2026-07-08, card #1812476922312000519).
      { type: 'system', subtype: 'init', session_id: 'sess-4ee409c8' },
      { type: 'assistant', message: { content: [] } }, // no tool_result — skipped
      toolResultMsg(LAUNCH_TEXT),
    ])
    await expect(peelLaunch(it, 1000)).resolves.toEqual({
      runId: 'wf_peel-1',
      transcriptDir: '/tmp/subagents/workflows/wf_peel-1',
      toolUseId: 'toolu_peel',
      sessionId: 'sess-4ee409c8',
    })
  })

  it('yields sessionId null when no init precedes the launch tool_result', async () => {
    const it = iterOf([toolResultMsg(LAUNCH_TEXT)])
    await expect(peelLaunch(it, 1000)).resolves.toMatchObject({ runId: 'wf_peel-1', sessionId: null })
  })

  it('rejects with LaunchTimeoutError when no tool_result arrives within the deadline', async () => {
    const neverIter: AsyncIterator<unknown> = { next: () => new Promise<never>(() => {}) }
    const err = await peelLaunch(neverIter, 30).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LaunchTimeoutError)
    expect((err as LaunchTimeoutError).timeoutMs).toBe(30)
  })

  it('throws when the launch tool_result is an error (syntax rejection)', async () => {
    const it = iterOf([toolResultMsg('<tool_use_error>Invalid workflow script</tool_use_error>', true)])
    await expect(peelLaunch(it, 1000)).rejects.toThrow(/rejected/)
  })

  it('throws when the stream ends before any launch tool_result', async () => {
    const it = iterOf([{ type: 'system', subtype: 'init' }])
    await expect(peelLaunch(it, 1000)).rejects.toThrow(/ended before/)
  })

  it('throws when the tool_result lacks the Run ID / Transcript dir markers', async () => {
    const it = iterOf([toolResultMsg('launched, but no identifiers here')])
    await expect(peelLaunch(it, 1000)).rejects.toThrow(/Run ID/)
  })
})
