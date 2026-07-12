import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scaffoldWorkflow, PATTERN_NAMES } from '../src/scaffold.js'
import type { ScaffoldSpec, PatternName } from '../src/scaffold.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_FILE = path.join(__dirname, 'fixtures', 'all-patterns.workflow.ts')
const UPDATE_GOLDEN = process.env['UPDATE_GOLDEN'] === '1'

const single = (pattern: PatternName): ScaffoldSpec => ({
  meta: { name: 'demo-workflow', description: 'A demo workflow.' },
  steps: [{ pattern, phase: 'Work' }],
})

// The slice of the emitted source covering the `meta: { … }` object literal only.
function metaSpan(src: string): string {
  const start = src.indexOf('meta: {')
  const runAt = src.indexOf('run:', start)
  return src.slice(start, runAt)
}

describe('scaffoldWorkflow — determinism', () => {
  it('is a pure function: same spec → byte-identical output', () => {
    const spec = single('generateAndFilter')
    expect(scaffoldWorkflow(spec)).toBe(scaffoldWorkflow(spec))
  })

  it('emits no non-deterministic calls (Date.now / Math.random / new Date)', () => {
    const src = scaffoldWorkflow(single('loopUntilDone'))
    expect(src).not.toMatch(/Date\s*\.\s*now\s*\(/)
    expect(src).not.toMatch(/Math\s*\.\s*random\s*\(/)
    expect(src).not.toMatch(/new\s+Date\s*\(\s*\)/)
  })
})

describe('scaffoldWorkflow — per-pattern emission', () => {
  it('exports all nine canonical pattern names', () => {
    expect(PATTERN_NAMES).toEqual([
      'classifyAndAct',
      'fanOutAndSynthesize',
      'adversarialVerification',
      'generateAndFilter',
      'tournament',
      'loopUntilDone',
      'planAndExecute',
      'scoreAndRank',
      'chunkedAnalysis',
    ])
  })

  for (const pattern of [
    'classifyAndAct',
    'fanOutAndSynthesize',
    'adversarialVerification',
    'generateAndFilter',
    'tournament',
    'loopUntilDone',
    'planAndExecute',
    'chunkedAnalysis',
  ] as const) {
    it(`${pattern}: imports it from @workflow-toolbox/patterns, calls it, and binds the result`, () => {
      const src = scaffoldWorkflow(single(pattern))
      expect(src).toMatch(new RegExp(`import \\{[^}]*\\b${pattern}\\b[^}]*\\} from '@workflow-toolbox/patterns'`))
      expect(src).toContain(`await ${pattern}(rt, {`)
      expect(src).toContain('const step1 =')
      expect(src).toContain('return { step1: step1.value }')
    })
  }

  it('loopUntilDone uses rt.phase() (it has no phase option) and a non-degenerate done', () => {
    const src = scaffoldWorkflow(single('loopUntilDone'))
    expect(src).toContain('rt.phase("Work")')
    // must NOT pass a `phase:` option to loopUntilDone
    const callStart = src.indexOf('await loopUntilDone(rt, {')
    const callEnd = src.indexOf('return {', callStart)
    expect(src.slice(callStart, callEnd)).not.toMatch(/\bphase:/)
    // done must not be tied to agent success (that would exit after one round)
    expect(src.slice(callStart, callEnd)).not.toMatch(/done:\s*result/)
  })

  it('patterns that DO take a phase option pass it', () => {
    const src = scaffoldWorkflow(single('classifyAndAct'))
    expect(src).toContain('phase: "Work"')
  })
})

describe('scaffoldWorkflow — structure', () => {
  const src = scaffoldWorkflow({
    meta: { name: 'multi-step', description: 'Several patterns in sequence.' },
    steps: [
      { pattern: 'classifyAndAct', phase: 'Route' },
      { pattern: 'adversarialVerification', phase: 'Verify' },
      { pattern: 'classifyAndAct', phase: 'Route' },
    ],
  })

  it('imports defineWorkflow from the sandbox-pure subpath', () => {
    expect(src).toContain("import { defineWorkflow } from '@workflow-toolbox/build/define'")
  })

  it('emits `export default defineWorkflow(`', () => {
    expect(src).toContain('export default defineWorkflow(')
  })

  it('omits the unused `input` param from run', () => {
    expect(src).toContain('run: async (rt0) => {')
  })

  it('dedups pattern imports', () => {
    const importLine = src.split('\n').find((l) => l.includes("from '@workflow-toolbox/patterns'"))!
    expect(importLine.match(/classifyAndAct/g)).toHaveLength(1)
  })

  it('dedups phases in first-seen order', () => {
    const meta = metaSpan(src)
    expect(meta).toContain('{ title: "Route" }')
    expect(meta).toContain('{ title: "Verify" }')
    expect(meta.indexOf('"Route"')).toBeLessThan(meta.indexOf('"Verify"'))
    expect(meta.match(/"Route"/g)).toHaveLength(1)
  })

  it('binds one const per step and references each in the return', () => {
    expect(src).toContain('const step1 =')
    expect(src).toContain('const step2 =')
    expect(src).toContain('const step3 =')
    expect(src).toContain('return { step1: step1.value, step2: step2.value, step3: step3.value }')
  })

  it('emits meta name/description as double-quoted JSON strings (no backtick in the meta span)', () => {
    const meta = metaSpan(src)
    expect(meta).toContain('name: "multi-step"')
    expect(meta).toContain('description: "Several patterns in sequence."')
    expect(meta).not.toContain('`')
  })

  it('wires the default leaf-agent fence (withLeafFence) as the first run-body line', () => {
    expect(src).toContain("import { classifyAndAct, adversarialVerification, withLeafFence } from '@workflow-toolbox/patterns'")
    expect(src).toContain("const { rt } = await withLeafFence(rt0, { phase: 'Fence' })")
    // 'Fence' is the first phase, ahead of every step phase.
    const meta = metaSpan(src)
    expect(meta.indexOf('{ title: "Fence" }')).toBeLessThan(meta.indexOf('{ title: "Route" }'))
  })
})

describe('scaffoldWorkflow — actionable validation', () => {
  it('throws on empty steps', () => {
    expect(() =>
      scaffoldWorkflow({ meta: { name: 'x', description: 'y' }, steps: [] }),
    ).toThrow(/steps is empty/)
  })

  it('throws on an unknown pattern, naming the valid set', () => {
    expect(() =>
      scaffoldWorkflow({
        meta: { name: 'x', description: 'y' },
        steps: [{ pattern: 'doStuff' as PatternName, phase: 'P' }],
      }),
    ).toThrow(/unknown pattern "doStuff".*classifyAndAct/s)
  })

  it.each([
    ['UpperCase', 'Bad-Case'],
    ['spaces', 'my workflow'],
    ['empty', ''],
    ['leading dash', '-x'],
  ])('throws on a non-kebab meta.name (%s)', (_label, name) => {
    expect(() =>
      scaffoldWorkflow({ meta: { name, description: 'y' }, steps: [single('tournament').steps[0]!] }),
    ).toThrow(/invalid meta\.name.*kebab-case/s)
  })

  it('throws on an empty description', () => {
    expect(() =>
      scaffoldWorkflow({
        meta: { name: 'ok-name', description: '' },
        steps: [single('tournament').steps[0]!],
      }),
    ).toThrow(/description is empty/)
  })
})

// Golden: the all-seven-patterns emission is committed as test/fixtures/all-patterns.workflow.ts.
// That committed file is typechecked by `pnpm typecheck` (proves the emitted code compiles against
// the REAL @workflow-toolbox types) and eslint-checked by `pnpm lint` (proves it is lint-clean) — so this golden
// is the regression guard that keeps the emitter producing that proven-good output.
// Regenerate after an intentional emitter change: UPDATE_GOLDEN=1 pnpm -F @workflow-toolbox/scaffold test
const ALL_PATTERNS_SPEC: ScaffoldSpec = {
  meta: {
    name: 'all-patterns-demo',
    description: 'A scaffold exercising every pattern (typecheck + lint fixture).',
  },
  steps: [
    { pattern: 'classifyAndAct', phase: 'Route' },
    { pattern: 'fanOutAndSynthesize', phase: 'Analyze' },
    { pattern: 'adversarialVerification', phase: 'Verify' },
    { pattern: 'generateAndFilter', phase: 'Generate' },
    { pattern: 'tournament', phase: 'Compete' },
    { pattern: 'loopUntilDone', phase: 'Refine' },
    { pattern: 'planAndExecute', phase: 'Execute' },
    { pattern: 'scoreAndRank', phase: 'Triage' },
    { pattern: 'chunkedAnalysis', phase: 'Chunk' },
  ],
}

describe('golden — all-patterns fixture (typechecked + linted by the workspace gates)', () => {
  it('emitted all-patterns source matches the committed fixture exactly', () => {
    const src = scaffoldWorkflow(ALL_PATTERNS_SPEC)
    if (UPDATE_GOLDEN) {
      fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true })
      fs.writeFileSync(GOLDEN_FILE, src, 'utf8')
      return
    }
    expect(
      fs.existsSync(GOLDEN_FILE),
      `Golden not found: ${GOLDEN_FILE}\nRun: UPDATE_GOLDEN=1 pnpm -F @workflow-toolbox/scaffold test`,
    ).toBe(true)
    expect(src).toBe(fs.readFileSync(GOLDEN_FILE, 'utf8'))
  })
})
