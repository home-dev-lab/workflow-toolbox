// tool-denial.test.ts — unit tests for the PURE transcript tool-denial scanner.
//
// The matcher is a CLOSED allow-list of three grounded policy-denial wordings (see
// tool-denial.ts). The two halves of correctness it must hold:
//   1. RECALL on the real signatures (auto-mode classifier, generic rejection, hook denial) —
//      using the EXACT strings captured from on-disk transcripts on 2026-06-29.
//   2. PRECISION against ordinary tool errors (exit codes, MCP arg-validation, oversize reads,
//      404s, EISDIR, "No such tool available") — a false "degraded" erodes trust in the signal.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  classifyDenial,
  parseTranscriptDenials,
  buildToolDenialReport,
  emptyDenialReport,
  type ToolDenial,
} from '../src/tool-denial.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

// The exact on-disk wordings (captured 2026-06-29).
const AUTO_MODE =
  'Permission for this action was denied by the Claude Code auto mode classifier. Reason: ' +
  '[Create Unsafe Agents] `codex exec --sandbox workspace-write` launches another autonomous AI ' +
  "agent that executes code/commands without human approval.. If you have other tasks that don't " +
  'depend on this action, continue working on those.'
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was " +
  'a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for ' +
  'the user to tell you how to proceed.'
const HOOK = 'Hook PreToolUse:WebFetch denied this tool'

describe('classifyDenial — recall on the real denial signatures', () => {
  it('classifies the auto-mode classifier denial and extracts the [Reason] tag', () => {
    expect(classifyDenial(AUTO_MODE)).toEqual({
      kind: 'auto-mode-classifier',
      reason: '[Create Unsafe Agents]',
    })
  })

  it('classifies the generic rejection (no human in a workflow run = a policy denial)', () => {
    expect(classifyDenial(REJECTED)).toEqual({ kind: 'rejected', reason: null })
  })

  it('classifies a PreToolUse hook denial', () => {
    expect(classifyDenial(HOOK)).toEqual({ kind: 'hook', reason: null })
  })

  it('matches the auto-mode wording even without a Reason tag', () => {
    expect(classifyDenial('Permission for this action was denied by the Claude Code auto mode classifier.')).toEqual(
      { kind: 'auto-mode-classifier', reason: null },
    )
  })
})

describe('classifyDenial — precision: ordinary errors are NOT denials', () => {
  const nonDenials = [
    'Exit code 1\nenvelope.ts:116: emitDigest()',
    'MCP error -32602: Input validation error: Invalid arguments for tool ctx_batch_execute',
    'File content (302.5KB) exceeds maximum allowed size (256KB).',
    'Failed to fetch https://example.com/x: HTTP 404',
    "EISDIR: illegal operation on a directory, read '/tmp/x'",
    '<tool_use_error>Error: No such tool available: bash</tool_use_error>',
    "<tool_use_error>InputValidationError: Read failed</tool_use_error>",
    'BLOCKED: 10 search calls in 14s. You are flooding context.',
    '',
  ]
  for (const text of nonDenials) {
    it(`returns null for: ${JSON.stringify(text.slice(0, 40))}`, () => {
      expect(classifyDenial(text)).toBeNull()
    })
  }

  it('returns null for a non-string input', () => {
    expect(classifyDenial(undefined as unknown as string)).toBeNull()
  })
})

describe('parseTranscriptDenials — over a realistic transcript', () => {
  const jsonl = readFileSync(join(FIXTURES, 'agent-denied-sample.jsonl'), 'utf8')
  const denials = parseTranscriptDenials(jsonl, 'a-agent1')

  it('extracts exactly the three denials, skipping the two ordinary errors', () => {
    expect(denials).toHaveLength(3)
    expect(denials.map((d) => d.kind)).toEqual(['rejected', 'hook', 'auto-mode-classifier'])
  })

  it('attributes each denial to its tool + attempted detail', () => {
    expect(denials[0]).toMatchObject({ agentId: 'a-agent1', tool: 'Bash' })
    expect(denials[0]!.detail).toContain('git diff 4bc5dde..30b62ff')
    expect(denials[1]).toMatchObject({ tool: 'WebFetch', kind: 'hook' })
    expect(denials[1]!.detail).toContain('raw.githubusercontent.com')
    expect(denials[2]).toMatchObject({ tool: 'Bash', reason: '[Create Unsafe Agents]' })
    expect(denials[2]!.detail).toContain('codex exec')
  })

  it('marks the tool "(unknown)" when no matching tool_use precedes the result', () => {
    const orphan =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result",' +
      '"tool_use_id":"toolu_x","is_error":true,"content":"The tool use was rejected"}]}}'
    const out = parseTranscriptDenials(orphan, 'a-orphan')
    expect(out).toEqual([{ agentId: 'a-orphan', tool: '(unknown)', detail: '', kind: 'rejected', reason: null, at: null }])
  })

  it('stamps each denial with its line timestamp (at), null when the line has none', () => {
    const stamped =
      '{"type":"user","timestamp":"2026-07-13T22:00:00.000Z","message":{"role":"user","content":[{"type":"tool_result",' +
      '"tool_use_id":"t","is_error":true,"content":"The tool use was rejected"}]}}\n' +
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result",' +
      '"tool_use_id":"t2","is_error":true,"content":"The tool use was rejected"}]}}'
    const out = parseTranscriptDenials(stamped, 'a-ts')
    expect(out).toHaveLength(2)
    expect(out[0]!.at).toBe('2026-07-13T22:00:00.000Z')
    expect(out[1]!.at).toBeNull()
  })

  it('never throws on malformed lines', () => {
    expect(() => parseTranscriptDenials('not json\n{bad\n', 'a')).not.toThrow()
    expect(parseTranscriptDenials('not json\n{bad\n', 'a')).toEqual([])
  })

  it('flattens an array-of-text-blocks tool_result content', () => {
    const arr =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result",' +
      '"tool_use_id":"t","is_error":true,"content":[{"type":"text","text":"Hook PreToolUse:Bash denied this tool"}]}]}}'
    expect(parseTranscriptDenials(arr, 'a')).toHaveLength(1)
  })

  // PRECISION: a SUCCESSFUL tool_result that merely QUOTES a denial phrase (e.g. a workflow
  // grepping a transcript / the CC logs / this module's own source) must NOT be flagged. The
  // is_error gate is what kills this self-referential false-positive vector.
  it('does NOT flag a non-error tool_result that merely quotes a denial phrase', () => {
    const quoted =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result",' +
      '"tool_use_id":"t","is_error":false,"content":"grep hit: \\"The tool use was rejected\\" and ' +
      '\\"denied by the Claude Code auto mode classifier\\""}]}}'
    expect(parseTranscriptDenials(quoted, 'a')).toEqual([])
  })

  it('does NOT flag a tool_result with no is_error field even if it quotes a phrase', () => {
    const noFlag =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result",' +
      '"tool_use_id":"t","content":"Hook PreToolUse:WebFetch denied this tool"}]}}'
    expect(parseTranscriptDenials(noFlag, 'a')).toEqual([])
  })
})

describe('buildToolDenialReport — run-level rollup', () => {
  it('aggregates across agents, groups Bash by command head, and flags degraded', () => {
    const a1: ToolDenial[] = [
      { agentId: 'a1', tool: 'Bash', detail: 'git diff a..b -- x', kind: 'rejected', reason: null, at: null },
      { agentId: 'a1', tool: 'Bash', detail: 'git diff c..d -- y', kind: 'rejected', reason: null, at: null },
    ]
    const a2: ToolDenial[] = [
      { agentId: 'a2', tool: 'Bash', detail: 'git diff e..f', kind: 'rejected', reason: null, at: null },
      { agentId: 'a2', tool: 'WebFetch', detail: 'https://x', kind: 'hook', reason: null, at: null },
    ]
    const r = buildToolDenialReport([a1, a2])
    expect(r.total).toBe(4)
    expect(r.agentsAffected).toBe(2)
    expect(r.degraded).toBe(true)
    expect(r.bySignature[0]).toEqual({ signature: 'git diff', count: 3 })
    expect(r.bySignature).toContainEqual({ signature: 'WebFetch', count: 1 })
  })

  it('collapses a leading "cd <dir> &&" to the real verb (first non-cd segment)', () => {
    const r = buildToolDenialReport([
      [{ agentId: 'a', tool: 'Bash', detail: 'cd toolkit && git log --oneline', kind: 'rejected', reason: null, at: null }],
    ])
    expect(r.bySignature[0]).toEqual({ signature: 'git log', count: 1 })
  })

  it('groups by the FIRST command, not a trailing "&& echo" (signatureOf direction)', () => {
    const r = buildToolDenialReport([
      [{ agentId: 'a', tool: 'Bash', detail: 'git diff a..b && echo done', kind: 'rejected', reason: null, at: null }],
    ])
    expect(r.bySignature[0]).toEqual({ signature: 'git diff', count: 1 })
  })

  it('aggregates ACROSS sources (pipeline stages) by global agentId — distinct ids sum, a shared id counts once', () => {
    // The observe-ui pipeline combined view flattens each stage's denials into one report.
    // Two stages with DISTINCT agentIds (the 17-char random-id runtime guarantee) → summed.
    const stage1: ToolDenial[] = [{ agentId: 'a-stage1', tool: 'Bash', detail: 'git diff x', kind: 'rejected', reason: null, at: null }]
    const stage2: ToolDenial[] = [{ agentId: 'a-stage2', tool: 'Bash', detail: 'git diff y', kind: 'rejected', reason: null, at: null }]
    const r = buildToolDenialReport([stage1, stage2])
    expect(r.total).toBe(2)
    expect(r.agentsAffected).toBe(2) // distinct agentIds → two affected agents

    // A shared agentId across sources is the SAME affected agent (the documented global-key contract
    // the cross-stage rollup relies on) — counted once, not double-counted.
    const shared: ToolDenial[] = [{ agentId: 'a-stage1', tool: 'Bash', detail: 'git diff z', kind: 'rejected', reason: null, at: null }]
    const r2 = buildToolDenialReport([stage1, shared])
    expect(r2.total).toBe(2)
    expect(r2.agentsAffected).toBe(1) // same agentId → one affected agent
  })

  it('reports not-degraded for no denials', () => {
    const r = buildToolDenialReport([])
    expect(r).toEqual(emptyDenialReport())
    expect(r.degraded).toBe(false)
  })
})

describe('parseTranscriptDenials — recovery-awareness (denied+recovered ≠ denied+blind)', () => {
  // Synthetic transcripts in the real on-disk line shape. Every recovery signal asserted
  // here is grounded on a REAL occurrence: WebFetch→WebSearch (run wf_43d020e4-fbe),
  // WebFetch→ctx_fetch_and_index (run wf_822e6cf3-326), Bash curl→ctx_execute (session
  // 2026-07-02). Precision posture unchanged: no signal → no recovered field, never guess.
  const line = (blocks: unknown[], ts?: string): string =>
    JSON.stringify({ type: 'x', ...(ts !== undefined ? { timestamp: ts } : {}), message: { role: 'x', content: blocks } })
  const use = (id: string, name: string, input: unknown): unknown => ({ type: 'tool_use', id, name, input })
  const ok = (id: string): unknown => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })
  const err = (id: string, content: string): unknown => ({ type: 'tool_result', tool_use_id: id, is_error: true, content })
  const HOOK_WF = 'Hook PreToolUse:WebFetch denied this tool'
  const CTX_FETCH = 'mcp__plugin_context-mode_context-mode__ctx_fetch_and_index'
  const CTX_EXEC = 'mcp__plugin_context-mode_context-mode__ctx_execute'

  it('fetch-class: a hook-denied WebFetch followed by a successful WebSearch is recovered (the wf_43d020e4-fbe case)', () => {
    const jsonl = [
      line([use('t1', 'WebFetch', { url: 'https://html.spec.whatwg.org/x' })]),
      line([err('t1', HOOK_WF)]),
      line([use('t2', 'WebSearch', { query: 'Location href navigate' })]),
      line([ok('t2')], '2026-07-02T12:00:00.000Z'),
    ].join('\n')
    const denials = parseTranscriptDenials(jsonl, 'a')
    expect(denials).toHaveLength(1)
    expect(denials[0]!.recovered).toEqual({ via: 'WebSearch', at: '2026-07-02T12:00:00.000Z' })
  })

  it('fetch-class: a denied WebFetch recovered via a successful MCP fetch tool (the wf_822e6cf3-326 case)', () => {
    const jsonl = [
      line([use('t1', 'WebFetch', { url: 'https://a' }), use('t2', CTX_FETCH, { url: 'https://a' })]),
      line([err('t1', HOOK_WF)]),
      line([ok('t2')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toEqual({ via: CTX_FETCH, at: null })
  })

  it('exec-fallback: a denied Bash recovered via a successful MCP execute tool (the curl→ctx_execute case)', () => {
    const jsonl = [
      line([use('t1', 'Bash', { command: 'curl -s http://127.0.0.1:5177/api/health' })]),
      line([err('t1', 'The user doesn’t want to proceed with this tool use. The tool use was rejected')]),
      line([use('t2', CTX_EXEC, { language: 'javascript', code: 'fetch(...)' })]),
      line([ok('t2')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toEqual({ via: CTX_EXEC, at: null })
  })

  it('exact retry: the SAME tool with the SAME attempted detail succeeding later is recovered', () => {
    const jsonl = [
      line([use('t1', 'Read', { file_path: '/x.ts' })]),
      line([err('t1', 'The tool use was rejected')]),
      line([use('t2', 'Read', { file_path: '/x.ts' })]),
      line([ok('t2')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toEqual({ via: 'Read', at: null })
  })

  it('a DIFFERENT detail on the same tool is NOT an exact retry (no recovery claimed)', () => {
    const jsonl = [
      line([use('t1', 'Read', { file_path: '/x.ts' })]),
      line([err('t1', 'The tool use was rejected')]),
      line([use('t2', 'Read', { file_path: '/other.ts' })]),
      line([ok('t2')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toBeUndefined()
  })

  it('a generic later Bash success does NOT recover a denied Bash (any run has later Bash calls)', () => {
    const jsonl = [
      line([use('t1', 'Bash', { command: 'git push origin main' })]),
      line([err('t1', 'The tool use was rejected')]),
      line([use('t2', 'Bash', { command: 'ls -la' })]),
      line([ok('t2')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toBeUndefined()
  })

  it('ToolSearch success after a denied WebFetch is NOT fetch-class (loading a schema fetches no content)', () => {
    const jsonl = [
      line([use('t1', 'WebFetch', { url: 'https://a' })]),
      line([err('t1', HOOK_WF)]),
      line([use('t2', 'ToolSearch', { query: 'select:WebSearch' })]),
      line([ok('t2')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toBeUndefined()
  })

  it('a success BEFORE the denial is not a recovery (order matters)', () => {
    const jsonl = [
      line([use('t0', 'WebSearch', { query: 'q' })]),
      line([ok('t0')]),
      line([use('t1', 'WebFetch', { url: 'https://a' })]),
      line([err('t1', HOOK_WF)]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toBeUndefined()
  })

  it('recovery carries at:null when the recovering line has no timestamp', () => {
    const jsonl = [
      line([use('t1', 'WebFetch', { url: 'https://a' })]),
      line([err('t1', HOOK_WF)]),
      line([use('t2', 'WebSearch', { query: 'q' })]),
      line([ok('t2')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toEqual({ via: 'WebSearch', at: null })
  })

  it('recovered denials still COUNT as denials in the report (annotate, never suppress)', () => {
    const jsonl = [
      line([use('t1', 'WebFetch', { url: 'https://a' })]),
      line([err('t1', HOOK_WF)]),
      line([use('t2', 'WebSearch', { query: 'q' })]),
      line([ok('t2')]),
    ].join('\n')
    const r = buildToolDenialReport([parseTranscriptDenials(jsonl, 'a')])
    expect(r.total).toBe(1)
    expect(r.degraded).toBe(true)
    expect(r.denials[0]!.recovered?.via).toBe('WebSearch')
  })
})

describe('recovery matching — precision hardening (review wf_9fdbddfe-ba5)', () => {
  const line = (blocks: unknown[], ts?: string): string =>
    JSON.stringify({ type: 'x', ...(ts !== undefined ? { timestamp: ts } : {}), message: { role: 'x', content: blocks } })
  const use = (id: string, name: string, input: unknown): unknown => ({ type: 'tool_use', id, name, input })
  const ok = (id: string): unknown => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })
  const err = (id: string, content: string): unknown => ({ type: 'tool_result', tool_use_id: id, is_error: true, content })
  const HOOK_WF = 'Hook PreToolUse:WebFetch denied this tool'
  const CTX_EXEC = 'mcp__plugin_context-mode_context-mode__ctx_execute'

  it('one success recovers ONE denial, not every earlier one (consumed after its first match)', () => {
    const jsonl = [
      line([use('d1', 'Bash', { command: 'npm test' })]),
      line([err('d1', 'The tool use was rejected')]),
      line([use('d2', 'Bash', { command: 'git diff HEAD~1' })]),
      line([err('d2', 'The tool use was rejected')]),
      line([use('s1', CTX_EXEC, { language: 'javascript', code: 'run()' })]),
      line([ok('s1')]),
    ].join('\n')
    const denials = parseTranscriptDenials(jsonl, 'a')
    expect(denials).toHaveLength(2)
    expect(denials.filter((d) => d.recovered !== undefined)).toHaveLength(1)
  })

  it('a matching success far past the proximity window does NOT recover (no unbounded credit)', () => {
    const fillers: string[] = []
    for (let i = 0; i < 6; i++) {
      fillers.push(line([use(`f${i}`, 'Read', { file_path: `/f${i}` })]), line([ok(`f${i}`)]))
    }
    const jsonl = [
      line([use('d1', 'WebFetch', { url: 'https://a' })]),
      line([err('d1', HOOK_WF)]),
      ...fillers,
      line([use('s1', 'WebSearch', { query: 'q' })]),
      line([ok('s1')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toBeUndefined()
  })

  it('same-tool with a DIFFERENT url still counts as fetch-class recovery (WebFetch→WebFetch)', () => {
    const jsonl = [
      line([use('d1', 'WebFetch', { url: 'https://a.example/1' })]),
      line([err('d1', HOOK_WF)]),
      line([use('s1', 'WebFetch', { url: 'https://a.example/2' })]),
      line([ok('s1')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toEqual({ via: 'WebFetch', at: null })
  })

  it('two long commands sharing a 120-char prefix are NOT an exact retry (compares untruncated detail)', () => {
    const prefix = `echo ${'x'.repeat(130)}`
    const jsonl = [
      line([use('d1', 'Bash', { command: `${prefix} one` })]),
      line([err('d1', 'The tool use was rejected')]),
      line([use('s1', 'Bash', { command: `${prefix} two` })]),
      line([ok('s1')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toBeUndefined()
  })

  it('buildToolDenialReport exposes recoveredCount + allRecovered (single source for the wording gates)', () => {
    const rec: ToolDenial = { agentId: 'a', tool: 'WebFetch', detail: 'https://a', kind: 'hook', reason: null, at: null, recovered: { via: 'WebSearch', at: null } }
    const bare: ToolDenial = { agentId: 'a', tool: 'Bash', detail: 'git diff', kind: 'rejected', reason: null, at: null }
    const mixed = buildToolDenialReport([[rec, bare]])
    expect(mixed.recoveredCount).toBe(1)
    expect(mixed.allRecovered).toBe(false)
    const all = buildToolDenialReport([[rec]])
    expect(all.recoveredCount).toBe(1)
    expect(all.allRecovered).toBe(true)
    expect(emptyDenialReport().recoveredCount).toBe(0)
    expect(emptyDenialReport().allRecovered).toBe(false) // no denials ≠ all recovered
  })
})

describe('recovery matching — round-2 hardening (review wf_8036d275-e0a)', () => {
  const line = (blocks: unknown[]): string => JSON.stringify({ type: 'x', message: { role: 'x', content: blocks } })
  const use = (id: string, name: string, input: unknown): unknown => ({ type: 'tool_use', id, name, input })
  const ok = (id: string): unknown => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })
  const err = (id: string, content: string): unknown => ({ type: 'tool_result', tool_use_id: id, is_error: true, content })
  const HOOK_WF = 'Hook PreToolUse:WebFetch denied this tool'
  const CTX_EXEC = 'mcp__plugin_context-mode_context-mode__ctx_execute'

  it('a tool name merely CONTAINING "search" (research_status) is NOT fetch-class (word boundary)', () => {
    const jsonl = [
      line([use('d1', 'WebFetch', { url: 'https://a' })]),
      line([err('d1', HOOK_WF)]),
      line([use('s1', 'mcp__foo__research_status', { query: 'q' })]),
      line([ok('s1')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toBeUndefined()
  })

  it('boundary-separated fetch/search MCP names still match (ctx_fetch_and_index, web_search)', () => {
    const jsonl = [
      line([use('d1', 'WebFetch', { url: 'https://a' })]),
      line([err('d1', HOOK_WF)]),
      line([use('s1', 'mcp__acme__web_search', { query: 'q' })]),
      line([ok('s1')]),
    ].join('\n')
    expect(parseTranscriptDenials(jsonl, 'a')[0]!.recovered).toEqual({ via: 'mcp__acme__web_search', at: null })
  })

  it('a success is attributed to the CLOSEST preceding unrecovered denial, not the earliest (misattribution repro)', () => {
    const jsonl = [
      line([use('d1', 'Bash', { command: 'npm test' })]),
      line([err('d1', 'The tool use was rejected')]),
      line([use('d2', 'Bash', { command: 'git diff HEAD~1' })]),
      line([err('d2', 'The tool use was rejected')]),
      line([use('s1', CTX_EXEC, { language: 'javascript', code: 'run()' })]),
      line([ok('s1')]),
    ].join('\n')
    const denials = parseTranscriptDenials(jsonl, 'a')
    // The agent reacts to its LAST failure — the adjacent git-diff denial gets the credit.
    expect(denials[1]!.recovered).toEqual({ via: CTX_EXEC, at: null })
    expect(denials[0]!.recovered).toBeUndefined()
  })

  it('two successes recover two stacked denials (closest-first does not starve the earlier one)', () => {
    const jsonl = [
      line([use('d1', 'Bash', { command: 'npm test' })]),
      line([err('d1', 'The tool use was rejected')]),
      line([use('d2', 'Bash', { command: 'git diff HEAD~1' })]),
      line([err('d2', 'The tool use was rejected')]),
      line([use('s1', CTX_EXEC, { language: 'javascript', code: 'a()' })]),
      line([ok('s1')]),
      line([use('s2', CTX_EXEC, { language: 'javascript', code: 'b()' })]),
      line([ok('s2')]),
    ].join('\n')
    const denials = parseTranscriptDenials(jsonl, 'a')
    expect(denials[0]!.recovered).toBeDefined()
    expect(denials[1]!.recovered).toBeDefined()
  })
})
