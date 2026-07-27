// card-hygiene-lens.ts checks INTEGRITY only: label completeness, dependency
// existence, dependency cycles, and closed-target chain coherence. It NEVER
// judges dependency QUALITY or relevance; whether a dependency still makes
// semantic sense is always a human judgment call.
//
// This is a NEW standalone lens. Its mechanical invocation point (a hook versus
// an advisory skill-line) is deliberately undecided here because `.claude/hooks/`
// belongs to a concurrent workstream. This file provides only the CHECKER, ready
// to be wired by either a hook or a skill instruction in a follow-up. That open
// follow-up is intentional, not an oversight.
//
// KNOWN LIMITATIONS (found by cross-family review, 2026-07-27, disclosed rather
// than fixed — none of them silently manufacture a false-clean verdict, only
// under- or mis-attribute noise):
//   → `Depends-on: #12 (follow-up to #34)` extracts BOTH #12 and #34 as
//     dependencies — a `#<id>` appearing in explanatory prose after the marker,
//     not just as a genuine second dependency, is indistinguishable from one.
//   → a card whose MCP response omits `listName` is normalized to `''` by
//     `planka-mcp-client.ts`, which this lens then treats as "not closed" —
//     silent under-detection of chain-coherence, not a fabricated pass.
//   → `Done`/`NotDoing` are matched by exact, hardcoded name — this lens assumes
//     THIS project's board convention (see the task-tracking rule's fixed list
//     set); a board using different terminal-list names needs this constant
//     updated, not auto-detected.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EFFORT_VALUES, PRIORITY_VALUES, TYPE_VALUES } from './label-intent-lens.ts'
import { fetchBoardCards, type BoardCard } from './planka-mcp-client.ts'

export const CATEGORY_VALUES = ['process', 'tooling', 'product'] as const

export interface HygieneFinding {
  cardId: string
  kind: 'missing-label' | 'broken-dependency' | 'dependency-cycle'
  message: string
}

export interface HygieneAdvisory {
  cardId: string
  kind: 'chain-coherence' | 'cannot-judge'
  message: string
}

export interface CardHygieneResult {
  cardId: string
  findings: HygieneFinding[]
  advisories: HygieneAdvisory[]
}

export interface BoardHygieneResult {
  ok: boolean
  results: CardHygieneResult[]
}

const CLOSED_LISTS = new Set(['Done', 'NotDoing'])
const DEPENDS_ON = /depends-on\s*:([^\r\n]*)/gi
const CARD_ID = /#(\d+)\b/g

function dependencyIds(description: string | undefined): string[] {
  const ids: string[] = []
  for (const declaration of (description ?? '').matchAll(DEPENDS_ON)) {
    for (const match of (declaration[1] ?? '').matchAll(CARD_ID)) {
      const id = match[1]
      if (id !== undefined) ids.push(id)
    }
  }
  return ids
}

function canonicalCycle(cycle: string[]): string[] {
  let best = cycle
  for (let index = 1; index < cycle.length; index += 1) {
    const rotated = [...cycle.slice(index), ...cycle.slice(0, index)]
    if (rotated.join('\u0000') < best.join('\u0000')) best = rotated
  }
  return best
}

function dependencyCycles(graph: Map<string, string[]>): string[][] {
  const cycles = new Map<string, string[]>()

  for (const start of graph.keys()) {
    const path: string[] = []
    const recursionStack = new Set<string>()

    function visit(cardId: string): void {
      path.push(cardId)
      recursionStack.add(cardId)

      for (const targetId of graph.get(cardId) ?? []) {
        if (targetId === start) {
          const cycle = canonicalCycle([...path])
          cycles.set(cycle.join('\u0000'), cycle)
        } else if (!recursionStack.has(targetId)) {
          visit(targetId)
        }
      }

      recursionStack.delete(cardId)
      path.pop()
    }

    visit(start)
  }

  return [...cycles.values()]
}

function hasAny(labels: string[], values: readonly string[], prefix = ''): boolean {
  return values.some((value) => labels.includes(`${prefix}${value}`))
}

export function checkBoardHygiene(cards: BoardCard[]): BoardHygieneResult {
  const cardsById = new Map(cards.map((card) => [card.id, card]))
  const dependencies = new Map(
    cards.map((card) => [
      card.id,
      [...new Set(dependencyIds(card.description))],
    ]),
  )
  const resultById = new Map<string, CardHygieneResult>()

  function resultFor(cardId: string): CardHygieneResult {
    let result = resultById.get(cardId)
    if (result === undefined) {
      result = { cardId, findings: [], advisories: [] }
      resultById.set(cardId, result)
    }
    return result
  }

  for (const card of cards) {
    const labels = card.labels ?? []
    const description = card.description ?? ''
    const result = resultFor(card.id)

    if (labels.length === 0 && description.trim().length === 0) {
      result.advisories.push({
        cardId: card.id,
        kind: 'cannot-judge',
        message: 'cannot judge card hygiene: labels are missing and description is empty',
      })
    } else {
      const missingAxes = [
        {
          missing: !hasAny(labels, PRIORITY_VALUES),
          message: 'missing priority label (P0/P1/P2)',
        },
        {
          missing: !hasAny(labels, TYPE_VALUES),
          message: 'missing type label (feature/chore/bug/research/docs)',
        },
        {
          missing: !hasAny(labels, EFFORT_VALUES, 'effort:'),
          message: 'missing effort label (effort:S/effort:M/effort:L)',
        },
        {
          missing: !hasAny(labels, CATEGORY_VALUES),
          message: 'missing category label (process/tooling/product)',
        },
      ]

      for (const axis of missingAxes) {
        if (!axis.missing) continue
        result.findings.push({ cardId: card.id, kind: 'missing-label', message: axis.message })
      }
    }

    for (const targetId of dependencies.get(card.id) ?? []) {
      if (cardsById.has(targetId)) continue
      result.findings.push({
        cardId: card.id,
        kind: 'broken-dependency',
        message: `Depends-on target #${targetId} does not exist on this board`,
      })
    }
  }

  for (const dependent of cards) {
    if (CLOSED_LISTS.has(dependent.listName)) continue
    for (const targetId of dependencies.get(dependent.id) ?? []) {
      const target = cardsById.get(targetId)
      if (target === undefined || !CLOSED_LISTS.has(target.listName)) continue
      resultFor(dependent.id).advisories.push({
        cardId: dependent.id,
        kind: 'chain-coherence',
        message: `card #${dependent.id} declares Depends-on: #${targetId}, whose target is closed (list: ${target.listName}) — review whether the dependency still applies`,
      })
    }
  }

  const existingGraph = new Map(
    [...dependencies].map(([cardId, targets]) => [
      cardId,
      targets.filter((targetId) => cardsById.has(targetId)),
    ]),
  )
  for (const cycle of dependencyCycles(existingGraph)) {
    const displayIds = [...cycle, cycle[0]]
    const cardId = cycle[0]
    if (cardId === undefined) continue
    resultFor(cardId).findings.push({
      cardId,
      kind: 'dependency-cycle',
      message: `dependency cycle: ${displayIds.map((id) => `#${id}`).join(' -> ')}`,
    })
  }

  const results = cards
    .map((card) => resultById.get(card.id))
    .filter((result): result is CardHygieneResult => {
      return result !== undefined && (result.findings.length > 0 || result.advisories.length > 0)
    })

  return {
    ok: results.every((result) => result.findings.length === 0),
    results,
  }
}

function printResult(source: string, result: BoardHygieneResult): void {
  console.log(`card-hygiene-lens — ${source}`)
  console.log('')

  let totalFindings = 0
  let totalAdvisories = 0
  for (const cardResult of result.results) {
    console.log(`card ${cardResult.cardId}`)
    for (const finding of cardResult.findings) {
      totalFindings += 1
      console.log(`  [${finding.kind}] ${finding.message}`)
    }
    if (cardResult.advisories.length > 0) {
      console.log('  ADVISORY')
      for (const advisory of cardResult.advisories) {
        totalAdvisories += 1
        console.log(`    [${advisory.kind}] ${advisory.message}`)
      }
    }
    console.log('')
  }

  console.log(`TOTAL: ${totalFindings} finding(s), ${totalAdvisories} advisory/advisories, ${result.results.length} card(s)`)
  console.log(result.ok ? 'RESULT: PASS (exit 0)' : 'RESULT: FAIL (exit 1)')
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

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0) {
    console.error(
      'usage: tsx toolkit/scripts/card-hygiene-lens.ts --board <boardId> [--mcp-url <url>]\n' +
        '       tsx toolkit/scripts/card-hygiene-lens.ts --snapshot <file.json>',
    )
    process.exit(2)
  }

  const { cards, source } = await resolveCards(args)
  const result = checkBoardHygiene(cards)
  printResult(source, result)
  process.exit(result.ok ? 0 : 1)
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
