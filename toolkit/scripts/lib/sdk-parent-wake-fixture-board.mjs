import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const fixtureBoardContract = {
  boardId: 'fixture-board', listId: 'fixture-list',
  labels: {
    category: 'fixture-label-category',
    priority: { P0: 'fixture-label-p0', P1: 'fixture-label-p1', P2: 'fixture-label-p2' },
    type: { bug: 'fixture-label-bug', chore: 'fixture-label-chore', feature: 'fixture-label-feature', research: 'fixture-label-research' },
    effort: { S: 'fixture-label-s', M: 'fixture-label-m', L: 'fixture-label-l' },
  },
}

export function createFixtureBoard(root) {
  let serial = 0
  return {
    async createRoutedCard(args) {
      const card = { id: `fixture-routed-${++serial}`, title: args.title, dependencyVerified: true }
      appendFileSync(join(root, 'routed-findings.jsonl'), `${JSON.stringify({ ...args, ...card })}\n`)
      return card
    },
    async resolveRoutedCard() {},
  }
}
