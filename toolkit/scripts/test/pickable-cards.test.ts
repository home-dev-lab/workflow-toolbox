import { describe, expect, it } from 'vitest'
import { computePickable } from '../pickable-cards.ts'
import type { BoardCard } from '../planka-mcp-client.ts'

const PICKABLE_LABELS = ['P1', 'feature', 'effort:M', 'product']

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    name: `Card ${id}`,
    description: 'Card description\nDepends-on: none',
    labels: PICKABLE_LABELS,
    listName: 'Backlog',
    ...overrides,
  }
}

describe('pickable-cards', () => {
  it('makes a Backlog card declaring Depends-on: none pickable', () => {
    const result = computePickable([card('1000')])

    expect(result.pickable).toEqual([
      {
        cardId: '1000',
        name: 'Card 1000',
        category: 'product',
        priority: 'P1',
        reason: 'Depends-on: none',
      },
    ])
    expect(result.excluded).toEqual([])
    expect(result.unjudgeable).toEqual([])
  })

  it('I4: a card with no Depends-on line is unjudgeable (not checked), never pickable', () => {
    const result = computePickable([card('1000', { description: 'Card description' })])

    expect(result).toEqual({
      pickable: [],
      excluded: [],
      unjudgeable: [
        { cardId: '1000', name: 'Card 1000', reason: 'no Depends-on line: not checked (add one; "Depends-on: none" qualifies)' },
      ],
    })
  })

  it('I4: an unparseable Depends-on line excludes the card and quotes the line', () => {
    const result = computePickable([card('1000', { description: 'Depends-on: TBD' })])

    expect(result.excluded).toEqual([
      { cardId: '1000', name: 'Card 1000', reason: 'unparseable Depends-on line: "Depends-on: TBD"' },
    ])
    expect(result.pickable).toEqual([])
  })

  it('I4: only the shipped parser decides the ids — a parenthesised mention is not a dependency, a bare id is', () => {
    const result = computePickable([
      card('1000', { listName: 'Done' }),
      card('3400', { listName: 'In Progress' }),
      card('2000', { description: 'Depends-on: #1000 (see also #3400)' }),
      card('2100', { description: 'Depends-on: 3400' }),
    ])

    expect(result.pickable.map(({ cardId }) => cardId)).toEqual(['2000'])
    expect(result.excluded).toContainEqual({
      cardId: '2100',
      name: 'Card 2100',
      reason: 'depends on #3400 (Card 3400), not yet Done (currently: In Progress)',
    })
  })

  it('makes a Next card pickable when all dependencies are Done', () => {
    const result = computePickable([
      card('1000', { listName: 'Done' }),
      card('2000', { listName: 'Next', description: 'Depends-on: #1000' }),
    ])

    expect(result.pickable[0]).toMatchObject({ cardId: '2000', reason: 'all 1 dependencies Done' })
  })

  it('excludes a card whose dependency is not Done and names the blocker', () => {
    const result = computePickable([
      card('1000', { name: 'Blocking card', listName: 'In Progress' }),
      card('2000', { description: 'Depends-on: #1000' }),
    ])

    expect(result.excluded).toContainEqual({
      cardId: '2000',
      name: 'Card 2000',
      reason: 'depends on #1000 (Blocking card), not yet Done (currently: In Progress)',
    })
  })

  it('excludes a card whose dependency does not exist', () => {
    const result = computePickable([card('1000', { description: 'Depends-on: #9999' })])

    expect(result.excluded).toEqual([
      {
        cardId: '1000',
        name: 'Card 1000',
        reason: 'depends on #9999, which does not exist on this board',
      },
    ])
  })

  it('reports a missing category as unjudgeable', () => {
    const result = computePickable([card('1', { labels: ['P1', 'feature', 'effort:M'] })])

    expect(result).toEqual({
      pickable: [],
      excluded: [],
      unjudgeable: [{ cardId: '1', name: 'Card 1', reason: 'no category label' }],
    })
  })

  it('reports a missing priority as unjudgeable', () => {
    const result = computePickable([card('1', { labels: ['feature', 'effort:M', 'product'] })])

    expect(result.unjudgeable).toEqual([
      { cardId: '1', name: 'Card 1', reason: 'no priority label' },
    ])
  })

  it('orders process before product even when product has higher priority', () => {
    const result = computePickable([
      card('1', { labels: ['P0', 'product'] }),
      card('2', { labels: ['P1', 'process'] }),
    ])

    expect(result.pickable.map(({ cardId }) => cardId)).toEqual(['2', '1'])
  })

  it('hoists a hard-deadline card regardless of category and priority', () => {
    const result = computePickable([
      card('1', { labels: ['P0', 'process'] }),
      card('2', {
        description: 'Hard-DEADLINE: before launch\nDepends-on: none',
        labels: ['P2', 'product'],
      }),
    ])

    expect(result.pickable.map(({ cardId }) => cardId)).toEqual(['2', '1'])
    expect(result.pickable[0]?.hardDeadline).toBe('before launch')
  })

  it.each(['In Progress', 'Blocked', 'Done'])('never makes a card in %s pickable', (listName) => {
    const result = computePickable([card('1', { listName })])

    expect(result.pickable).toEqual([])
    expect(result.excluded).toHaveLength(1)
  })
})
