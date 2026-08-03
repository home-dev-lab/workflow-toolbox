import { describe, expect, it } from 'vitest'
import { checkBoardHygiene } from '../card-hygiene-lens.ts'
import type { BoardCard } from '../planka-mcp-client.ts'

const COMPLETE_LABELS = ['P1', 'feature', 'effort:M', 'product']

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    name: `Card ${id}`,
    description: 'Card description',
    labels: COMPLETE_LABELS,
    listName: 'Next',
    ...overrides,
  }
}

describe('card-hygiene-lens', () => {
  it('reports the missing label axis with the closed-vocabulary message', () => {
    const result = checkBoardHygiene([
      card('1', { labels: ['P1', 'feature', 'product'] }),
    ])

    expect(result.ok).toBe(false)
    expect(result.results[0]?.findings).toEqual([
      {
        cardId: '1',
        kind: 'missing-label',
        message: 'missing effort label (effort:S/effort:M/effort:L)',
      },
    ])
  })

  it('reports a Depends-on target that does not exist on the board', () => {
    const result = checkBoardHygiene([
      card('1', { description: 'Depends-on: #999 (missing)' }),
    ])

    expect(result.results[0]?.findings).toContainEqual({
      cardId: '1',
      kind: 'broken-dependency',
      message: 'Depends-on target #999 does not exist on this board',
    })
  })

  it('accepts all existing Depends-on targets, including multiple ids on one line', () => {
    const result = checkBoardHygiene([
      card('1', { description: 'Depends-on: #2 (first) and #3 (second)' }),
      card('2'),
      card('3'),
    ])

    expect(result).toEqual({ ok: true, results: [] })
  })

  it('advises an open dependent chasing Done but ignores a closed dependent', () => {
    const result = checkBoardHygiene([
      card('1', { listName: 'Done' }),
      card('2', { description: 'Depends-on: #1' }),
      card('3', { description: 'depends-ON: #1', listName: 'NotDoing' }),
    ])

    expect(result.ok).toBe(true)
    expect(result.results).toEqual([
      {
        cardId: '2',
        findings: [],
        advisories: [
          {
            cardId: '2',
            kind: 'chain-coherence',
            message:
              'card #2 declares Depends-on: #1, whose target is closed (list: Done) — review whether the dependency still applies',
          },
        ],
      },
    ])
  })

  it('flags a permanent-block finding when an open card depends on a NotDoing target', () => {
    const result = checkBoardHygiene([
      card('1', { listName: 'NotDoing' }),
      card('2', { description: 'Depends-on: #1' }),
    ])

    expect(result.ok).toBe(false)
    const card2 = result.results.find((entry) => entry.cardId === '2')
    expect(card2?.advisories).toEqual([])
    expect(card2?.findings).toContainEqual({
      cardId: '2',
      kind: 'permanent-block',
      message: expect.stringContaining('#2'),
    })
    const finding = card2?.findings.find((entry) => entry.kind === 'permanent-block')
    expect(finding?.message).toContain('#1')
    expect(finding?.message).toContain('Card 1')
  })

  it('does not flag permanent-block for a NotDoing target when the dependent is itself closed', () => {
    const result = checkBoardHygiene([
      card('1', { listName: 'NotDoing' }),
      card('2', { description: 'Depends-on: #1', listName: 'NotDoing' }),
      card('3', { description: 'Depends-on: #1', listName: 'Done' }),
    ])

    const findings = result.results.flatMap(({ findings }) => findings)
    expect(findings.filter(({ kind }) => kind === 'permanent-block')).toEqual([])
  })

  it('reports a two-card dependency cycle exactly once', () => {
    const result = checkBoardHygiene([
      card('1', { description: 'Depends-on: #2' }),
      card('2', { description: 'Depends-on: #1' }),
    ])
    const cycleFindings = result.results.flatMap(({ findings }) => {
      return findings.filter(({ kind }) => kind === 'dependency-cycle')
    })

    expect(cycleFindings).toEqual([
      {
        cardId: '1',
        kind: 'dependency-cycle',
        message: 'dependency cycle: #1 -> #2 -> #1',
      },
    ])
  })

  it('reports a longer dependency chain cycle (A -> B -> C -> A), not just a 2-card one', () => {
    const result = checkBoardHygiene([
      card('1', { description: 'Depends-on: #2' }),
      card('2', { description: 'Depends-on: #3' }),
      card('3', { description: 'Depends-on: #1' }),
    ])
    const cycleFindings = result.results.flatMap(({ findings }) => {
      return findings.filter(({ kind }) => kind === 'dependency-cycle')
    })

    expect(cycleFindings).toEqual([
      {
        cardId: '1',
        kind: 'dependency-cycle',
        message: 'dependency cycle: #1 -> #2 -> #3 -> #1',
      },
    ])
  })

  it('reports a card with no labels and no description as cannot judge', () => {
    const result = checkBoardHygiene([
      card('1', { labels: [], description: '' }),
    ])

    expect(result).toEqual({
      ok: true,
      results: [
        {
          cardId: '1',
          findings: [],
          advisories: [
            {
              cardId: '1',
              kind: 'cannot-judge',
              message: 'cannot judge card hygiene: labels are missing and description is empty',
            },
          ],
        },
      ],
    })
  })

  it('returns complete silence for a fully healthy board', () => {
    const result = checkBoardHygiene([
      card('1', { description: 'Foundation card' }),
      card('2', { description: 'Depends-on: #1' }),
      card('3', { description: 'Independent work' }),
    ])

    expect(result).toEqual({ ok: true, results: [] })
  })
})
