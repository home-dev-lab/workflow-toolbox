import { describe, it, expect } from 'vitest'
import { scaffoldAgent, assertAgentSpecShape } from '../src/scaffold.js'
import type { AgentScaffoldSpec } from '../src/scaffold.js'

const base: AgentScaffoldSpec = {
  name: 'locked-reviewer',
  description: 'A read-only code reviewer.',
  prompt: 'You review code and report findings.',
}

describe('scaffoldAgent — emission', () => {
  it('is a pure function: same spec → byte-identical output', () => {
    expect(scaffoldAgent(base)).toBe(scaffoldAgent(base))
  })

  it('emits valid frontmatter delimiters + name/description/prompt for a minimal spec', () => {
    const md = scaffoldAgent(base)
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('\nname: locked-reviewer\n')
    expect(md).toContain('\ndescription: A read-only code reviewer.\n')
    expect(md).toContain('You review code and report findings.')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('warns when no tools allowlist is given (inherits ALL tools)', () => {
    const md = scaffoldAgent(base)
    expect(md).toMatch(/⚠ No `tools:` allowlist/)
    expect(md).not.toContain('\ntools:')
  })

  it('emits tools/disallowedTools/skills comma-separated and model/effort scalars', () => {
    const md = scaffoldAgent({
      ...base,
      tools: ['Read', 'Glob'],
      disallowedTools: ['Bash'],
      skills: ['playwright-cli'],
      model: 'sonnet',
      effort: 'medium',
    })
    expect(md).toContain('\ntools: Read, Glob\n')
    expect(md).toContain('\ndisallowedTools: Bash\n')
    expect(md).toContain('\nskills: playwright-cli\n')
    expect(md).toContain('\nmodel: sonnet\n')
    expect(md).toContain('\neffort: medium\n')
    // With a tools allowlist present, the inherit-all warning must NOT appear.
    expect(md).not.toMatch(/⚠ No `tools:` allowlist/)
  })

  it('renders nonGoals as "Do NOT …" lines and de-dupes a trailing period', () => {
    const md = scaffoldAgent({ ...base, nonGoals: ['commit or push', 'write to the memory directory.'] })
    expect(md).toContain('- Do NOT commit or push.')
    expect(md).toContain('- Do NOT write to the memory directory.')
    expect(md).not.toContain('directory..')
  })

  it('double-quotes a description that would break unquoted YAML (colon-space)', () => {
    const md = scaffoldAgent({ ...base, description: 'Reviewer: strict mode' })
    expect(md).toContain('description: "Reviewer: strict mode"')
  })
})

describe('scaffoldAgent — validation', () => {
  it('rejects a non-kebab name, empty description, empty prompt', () => {
    expect(() => scaffoldAgent({ ...base, name: 'Not Kebab' })).toThrow(/kebab-case/)
    expect(() => scaffoldAgent({ ...base, description: '  ' })).toThrow(/description is empty/)
    expect(() => scaffoldAgent({ ...base, prompt: '' })).toThrow(/prompt is empty/)
  })
})

describe('assertAgentSpecShape', () => {
  it('accepts a well-formed spec', () => {
    expect(() => assertAgentSpecShape({ ...base, tools: ['Read'] })).not.toThrow()
  })

  it('rejects missing required strings and malformed arrays', () => {
    expect(() => assertAgentSpecShape(null)).toThrow(/JSON object/)
    expect(() => assertAgentSpecShape({ name: 'x', description: 'y' })).toThrow(/prompt must be a string/)
    expect(() => assertAgentSpecShape({ ...base, tools: 'Read' })).toThrow(/tools, if present, must be an array/)
    expect(() => assertAgentSpecShape({ ...base, tools: ['Read', 3] })).toThrow(/array of strings/)
    expect(() => assertAgentSpecShape({ ...base, model: 5 })).toThrow(/model, if present, must be a string/)
  })
})
