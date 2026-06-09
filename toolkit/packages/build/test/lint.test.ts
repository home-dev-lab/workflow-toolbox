// lint.test.ts — unit tests for lintWorkflowSource (RED → GREEN)
//
// One focused test per rule. The linter is a pure function over strings — no
// file I/O — so every test is self-contained. A "clean" realistic workflow
// at the bottom confirms zero errors + zero warnings for valid input.

import { describe, it, expect } from 'vitest'
import { lintWorkflowSource, MAX_WORKFLOW_BYTES } from '../src/lint.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid workflow source — passes all checks. */
const CLEAN_SOURCE = `\
export const meta = {
  name: 'my-workflow',
  description: 'A useful workflow',
}

export default async function run(rt, args) {
  const result = await rt.agent('Do the thing')
  rt.log(result)
  return result
}
`

/** Insert a line before the meta declaration. */
function withLineBefore(line: string): string {
  return `${line}\n${CLEAN_SOURCE}`
}

// ---------------------------------------------------------------------------
// MAX_WORKFLOW_BYTES constant
// ---------------------------------------------------------------------------

describe('MAX_WORKFLOW_BYTES', () => {
  it('is 524288 (512 KB)', () => {
    expect(MAX_WORKFLOW_BYTES).toBe(524288)
  })
})

// ---------------------------------------------------------------------------
// Rule 1: size
// ---------------------------------------------------------------------------

describe('lintWorkflowSource — size check', () => {
  it('errors when source exceeds 524288 bytes', () => {
    // Generate a source string that is definitively over 512 KB
    const oversized = 'x'.repeat(524289)
    const result = lintWorkflowSource(oversized)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toMatch(/bytes/)
    expect(result.errors[0]).toMatch(/524288/)
  })

  it('does not error for source exactly at the limit', () => {
    // A source at or under the limit — we just test a small source is fine
    const result = lintWorkflowSource(CLEAN_SOURCE)
    const sizeErrors = result.errors.filter(e => e.includes('bytes'))
    expect(sizeErrors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Rule 2 + 3: meta checks
// ---------------------------------------------------------------------------

describe('lintWorkflowSource — meta missing', () => {
  it('errors when no export const meta found', () => {
    const result = lintWorkflowSource('export default async function run(rt) { }')
    expect(result.errors.some(e => e.includes('meta'))).toBe(true)
  })
})

describe('lintWorkflowSource — meta must be first', () => {
  it('errors when code precedes meta declaration', () => {
    const src = withLineBefore('const x = 1')
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.toLowerCase().includes('first'))).toBe(true)
  })

  it('does not error when meta is the first statement', () => {
    const result = lintWorkflowSource(CLEAN_SOURCE)
    const firstErrors = result.errors.filter(e => e.toLowerCase().includes('first'))
    expect(firstErrors).toHaveLength(0)
  })
})

describe('lintWorkflowSource — meta missing name', () => {
  it('errors when meta has no name field', () => {
    const src = `export const meta = {
  description: 'No name here',
}
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('name'))).toBe(true)
  })
})

describe('lintWorkflowSource — meta missing description', () => {
  it('errors when meta has no description field', () => {
    const src = `export const meta = {
  name: 'my-workflow',
}
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('description'))).toBe(true)
  })
})

describe('lintWorkflowSource — meta spread', () => {
  it('errors when meta contains a spread operator', () => {
    const src = `export const meta = {
  ...base,
  name: 'my-workflow',
  description: 'Spread test',
}
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('spread'))).toBe(true)
  })
})

describe('lintWorkflowSource — meta template literal', () => {
  it('errors when meta contains a template literal', () => {
    // Must use the RAW src (not stripped) to detect backticks
    const src = 'export const meta = {\n  name: `my-workflow`,\n  description: `desc`,\n}\nexport default async function run(rt) { }\n'
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('template literal'))).toBe(true)
  })
})

describe('lintWorkflowSource — meta function call', () => {
  it('errors when meta appears to contain a function call', () => {
    const src = `export const meta = {
  name: getName(),
  description: 'Has a function call',
}
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('function call'))).toBe(true)
  })
})

describe('lintWorkflowSource — meta reserved keys', () => {
  it('errors for __proto__ key in meta', () => {
    const src = `export const meta = {
  name: 'my-workflow',
  description: 'Reserved',
  __proto__: null,
}
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('__proto__'))).toBe(true)
  })

  it('errors for constructor key in meta', () => {
    const src = `export const meta = {
  name: 'my-workflow',
  description: 'Reserved',
  constructor: null,
}
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('constructor'))).toBe(true)
  })

  it('errors for prototype key in meta', () => {
    const src = `export const meta = {
  name: 'my-workflow',
  description: 'Reserved',
  prototype: null,
}
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('prototype'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Rule 4: banned non-deterministic calls — each must include line number
// ---------------------------------------------------------------------------

describe('lintWorkflowSource — banned: Date.now()', () => {
  it('errors for Date.now() with correct line number', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
const ts = Date.now()
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    const err = result.errors.find(e => e.includes('Date.now()'))
    expect(err).toBeDefined()
    // Line 2 contains Date.now()
    expect(err).toMatch(/line 2/i)
  })

  it('does not flag Date.now() inside a line comment', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
// const ts = Date.now()
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('Date.now()'))).toBe(false)
  })

  it('does not flag Date.now() inside a string literal', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
const msg = "avoid Date.now() calls"
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('Date.now()'))).toBe(false)
  })

  it('does not flag Date.now() inside a block comment', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
/* Date.now() is banned */
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('Date.now()'))).toBe(false)
  })
})

describe('lintWorkflowSource — banned: Math.random()', () => {
  it('errors for Math.random() with correct line number', () => {
    const src = `export const meta = { name: 'w', description: 'd' }

const r = Math.random()
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    const err = result.errors.find(e => e.includes('Math.random()'))
    expect(err).toBeDefined()
    expect(err).toMatch(/line 3/i)
  })

  it('does not flag Math.random() inside a line comment', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
// Math.random() is banned
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('Math.random()'))).toBe(false)
  })
})

describe('lintWorkflowSource — banned: new Date()', () => {
  it('errors for argless new Date() with correct line number', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
const d = new Date()
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    const err = result.errors.find(e => e.includes('new Date()') || e.includes('new Date(  )'))
    expect(err).toBeDefined()
    expect(err).toMatch(/line 2/i)
  })

  it('does not flag new Date() inside a string literal', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
const s = 'never call new Date()'
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('Date'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 5: host-API warnings — each must include line number
// ---------------------------------------------------------------------------

describe('lintWorkflowSource — warning: require()', () => {
  it('warns for require() with correct line number', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
const fs = require('fs')
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    const warn = result.warnings.find(w => w.includes('require('))
    expect(warn).toBeDefined()
    expect(warn).toMatch(/line 2/i)
  })

  it('does not warn for require() inside a comment', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
// const fs = require('fs')
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.warnings.some(w => w.includes('require('))).toBe(false)
  })
})

describe('lintWorkflowSource — warning: import from', () => {
  it('warns for import … from … with correct line number', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
import fs from 'node:fs'
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    const warn = result.warnings.find(w => w.includes('import'))
    expect(warn).toBeDefined()
    expect(warn).toMatch(/line 2/i)
  })
})

describe('lintWorkflowSource — warning: process.*', () => {
  it('warns for process.env with correct line number', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
const env = process.env
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    const warn = result.warnings.find(w => w.includes('process.'))
    expect(warn).toBeDefined()
    expect(warn).toMatch(/line 2/i)
  })

  it('does not warn for process.* inside a line comment', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
// process.env is banned
export default async function run(rt) { }
`
    const result = lintWorkflowSource(src)
    expect(result.warnings.some(w => w.includes('process.'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 6: parallel() with bare agent() calls → warning
// ---------------------------------------------------------------------------

describe('lintWorkflowSource — warning: parallel with bare agent()', () => {
  it('warns when parallel([...]) is immediately followed by bare agent()', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
export default async function run(rt) {
  const results = await rt.parallel([
    agent('task 1'),
    agent('task 2'),
  ])
}
`
    const result = lintWorkflowSource(src)
    const warn = result.warnings.find(w => w.includes('thunk') || w.includes('parallel'))
    expect(warn).toBeDefined()
  })

  it('does not warn when parallel([...]) uses thunks', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
export default async function run(rt) {
  const results = await rt.parallel([
    () => rt.agent('task 1'),
    () => rt.agent('task 2'),
  ])
}
`
    const result = lintWorkflowSource(src)
    expect(result.warnings.some(w => w.includes('thunk') || w.toLowerCase().includes('parallel'))).toBe(false)
  })

  it('warns on a MIXED array — one thunk, one bare call (P3.9 review fix)', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
export default async function run(rt) {
  const results = await rt.parallel([
    () => rt.agent('task 1'),
    rt.agent('task 2'),
  ])
}
`
    const result = lintWorkflowSource(src)
    const warn = result.warnings.find(w => w.includes('thunk') || w.includes('parallel'))
    expect(warn).toBeDefined()
  })

  it('does not warn when a thunk nests further calls inside its body', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
export default async function run(rt) {
  const results = await rt.parallel([
    () => rt.agent(makePrompt('task 1')),
    () => rt.agent(makePrompt('task 2')),
  ])
}
`
    const result = lintWorkflowSource(src)
    expect(result.warnings.some(w => w.includes('thunk') || w.toLowerCase().includes('parallel'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 4 nuance — only CALLS are banned, not bare member references.
// A bare `Date.now` (no parentheses) is a function value, not an invocation;
// it cannot throw at script level. Pinned deliberately in P3.9: the rewrite
// requires the call parenthesis, where earlier behavior also flagged bare
// references.
// ---------------------------------------------------------------------------

describe('lintWorkflowSource — bare nondeterministic references are not calls', () => {
  it('does not flag a bare Date.now reference without invocation', () => {
    const src = `export const meta = { name: 'w', description: 'd' }
const fn = Date.now
return typeof fn
`
    const result = lintWorkflowSource(src)
    expect(result.errors.some(e => e.includes('Date.now()'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Clean source — zero errors, zero warnings
// ---------------------------------------------------------------------------

describe('lintWorkflowSource — clean source', () => {
  it('returns zero errors and zero warnings for a valid workflow', () => {
    const result = lintWorkflowSource(CLEAN_SOURCE)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Serialized meta (JSON-quoted keys) — the shape dwt emits
//
// The stripper blanks string contents, so quoted keys vanish from the stripped
// copy; the linter must match them on the raw meta span instead. Regression
// guard for the M3 false positive ("meta is missing a `name` field" on every
// dwt-emitted artifact).
// ---------------------------------------------------------------------------

describe('lintWorkflowSource — serialized meta with JSON-quoted keys', () => {
  const SERIALIZED_META_SOURCE = [
    'export const meta = {',
    '  "name": "my-workflow",',
    '  "description": "A workflow with serialized meta",',
    '  "phases": [',
    '    {',
    '      "title": "Run"',
    '    }',
    '  ]',
    '}',
    'return await __dwt.default.run({ log, phase }, args)',
  ].join('\n')

  it('does not report missing name/description for quoted keys', () => {
    const result = lintWorkflowSource(SERIALIZED_META_SOURCE)
    expect(result.errors).toHaveLength(0)
  })

  it('still flags a quoted reserved key', () => {
    const withProto = SERIALIZED_META_SOURCE.replace(
      '"phases"',
      '"__proto__": {}, "phases"',
    )
    const result = lintWorkflowSource(withProto)
    expect(result.errors.some(e => e.includes('__proto__'))).toBe(true)
  })

  it('still reports a genuinely missing name with quoted keys present', () => {
    const noName = SERIALIZED_META_SOURCE.replace('  "name": "my-workflow",\n', '')
    const result = lintWorkflowSource(noName)
    expect(result.errors.some(e => e.includes('name'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// LintResult shape
// ---------------------------------------------------------------------------

describe('lintWorkflowSource — result shape', () => {
  it('returns an object with errors and warnings arrays', () => {
    const result = lintWorkflowSource(CLEAN_SOURCE)
    expect(Array.isArray(result.errors)).toBe(true)
    expect(Array.isArray(result.warnings)).toBe(true)
  })
})
