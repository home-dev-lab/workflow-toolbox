// This report exists because deterministic predicates such as dependency closure,
// category order, and priority should be computed by code, not re-derived by a
// model on every turn. Routing mechanical facts through a model adds uncertainty
// where there was none.
//
// HONEST COVERAGE: this script computes only the mechanical CANDIDATE SET. The
// actual CHOICE among pickable cards remains a human/orchestrator judgment call
// and is never made here.
//
// KNOWN LIMITATIONS (found by cross-family review, 2026-07-27, disclosed rather
// than fixed — same shape as card-hygiene-lens.ts, which shares this parsing):
//   → `Depends-on: #12 (see also #34)` extracts BOTH ids as dependencies; a
//     `#<id>` in explanatory prose is indistinguishable from a real dependency.
//   → `Backlog`/`Next`/`Done` are matched by exact, hardcoded name — this script
//     assumes THIS project's board convention; a board with different list
//     names needs `CANDIDATE_LISTS`/the `'Done'` check updated, not auto-detected.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CATEGORY_VALUES } from './card-hygiene-lens.ts'
import { PRIORITY_VALUES } from './label-intent-lens.ts'
import { fetchBoardCards, type BoardCard } from './planka-mcp-client.ts'

type Category = (typeof CATEGORY_VALUES)[number]

export interface PickableCard {
  cardId: string
  name: string
  category: Category
  priority: string
  hardDeadline?: string
  reason: string
}

export interface ExcludedCard {
  cardId: string
  name: string
  reason: string
}

export interface UnjudgeableCard {
  cardId: string
  name: string
  reason: string
}

export interface PickableResult {
  pickable: PickableCard[]
  excluded: ExcludedCard[]
  unjudgeable: UnjudgeableCard[]
}

const CANDIDATE_LISTS = new Set(['Backlog', 'Next'])
const DEPENDS_ON = /depends-on\s*:([^\r\n]*)/gi
const CARD_ID = /#(\d+)\b/g
const HARD_DEADLINE = /^hard-deadline\s*:\s*([^\r\n]*)/im

function dependencyIds(description: string): string[] {
  const ids: string[] = []
  for (const declaration of description.matchAll(DEPENDS_ON)) {
    for (const match of (declaration[1] ?? '').matchAll(CARD_ID)) {
      const id = match[1]
      if (id !== undefined) ids.push(id)
    }
  }
  return [...new Set(ids)]
}

function listExclusionReason(listName: string): string {
  if (listName === 'In Progress') return 'already claimed'
  if (listName === 'Blocked') return 'blocked list'
  if (listName === 'Done') return 'done'
  if (listName === 'NotDoing') return 'not doing'
  return `not in Backlog or Next (currently: ${listName})`
}

export function computePickable(cards: BoardCard[]): PickableResult {
  const cardsById = new Map(cards.map((card) => [card.id, card]))
  const result: PickableResult = { pickable: [], excluded: [], unjudgeable: [] }

  for (const card of cards) {
    if (!CANDIDATE_LISTS.has(card.listName)) {
      result.excluded.push({
        cardId: card.id,
        name: card.name,
        reason: listExclusionReason(card.listName),
      })
      continue
    }

    const dependencies = dependencyIds(card.description)
    const dependencyFailures: string[] = []
    for (const dependencyId of dependencies) {
      const dependency = cardsById.get(dependencyId)
      if (dependency === undefined) {
        dependencyFailures.push(`depends on #${dependencyId}, which does not exist on this board`)
      } else if (dependency.listName !== 'Done') {
        dependencyFailures.push(
          `depends on #${dependencyId} (${dependency.name}), not yet Done (currently: ${dependency.listName})`,
        )
      }
    }

    if (dependencyFailures.length > 0) {
      result.excluded.push({
        cardId: card.id,
        name: card.name,
        reason: dependencyFailures.join('; '),
      })
      continue
    }

    const categories = CATEGORY_VALUES.filter((category) => card.labels.includes(category))
    const priorities = PRIORITY_VALUES.filter((priority) => card.labels.includes(priority))
    const labelProblems: string[] = []
    if (categories.length === 0) labelProblems.push('no category label')
    if (categories.length > 1) labelProblems.push(`multiple category labels: ${categories.join(', ')}`)
    if (priorities.length === 0) labelProblems.push('no priority label')
    if (priorities.length > 1) labelProblems.push(`multiple priority labels: ${priorities.join(', ')}`)

    if (labelProblems.length > 0) {
      result.unjudgeable.push({
        cardId: card.id,
        name: card.name,
        reason: labelProblems.join('; '),
      })
      continue
    }

    const category = categories[0]
    const priority = priorities[0]
    if (category === undefined || priority === undefined) continue
    const hardDeadline = HARD_DEADLINE.exec(card.description)?.[1]?.trim()
    result.pickable.push({
      cardId: card.id,
      name: card.name,
      category,
      priority,
      ...(hardDeadline === undefined ? {} : { hardDeadline }),
      reason: dependencies.length === 0 ? 'no dependencies' : `all ${dependencies.length} dependencies Done`,
    })
  }

  result.pickable.sort((left, right) => {
    const deadlineRank = Number(right.hardDeadline !== undefined) - Number(left.hardDeadline !== undefined)
    if (deadlineRank !== 0) return deadlineRank

    const categoryRank = (category: Category): number => (category === 'product' ? 1 : 0)
    const categoryDifference = categoryRank(left.category) - categoryRank(right.category)
    if (categoryDifference !== 0) return categoryDifference

    return PRIORITY_VALUES.indexOf(left.priority as (typeof PRIORITY_VALUES)[number]) -
      PRIORITY_VALUES.indexOf(right.priority as (typeof PRIORITY_VALUES)[number])
  })

  return result
}

interface ResolvedCards {
  cards: BoardCard[]
  source: string
}

export async function resolveCards(args: string[]): Promise<ResolvedCards> {
  const mode = args[0]
  if (mode === '--snapshot') {
    const path = args[1]
    if (!path) throw new Error('--snapshot requires a file path')
    if (args.length > 2) throw new Error(`unknown argument in --snapshot mode: ${args[2]}`)
    return { cards: JSON.parse(readFileSync(path, 'utf8')) as BoardCard[], source: path }
  }

  if (mode !== '--board') throw new Error(`unknown mode: ${mode ?? ''}`)
  const boardId = args[1]
  if (!boardId) throw new Error('--board requires a boardId')

  let mcpUrl: string | undefined
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]
    if (arg !== '--mcp-url') throw new Error(`unknown argument in --board mode: ${arg}`)
    mcpUrl = args[index + 1]
    if (!mcpUrl) throw new Error('--mcp-url requires a URL')
    index += 1
  }

  return {
    cards: await fetchBoardCards({ boardId, mcpUrl }),
    source: `board ${boardId}`,
  }
}

function printResult(source: string, result: PickableResult): void {
  console.log(`pickable-cards — ${source}`)
  console.log('')
  console.log('PICKABLE')
  for (const card of result.pickable) {
    const deadline = card.hardDeadline === undefined ? '' : `; hard deadline: ${card.hardDeadline}`
    console.log(`  #${card.cardId} ${card.name} [${card.category}, ${card.priority}${deadline}] — ${card.reason}`)
  }
  console.log('EXCLUDED')
  for (const card of result.excluded) console.log(`  #${card.cardId} ${card.name} — ${card.reason}`)
  console.log('UNJUDGEABLE')
  for (const card of result.unjudgeable) console.log(`  #${card.cardId} ${card.name} — ${card.reason}`)
  console.log(
    `TOTAL: ${result.pickable.length} pickable, ${result.excluded.length} excluded, ${result.unjudgeable.length} unjudgeable`,
  )
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0) {
    console.error(
      'usage: tsx toolkit/scripts/pickable-cards.ts --board <boardId> [--mcp-url <url>]\n' +
        '       tsx toolkit/scripts/pickable-cards.ts --snapshot <file.json>',
    )
    process.exit(2)
  }

  const { cards, source } = await resolveCards(args)
  printResult(source, computePickable(cards))
}

export function handleCliError(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const isMain = (() => {
  try {
    const argvPath = process.argv[1]
    if (!argvPath) return false
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath)
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch(handleCliError)
}
