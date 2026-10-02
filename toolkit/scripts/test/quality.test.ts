import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { coverageFreshness } from '../coverage-stamp.mjs'
import { debtCards, parseJsonOutput, parseLint, readCoverage, renderDelta } from '../quality.mjs'

const HEAD = { commit: 'c'.repeat(40), tree: 'a'.repeat(40), dirty: false }
const OLDER = { commit: 'd'.repeat(40), tree: 'b'.repeat(40) }
const stampAt = (identity: { commit: string, tree: string }, extra = {}) => ({ ...identity, dirty: false, filtered: false, generatedAt: '2026-09-30T20:43:00.000Z', ...extra })
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function coverageFixture(stamp: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'wt-quality-coverage-'))
  roots.push(root)
  const pct = { pct: 80 }
  const coverage = join(root, 'coverage-summary.json')
  writeFileSync(coverage, JSON.stringify({ total: { lines: pct, branches: pct, functions: pct, statements: pct } }))
  const stampPath = join(root, 'coverage-stamp.json')
  if (stamp !== undefined) writeFileSync(stampPath, typeof stamp === 'string' ? stamp : JSON.stringify(stamp))
  return { coverage, stamp: stampPath }
}

describe('coverage artifact freshness', () => {
  it('refuses an artifact measured at another tree and names the refresh command', () => {
    const verdict = coverageFreshness(stampAt(OLDER), HEAD)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain(OLDER.commit.slice(0, 12))
    expect(verdict.reason).toContain('pnpm quality:coverage')
  })

  it('accepts a different commit that carries the same tree (a merge or a message-only amend)', () => {
    expect(coverageFreshness(stampAt({ commit: OLDER.commit, tree: HEAD.tree }), HEAD)).toEqual({ ok: true })
  })

  it('refuses an artifact with no provenance stamp, as written before stamps existed', () => {
    for (const stamp of [null, undefined, 'text']) {
      const verdict = coverageFreshness(stamp, HEAD)
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toContain('pnpm quality:coverage')
    }
  })

  it('refuses a stamp that recorded no tree, and a HEAD that git cannot read', () => {
    expect(coverageFreshness(stampAt({ commit: HEAD.commit, tree: null as never }), HEAD).ok).toBe(false)
    expect(coverageFreshness(stampAt(HEAD), { commit: null, tree: null, dirty: null }).ok).toBe(false)
  })

  it('refuses a partial run, and a run that did not record whether it ran the whole suite', () => {
    expect(coverageFreshness(stampAt(HEAD, { filtered: true }), HEAD).reason).toMatch(/whole suite.*pnpm quality:coverage/s)
    expect(coverageFreshness(stampAt(HEAD, { filtered: undefined }), HEAD).ok).toBe(false)
  })

  it('accepts an artifact measured at HEAD from a committed tree only', () => {
    expect(coverageFreshness(stampAt(HEAD), HEAD)).toEqual({ ok: true })
    expect(coverageFreshness(stampAt(HEAD, { dirty: true }), HEAD).reason).toMatch(/uncommitted.*pnpm quality:coverage/s)
    expect(coverageFreshness(stampAt(HEAD, { dirty: null }), HEAD).ok).toBe(false)
  })

  it('makes delta and baseline fail instead of printing numbers from an older run', () => {
    expect(() => readCoverage({ ...coverageFixture(stampAt(OLDER)), current: HEAD })).toThrow(/stale.*pnpm quality:coverage/is)
    expect(() => readCoverage({ ...coverageFixture(undefined), current: HEAD })).toThrow(/stale.*pnpm quality:coverage/is)
    expect(() => readCoverage({ ...coverageFixture('{not json'), current: HEAD })).toThrow(/stale.*pnpm quality:coverage/is)
  })

  it('reads the totals when the artifact was measured at HEAD', () => {
    expect(readCoverage({ ...coverageFixture(stampAt(HEAD)), current: HEAD }).coverageLines.value).toBe(80)
  })
})

const metric = (value: number, file = 'plugin/bin/a.mjs') => ({
  value, file, function: '', detail: '', offenders: [{ value, file, exact: `${file}: exact tool line` }],
})

describe('quality tooling', () => {
  it('parses ESLint metric messages rather than source text', () => {
    const parsed = parseLint([{
      filePath: '/repo/plugin/bin/a.mjs',
      messages: [
        { ruleId: 'complexity', message: "Function 'run' has a complexity of 12. Maximum allowed is 0.", line: 4 },
        { ruleId: 'max-lines-per-function', message: "Function 'run' has too many lines (19). Maximum allowed is 0.", line: 4 },
      ],
    }] as never)
    expect(parsed.cyclomaticComplexity.value).toBe(12)
    expect(parsed.functionLines.value).toBe(19)
    expect(parsed.cyclomaticComplexity.offenders[0].function).toBe('run')
  })

  it('shows an improved touched file even when the total is flat', () => {
    const keys = ['cyclomaticComplexity', 'cognitiveComplexity', 'fileLines', 'functionLines', 'depth', 'params', 'eslintWarnings', 'duplication', 'knipIssues', 'dependencyCycles', 'coverageLines', 'coverageBranches', 'coverageFunctions', 'coverageStatements']
    const before = { metrics: Object.fromEntries(keys.map((key) => [key, metric(10)])) }
    const after = Object.fromEntries(keys.map((key) => [key, metric(10)]))
    after.cyclomaticComplexity = metric(10)
    after.cyclomaticComplexity.offenders = [{ value: 8, file: 'plugin/bin/a.mjs', exact: 'improved' }]
    expect(renderDelta(before as never, after as never, ['plugin/bin/a.mjs'])).toContain('10 -> 8 | plugin/bin/a.mjs')
  })

  it('emits stable, prioritised debt-card identities', () => {
    const keys = ['cyclomaticComplexity', 'cognitiveComplexity', 'fileLines', 'functionLines', 'depth', 'params', 'eslintWarnings', 'duplication', 'knipIssues', 'dependencyCycles', 'coverageLines', 'coverageBranches', 'coverageFunctions', 'coverageStatements']
    const cards = debtCards({ metrics: Object.fromEntries(keys.map((key) => [key, metric(10)])) } as never, 1)
    expect(cards[0]).toMatchObject({ id: 'plugin/bin/a.mjs:cyclomaticComplexity', priority: 'P1', labels: ['tooling', 'chore'] })
  })
})

describe('parseJsonOutput', () => {
  it('parses a tool report that pnpm prefixed with its workspace banner', () => {
    expect(parseJsonOutput('Scope: all 11 workspace projects\n{"modules":[]}\n')).toEqual({ modules: [] })
    expect(parseJsonOutput('[1, 2]')).toEqual([1, 2])
    expect(parseJsonOutput('[WARN] There are cyclic workspace dependencies: a, b\n{"summary":{"violations":0}}\n')).toEqual({ summary: { violations: 0 } })
  })

  it('names the output when no JSON is present instead of throwing a bare parse error', () => {
    expect(() => parseJsonOutput('Scope: all 11 workspace projects\n')).toThrow(/no JSON document in tool output/)
  })
})
