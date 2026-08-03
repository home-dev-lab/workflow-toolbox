// stale-card-sweep.ts — the MECHANICAL layer of the closure-time staleness sweep:
// given the files a closing card's diff touched, shortlist which OTHER open
// cards even mention one of those paths. This is candidate generation only,
// never a verdict — deciding whether a shortlisted card is actually SUBSUMED
// by the diff (its described defect genuinely fixed, not merely adjacent) is
// a judgment call that needs the diff's content and the card's description
// read side by side. See the `stale-card-sweep` skill for the judgment step
// and for why "below ~200 open cards, read every open card directly" is the
// primary mode — this script's shortlist is a degradation accepted for volume
// at or above that threshold, never an improvement on reading everything.
//
// WHY THE DIFF, NOT KEYWORDS (the founding card's own argument, kept here
// because the code is the mechanism that enforces it): the same defect gets
// written "déjà implémentée", "subsumée", "redondante", "double travail",
// "obsolescence" — a keyword grep on one misses the other four and returns
// zero, which reads as "does not exist" and creates the duplicate. A changed
// file path is mechanical and independent of wording or language: a card that
// names `TokenUsage.svelte` and a diff that touches `TokenUsage.svelte` meet
// regardless of which of those five words surrounds the mention.
//
// KNOWN LIMITATIONS (disclosed, not fixed — none of these fabricate a false
// "nothing stale" verdict; they only under- or over-shortlist candidates that
// the judgment step still has to sort out):
//   → substring matching over-includes: a card mentioning a changed file only
//     in passing (e.g. as a file it explicitly does NOT touch) still matches.
//     This is deliberate — the mechanical layer optimizes for recall, and the
//     judgment layer is what applies the negative sense (a merely NEIGHBOURING
//     card must not be flagged).
//   → a changed file whose BASENAME is short/generic (e.g. `index.ts`,
//     `types.ts`) is excluded from basename-only matching (see
//     MIN_BASENAME_MATCH_LENGTH) to avoid drowning the shortlist in
//     coincidental hits; the full relative path still matches unconditionally.
//   → only `card.description` and `card.name` are scanned — a defect described
//     solely in a card COMMENT is invisible to this layer (comments are not
//     part of the `BoardCard` snapshot `planka-mcp-client.ts` exposes).

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchBoardCards, type BoardCard } from './planka-mcp-client.ts'

// Measured 2026-07-27 (founding card comment): 77 open cards excluding
// `Blocked`, 90 including it (the definition this tooling actually uses:
// Backlog + Next + In Progress + Blocked). Read at 90/2min ≈ trivially cheap.
// The threshold stays a round order-of-magnitude above the measured point,
// not tuned to today's exact count.
export const DIFF_FILTER_THRESHOLD = 200

const CLOSED_LISTS = new Set(['Done', 'NotDoing'])
const MIN_BASENAME_MATCH_LENGTH = 8

export interface StaleCandidate {
  cardId: string
  cardName: string
  matchedPaths: string[]
}

export interface StaleSweepResult {
  candidates: StaleCandidate[]
  filtered: boolean
  openCardCount: number
}

/** Below the threshold, filtering is a needless degradation — read every open
 * card directly instead of trusting a shortlist. See DIFF_FILTER_THRESHOLD. */
export function shouldFilterByDiff(openCardCount: number): boolean {
  return openCardCount >= DIFF_FILTER_THRESHOLD
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

function matchedPathsFor(text: string, changedFiles: string[]): string[] {
  const matches: string[] = []
  for (const file of changedFiles) {
    if (file.length > 0 && text.includes(file)) {
      matches.push(file)
      continue
    }
    const base = basename(file)
    if (base.length >= MIN_BASENAME_MATCH_LENGTH && text.includes(base)) {
      matches.push(file)
    }
  }
  return matches
}

/** Mechanical candidate generation: an OPEN card whose name or description
 * mentions one of `changedFiles` (full path, or a sufficiently distinctive
 * basename) is a candidate. This never judges whether the card is actually
 * subsumed — that reading is left to the caller (a human, or an agent
 * applying the `stale-card-sweep` skill's judgment step). */
export function findStaleCandidates(
  cards: BoardCard[],
  changedFiles: string[],
  excludeCardId?: string,
): StaleCandidate[] {
  const candidates: StaleCandidate[] = []
  for (const card of cards) {
    if (CLOSED_LISTS.has(card.listName)) continue
    if (excludeCardId !== undefined && card.id === excludeCardId) continue
    const text = `${card.name}\n${card.description}`
    const matchedPaths = matchedPathsFor(text, changedFiles)
    if (matchedPaths.length > 0) {
      candidates.push({ cardId: card.id, cardName: card.name, matchedPaths })
    }
  }
  return candidates
}

// `excludeCardId` should always be the CLOSING card's own id: its diff's
// changed files trivially mention its own text, so without exclusion it
// shortlists itself as "stale" — a false candidate every single run.
export function sweep(cards: BoardCard[], changedFiles: string[], excludeCardId?: string): StaleSweepResult {
  const openCardCount = cards.filter((card) => !CLOSED_LISTS.has(card.listName)).length
  const filtered = shouldFilterByDiff(openCardCount)
  return {
    candidates: findStaleCandidates(cards, changedFiles, excludeCardId),
    filtered,
    openCardCount,
  }
}

function printResult(source: string, result: StaleSweepResult): void {
  console.log(`stale-card-sweep — ${source}`)
  console.log(`open cards: ${result.openCardCount} (Backlog+Next+In Progress+Blocked)`)
  console.log(
    result.filtered
      ? `>= ${DIFF_FILTER_THRESHOLD} — diff-shortlist mode (a degradation accepted for volume, never an improvement on reading everything)`
      : `< ${DIFF_FILTER_THRESHOLD} — this shortlist is ADVISORY ONLY; read every open card directly per the founding card`,
  )
  console.log('')

  if (result.candidates.length === 0) {
    console.log('no open card mentions any of the changed files')
  } else {
    for (const candidate of result.candidates) {
      console.log(`card ${candidate.cardId} — ${candidate.cardName}`)
      for (const path of candidate.matchedPaths) console.log(`  matched: ${path}`)
    }
  }
  console.log('')
  console.log(`TOTAL: ${result.candidates.length} candidate(s) — JUDGMENT REQUIRED, not a verdict`)
}

interface ResolvedCards {
  cards: BoardCard[]
  source: string
}

async function resolveCards(mode: string | undefined, value: string | undefined): Promise<ResolvedCards> {
  if (mode === '--snapshot') {
    if (!value) throw new Error('--snapshot requires a file path')
    return { cards: JSON.parse(readFileSync(value, 'utf8')) as BoardCard[], source: value }
  }
  if (mode === '--board') {
    if (!value) throw new Error('--board requires a boardId')
    return { cards: await fetchBoardCards({ boardId: value }), source: `board ${value}` }
  }
  throw new Error(`unknown mode: ${mode ?? ''}`)
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

export interface ParsedArgs {
  mode?: string
  modeValue?: string
  changedFiles: string[]
  closingCardId?: string
}

export const USAGE =
  'usage: tsx toolkit/scripts/stale-card-sweep.ts --board <boardId> --changed-file <path> [--changed-file <path> ...] [--closing-card <id>]\n' +
  '       tsx toolkit/scripts/stale-card-sweep.ts --snapshot <file.json> --changed-file <path> [...] [--closing-card <id>]\n' +
  'at least one --changed-file is required — a diff with no changed files cannot determine anything, and reporting an\n' +
  'empty shortlist in that case would be a silent false-clean verdict.'

/** Pure argument parsing, kept separate from `main()` so bad-input paths
 * (mutually exclusive flags, a flag consuming another flag as its value, a
 * missing --changed-file) are unit-testable without spawning a process. */
export function parseArgs(args: string[]): ParsedArgs {
  const changedFiles: string[] = []
  let mode: string | undefined
  let modeValue: string | undefined
  let closingCardId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--board' || arg === '--snapshot') {
      if (mode !== undefined) throw new Error('--board and --snapshot are mutually exclusive')
      mode = arg
      modeValue = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--changed-file') {
      changedFiles.push(takeValue(args, index, arg))
      index += 1
    } else if (arg === '--closing-card') {
      closingCardId = takeValue(args, index, arg)
      index += 1
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  return { mode, modeValue, changedFiles, closingCardId }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { mode, modeValue, changedFiles, closingCardId } = parseArgs(args)

  if (!mode || changedFiles.length === 0) {
    console.error(USAGE)
    process.exit(2)
  }

  const { cards, source } = await resolveCards(mode, modeValue)
  const result = sweep(cards, changedFiles, closingCardId)
  printResult(source, result)
  process.exit(0)
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
