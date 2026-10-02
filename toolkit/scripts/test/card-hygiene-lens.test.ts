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
      card('1', { description: 'Depends-on: #9999 (missing)' }),
    ])

    expect(result.results[0]?.findings).toContainEqual({
      cardId: '1',
      kind: 'broken-dependency',
      message: 'Depends-on target #9999 does not exist on this board',
    })
  })

  it('accepts all existing Depends-on targets, including multiple ids on one line', () => {
    const result = checkBoardHygiene([
      card('1001', { description: 'Depends-on: #1002 (first) and #1003 (second)' }),
      card('1002'),
      card('1003'),
    ])

    expect(result).toEqual({ ok: true, results: [] })
  })

  it('advises an open dependent chasing Done but ignores a closed dependent', () => {
    const result = checkBoardHygiene([
      card('1001', { listName: 'Done' }),
      card('1002', { description: 'Depends-on: #1001' }),
      card('1003', { description: 'depends-ON: #1001', listName: 'NotDoing' }),
    ])

    expect(result.ok).toBe(true)
    expect(result.results).toEqual([
      {
        cardId: '1002',
        findings: [],
        advisories: [
          {
            cardId: '1002',
            kind: 'chain-coherence',
            message:
              'card #1002 declares Depends-on: #1001, whose target is closed (list: Done) — review whether the dependency still applies',
          },
        ],
      },
    ])
  })

  it('flags a permanent-block finding when an open card depends on a NotDoing target', () => {
    const result = checkBoardHygiene([
      card('1001', { listName: 'NotDoing' }),
      card('1002', { description: 'Depends-on: #1001' }),
    ])

    expect(result.ok).toBe(false)
    const card2 = result.results.find((entry) => entry.cardId === '1002')
    expect(card2?.advisories).toEqual([])
    expect(card2?.findings).toContainEqual({
      cardId: '1002',
      kind: 'permanent-block',
      message: expect.stringContaining('#1002'),
    })
    const finding = card2?.findings.find((entry) => entry.kind === 'permanent-block')
    expect(finding?.message).toContain('#1001')
    expect(finding?.message).toContain('Card 1001')
  })

  it('does not flag permanent-block for a NotDoing target when the dependent is itself closed', () => {
    const result = checkBoardHygiene([
      card('1001', { listName: 'NotDoing' }),
      card('1002', { description: 'Depends-on: #1001', listName: 'NotDoing' }),
      card('1003', { description: 'Depends-on: #1001', listName: 'Done' }),
    ])

    const findings = result.results.flatMap(({ findings }) => findings)
    expect(findings.filter(({ kind }) => kind === 'permanent-block')).toEqual([])
  })

  it('reports a two-card dependency cycle exactly once', () => {
    const result = checkBoardHygiene([
      card('1001', { description: 'Depends-on: #1002' }),
      card('1002', { description: 'Depends-on: #1001' }),
    ])
    const cycleFindings = result.results.flatMap(({ findings }) => {
      return findings.filter(({ kind }) => kind === 'dependency-cycle')
    })

    expect(cycleFindings).toEqual([
      {
        cardId: '1001',
        kind: 'dependency-cycle',
        message: 'dependency cycle: #1001 -> #1002 -> #1001',
      },
    ])
  })

  it('reports a longer dependency chain cycle (A -> B -> C -> A), not just a 2-card one', () => {
    const result = checkBoardHygiene([
      card('1001', { description: 'Depends-on: #1002' }),
      card('1002', { description: 'Depends-on: #1003' }),
      card('1003', { description: 'Depends-on: #1001' }),
    ])
    const cycleFindings = result.results.flatMap(({ findings }) => {
      return findings.filter(({ kind }) => kind === 'dependency-cycle')
    })

    expect(cycleFindings).toEqual([
      {
        cardId: '1001',
        kind: 'dependency-cycle',
        message: 'dependency cycle: #1001 -> #1002 -> #1003 -> #1001',
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

  it('I5: an unreadable Depends-on line on an open card is a broken-dependency finding naming the line', () => {
    const result = checkBoardHygiene([card('1001', { description: 'Depends-on: TBD' })])

    expect(result.ok).toBe(false)
    expect(result.results[0]?.findings).toEqual([
      { cardId: '1001', kind: 'broken-dependency', message: 'Depends-on line cannot be read: "Depends-on: TBD"' },
    ])
  })

  it('I5: an unreadable Depends-on line on a closed card adds no finding', () => {
    const result = checkBoardHygiene([
      card('1001', { description: 'Depends-on: TBD', listName: 'Done' }),
      card('1002', { description: 'Depends-on: none until #1001 lands', listName: 'NotDoing' }),
    ])

    expect(result).toEqual({ ok: true, results: [] })
  })

  it('I5: a #id mentioned inside parentheses is not a dependency edge', () => {
    const result = checkBoardHygiene([card('1001', { description: 'Depends-on: none (see also #9999)' })])

    expect(result).toEqual({ ok: true, results: [] })
  })

  it('returns complete silence for a fully healthy board', () => {
    const result = checkBoardHygiene([
      card('1001', { description: 'Foundation card' }),
      card('1002', { description: 'Depends-on: #1001' }),
      card('1003', { description: 'Independent work' }),
    ])

    expect(result).toEqual({ ok: true, results: [] })
  })
})
