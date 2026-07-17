// capabilities-probe.test.ts — TEST-LOCKs for the probe's pure stream-parsing
// (review of c77d187, findings 2.1/2.2/2.3): synthetic SDK messages, no launch.

import { describe, expect, it } from 'vitest'
import { checkExpectations, emptyOutcome, ingestProbeMessage, type CapabilitiesProbeSpec } from '../src/capabilities-probe.js'

const SPEC: CapabilitiesProbeSpec = {
  main: { prompt: 'x' },
  expect: { subagentToolPrefix: 'mcp__serena__', minSubagentInstances: 1, noMcpToolErrors: true },
}

function assistantMsg(over: Record<string, unknown>, inner: Record<string, unknown>): Record<string, unknown> {
  return { type: 'assistant', session_id: 's1', message: inner, ...over }
}

describe('ingestProbeMessage + checkExpectations', () => {
  it('LOCK 2.1: an unrelated Read error does NOT fail the MCP-scoped noMcpToolErrors check', () => {
    const out = emptyOutcome()
    // subagent uses Read (id r1, errors) and a serena tool (id s1, succeeds)
    ingestProbeMessage(out, assistantMsg({ subagent_type: 'wt-check', parent_tool_use_id: 'ptu_AAAA1111' }, {
      id: 'm1',
      content: [
        { type: 'tool_use', id: 'r1', name: 'Read', input: {} },
        { type: 'tool_use', id: 's1', name: 'mcp__serena__find_symbol', input: {} },
      ],
    }))
    ingestProbeMessage(out, { type: 'user', session_id: 's1', subagent_type: 'wt-check', parent_tool_use_id: 'ptu_AAAA1111', message: { content: [
      { type: 'tool_result', tool_use_id: 'r1', is_error: true, content: 'ENOENT' },
      { type: 'tool_result', tool_use_id: 's1', content: 'ok' },
    ] } })
    const { pass, lines } = checkExpectations(SPEC, out)
    expect(pass, lines.join('\n')).toBe(true)
  })

  it('LOCK 2.1 (inverse): a serena tool error DOES fail the scoped check', () => {
    const out = emptyOutcome()
    ingestProbeMessage(out, assistantMsg({ subagent_type: 'wt-check', parent_tool_use_id: 'ptu_BBBB2222' }, {
      id: 'm1',
      content: [{ type: 'tool_use', id: 's1', name: 'mcp__serena__find_symbol', input: {} }],
    }))
    ingestProbeMessage(out, { type: 'user', session_id: 's1', subagent_type: 'wt-check', parent_tool_use_id: 'ptu_BBBB2222', message: { content: [
      { type: 'tool_result', tool_use_id: 's1', is_error: true, content: 'boom' },
    ] } })
    const { pass } = checkExpectations(SPEC, out)
    expect(pass).toBe(false)
  })

  it('LOCK 2.3: the fallback bucket (no parent_tool_use_id) does not count toward minSubagentInstances', () => {
    const out = emptyOutcome()
    // Only a fallback-tagged message (e.g. a Task RESULT notification): 0 real instances.
    ingestProbeMessage(out, assistantMsg({ subagent_type: 'wt-check' }, { id: 'm1', content: [] }))
    const { pass, lines } = checkExpectations({ main: { prompt: 'x' }, expect: { minSubagentInstances: 1 } }, out)
    expect(pass, lines.join('\n')).toBe(false)
    // Add one keyed instance → passes.
    ingestProbeMessage(out, assistantMsg({ subagent_type: 'wt-check', parent_tool_use_id: 'ptu_CCCC3333' }, { id: 'm2', content: [{ type: 'tool_use', id: 't1', name: 'mcp__serena__find_symbol', input: {} }] }))
    expect(checkExpectations({ main: { prompt: 'x' }, expect: { minSubagentInstances: 1 } }, out).pass).toBe(true)
  })

  it('LOCK 2.2: usage is deduped by message id when present (same id twice counts once)', () => {
    const out = emptyOutcome()
    const inner = { id: 'dup', usage: { cache_creation_input_tokens: 100, output_tokens: 5 }, content: [] }
    const msg = assistantMsg({ subagent_type: 'wt-check', parent_tool_use_id: 'ptu_DDDD4444' }, inner)
    ingestProbeMessage(out, msg)
    ingestProbeMessage(out, msg)
    const stats = [...out.instances.values()].find((s) => !s.isFallback)
    expect(stats?.outputTokens).toBe(5)
  })

  it('keeps the LAST result text across multiple result messages (async Task spawns)', () => {
    const out = emptyOutcome()
    ingestProbeMessage(out, { type: 'result', result: 'first (premature)' })
    ingestProbeMessage(out, { type: 'result', result: 'final answer' })
    expect(out.resultText).toBe('final answer')
    expect(out.resultCount).toBe(2)
  })
})
