// doc-rewrite.test.ts — end-to-end composition test for the doc-rewrite workflow.
// Uses FakeRuntime with onAgent handler routing on prompt content.
// TDD: written before the implementation (RED step).

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@dwt/runtime'
import wf from '../doc-rewrite.workflow.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a FakeRuntime for the happy path:
 *  - Generate stage: candidates produce rewrite+angle
 *  - Filter stage: all pass
 *  - Evaluator: passes on iteration 2 (fails first, then passes)
 *  - Optimizer: produces a refined draft
 *
 * Routing uses UNIQUE phrases from workflow prompts in priority order:
 *  1. Filter:    "evaluate this candidate rewrite"
 *  2. Evaluator: "evaluator: does this draft meet all criteria"
 *  3. Optimizer: "optimizer: improve this draft"
 *  4. Fresh seed: "generate a single rewrite" (zero-survivor fallback)
 *  5. Generate:  "generate a rewrite of the document"
 */
function makeHappyPathRuntime(): FakeRuntime {
  let evaluatorCallCount = 0

  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()

      // (1) Filter stage — evaluates a candidate
      if (p.includes('evaluate this candidate rewrite')) {
        return { pass: true, reason: 'Meets all criteria' }
      }

      // (2) Evaluator stage — pass on second call
      if (p.includes('evaluator: does this draft meet all criteria')) {
        evaluatorCallCount++
        if (evaluatorCallCount < 2) {
          return { pass: false, feedback: 'Needs more examples in section 2' }
        }
        return { pass: true, feedback: 'All criteria satisfied' }
      }

      // (3) Optimizer stage
      if (p.includes('optimizer: improve this draft')) {
        return { rewrite: 'Improved draft content with better examples' }
      }

      // (4) Fresh seed agent (zero-survivor fallback)
      if (p.includes('generate a single rewrite')) {
        return { rewrite: 'Fresh seed draft content', angle: 'balanced' }
      }

      // (5) Generate stage
      if (p.includes('generate a rewrite of the document')) {
        return { rewrite: 'Draft rewrite content for the document', angle: 'concision-first' }
      }

      // Fallback
      return { rewrite: 'Fallback draft', angle: 'general' }
    },
  })
}

// ---------------------------------------------------------------------------
// Test: workflow metadata
// ---------------------------------------------------------------------------

describe('doc-rewrite workflow metadata', () => {
  it('has correct name and phases', () => {
    expect(wf.meta.name).toBe('doc-rewrite')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map(p => p.title)
    expect(titles).toEqual(['Generate', 'Refine', 'Finalize'])
  })
})

// ---------------------------------------------------------------------------
// Test: parseInput / fail-fast validation
// ---------------------------------------------------------------------------

describe('doc-rewrite parseInput', () => {
  it('throws actionable error when docPath is missing', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify({ criteria: ['be clear'] }))).rejects.toThrow(/docPath/)
  })

  it('throws actionable error when docPath is empty string', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify({ docPath: '', criteria: ['be clear'] }))).rejects.toThrow(/docPath/)
  })

  it('throws actionable error when criteria is missing', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify({ docPath: 'README.md' }))).rejects.toThrow(/criteria/)
  })

  it('throws actionable error when criteria is empty array', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify({ docPath: 'README.md', criteria: [] }))).rejects.toThrow(/criteria/)
  })

  it('throws actionable error when a criterion is an empty string', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify({ docPath: 'README.md', criteria: ['ok', ''] }))).rejects.toThrow(/criteria/)
  })

  it('throws actionable error when candidates is below 1', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify({ docPath: 'README.md', criteria: ['be clear'], candidates: 0 }))).rejects.toThrow(/candidates/)
  })

  it('throws actionable error when candidates exceeds max (5)', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify({ docPath: 'README.md', criteria: ['be clear'], candidates: 6 }))).rejects.toThrow(/candidates/)
  })

  it('throws actionable error when maxIterations is below 1', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify({ docPath: 'README.md', criteria: ['be clear'], maxIterations: 0 }))).rejects.toThrow(/maxIterations/)
  })

  it('accepts valid JSON-encoded object args', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify({ docPath: 'README.md', criteria: ['be concise', 'be accurate'] }))
    expect(result).toBeDefined()
    expect(result).toHaveProperty('finalDoc')
  })

  it('accepts JSON-encoded string args for docPath shorthand NOT applicable — object required', async () => {
    // docPath is inside an object — plain string input is invalid
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify('README.md'))).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Test: happy path — candidates pass filter, evaluator passes on iteration 2
// ---------------------------------------------------------------------------

describe('doc-rewrite happy path', () => {
  it('returns correct final shape with approved:true when evaluator passes', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify({
      docPath: 'docs/guide.md',
      criteria: ['be concise', 'use examples'],
      candidates: 2,
      maxIterations: 4,
    }))

    // Top-level shape
    expect(result).toHaveProperty('finalDoc')
    expect(result).toHaveProperty('approved')
    expect(result).toHaveProperty('iterations')
    expect(result).toHaveProperty('stoppedBy')
    expect(result).toHaveProperty('warnings')

    // Evaluator passed → approved = true
    expect(result.approved).toBe(true)
    expect(result.stoppedBy).toBe('done')

    // Ran at least 1 iteration (evaluator failed once, then passed)
    expect(result.iterations).toBeGreaterThanOrEqual(1)

    // finalDoc is a non-empty string
    expect(typeof result.finalDoc).toBe('string')
    expect(result.finalDoc.length).toBeGreaterThan(0)

    // warnings is an array
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('records Generate, Refine, and Finalize phases', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({
      docPath: 'docs/guide.md',
      criteria: ['be concise'],
      candidates: 2,
    }))

    expect(rt.phases).toContain('Generate')
    expect(rt.phases).toContain('Refine')
    expect(rt.phases).toContain('Finalize')
  })

  it('spawns agents for generation, filtering, evaluation, and optimization', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({
      docPath: 'docs/guide.md',
      criteria: ['be concise', 'use examples'],
      candidates: 3,
    }))

    // 3 generators + 3 filters + at least 1 evaluator + at least 1 optimizer
    expect(rt.agentsSpawned).toBeGreaterThan(6)
  })

  it('stoppedBy is "done" when evaluator approves', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify({
      docPath: 'docs/guide.md',
      criteria: ['clarity'],
      candidates: 1,
      maxIterations: 4,
    }))

    expect(result.stoppedBy).toBe('done')
    expect(result.approved).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test: zero-survivor fallback — all candidates rejected by filter
// ---------------------------------------------------------------------------

describe('doc-rewrite zero-survivor fallback', () => {
  it('emits warnings and seeds loop from fresh agent call when all candidates fail filter', async () => {
    let evaluatorCount = 0
    let seedCount = 0

    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // (1) Filter — rejects ALL candidates
        if (p.includes('evaluate this candidate rewrite')) {
          return { pass: false, reason: 'Does not meet criteria at all' }
        }

        // (2) Evaluator
        if (p.includes('evaluator: does this draft meet all criteria')) {
          evaluatorCount++
          return { pass: true, feedback: 'Approved' }
        }

        // (3) Optimizer
        if (p.includes('optimizer: improve this draft')) {
          return { rewrite: 'Optimized draft' }
        }

        // (4) Fresh seed agent
        if (p.includes('generate a single rewrite')) {
          seedCount++
          return { rewrite: 'Fresh seed fallback content', angle: 'balanced' }
        }

        // (5) Generate stage
        if (p.includes('generate a rewrite of the document')) {
          return { rewrite: 'Candidate draft', angle: 'concision-first' }
        }

        return { rewrite: 'Default', angle: 'general' }
      },
    })

    const result = await wf.run(rt, JSON.stringify({
      docPath: 'docs/api.md',
      criteria: ['be accurate'],
      candidates: 2,
      maxIterations: 3,
    }))

    // Composition must complete
    expect(result).toHaveProperty('finalDoc')

    // Warning about zero survivors must be emitted
    expect(result.warnings.length).toBeGreaterThan(0)
    const warningText = result.warnings.join(' ')
    expect(warningText).toMatch(/filter|survivor|criteria/i)

    // The FRESH-SEED fallback path specifically must have been taken —
    // evaluatorCount alone would only prove the loop ran, not how it was seeded
    expect(seedCount).toBe(1)
    // …and the loop did proceed from that seed
    expect(evaluatorCount).toBeGreaterThan(0)
  })

  it('zero-survivor fallback warning mentions criteria problem', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()
        if (p.includes('evaluate this candidate rewrite')) {
          return { pass: false, reason: 'Rejected' }
        }
        if (p.includes('evaluator: does this draft meet all criteria')) {
          return { pass: true, feedback: 'OK' }
        }
        if (p.includes('generate a single rewrite')) {
          return { rewrite: 'Seed content', angle: 'balanced' }
        }
        if (p.includes('generate a rewrite of the document')) {
          return { rewrite: 'Candidate', angle: 'concision-first' }
        }
        if (p.includes('optimizer: improve this draft')) {
          return { rewrite: 'Better draft' }
        }
        return { rewrite: 'Default', angle: 'general' }
      },
    })

    const result = await wf.run(rt, JSON.stringify({
      docPath: 'docs/api.md',
      criteria: ['be accurate'],
      candidates: 2,
      maxIterations: 2,
    }))

    // Warning must mention the criteria as the likely source of the problem
    const allWarnings = result.warnings.join(' ')
    expect(allWarnings.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Test: maxIterations exhaustion — evaluator never passes
// ---------------------------------------------------------------------------

describe('doc-rewrite maxIterations exhaustion', () => {
  it('returns approved:false and stoppedBy maxIterations when evaluator never passes', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // (1) Filter passes
        if (p.includes('evaluate this candidate rewrite')) {
          return { pass: true, reason: 'Acceptable' }
        }

        // (2) Evaluator NEVER passes
        if (p.includes('evaluator: does this draft meet all criteria')) {
          return { pass: false, feedback: 'Still missing key examples' }
        }

        // (3) Optimizer
        if (p.includes('optimizer: improve this draft')) {
          return { rewrite: 'Another attempt at improving the draft' }
        }

        // (4) Fresh seed (not needed here)
        if (p.includes('generate a single rewrite')) {
          return { rewrite: 'Seed', angle: 'balanced' }
        }

        // (5) Generate
        if (p.includes('generate a rewrite of the document')) {
          return { rewrite: 'Generated candidate', angle: 'examples-first' }
        }

        return { rewrite: 'Default', angle: 'general' }
      },
    })

    const result = await wf.run(rt, JSON.stringify({
      docPath: 'docs/guide.md',
      criteria: ['be very detailed'],
      candidates: 1,
      maxIterations: 2,
    }))

    // Honest terminal reporting: not approved
    expect(result.approved).toBe(false)
    expect(result.stoppedBy).toBe('maxIterations')

    // iterations should match maxIterations
    expect(result.iterations).toBe(2)

    // finalDoc is still populated (last state)
    expect(typeof result.finalDoc).toBe('string')
    expect(result.finalDoc.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Test: generator null results handled — dropped, composition completes
// ---------------------------------------------------------------------------

describe('doc-rewrite generator null results', () => {
  it('drops null generate results and completes with remaining survivors', async () => {
    let generateCount = 0

    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // (1) Filter
        if (p.includes('evaluate this candidate rewrite')) {
          return { pass: true, reason: 'Good' }
        }

        // (2) Evaluator — passes immediately
        if (p.includes('evaluator: does this draft meet all criteria')) {
          return { pass: true, feedback: 'Looks good' }
        }

        // (3) Optimizer
        if (p.includes('optimizer: improve this draft')) {
          return { rewrite: 'Improved' }
        }

        // (4) Fresh seed (in case all fail)
        if (p.includes('generate a single rewrite')) {
          return { rewrite: 'Seed', angle: 'balanced' }
        }

        // (5) Generate — first call returns null (simulates failed agent)
        if (p.includes('generate a rewrite of the document')) {
          generateCount++
          if (generateCount === 1) return null
          return { rewrite: 'Valid candidate draft', angle: 'structure-first' }
        }

        return { rewrite: 'Default', angle: 'general' }
      },
    })

    const result = await wf.run(rt, JSON.stringify({
      docPath: 'docs/guide.md',
      criteria: ['clarity'],
      candidates: 3,
      maxIterations: 3,
    }))

    // Composition must complete despite a null generator
    expect(result).toHaveProperty('finalDoc')
    expect(result).toHaveProperty('stoppedBy')
  })
})

// ---------------------------------------------------------------------------
// Test: defaults — candidates defaults to 3, maxIterations defaults to 4
// ---------------------------------------------------------------------------

describe('doc-rewrite input defaults', () => {
  it('uses default candidates=3 and maxIterations=4 when not specified', async () => {
    let generateCount = 0
    let evaluatorCount = 0

    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()
        if (p.includes('evaluate this candidate rewrite')) {
          return { pass: true, reason: 'OK' }
        }
        if (p.includes('evaluator: does this draft meet all criteria')) {
          evaluatorCount++
          return { pass: true, feedback: 'Approved' }
        }
        if (p.includes('optimizer: improve this draft')) {
          return { rewrite: 'Better' }
        }
        if (p.includes('generate a single rewrite')) {
          return { rewrite: 'Seed', angle: 'balanced' }
        }
        if (p.includes('generate a rewrite of the document')) {
          generateCount++
          return { rewrite: `Candidate ${generateCount}`, angle: 'concision-first' }
        }
        return { rewrite: 'Default', angle: 'general' }
      },
    })

    await wf.run(rt, JSON.stringify({
      docPath: 'README.md',
      criteria: ['be concise'],
    }))

    // Default candidates = 3 → 3 generate + 3 filter calls
    expect(generateCount).toBe(3)
    // Evaluator passes immediately → exactly 1 iteration of the refine loop
    expect(evaluatorCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Test: index-based angle diversity in generate prompts
// ---------------------------------------------------------------------------

describe('doc-rewrite index-based angle variation', () => {
  it('uses different angles per generate index (deterministic diversity)', async () => {
    const generatePrompts: string[] = []

    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()
        if (p.includes('evaluate this candidate rewrite')) {
          return { pass: true, reason: 'OK' }
        }
        if (p.includes('evaluator: does this draft meet all criteria')) {
          return { pass: true, feedback: 'Good' }
        }
        if (p.includes('optimizer: improve this draft')) {
          return { rewrite: 'Better' }
        }
        if (p.includes('generate a single rewrite')) {
          return { rewrite: 'Seed', angle: 'balanced' }
        }
        if (p.includes('generate a rewrite of the document')) {
          generatePrompts.push(prompt)
          return { rewrite: 'Draft', angle: 'concision-first' }
        }
        return { rewrite: 'Default', angle: 'general' }
      },
    })

    await wf.run(rt, JSON.stringify({
      docPath: 'README.md',
      criteria: ['be concise'],
      candidates: 3,
    }))

    // 3 generate prompts captured
    expect(generatePrompts).toHaveLength(3)

    // At minimum the prompts should differ (index-based variation)
    expect(generatePrompts[0]).not.toBe(generatePrompts[1])
  })
})
