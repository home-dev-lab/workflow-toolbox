import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf, { isTestFile } from '../../../examples/pr-review.workflow.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PROBE = new URL('../../../scripts/lens-enumeration-probe.mjs', import.meta.url)

function runtimeFor(changedFiles: string[]): FakeRuntime {
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string }) => {
      const lower = prompt.toLowerCase()
      if (lower.includes('availability probe')) return 'PROBE_OK'
      if (lower.includes('adversarially verify')) return { verdict: 'confirmed', reason: 'Confirmed' }
      if (lower.includes('synthesizing a code review')) return { verdict: 'approve', summary: 'Approved' }
      if (lower.includes('you are a specialized code reviewer')) return { findings: [] }
      if (lower.includes('you are reviewing a')) {
        return { summary: 'A test-focused change with enough detail', riskAreas: ['tests'], changedFiles, addedPublicSurface: [] }
      }
      if (lower.includes('classify it into exactly one category')) return { category: 'bugfix' }
      return null
    },
  })
}

const reviewerLenses = (rt: FakeRuntime) =>
  rt.calls
    .map((call) => call.opts?.label)
    .filter((label): label is string => typeof label === 'string' && label.startsWith('pr-review:reviewer:'))
    .map((label) => label.slice('pr-review:reviewer:'.length))

describe('pr-review lock-enumeration lens', () => {
  it('recognizes test-file path conventions', async () => {
    expect(isTestFile('packages/build/test/x.test.ts')).toBe(true)
    expect(isTestFile('src/x.ts')).toBe(false)
    expect(isTestFile('e2e/flow.spec.ts')).toBe(true)

    const testFile = runtimeFor(['packages/build/test/x.test.ts'])
    await wf.run(testFile, JSON.stringify({ target: 'HEAD~1..HEAD' }))
    expect(reviewerLenses(testFile)).toContain('lock-enumeration')

    const sourceFile = runtimeFor(['src/x.ts'])
    await wf.run(sourceFile, JSON.stringify({ target: 'HEAD~1..HEAD' }))
    expect(reviewerLenses(sourceFile)).not.toContain('lock-enumeration')

    const e2eFile = runtimeFor(['e2e/flow.spec.ts'])
    await wf.run(e2eFile, JSON.stringify({ target: 'HEAD~1..HEAD' }))
    expect(reviewerLenses(e2eFile)).toContain('lock-enumeration')
  })

  it('arms only when routing reports a test file', async () => {
    const armed = runtimeFor(['src/shared.test.ts'])
    await wf.run(armed, JSON.stringify({ target: 'HEAD~1..HEAD' }))
    expect(reviewerLenses(armed)).toContain('lock-enumeration')

    const silent = runtimeFor(['src/shared.ts'])
    await wf.run(silent, JSON.stringify({ target: 'HEAD~1..HEAD' }))
    expect(reviewerLenses(silent)).not.toContain('lock-enumeration')
  })

  it('distinguishes open families from lists closed by nature', async () => {
    const rt = runtimeFor(['src/shared.test.ts'])
    await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))
    const prompt = rt.calls.find((call) => call.opts?.label === 'pr-review:reviewer:lock-enumeration')?.prompt
    expect(prompt).toContain('OPEN family')
    expect(prompt).toContain('closed by its nature')
  })

  it('prints the exact lock-enumeration prompt with the requested fixture inline', () => {
    const output = execFileSync(process.execPath, [fileURLToPath(PROBE), 'open-family'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(output).toContain('OPEN family')
    expect(output).toContain('expect(record).toMatchObject({')
    expect(output).toContain('open-family.diff')
  })
})
