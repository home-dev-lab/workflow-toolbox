import { describe, it, expect } from 'vitest'
import { FakeRuntime, parseDigest } from '@workflow-toolbox/runtime'
import { tournament } from '../src/tournament.js'
import type { TournamentOptions } from '../src/tournament.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(
  overrides: Partial<TournamentOptions<string>> = {},
): TournamentOptions<string> {
  return {
    angles: ['angle-0', 'angle-1', 'angle-2'],
    attemptPrompt: (angle, i) => `attempt ${i}: ${angle}`,
    judgePrompt: (attempt) => `judge: ${attempt}`,
    synthesisPrompt: (ranked) => `synthesize: ${ranked.map(r => r.attempt).join(', ')}`,
    ...overrides,
  }
}

function makeJudgeResponse(score: number) {
  return { score, reason: `score is ${score}` }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('tournament — config validation', () => {
  it('rejects when angles.length < 2', async () => {
    const rt = new FakeRuntime()
    await expect(
      tournament(rt, makeOptions({ angles: ['only-one'] })),
    ).rejects.toThrow(/angles.*>=.*2|not a tournament/)
  })

  it('rejects when angles has duplicates', async () => {
    const rt = new FakeRuntime()
    await expect(
      tournament(rt, makeOptions({ angles: ['a', 'a', 'b'] })),
    ).rejects.toThrow(/duplicate.*angle/i)
  })

  it('rejects when judgeCount < 1', async () => {
    const rt = new FakeRuntime()
    await expect(
      tournament(rt, makeOptions({ judgeCount: 0 })),
    ).rejects.toThrow(/judgeCount.*>=.*1/)
  })
})

// ---------------------------------------------------------------------------
// agentType routing (attemptType / judgeType / synthesisType) — per-role
// cross-family routing. Judge spawns are nested (parallel-of-parallel), so
// judgeType must thread to every judge across every surviving attempt.
// ---------------------------------------------------------------------------

function routingOnAgent({ opts }: { opts?: { label?: string } }): unknown {
  const label = opts?.label ?? ''
  if (label.startsWith('tournament:judge:')) return makeJudgeResponse(5)
  return 'ok'
}

describe('tournament — agentType routing', () => {
  it('omits agentType on every call when none of attemptType/judgeType/synthesisType is set', async () => {
    const rt = new FakeRuntime({ onAgent: routingOnAgent })
    await tournament(rt, makeOptions())
    expect(rt.calls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads attemptType to the attempt agents only', async () => {
    const rt = new FakeRuntime({ onAgent: routingOnAgent })
    await tournament(rt, makeOptions({ attemptType: 'codex:codex-rescue' }))
    const attemptCalls = rt.calls.filter((c) => c.opts?.label?.startsWith('tournament:attempt:'))
    const otherCalls = rt.calls.filter((c) => !c.opts?.label?.startsWith('tournament:attempt:'))
    expect(attemptCalls.length).toBe(3)
    expect(attemptCalls.every((c) => c.opts?.agentType === 'codex:codex-rescue')).toBe(true)
    expect(otherCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads judgeType to every judge agent across every attempt (nested parallel-of-parallel)', async () => {
    const rt = new FakeRuntime({ onAgent: routingOnAgent })
    await tournament(rt, makeOptions({ judgeType: 'workflow-toolbox:opencode-verifier', judgeCount: 3 }))
    const judgeCalls = rt.calls.filter((c) => c.opts?.label?.startsWith('tournament:judge:'))
    const otherCalls = rt.calls.filter((c) => !c.opts?.label?.startsWith('tournament:judge:'))
    // 3 angles * 3 judges = 9 judge calls
    expect(judgeCalls.length).toBe(9)
    expect(judgeCalls.every((c) => c.opts?.agentType === 'workflow-toolbox:opencode-verifier')).toBe(true)
    expect(otherCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads synthesisType to the synthesis agent only', async () => {
    const rt = new FakeRuntime({ onAgent: routingOnAgent })
    await tournament(rt, makeOptions({ synthesisType: 'codex:codex-rescue' }))
    const synthCalls = rt.calls.filter((c) => c.opts?.label === 'tournament:synthesize')
    const otherCalls = rt.calls.filter((c) => c.opts?.label !== 'tournament:synthesize')
    expect(synthCalls.length).toBe(1)
    expect(synthCalls.every((c) => c.opts?.agentType === 'codex:codex-rescue')).toBe(true)
    expect(otherCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('rejects an empty or whitespace-only attemptType', async () => {
    const rt = new FakeRuntime()
    await expect(tournament(rt, makeOptions({ attemptType: '' }))).rejects.toThrow(/attemptType/)
    await expect(tournament(rt, makeOptions({ attemptType: '   ' }))).rejects.toThrow(/attemptType/)
  })

  it('rejects an empty or whitespace-only judgeType', async () => {
    const rt = new FakeRuntime()
    await expect(tournament(rt, makeOptions({ judgeType: '' }))).rejects.toThrow(/judgeType/)
    await expect(tournament(rt, makeOptions({ judgeType: '   ' }))).rejects.toThrow(/judgeType/)
  })

  it('rejects an empty or whitespace-only synthesisType', async () => {
    const rt = new FakeRuntime()
    await expect(tournament(rt, makeOptions({ synthesisType: '' }))).rejects.toThrow(/synthesisType/)
    await expect(tournament(rt, makeOptions({ synthesisType: '   ' }))).rejects.toThrow(/synthesisType/)
  })
})

// ---------------------------------------------------------------------------
// Phase digest on the failure early-return
// ---------------------------------------------------------------------------

describe('tournament — failure digest', () => {
  it('emits a digest even when all attempts fail (no winner to rank)', async () => {
    const rt = new FakeRuntime({ onAgent: () => null }) // every attempt returns null
    await tournament(rt, makeOptions())
    const digest = rt.logs.map(parseDigest).find((d) => d?.stage === 'tournament')
    expect(digest).toBeDefined()
    expect(digest?.counts).toEqual({ attempts: 0 })
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('tournament — happy path', () => {
  it('returns synthesized value, correct stats, empty warnings', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return `attempt-result-${label.split(':').pop()}`
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(8)
        if (label === 'tournament:synthesize') return 'synthesis-winner'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 2,
    }))

    expect(result.warnings).toHaveLength(0)
    expect(result.value).toBe('synthesis-winner')
    // itemsIn = angles.length
    expect(result.stats.itemsIn).toBe(2)
    // itemsOut = ranked attempts
    expect(result.stats.itemsOut).toBe(2)
    expect(result.stats.dropped).toBe(0)
    expect(result.stats.truncated).toBe(0)
    // 2 attempts + 2*2 judges + 1 synthesis = 7
    expect(result.stats.agentsSpawned).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// All attempts null — no judging or synthesis spawned
// ---------------------------------------------------------------------------

describe('tournament — all attempts null', () => {
  it('skips judging and synthesis, returns null, emits warning', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return null
        return 'should-not-be-called'
      },
    })

    const result = await tournament(rt, makeOptions({ angles: ['a', 'b'] }))

    expect(result.value).toBeNull()
    // No judge or synthesis calls
    const nonAttemptCalls = rt.calls.filter(
      c => !c.opts?.label?.startsWith('tournament:attempt:'),
    )
    expect(nonAttemptCalls).toHaveLength(0)
    expect(result.warnings.some(w => w.includes('all attempts failed'))).toBe(true)
    // agentsSpawned = only attempt calls = 2
    expect(result.stats.agentsSpawned).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Attempt with zero judge votes — excluded from ranking
// ---------------------------------------------------------------------------

describe('tournament — zero judge votes for an attempt', () => {
  it('excludes attempt from ranking, emits warning, still synthesizes remaining', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'tournament:attempt:0') return 'attempt-0-result'
        if (label === 'tournament:attempt:1') return 'attempt-1-result'
        // All judges for attempt 0 return null
        if (label.startsWith('tournament:judge:0:')) return null
        // Judges for attempt 1 return normal scores
        if (label.startsWith('tournament:judge:1:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'synthesized'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 2,
    }))

    // attempt 0 excluded → only attempt 1 ranked
    expect(result.stats.itemsOut).toBe(1)
    expect(result.stats.dropped).toBe(1)
    expect(result.warnings.some(w => w.includes('no judge votes') || w.includes('excluded from ranking'))).toBe(true)
    expect(result.value).toBe('synthesized')
  })
})

// ---------------------------------------------------------------------------
// Median score computation — odd count
// ---------------------------------------------------------------------------

describe('tournament — median: odd judge count', () => {
  it('picks the middle value for odd number of judges', async () => {
    const capturedRanked: Array<{ attempt: string; score: number }> = []

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return `attempt-${label.split(':').pop()}`
        if (label.startsWith('tournament:judge:')) {
          const parts = label.split(':')
          const attemptIdx = Number(parts[2])
          // attempt 0: scores [3, 7, 5] → median = 5
          // attempt 1: scores [8, 6, 9] → median = 8
          const scores: Record<number, number[]> = { 0: [3, 7, 5], 1: [8, 6, 9] }
          const voteIdx = Number(parts[3])
          return makeJudgeResponse(scores[attemptIdx]![voteIdx]!)
        }
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 3,
      synthesisPrompt: (ranked) => {
        capturedRanked.push(...ranked.map(r => ({ attempt: r.attempt as string, score: r.score })))
        return 'synth'
      },
    }))

    // ranked DESC: attempt-1 (8) then attempt-0 (5)
    expect(capturedRanked[0]!.score).toBe(8)
    expect(capturedRanked[1]!.score).toBe(5)
    // winner is attempt-1
    expect(capturedRanked[0]!.attempt).toContain('attempt-1')
  })
})

// ---------------------------------------------------------------------------
// Median score computation — even count
// ---------------------------------------------------------------------------

describe('tournament — median: even judge count', () => {
  it('averages the two middle values for even judge count', async () => {
    const capturedRanked: Array<{ score: number }> = []

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return `attempt-${label.split(':').pop()}`
        if (label.startsWith('tournament:judge:')) {
          // 4 judges, scores [2, 6, 4, 8] → sorted [2,4,6,8] → median = (4+6)/2 = 5
          const parts = label.split(':')
          const voteIdx = Number(parts[3])
          const scores = [2, 6, 4, 8]
          return makeJudgeResponse(scores[voteIdx]!)
        }
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 4,
      synthesisPrompt: (ranked) => {
        capturedRanked.push(...ranked.map(r => ({ score: r.score })))
        return 'synth'
      },
    }))

    // Both attempts get same scores → median = 5
    expect(capturedRanked[0]!.score).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Ranking order — DESC with stable ties keeping angle order
// ---------------------------------------------------------------------------

describe('tournament — ranking order', () => {
  it('sorts ranked attempts by score DESC, ties keep angle order', async () => {
    const capturedAngles: string[] = []

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) {
          const idx = Number(label.split(':').pop())
          return `attempt-${idx}`
        }
        if (label.startsWith('tournament:judge:')) {
          const parts = label.split(':')
          const attemptIdx = Number(parts[2])
          // scores: angle-0 → 7, angle-1 → 9, angle-2 → 7 (tie with 0)
          const scores: Record<number, number> = { 0: 7, 1: 9, 2: 7 }
          return makeJudgeResponse(scores[attemptIdx] ?? 5)
        }
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    await tournament(rt, makeOptions({
      angles: ['angle-0', 'angle-1', 'angle-2'],
      judgeCount: 1,
      synthesisPrompt: (ranked) => {
        capturedAngles.push(...ranked.map(r => r.angle))
        return 'synth'
      },
    }))

    // DESC: angle-1 (9), then angle-0 (7), then angle-2 (7) — angle-0 before angle-2 (stable)
    expect(capturedAngles[0]).toBe('angle-1')
    expect(capturedAngles[1]).toBe('angle-0')
    expect(capturedAngles[2]).toBe('angle-2')
  })
})

// ---------------------------------------------------------------------------
// Synthesis receives winner first
// ---------------------------------------------------------------------------

describe('tournament — synthesisPrompt receives winner first', () => {
  it('passes ranked list winner-first to synthesisPrompt', async () => {
    const capturedFirst: string[] = []

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return `attempt-${label.split(':').pop()}`
        if (label.startsWith('tournament:judge:')) {
          const parts = label.split(':')
          const attemptIdx = Number(parts[2])
          // attempt 1 wins with score 9, attempt 0 gets 3
          return makeJudgeResponse(attemptIdx === 1 ? 9 : 3)
        }
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    await tournament(rt, makeOptions({
      angles: ['low', 'high'],
      judgeCount: 1,
      synthesisPrompt: (ranked) => {
        capturedFirst.push(ranked[0]!.angle)
        return 'synth'
      },
    }))

    // Winner (attempt 1, angle 'high') is first
    expect(capturedFirst[0]).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// Phase forwarding
// ---------------------------------------------------------------------------

describe('tournament — phase forwarding', () => {
  it('forwards phase to all agent calls', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    await tournament(rt, makeOptions({ angles: ['a', 'b'], judgeCount: 1, phase: 'tourney-phase' }))

    expect(rt.calls.every(c => c.phase === 'tourney-phase')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('tournament — labels', () => {
  it('assigns correct label shapes for attempt, judge, synthesize calls', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    await tournament(rt, makeOptions({ angles: ['a', 'b'], judgeCount: 2 }))

    const labels = rt.calls.map(c => c.opts?.label)
    expect(labels).toContain('tournament:attempt:0')
    expect(labels).toContain('tournament:attempt:1')
    expect(labels).toContain('tournament:judge:0:0')
    expect(labels).toContain('tournament:judge:0:1')
    expect(labels).toContain('tournament:judge:1:0')
    expect(labels).toContain('tournament:judge:1:1')
    expect(labels).toContain('tournament:synthesize')
  })
})

// ---------------------------------------------------------------------------
// Judge control schema shape
// ---------------------------------------------------------------------------

describe('tournament — judge control schema', () => {
  it('forwards owned score schema to judge calls', async () => {
    let capturedSchema: unknown = null
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) {
          capturedSchema = opts?.schema
          return makeJudgeResponse(7)
        }
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    await tournament(rt, makeOptions({ angles: ['a', 'b'], judgeCount: 1 }))

    expect(capturedSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        score: expect.objectContaining({ type: 'number', minimum: 0, maximum: 10 }),
        reason: { type: 'string' },
      }),
      required: expect.arrayContaining(['score', 'reason']),
      additionalProperties: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Null judge votes warning (attempt survives via median of rest)
// ---------------------------------------------------------------------------

describe('tournament — partial null judge votes', () => {
  it('emits warning for null judge votes but attempt survives if others scored', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label === 'tournament:judge:0:0') return null       // one null vote
        if (label === 'tournament:judge:0:1') return makeJudgeResponse(8)  // one good vote
        if (label.startsWith('tournament:judge:1:')) return makeJudgeResponse(6)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({ angles: ['a', 'b'], judgeCount: 2 }))

    expect(result.value).toBe('done')
    // dropped = null attempts + unjudgeable attempts (not null judge votes)
    expect(result.stats.dropped).toBe(0)
    expect(result.warnings.some(w => w.includes('null') && w.includes('judge'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// All ranking ends up empty → value null, synthesis skipped
// ---------------------------------------------------------------------------

describe('tournament — empty ranking after judging', () => {
  it('returns null and skips synthesis when all attempts receive zero judge votes', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return null  // all judges fail
        if (label === 'tournament:synthesize') return 'done'   // should NOT be called
        return null
      },
    })

    const result = await tournament(rt, makeOptions({ angles: ['a', 'b'], judgeCount: 1 }))

    expect(result.value).toBeNull()
    expect(rt.calls.find(c => c.opts?.label === 'tournament:synthesize')).toBeUndefined()
    expect(result.warnings.some(w => w.includes('ranking') || w.includes('empty'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Synthesis null → value null + warning
// ---------------------------------------------------------------------------

describe('tournament — synthesis null', () => {
  it('returns null and emits warning when synthesis returns null', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return null
        return null
      },
    })

    const result = await tournament(rt, makeOptions({ angles: ['a', 'b'], judgeCount: 1 }))

    expect(result.value).toBeNull()
    expect(result.warnings.some(w => w.includes('synthesis') && w.includes('null'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Model forwarding
// ---------------------------------------------------------------------------

describe('tournament — model forwarding', () => {
  it('forwards attemptModel and judgeModel and synthesisModel', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 1,
      attemptModel: 'haiku',
      judgeModel: 'sonnet',
      synthesisModel: 'opus',
    }))

    const attemptCalls = rt.calls.filter(c => c.opts?.label?.startsWith('tournament:attempt:'))
    const judgeCalls = rt.calls.filter(c => c.opts?.label?.startsWith('tournament:judge:'))
    const synthCall = rt.calls.find(c => c.opts?.label === 'tournament:synthesize')

    expect(attemptCalls.every(c => c.opts?.model === 'haiku')).toBe(true)
    expect(judgeCalls.every(c => c.opts?.model === 'sonnet')).toBe(true)
    expect(synthCall?.opts?.model).toBe('opus')
  })
})

// ---------------------------------------------------------------------------
// Trail — happy path: attempts + judges + synthesis, count === agentsSpawned
// ---------------------------------------------------------------------------

describe('tournament — trail: happy path', () => {
  it('returns trail defined, length === agentsSpawned', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(8)
        if (label === 'tournament:synthesize') return 'winner'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 2,
    }))

    // trail must be defined and present
    expect(result.trail).toBeDefined()
    // invariant: trail.length === agentsSpawned (2 attempts + 4 judges + 1 synth = 7)
    expect(result.trail!.length).toBe(result.stats.agentsSpawned)
    expect(result.trail!.length).toBe(7)
  })

  it('trail records have correct stages for attempts', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 1,
    }))

    const attemptRecords = result.trail!.filter(r => r.stage.startsWith('tournament:attempt:'))
    expect(attemptRecords).toHaveLength(2)
    for (const rec of attemptRecords) {
      expect(rec.outcome).toBe('ok')
    }
  })

  it('judge trail records carry numeric score as decision string', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(9)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 1,
    }))

    const judgeRecords = result.trail!.filter(r => r.stage.startsWith('tournament:judge:'))
    expect(judgeRecords.length).toBeGreaterThan(0)
    for (const rec of judgeRecords) {
      expect(rec.outcome).toBe('ok')
      // decision = score=<value> format for intra-pattern consistency
      expect(rec.decision).toBe('score=9')
    }
  })

  it('synthesis trail record carries winner=<attemptIndex> decision', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) {
          const parts = label.split(':')
          const attemptIdx = Number(parts[2])
          // attempt 0 gets 3, attempt 1 gets 9 → attempt 1 wins (originalIndex=1)
          return makeJudgeResponse(attemptIdx === 0 ? 3 : 9)
        }
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 1,
    }))

    const synthRecord = result.trail!.find(r => r.stage === 'tournament:synthesize')
    expect(synthRecord).toBeDefined()
    expect(synthRecord!.outcome).toBe('ok')
    // winner is attempt at originalIndex=1
    expect(synthRecord!.decision).toBe('winner=1')
  })

  it('trail records appear in index order after parallel barrier (determinism)', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    const result1 = await tournament(rt, makeOptions({ angles: ['a', 'b'], judgeCount: 2 }))
    const rt2 = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })
    const result2 = await tournament(rt2, makeOptions({ angles: ['a', 'b'], judgeCount: 2 }))

    expect(result1.trail).toEqual(result2.trail)
  })
})

// ---------------------------------------------------------------------------
// Trail — null judge: outcome 'null', still counted in agentsSpawned
// ---------------------------------------------------------------------------

describe('tournament — trail: null judge vote', () => {
  it('null judge gets outcome=null trail record, still counted in agentsSpawned', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label === 'tournament:judge:0:0') return null
        if (label === 'tournament:judge:0:1') return makeJudgeResponse(6)
        if (label.startsWith('tournament:judge:1:')) return makeJudgeResponse(8)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 2,
    }))

    // trail must be defined
    expect(result.trail).toBeDefined()
    // invariant holds: 2 attempts + 4 judges + 1 synth = 7
    expect(result.trail!.length).toBe(result.stats.agentsSpawned)

    const nullJudgeRec = result.trail!.find(r => r.stage === 'tournament:judge:0:0')
    expect(nullJudgeRec).toBeDefined()
    expect(nullJudgeRec!.outcome).toBe('null')
    // null judge has no decision (no score to report)
    expect(nullJudgeRec).not.toHaveProperty('decision')
  })
})

// ---------------------------------------------------------------------------
// Trail — all attempts null early return (return site 1)
// ---------------------------------------------------------------------------

describe('tournament — trail: all attempts null early return', () => {
  it('trail defined, contains attempt records with outcome=null, length===agentsSpawned', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return null
        return 'should-not-be-called'
      },
    })

    const result = await tournament(rt, makeOptions({ angles: ['a', 'b'] }))

    expect(result.trail).toBeDefined()
    // agentsSpawned = 2 attempt calls only
    expect(result.trail!.length).toBe(result.stats.agentsSpawned)
    expect(result.trail!.length).toBe(2)

    for (const rec of result.trail!) {
      expect(rec.stage).toMatch(/^tournament:attempt:/)
      expect(rec.outcome).toBe('null')
    }
  })
})

// ---------------------------------------------------------------------------
// Trail — model override present/absent
// ---------------------------------------------------------------------------

describe('tournament — trail: model override', () => {
  it('model key present in trail record when explicit model passed', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 1,
      attemptModel: 'haiku',
      judgeModel: 'sonnet',
      synthesisModel: 'opus',
    }))

    const attemptRecs = result.trail!.filter(r => r.stage.startsWith('tournament:attempt:'))
    const judgeRecs = result.trail!.filter(r => r.stage.startsWith('tournament:judge:'))
    const synthRec = result.trail!.find(r => r.stage === 'tournament:synthesize')

    for (const rec of attemptRecs) expect(rec.model).toBe('haiku')
    for (const rec of judgeRecs) expect(rec.model).toBe('sonnet')
    expect(synthRec!.model).toBe('opus')
  })

  it('model key absent in trail record when no model override', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 1,
    }))

    for (const rec of result.trail!) {
      expect(rec).not.toHaveProperty('model')
    }
  })
})

// ---------------------------------------------------------------------------
// Effort forwarding
// ---------------------------------------------------------------------------

describe('tournament — effort forwarding', () => {
  it('forwards attemptEffort, judgeEffort, and synthesisEffort to each call site', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 1,
      attemptEffort: 'low',
      judgeEffort: 'high',
      synthesisEffort: 'max',
    }))

    const attemptCalls = rt.calls.filter(c => c.opts?.label?.startsWith('tournament:attempt:'))
    const judgeCalls = rt.calls.filter(c => c.opts?.label?.startsWith('tournament:judge:'))
    const synthCall = rt.calls.find(c => c.opts?.label === 'tournament:synthesize')

    expect(attemptCalls.every(c => c.opts?.effort === 'low')).toBe(true)
    expect(judgeCalls.every(c => c.opts?.effort === 'high')).toBe(true)
    expect(synthCall?.opts?.effort).toBe('max')
  })
})

// ---------------------------------------------------------------------------
// Effort in the audit trail
// ---------------------------------------------------------------------------

describe('tournament — trail: effort override', () => {
  it('effort key present in trail record when explicit effort passed', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 1,
      attemptEffort: 'low',
      judgeEffort: 'high',
      synthesisEffort: 'max',
    }))

    const attemptRecs = result.trail!.filter(r => r.stage.startsWith('tournament:attempt:'))
    const judgeRecs = result.trail!.filter(r => r.stage.startsWith('tournament:judge:'))
    const synthRec = result.trail!.find(r => r.stage === 'tournament:synthesize')

    for (const rec of attemptRecs) expect(rec.effort).toBe('low')
    for (const rec of judgeRecs) expect(rec.effort).toBe('high')
    expect(synthRec!.effort).toBe('max')
  })

  it('effort key absent in trail record when no effort override', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('tournament:attempt:')) return 'att'
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(7)
        if (label === 'tournament:synthesize') return 'done'
        return null
      },
    })

    const result = await tournament(rt, makeOptions({
      angles: ['a', 'b'],
      judgeCount: 1,
    }))

    for (const rec of result.trail!) {
      expect(rec).not.toHaveProperty('effort')
    }
  })
})

// ---------------------------------------------------------------------------
// cacheWarm (opt-in, mechanism b — warmup-agent, TWO independent warm points:
// one before the attempts stage, one before the judges stage)
//
// Chosen over mechanism (a) here because both stages share ONE uniform model
// each (attemptModel / judgeModel) and angles/judgeCount are typically small
// (judgeCount defaults to 3) — losing one real slot to serial execution would
// cost proportionally more than a single extra throwaway agent per stage.
// ---------------------------------------------------------------------------

function tournamentOnAgent({ opts }: { opts?: { label?: string } }): unknown {
  const label = opts?.label ?? ''
  if (label.startsWith('tournament:judge:')) return makeJudgeResponse(5)
  return 'ok' // covers attempts, synthesis, and both warm calls
}

describe('tournament — cacheWarm=false (default, inert)', () => {
  it('is byte-identical to omitting the option: no warm calls, same stats/trail', async () => {
    const rtOmitted = new FakeRuntime({ onAgent: tournamentOnAgent })
    const rtFalse = new FakeRuntime({ onAgent: tournamentOnAgent })

    const resultOmitted = await tournament(rtOmitted, makeOptions())
    const resultFalse = await tournament(rtFalse, makeOptions({ cacheWarm: false }))

    expect(resultFalse.stats).toEqual(resultOmitted.stats)
    expect(resultFalse.trail).toEqual(resultOmitted.trail)
    expect(rtFalse.calls).toHaveLength(rtOmitted.calls.length)
    expect(rtFalse.calls.some(c => c.opts?.label?.includes('warm'))).toBe(false)
  })
})

describe('tournament — cacheWarm=true (warmup-agent, two stages)', () => {
  it('fires attempt:warm first, then judge:warm after attempts complete but before any judge', async () => {
    const rt = new FakeRuntime({ onAgent: tournamentOnAgent })

    const result = await tournament(rt, makeOptions({ cacheWarm: true }))

    // 3 angles: 1 attempt-warm + 3 attempts + 1 judge-warm + 9 judges (3x3) + 1 synthesis = 15
    expect(rt.calls).toHaveLength(15)

    const labels = rt.calls.map(c => c.opts?.label)
    expect(labels[0]).toBe('tournament:attempt:warm')
    // The 3 real attempts follow, then the judge warm, before any real judge call.
    const judgeWarmIndex = labels.indexOf('tournament:judge:warm')
    const firstRealJudgeIndex = labels.findIndex(l => l?.startsWith('tournament:judge:') && l !== 'tournament:judge:warm')
    expect(judgeWarmIndex).toBeGreaterThan(0)
    expect(firstRealJudgeIndex).toBeGreaterThan(judgeWarmIndex)

    expect(result.stats.agentsSpawned).toBe(15)
    expect(result.trail).toHaveLength(15)
    expect(result.trail[0]!.stage).toBe('tournament:attempt:warm')
    expect(result.value).not.toBeNull()
  })

  it('threads attemptModel/attemptType to attempt:warm and judgeModel/judgeType to judge:warm', async () => {
    const rt = new FakeRuntime({ onAgent: tournamentOnAgent })

    await tournament(rt, makeOptions({
      attemptModel: 'sonnet', attemptType: 'codex:codex-rescue',
      judgeModel: 'opus', judgeType: 'workflow-toolbox:opencode-verifier',
      phase: 'tourney-phase',
      cacheWarm: true,
    }))

    const attemptWarm = rt.calls.find(c => c.opts?.label === 'tournament:attempt:warm')!
    const judgeWarm = rt.calls.find(c => c.opts?.label === 'tournament:judge:warm')!

    expect(attemptWarm.opts?.model).toBe('sonnet')
    expect(attemptWarm.opts?.agentType).toBe('codex:codex-rescue')
    expect(attemptWarm.phase).toBe('tourney-phase')

    expect(judgeWarm.opts?.model).toBe('opus')
    expect(judgeWarm.opts?.agentType).toBe('workflow-toolbox:opencode-verifier')
    expect(judgeWarm.phase).toBe('tourney-phase')
  })

  it('charges both warmup calls against the budget like every other agent', async () => {
    const rt = new FakeRuntime({ onAgent: tournamentOnAgent, budgetTotal: 10_000, agentTokenCost: 10 })

    await tournament(rt, makeOptions({ cacheWarm: true }))

    // 15 total calls (2 warm + 13 real) x 10 = 150.
    expect(rt.budget.spent()).toBe(150)
  })

  it('degrades gracefully when a warmup agent returns null: warns, both stages still proceed', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'tournament:attempt:warm' || label === 'tournament:judge:warm') return null
        if (label.startsWith('tournament:judge:')) return makeJudgeResponse(5)
        return 'ok'
      },
    })

    const result = await tournament(rt, makeOptions({ cacheWarm: true }))

    const attemptWarmRec = result.trail!.find(r => r.stage === 'tournament:attempt:warm')!
    const judgeWarmRec = result.trail!.find(r => r.stage === 'tournament:judge:warm')!
    expect(attemptWarmRec.outcome).toBe('null')
    expect(judgeWarmRec.outcome).toBe('null')

    expect(result.warnings.filter(w => w.includes('cache-warm'))).toHaveLength(2)

    // Both real stages proceeded normally to a winning synthesis.
    expect(result.value).not.toBeNull()
    expect(result.stats.itemsOut).toBe(3) // all 3 attempts ranked
  })
})
