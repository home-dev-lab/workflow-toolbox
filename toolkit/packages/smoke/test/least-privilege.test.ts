// least-privilege.test.ts — unit tests for the leastPrivilegeOptions() builder
// (src/least-privilege.ts). Pure: asserts the composed capability fragment. The
// RUNTIME enforcement of these levers is proven separately by `pnpm canary:agents`
// (the `least-privilege-recipe` case builds its options through this same builder).

import { describe, expect, it } from 'vitest'
import { leastPrivilegeOptions, type LeastPrivilegeSpec } from '../src/least-privilege.js'

describe('leastPrivilegeOptions', () => {
  it('locks everything down by default', () => {
    expect(leastPrivilegeOptions()).toEqual({
      tools: [],
      skills: [],
      settingSources: [],
      strictMcpConfig: true,
    })
  })

  it('opts capabilities in explicitly, one lever at a time', () => {
    expect(leastPrivilegeOptions({ tools: ['Read', 'Glob'] })).toEqual({
      tools: ['Read', 'Glob'],
      skills: [],
      settingSources: [],
      strictMcpConfig: true,
    })
    expect(leastPrivilegeOptions({ skills: ['playwright-cli'] }).skills).toEqual(['playwright-cli'])
  })

  it('always forces strictMcpConfig on, even when MCP servers are passed', () => {
    const mcp = { probe: { type: 'stdio', command: 'x' } } as unknown as LeastPrivilegeSpec['mcpServers']
    const opts = leastPrivilegeOptions({ mcpServers: mcp })
    expect(opts.strictMcpConfig).toBe(true)
    expect(opts.mcpServers).toBe(mcp)
  })

  it('sheds ambient context by default but honors an explicit opt-in', () => {
    expect(leastPrivilegeOptions().settingSources).toEqual([])
    expect(leastPrivilegeOptions({ ambient: ['project'] }).settingSources).toEqual(['project'])
  })

  it('omits model/mcpServers keys entirely when not requested (exactOptionalPropertyTypes-safe)', () => {
    const opts = leastPrivilegeOptions({ tools: ['Read'] })
    expect('model' in opts).toBe(false)
    expect('mcpServers' in opts).toBe(false)
    expect(leastPrivilegeOptions({ model: 'haiku' }).model).toBe('haiku')
  })
})
