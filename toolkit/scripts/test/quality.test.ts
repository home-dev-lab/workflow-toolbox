import { describe, expect, it } from 'vitest'

import { debtCards, parseLint, renderDelta } from '../quality.mjs'

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
