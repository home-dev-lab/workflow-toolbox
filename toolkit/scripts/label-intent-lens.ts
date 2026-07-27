// label-intent-lens.ts — a REVIEW LENS on board-card descriptions, for card
// #1827222345866020230: detect the mechanical gap between a label trio already
// written in prose and the labels actually applied on the card.
//
// WHY A LENS AND NOT A RULE (the card's own framing, kept here because the code
// IS the argument): this is not a judgment call about what a card SHOULD be
// labelled. The hole found on the live board was narrower: the author had
// already written the trio in plain text, but the labels were never transcribed
// mechanically into Planka. A lens is the right shape because it reads the
// artifact actually reviewed by humans (`/what-next`'s board snapshot), compares
// the written intent against the applied state, and fails loudly by exit code.
// Kept as a small standalone module (not a `.workflow.ts` composition) — this is
// a synchronous, deterministic text check with no agent fan-out and no tracker
// writes.
//
// HONEST COVERAGE (read this before trusting a clean run — the card explicitly
// asks for the scope and the limits to be stated, not implied):
//
//   Mechanical core
//     → MECHANICAL, CLOSED-VOCABULARY: this lens only compares the live card
//       state against the exact label catalog verified on board
//       `1798252060714468365` on 2026-07-26 (PRIORITY_VALUES / TYPE_VALUES /
//       EFFORT_VALUES below). It does not infer new values, synonyms, or board-
//       local aliases.
//     → MECHANICAL, CO-OCCURRENCE-BASED: after removing any `sr-meta` block, it
//       scans only the final two paragraphs of the description and looks for the
//       trio's co-occurrence there. The match is independent of a `Labels:`
//       prefix: both `Labels: P2 chore effort:M` and the naked form
//       `P2 chore, effort:M` count.
//     → SECOND, NARROWER GUARD against the same self-reference risk: even within
//       the scanned window, a match immediately preceded by an unclosed
//       "exemple :" / "illustration :" quote-opening (`QUOTED_EXAMPLE_PREFIX`) is
//       skipped. This exists because the two-paragraph window alone is only a
//       reliable guard on LONGER descriptions — on a short (≤3-paragraph)
//       description, a mid-document quoted example can still land inside the
//       scanned window. Found and locked by fixture 20, itself a regression test
//       for a REAL self-reference this lens's own governing card
//       (#1827222345866020230) commits in its own text — see that fixture for the
//       exact repro. Narrow and anchored (requires the literal cue word plus an
//       unclosed quote immediately before the match): the false-negative surface
//       is a description that genuinely writes "exemple : «" right before its own
//       real, unquoted suggestion, which is not expected to occur in practice.
//
//   Ambiguity handling
//     → EFFORT RANGES are ADVISORY ONLY: `effort:M-L` / `effort:M/L` means the
//       text names multiple effort values; the lens reports the ambiguity and
//       never guesses which concrete label to apply.
//     → MULTIPLE / ALTERNATIVE TYPES are ADVISORY ONLY: if the matched span
//       contains two or more distinct type words from the closed vocabulary, the
//       lens reports `type` as ambiguous and never promotes one candidate into a
//       blocking finding.
//
//   Deliberate exclusions
//     → A priority outside `P0`/`P1`/`P2` is NOT matched at all. Example: an
//       informal `P3` seen in real board prose produces no result, on purpose —
//       there is no such real label on this board, so there is nothing valid to
//       compare against.
//
//   Known limitations
//     → The lens does NOT distinguish a firm decision from a suggestion phrased
//       as "à confirmer par X". Both are treated the same: written text vs
//       applied labels. If the labels already match, it stays silent; if they do
//       not, it still raises the mechanical gap. Accepted tradeoff: rejecting a
//       correct-but-pending finding is cheaper than silently missing a real
//       transcription hole.
//     → A card that talks ABOUT another card's suggested trio (e.g. "carte #123 est P2 chore
//       effort:M, ne pas y toucher") in its own last-two-paragraph window is not
//       distinguished from a self-suggestion — it would still surface as a finding on the
//       CURRENT card. Not observed in the real board sample scanned (~90 trio occurrences
//       across the full board on 2026-07-26, all self-referential closing statements); not
//       mechanically excluded. Disclosed, not fixed — the fix would need card-reference-aware
//       parsing disproportionate to this lens's scope.
//     → Malformed CLI input (invalid JSON, a non-array top-level value, a card missing a
//       required field) fails LOUDLY by a non-zero exit code and a raw stack trace — it does
//       NOT fail with a clean, dedicated usage message. The gate property this lens exists
//       for (fail visibly, never silently) still holds; the message quality is a rough edge,
//       not a correctness gap.
//     → The lens reads only the CURRENT text. A trio written once and explicitly
//       retracted later without removing the original line would still be
//       detected. Not observed in the real sample that motivated this card, but
//       structurally possible.
//
//   Scope boundary
//     → The recommended `--board` mode fetches the board through the Planka MCP
//       client and resolves its own input, so the caller has no snapshot to build.
//       A lens that requires the caller to build its own input before invoking it
//       is an invitation, not a wiring — this is why --board exists.
//     → The snapshot-file mode remains available for fixtures and testing. Its
//       input must contain resolved LABEL NAMES, not raw IDs from `get_card`.
//
// Recommended CLI usage:
// `tsx toolkit/scripts/label-intent-lens.ts --board <boardId> [--mcp-url <url>]`
// Fixture/testing usage: `tsx toolkit/scripts/label-intent-lens.ts <snapshot.json>`
// Both forms exit 0 when there are no blocking findings, 1 otherwise.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchBoardCards } from './planka-mcp-client.ts'

export interface CardSnapshot {
  id: string
  description: string
  labels: string[] // noms de labels RÉELLEMENT appliqués (résolus, pas des IDs)
}

export type IntentField = 'priority' | 'type' | 'effort'

export interface Finding {
  cardId: string
  field: IntentField
  suggested: string
  message: string
  excerpt: string
}

export interface Advisory {
  cardId: string
  field: IntentField
  message: string
  excerpt: string
}

export interface CardCheckResult {
  cardId: string
  findings: Finding[]
  advisories: Advisory[]
}

export interface BoardCheckResult {
  ok: boolean
  results: CardCheckResult[]
}

// Source of truth: live label catalog of Planka board `1798252060714468365`,
// verified via `get_board` on 2026-07-26. Do not change without re-verifying
// that board's real labels.
export const PRIORITY_VALUES = ['P0', 'P1', 'P2'] as const
export const TYPE_VALUES = ['feature', 'chore', 'bug', 'research', 'docs'] as const
export const EFFORT_VALUES = ['S', 'M', 'L'] as const

const SR_META_BLOCK = /<!--\s*sr-meta\s+v1\s*-->[\s\S]*?<!--\s*\/sr-meta\s*-->/gi
const PARAGRAPH_SPLIT = /\r?\n\s*\r?\n/
const TRIO_REGEX =
  /\bP([0-2])\b([^\n]{0,50}?)\b(feature|chore|bug|research|docs)\b([^\n]{0,50}?)\beffort\s*:\s*([SML])(\s*[/-]\s*[SML])?/dgi
const TYPE_REGEX = /\b(feature|chore|bug|research|docs)\b/gi
const QUOTED_EXAMPLE_PREFIX = /(?:exemple|illustration)\s*:\s*[«"“][^»"”]*$/i

function paragraphsOf(text: string): string[] {
  return text
    .split(PARAGRAPH_SPLIT)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
}

function excerptOf(text: string, max = 140): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

function advisoryMessage(field: IntentField, suggested?: string): string {
  if (field === 'type') {
    return 'type ambigu suggéré dans le texte (plusieurs valeurs ou une alternative) — jugement requis, non bloquant'
  }
  return `effort ambigu suggéré dans le texte (fourchette ${suggested}) — jugement requis, non bloquant`
}

function conflictMessage(field: IntentField, values: string[]): string {
  const fieldName = field === 'priority' ? 'priorité' : field
  return `valeurs contradictoires suggérées dans le texte pour ${fieldName} (${values.join(' vs ')}) — jugement requis, non bloquant`
}

function findingMessage(field: IntentField, suggested: string): string {
  if (field === 'priority') {
    return `priorité suggérée dans le texte (${suggested}) non postée comme label`
  }
  if (field === 'type') {
    return `type suggéré dans le texte (${suggested}) non posté comme label`
  }
  return `effort suggéré dans le texte (${suggested}) non posté comme label`
}

function firstDistinctTypeIn(span: string): string[] {
  const values = new Set<string>()
  for (const match of span.matchAll(TYPE_REGEX)) {
    values.add(match[1].toLowerCase())
  }
  return [...values]
}

function pushFinding(result: CardCheckResult, seen: Set<IntentField>, finding: Finding): void {
  if (seen.has(finding.field)) return
  seen.add(finding.field)
  result.findings.push(finding)
}

function pushAdvisory(result: CardCheckResult, seen: Set<IntentField>, advisory: Advisory): void {
  if (seen.has(advisory.field)) return
  seen.add(advisory.field)
  result.advisories.push(advisory)
}

export function checkLabelIntent(card: CardSnapshot): CardCheckResult {
  const cleaned = card.description.replace(SR_META_BLOCK, '')
  const paragraphs = paragraphsOf(cleaned)
  const scanText = paragraphs.slice(-2).join(' ').replace(/\*\*/g, '')
  const result: CardCheckResult = { cardId: card.id, findings: [], advisories: [] }
  const seenFields = new Set<IntentField>()
  const firmCandidates: Record<IntentField, string[]> = {
    priority: [],
    type: [],
    effort: [],
  }
  const excerpts: Partial<Record<IntentField, string>> = {}
  const ambiguous: Partial<Record<IntentField, Advisory>> = {}

  function pushCandidate(field: IntentField, suggested: string, excerpt: string): void {
    if (!firmCandidates[field].includes(suggested)) {
      firmCandidates[field].push(suggested)
    }
    excerpts[field] ??= excerpt
  }

  function noteAmbiguity(field: IntentField, message: string, excerpt: string): void {
    ambiguous[field] ??= {
      cardId: card.id,
      field,
      message,
      excerpt,
    }
  }

  for (const match of scanText.matchAll(TRIO_REGEX)) {
    const fullMatch = match[0]
    const priorityDigit = match[1]
    const effortFirst = match[5]?.toUpperCase()
    if (!priorityDigit || !effortFirst || match.indices === undefined) continue

    const priorityEnd = match.indices[1]?.[1]
    const effortStart = match.indices[5]?.[0]
    if (priorityEnd === undefined || effortStart === undefined) continue

    const prefix = scanText.slice(0, match.index)
    if (QUOTED_EXAMPLE_PREFIX.test(prefix)) continue

    const excerpt = excerptOf(fullMatch)
    const priorityToken = `P${priorityDigit}`
    const typeSpan = scanText.slice(priorityEnd, effortStart)
    const distinctTypes = firstDistinctTypeIn(typeSpan)
    const effortSuffix = match[6]

    pushCandidate('priority', priorityToken, excerpt)

    if (distinctTypes.length >= 2) {
      noteAmbiguity('type', advisoryMessage('type'), excerpt)
    } else if (distinctTypes.length === 1) {
      pushCandidate('type', distinctTypes[0], excerpt)
    }

    if (effortSuffix !== undefined) {
      const suggestedRange = `effort:${effortFirst}${effortSuffix.replace(/\s+/g, '')}`
      noteAmbiguity('effort', advisoryMessage('effort', suggestedRange), excerpt)
    } else {
      const suggestedEffort = `effort:${effortFirst}`
      pushCandidate('effort', suggestedEffort, excerpt)
    }
  }

  for (const field of ['priority', 'type', 'effort'] as const) {
    const advisory = ambiguous[field]
    if (advisory !== undefined) {
      pushAdvisory(result, seenFields, advisory)
      continue
    }

    const suggestions = firmCandidates[field]
    if (suggestions.length >= 2) {
      pushAdvisory(result, seenFields, {
        cardId: card.id,
        field,
        message: conflictMessage(field, suggestions),
        excerpt: excerpts[field] ?? excerptOf(scanText),
      })
      continue
    }

    const suggested = suggestions[0]
    if (suggested !== undefined && !card.labels.includes(suggested)) {
        pushFinding(result, seenFields, {
          cardId: card.id,
          field,
          suggested,
          message: findingMessage(field, suggested),
          excerpt: excerpts[field] ?? excerptOf(scanText),
        })
    }
  }

  return result
}

export function checkBoard(cards: CardSnapshot[]): BoardCheckResult {
  const results = cards
    .map((card) => checkLabelIntent(card))
    .filter((result) => result.findings.length > 0 || result.advisories.length > 0)

  return {
    ok: results.every((result) => result.findings.length === 0),
    results,
  }
}

function printResult(path: string, result: BoardCheckResult): void {
  console.log(`label-intent-lens — ${path}`)
  console.log('')

  let totalFindings = 0
  let totalAdvisories = 0
  for (const cardResult of result.results) {
    console.log(`card ${cardResult.cardId}`)
    for (const finding of cardResult.findings) {
      totalFindings += 1
      console.log(`  [${finding.field}] ${finding.message}`)
      console.log(`    > ${finding.excerpt}`)
    }
    if (cardResult.advisories.length > 0) {
      console.log('  ADVISORY')
      for (const advisory of cardResult.advisories) {
        totalAdvisories += 1
        console.log(`    [${advisory.field}] ${advisory.message}`)
        console.log(`      > ${advisory.excerpt}`)
      }
    }
    console.log('')
  }

  console.log(`TOTAL: ${totalFindings} finding(s), ${totalAdvisories} advisory/advisories, ${result.results.length} card(s)`)
  console.log(result.ok ? 'RESULT: PASS (exit 0)' : 'RESULT: FAIL (exit 1)')
}

interface ResolvedCards {
  cards: CardSnapshot[]
  source: string
}

export async function resolveCards(args: string[]): Promise<ResolvedCards> {
  const firstArg = args[0]
  if (firstArg !== '--board') {
    const raw = readFileSync(firstArg, 'utf8')
    return { cards: JSON.parse(raw) as CardSnapshot[], source: firstArg }
  }

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

  const boardCards = await fetchBoardCards({ boardId, mcpUrl })
  return {
    cards: boardCards.map(({ id, description, labels }) => ({ id, description, labels })),
    source: `board ${boardId}`,
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0) {
    console.error(
      'usage: tsx toolkit/scripts/label-intent-lens.ts --board <boardId> [--mcp-url <url>]\n' +
        '       tsx toolkit/scripts/label-intent-lens.ts <snapshot.json>',
    )
    process.exit(2)
  }

  const { cards, source } = await resolveCards(args)
  const result = checkBoard(cards)
  printResult(source, result)
  process.exit(result.ok ? 0 : 1)
}

export function handleCliError(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err))
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
