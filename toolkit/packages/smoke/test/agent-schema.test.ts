import { describe, it, expect } from 'vitest'
import {
  AGENT_DEFINITION_BASELINE,
  OPTIONS_LEAST_PRIV_BASELINE,
  SCAFFOLD_HANDLED_AGENT_FIELDS,
  extractTypeFields,
  unhandledByScaffold,
  diffSchema,
  formatSchemaDrift,
  type LiveSchema,
} from '../src/agent-schema.js'

describe('extractTypeFields', () => {
  it('extracts sorted top-level fields of a `type X = {…}` alias, ignoring comments', () => {
    const dts = `
export declare type AgentDefinition = {
  /** doc */
  description: string;
  tools?: string[];
  prompt: string;
};
`
    expect(extractTypeFields(dts, 'AgentDefinition')).toEqual(['description', 'prompt', 'tools'])
  })

  it('extracts fields of an `interface X {…}` too', () => {
    const dts = `export interface Options { model?: string; tools?: string[]; }`
    expect(extractTypeFields(dts, 'Options')).toEqual(['model', 'tools'])
  })

  it('captures only DEPTH-1 members — an inline object field contributes its own name only', () => {
    const dts = `
type T = {
  outer: string;
  nested?: { inner: string; deeper: number };
};
`
    // 'inner'/'deeper' are depth-2 and must NOT leak into the top-level set.
    expect(extractTypeFields(dts, 'T')).toEqual(['nested', 'outer'])
  })

  it('excludes method signatures — only data properties count as fields', () => {
    // A method signature is NOT a schema field; including it would produce false drift
    // the day the SDK adds one.
    expect(extractTypeFields(`interface X { run(): void; prompt: string; }`, 'X')).toEqual(['prompt'])
  })

  it('matches the TOP-LEVEL declaration, never a same-named type nested in a namespace', () => {
    const dts = `
declare namespace N { export interface Options { nested: string } }
export declare type Options = { real: string };
`
    expect(extractTypeFields(dts, 'Options')).toEqual(['real'])
  })

  it('returns null when the only declaration of the name is nested (safe degradation)', () => {
    const dts = `declare namespace N { export interface Options { nested: string } }`
    expect(extractTypeFields(dts, 'Options')).toBeNull()
  })

  it('returns null for an unknown type name', () => {
    expect(extractTypeFields(`type A = { x: string }`, 'Missing')).toBeNull()
  })

  it('returns null when the named type is not an object shape (e.g. a union alias)', () => {
    expect(extractTypeFields(`type U = 'a' | 'b';`, 'U')).toBeNull()
  })

  it('is deterministic and pure: same input → same output', () => {
    const dts = `type Z = { b: string; a: number };`
    expect(extractTypeFields(dts, 'Z')).toEqual(extractTypeFields(dts, 'Z'))
    expect(extractTypeFields(dts, 'Z')).toEqual(['a', 'b'])
  })
})

describe('baseline sanity', () => {
  it('AGENT_DEFINITION_BASELINE is sorted and de-duplicated', () => {
    expect([...AGENT_DEFINITION_BASELINE]).toEqual([...new Set(AGENT_DEFINITION_BASELINE)].sort())
  })

  it('every scaffold-handled field is a real AgentDefinition baseline field', () => {
    for (const f of SCAFFOLD_HANDLED_AGENT_FIELDS) expect(AGENT_DEFINITION_BASELINE).toContain(f)
  })
})

describe('unhandledByScaffold', () => {
  it('keeps only fields the scaffold emitter does not write', () => {
    expect(unhandledByScaffold(['tools', 'initialPrompt', 'maxTurns', 'model'])).toEqual(['initialPrompt', 'maxTurns'])
  })
})

describe('diffSchema', () => {
  const inSync: LiveSchema = {
    agentDefinitionFields: [...AGENT_DEFINITION_BASELINE],
    optionFields: [...OPTIONS_LEAST_PRIV_BASELINE, 'extraUnrelatedOption'],
  }

  it('reports match when live == baseline (extra Options fields are ignored)', () => {
    const d = diffSchema(inSync)
    expect(d.status).toBe('match')
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.leastPrivMissing).toEqual([])
  })

  it('flags a NEW field and marks it unhandled by scaffold', () => {
    const d = diffSchema({ agentDefinitionFields: [...AGENT_DEFINITION_BASELINE, 'brandNewField'].sort(), optionFields: [...OPTIONS_LEAST_PRIV_BASELINE] })
    expect(d.status).toBe('drift')
    expect(d.added).toEqual(['brandNewField'])
    expect(d.addedUnhandled).toEqual(['brandNewField'])
    expect(d.possibleRename).toBeUndefined()
  })

  it('does NOT mark an added field unhandled when the scaffold already emits it', () => {
    // start from a baseline missing 'skills', then have it appear live → added but handled.
    const base = AGENT_DEFINITION_BASELINE.filter((f) => f !== 'skills')
    const d = diffSchema({ agentDefinitionFields: [...AGENT_DEFINITION_BASELINE], optionFields: [...OPTIONS_LEAST_PRIV_BASELINE] }, base)
    expect(d.added).toEqual(['skills'])
    expect(d.addedUnhandled).toEqual([])
  })

  it('flags a REMOVED field', () => {
    const live = AGENT_DEFINITION_BASELINE.filter((f) => f !== 'observer')
    const d = diffSchema({ agentDefinitionFields: [...live], optionFields: [...OPTIONS_LEAST_PRIV_BASELINE] })
    expect(d.status).toBe('drift')
    expect(d.removed).toEqual(['observer'])
  })

  it('hints a possible rename on exactly one add + one remove', () => {
    const live = [...AGENT_DEFINITION_BASELINE.filter((f) => f !== 'memory'), 'memoryScope'].sort()
    const d = diffSchema({ agentDefinitionFields: live, optionFields: [...OPTIONS_LEAST_PRIV_BASELINE] })
    expect(d.possibleRename).toEqual({ from: 'memory', to: 'memoryScope' })
  })

  it('flags a missing least-privilege Options field', () => {
    const opts = OPTIONS_LEAST_PRIV_BASELINE.filter((f) => f !== 'strictMcpConfig')
    const d = diffSchema({ agentDefinitionFields: [...AGENT_DEFINITION_BASELINE], optionFields: [...opts] })
    expect(d.status).toBe('drift')
    expect(d.leastPrivMissing).toEqual(['strictMcpConfig'])
  })

  it('is unavailable when AgentDefinition could not be read', () => {
    const d = diffSchema({ agentDefinitionFields: null, optionFields: null })
    expect(d.status).toBe('unavailable')
    expect(d.added).toEqual([])
  })

  it('skips the least-priv check (no false removals) when Options could not be read, and flags it unchecked', () => {
    const d = diffSchema({ agentDefinitionFields: [...AGENT_DEFINITION_BASELINE], optionFields: null })
    expect(d.status).toBe('match')
    expect(d.leastPrivMissing).toEqual([])
    expect(d.optionsAvailable).toBe(false)
  })

  it('marks optionsAvailable true when Options was read', () => {
    const d = diffSchema({ agentDefinitionFields: [...AGENT_DEFINITION_BASELINE], optionFields: [...OPTIONS_LEAST_PRIV_BASELINE] })
    expect(d.optionsAvailable).toBe(true)
  })
})

describe('formatSchemaDrift', () => {
  it('renders the match case as a single reassuring line under the header', () => {
    const lines = formatSchemaDrift(diffSchema({ agentDefinitionFields: [...AGENT_DEFINITION_BASELINE], optionFields: [...OPTIONS_LEAST_PRIV_BASELINE] }), '0.3.205')
    expect(lines[0]).toContain('AGENT SCHEMA DRIFT (SDK 0.3.205')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/matches the committed baseline/)
  })

  it('renders the unavailable case without throwing', () => {
    const lines = formatSchemaDrift(diffSchema({ agentDefinitionFields: null, optionFields: null }), null)
    expect(lines[0]).toContain('SDK ?')
    expect(lines[1]).toMatch(/source unavailable/)
  })

  it('does NOT claim "intact" on a match when Options was never read (honest wording)', () => {
    const lines = formatSchemaDrift(diffSchema({ agentDefinitionFields: [...AGENT_DEFINITION_BASELINE], optionFields: null }), '0.3.205')
    const body = lines.join('\n')
    expect(body).not.toMatch(/Options intact/)
    expect(body).toMatch(/Options NOT checked/)
  })

  it('notes Options-unchecked alongside AgentDefinition drift', () => {
    const live = [...AGENT_DEFINITION_BASELINE, 'newKnob'].sort()
    const lines = formatSchemaDrift(diffSchema({ agentDefinitionFields: live, optionFields: null }), '0.4.0')
    const body = lines.join('\n')
    expect(body).toMatch(/ADDED field: newKnob/)
    expect(body).toMatch(/least-priv Options NOT checked/)
  })

  it('annotates an unhandled ADDED field with the card Y-D sync cue', () => {
    const live = [...AGENT_DEFINITION_BASELINE, 'shinyNewKnob'].sort()
    const lines = formatSchemaDrift(diffSchema({ agentDefinitionFields: live, optionFields: [...OPTIONS_LEAST_PRIV_BASELINE] }), '0.4.0')
    const body = lines.join('\n')
    expect(body).toMatch(/ADDED field: shinyNewKnob.*NOT emitted by scaffold/)
    expect(body).toMatch(/update AGENT_DEFINITION_BASELINE in agent-schema\.ts/)
  })

  it('marks an ADDED field already handled by scaffold as such (no false alarm)', () => {
    const base = AGENT_DEFINITION_BASELINE.filter((f) => f !== 'tools')
    const lines = formatSchemaDrift(diffSchema({ agentDefinitionFields: [...AGENT_DEFINITION_BASELINE], optionFields: [...OPTIONS_LEAST_PRIV_BASELINE] }, base), '0.4.0')
    expect(lines.join('\n')).toMatch(/ADDED field: tools.*already handled by scaffold/)
  })

  it('renders a possible-rename hint and a missing least-priv option line', () => {
    const live = [...AGENT_DEFINITION_BASELINE.filter((f) => f !== 'memory'), 'memoryScope'].sort()
    const opts = OPTIONS_LEAST_PRIV_BASELINE.filter((f) => f !== 'settingSources')
    const lines = formatSchemaDrift(diffSchema({ agentDefinitionFields: live, optionFields: [...opts] }), '0.4.0')
    const body = lines.join('\n')
    expect(body).toMatch(/possible RENAME: memory → memoryScope/)
    expect(body).toMatch(/least-priv Options field MISSING: settingSources/)
  })
})
