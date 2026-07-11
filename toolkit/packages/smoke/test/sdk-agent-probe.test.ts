// sdk-agent-probe.test.ts — unit tests for the pure init/result readers behind
// the SDK-path least-privilege probe (src/sdk-agent-probe.ts). Fake SDK-shaped
// messages stand in for a real query() stream (mirroring sdk-driver.test.ts): the
// live probe itself (runProbe / the CASES) stays integration-verified by
// `pnpm canary:agents`; only the message readers are unit-tested here.

import { describe, expect, it } from 'vitest'
import { readInitSurface, readPermissionDenials, readResultText } from '../src/sdk-agent-probe.js'

const initMessage = (over: Record<string, unknown> = {}): unknown => ({
  type: 'system',
  subtype: 'init',
  claude_code_version: '2.1.205',
  model: 'claude-fable-5',
  cwd: '/repo',
  tools: ['Read', 'Glob', 'Bash'],
  mcp_servers: [
    { name: 'planka', status: 'connected' },
    { name: 'serena', status: 'pending' },
  ],
  skills: ['deep-research', 'verify'],
  agents: ['Explore', 'general-purpose'],
  slash_commands: ['/compact'],
  ...over,
})

describe('readInitSurface', () => {
  it('extracts the full capability surface from an init message', () => {
    const s = readInitSurface(initMessage())
    expect(s).not.toBeNull()
    expect(s?.ccVersion).toBe('2.1.205')
    expect(s?.model).toBe('claude-fable-5')
    expect(s?.cwd).toBe('/repo')
    expect(s?.tools).toEqual(['Read', 'Glob', 'Bash'])
    expect(s?.mcpServers).toEqual([
      { name: 'planka', status: 'connected' },
      { name: 'serena', status: 'pending' },
    ])
    expect(s?.skills).toEqual(['deep-research', 'verify'])
    expect(s?.agents).toEqual(['Explore', 'general-purpose'])
    expect(s?.slashCommands).toEqual(['/compact'])
  })

  it('returns null for a non-init message', () => {
    expect(readInitSurface({ type: 'system', subtype: 'task_notification' })).toBeNull()
    expect(readInitSurface({ type: 'assistant', message: {} })).toBeNull()
    expect(readInitSurface(null)).toBeNull()
    expect(readInitSurface('not a message')).toBeNull()
  })

  it('coerces missing/malformed arrays to empty and non-string scalars to null', () => {
    const s = readInitSurface({ type: 'system', subtype: 'init' })
    expect(s).not.toBeNull()
    expect(s?.ccVersion).toBeNull()
    expect(s?.model).toBeNull()
    expect(s?.tools).toEqual([])
    expect(s?.mcpServers).toEqual([])
    expect(s?.skills).toEqual([])
  })

  it('drops non-string entries inside the tool/skill arrays', () => {
    const s = readInitSurface(initMessage({ tools: ['Read', 42, null, 'Bash'] }))
    expect(s?.tools).toEqual(['Read', 'Bash'])
  })
})

describe('readResultText', () => {
  it('returns the result string of a result message', () => {
    expect(readResultText({ type: 'result', subtype: 'success', result: 'NONE' })).toBe('NONE')
  })

  it('returns null for non-result messages or a non-string result', () => {
    expect(readResultText({ type: 'assistant', message: {} })).toBeNull()
    expect(readResultText({ type: 'result', result: 123 })).toBeNull()
    expect(readResultText(null)).toBeNull()
  })
})

describe('readPermissionDenials', () => {
  it('extracts tool_name from each denial on a result message', () => {
    const denials = readPermissionDenials({
      type: 'result',
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 't1', tool_input: {} },
        { tool_name: 'Write', tool_use_id: 't2', tool_input: {} },
      ],
    })
    expect(denials).toEqual([{ tool_name: 'Bash' }, { tool_name: 'Write' }])
  })

  it('returns an empty array when there are no denials or on a non-result message', () => {
    expect(readPermissionDenials({ type: 'result' })).toEqual([])
    expect(readPermissionDenials({ type: 'result', permission_denials: [] })).toEqual([])
    expect(readPermissionDenials({ type: 'assistant', message: {} })).toEqual([])
    expect(readPermissionDenials(null)).toEqual([])
  })
})
