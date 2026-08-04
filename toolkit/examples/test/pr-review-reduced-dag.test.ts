import { describe, expect, it } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../pr-review-reduced-dag.workflow.js'

describe('pr-review-reduced-dag metadata', () => {
  it('declares the reduced DAG workflow and its four phases', () => {
    expect(wf.meta.name).toBe('pr-review-reduced-dag')
    expect(wf.meta.phases?.map((phase) => phase.title)).toEqual([
      'Classify',
      'Review',
      'Verify',
      'Synthesize',
    ])
  })
})

describe('pr-review-reduced-dag parseInput', () => {
  it('requires target and category', async () => {
    const rt = new FakeRuntime()
    await expect(wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))).rejects.toThrow(/category/)
    await expect(wf.run(rt, JSON.stringify({ category: 'bugfix' }))).rejects.toThrow(/target/)
  })

  it('rejects an unknown category', async () => {
    const rt = new FakeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD', category: 'other' })),
    ).rejects.toThrow(/bugfix, feature, refactor, config, docs/)
  })
})

describe('pr-review-reduced-dag execution', () => {
  it('runs exactly three reduced review nodes and one shared verifier, all pinned to haiku/low', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string }) => {
        const p = prompt.toLowerCase()
        if (p.includes('shared verifier')) {
          return {
            verdicts: [
              { findingId: 'root-cause:1', verdict: 'confirmed', citation: 'src/app.ts:10', rationale: 'Freshly confirmed' },
              { findingId: 'regression-risk:1', verdict: 'refuted', citation: 'src/app.ts:20', rationale: 'Freshly refuted' },
              { findingId: 'test-coverage:1', verdict: 'unverifiable', citation: 'src/app.ts:30', rationale: 'Could not verify' },
            ],
          }
        }
        return {
          findings: [
            {
              title: 'Finding',
              file: 'src/app.ts',
              severity: 'medium',
              detail: 'Detail',
            },
          ],
        }
      },
    })

    const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD', category: 'bugfix' }))

    expect(result.lenses).toEqual(['root-cause', 'regression-risk', 'test-coverage'])
    expect(result.waves).toBe(2)
    expect(rt.calls).toHaveLength(4)
    expect(rt.calls.map((call) => call.opts?.label)).toEqual([
      'pr-review-reduced-dag:review:root-cause',
      'pr-review-reduced-dag:review:regression-risk',
      'pr-review-reduced-dag:review:test-coverage',
      'pr-review-reduced-dag:verify',
    ])
    for (const call of rt.calls) {
      expect(call.opts?.model).toBe('haiku')
      expect(call.opts?.effort).toBe('low')
    }
    expect(result.verdict).toBe('request-changes')
  })

  it('makes the shared verifier prompt carry the three mechanically-checkable constraints and interleaves findings across lenses', async () => {
    let verifierPrompt = ''
    let reviewCall = 0
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string }) => {
        if (prompt.includes('shared verifier')) {
          verifierPrompt = prompt
          return {
            verdicts: [
              { findingId: 'correctness:1', verdict: 'confirmed', citation: 'src/a.ts:1', rationale: 'r1' },
              { findingId: 'security:1', verdict: 'confirmed', citation: 'src/b.ts:2', rationale: 'r2' },
              { findingId: 'api-design:1', verdict: 'confirmed', citation: 'src/c.ts:3', rationale: 'r3' },
              { findingId: 'correctness:2', verdict: 'confirmed', citation: 'src/a.ts:4', rationale: 'r4' },
              { findingId: 'security:2', verdict: 'confirmed', citation: 'src/b.ts:5', rationale: 'r5' },
              { findingId: 'api-design:2', verdict: 'confirmed', citation: 'src/c.ts:6', rationale: 'r6' },
            ],
          }
        }

        reviewCall++
        if (reviewCall === 1) {
          return {
            findings: [
              { title: 'c1', file: 'src/a.ts', severity: 'low', detail: 'd1' },
              { title: 'c2', file: 'src/a.ts', severity: 'low', detail: 'd2' },
            ],
          }
        }
        if (reviewCall === 2) {
          return {
            findings: [
              { title: 's1', file: 'src/b.ts', severity: 'low', detail: 'd3' },
              { title: 's2', file: 'src/b.ts', severity: 'low', detail: 'd4' },
            ],
          }
        }
        return {
          findings: [
            { title: 'a1', file: 'src/c.ts', severity: 'low', detail: 'd5' },
            { title: 'a2', file: 'src/c.ts', severity: 'low', detail: 'd6' },
          ],
        }
      },
    })

    await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD', category: 'feature' }))

    expect(verifierPrompt).toContain('Return one verdict per finding, each anchored in a FRESH re-read of the source and cited as file:line')
    expect(verifierPrompt).toContain('Do NOT reference any other finding in a verdict')
    expect(verifierPrompt).toContain('The findings below are intentionally INTERLEAVED across lenses')
    expect(verifierPrompt.indexOf('correctness:1')).toBeLessThan(verifierPrompt.indexOf('security:1'))
    expect(verifierPrompt.indexOf('security:1')).toBeLessThan(verifierPrompt.indexOf('api-design:1'))
    expect(verifierPrompt.indexOf('api-design:1')).toBeLessThan(verifierPrompt.indexOf('correctness:2'))
    expect(verifierPrompt.indexOf('correctness:2')).toBeLessThan(verifierPrompt.indexOf('security:2'))
    expect(verifierPrompt.indexOf('security:2')).toBeLessThan(verifierPrompt.indexOf('api-design:2'))
  })

  it('approves when every shared-verifier verdict is refuted', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string }) => {
        if (prompt.includes('shared verifier')) {
          return {
            verdicts: [
              { findingId: 'accuracy:1', verdict: 'refuted', citation: 'docs/readme.md:8', rationale: 'Not an issue' },
              { findingId: 'completeness:1', verdict: 'refuted', citation: 'docs/readme.md:12', rationale: 'Not an issue' },
              { findingId: 'clarity:1', verdict: 'refuted', citation: 'docs/readme.md:20', rationale: 'Not an issue' },
            ],
          }
        }
        return {
          findings: [
            { title: 'doc finding', file: 'docs/readme.md', severity: 'low', detail: 'detail' },
          ],
        }
      },
    })

    const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD', category: 'docs' }))
    expect(result.verdict).toBe('approve')
    expect(result.lensesConcluded).toEqual(result.lenses)
    expect(result.summary).not.toContain('INCOMPLETE')
  })

  // The reduced shape buys its saving by running fewer lenses, so losing one costs
  // proportionally more here than in the full shape — and a lens that dies produces exactly
  // the same evidence as a lens that ran and found nothing: an empty contribution.
  it('refuses to approve when a review lens never concluded, and says so in the summary', async () => {
    let reviewCall = 0
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string }) => {
        if (prompt.includes('shared verifier')) {
          return {
            verdicts: [
              { findingId: 'accuracy:1', verdict: 'refuted', citation: 'docs/readme.md:8', rationale: 'Not an issue' },
              { findingId: 'completeness:1', verdict: 'refuted', citation: 'docs/readme.md:12', rationale: 'Not an issue' },
            ],
          }
        }
        reviewCall++
        // The third lens dies. Every verdict that DOES come back is 'refuted', so without the
        // completeness check the run would read a clean "approve" over two lenses of three.
        if (reviewCall === 3) return null
        return {
          findings: [
            { title: 'doc finding', file: 'docs/readme.md', severity: 'low', detail: 'detail' },
          ],
        }
      },
    })

    const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD', category: 'docs' }))

    expect(result.lenses).toHaveLength(3)
    expect(result.lensesConcluded).toHaveLength(2)
    expect(result.lensesConcluded).not.toContain('clarity')
    expect(result.verdict).toBe('request-changes')
    expect(result.summary).toContain('INCOMPLETE — 1 of 3 lenses did not conclude (clarity)')
  })
})
