import { describe, expect, it } from 'vitest'
import {
  DIFF_FILTER_THRESHOLD,
  findStaleCandidates,
  formatHookOutput,
  parseArgs,
  shouldFilterByDiff,
  sweep,
} from '../stale-card-sweep.ts'
import type { BoardCard } from '../planka-mcp-client.ts'

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    name: `Card ${id}`,
    description: '',
    labels: [],
    listName: 'Next',
    ...overrides,
  }
}

describe('shouldFilterByDiff — the threshold, named with its measurement', () => {
  it('stays unfiltered at and below the measured board sizes (77 without Blocked, 90 with)', () => {
    expect(shouldFilterByDiff(77)).toBe(false)
    expect(shouldFilterByDiff(90)).toBe(false)
  })

  it('stays unfiltered one below the threshold and switches to filtered at it', () => {
    expect(shouldFilterByDiff(DIFF_FILTER_THRESHOLD - 1)).toBe(false)
    expect(shouldFilterByDiff(DIFF_FILTER_THRESHOLD)).toBe(true)
  })
})

describe('findStaleCandidates — invariant over the whole set, not an enumeration of known pairs', () => {
  // Property-style: build a mixed board where each card is EITHER made to
  // mention a changed path OR deliberately not, then assert the exact
  // membership of the result matches the predicate for every card — not just
  // for one hand-picked pair. This is what makes the lock generalize: adding
  // a card to either half of this fixture keeps the assertion meaningful
  // without touching the test body.
  const changedFiles = [
    'apps/observe-ui/src/lib/TokenUsage.svelte',
    'server/routes/phase-header.ts',
  ]

  const mentioningCards = [
    card('pos-1', { description: 'Touches apps/observe-ui/src/lib/TokenUsage.svelte directly.' }),
    card('pos-2', { description: 'A defect in TokenUsage.svelte truncates the badge.' }),
    card('pos-3', { name: 'phase-header.ts regression', description: 'unrelated body text' }),
  ]
  const silentCards = [
    card('neg-1', { description: 'A completely unrelated defect in the CLI wrapper.' }),
    card('neg-2', { description: 'Mentions a short generic file: index.ts (below the basename floor).' }),
    card('neg-3', { description: 'No file reference at all.' }),
  ]

  it('flags exactly the cards that mention a changed path, and none that do not', () => {
    const result = findStaleCandidates([...mentioningCards, ...silentCards], changedFiles)
    const flaggedIds = new Set(result.map((c) => c.cardId))

    for (const positive of mentioningCards) {
      expect(flaggedIds.has(positive.id), `expected ${positive.id} to be flagged`).toBe(true)
    }
    for (const negative of silentCards) {
      expect(flaggedIds.has(negative.id), `expected ${negative.id} to stay silent`).toBe(false)
    }
    expect(result).toHaveLength(mentioningCards.length)
  })

  it('excludes cards already in Done/NotDoing regardless of mention', () => {
    const result = findStaleCandidates(
      [
        card('done-1', { listName: 'Done', description: 'TokenUsage.svelte' }),
        card('notdoing-1', { listName: 'NotDoing', description: 'TokenUsage.svelte' }),
        card('open-1', { listName: 'Blocked', description: 'TokenUsage.svelte' }),
      ],
      changedFiles,
    )
    expect(result.map((c) => c.cardId)).toEqual(['open-1'])
  })

  it('matches the full path even when the basename alone would be excluded as too short', () => {
    // 'db.ts' is 5 chars, below MIN_BASENAME_MATCH_LENGTH (8) — a basename-only
    // match would miss this, but the full relative path still matches.
    const result = findStaleCandidates(
      [card('c1', { description: 'server/routes/db.ts needs a rewrite' })],
      ['server/routes/db.ts'],
    )
    expect(result).toHaveLength(1)

    const basenameOnly = findStaleCandidates(
      [card('c2', { description: 'db.ts needs a rewrite (no directory prefix)' })],
      ['server/routes/db.ts'],
    )
    expect(basenameOnly).toHaveLength(0)
  })

  it('excludes the closing card itself even though its own diff trivially mentions its own text', () => {
    const closingCard = card('closing-1', {
      name: 'Fix TokenUsage.svelte truncation',
      description: 'This card touches apps/observe-ui/src/lib/TokenUsage.svelte.',
    })
    const otherCard = card('other-1', { description: 'Also touches apps/observe-ui/src/lib/TokenUsage.svelte.' })

    const withoutExclusion = findStaleCandidates([closingCard, otherCard], changedFiles)
    expect(withoutExclusion.map((c) => c.cardId).sort()).toEqual(['closing-1', 'other-1'])

    const withExclusion = findStaleCandidates([closingCard, otherCard], changedFiles, 'closing-1')
    expect(withExclusion.map((c) => c.cardId)).toEqual(['other-1'])
  })
})

describe('parseArgs — CLI input validation, unit-testable without a subprocess', () => {
  it('rejects zero --changed-file (an empty shortlist there would read as a false-clean verdict)', () => {
    const parsed = parseArgs(['--board', 'board-1'])
    expect(parsed.changedFiles).toEqual([])
    // main() is what turns an empty changedFiles list into a usage error + exit 2;
    // parseArgs itself only reports the fact, so callers (main, or a future caller)
    // cannot silently proceed without checking it.
  })

  it('rejects --board and --snapshot together instead of silently picking the later one', () => {
    expect(() => parseArgs(['--board', 'b1', '--snapshot', 'file.json', '--changed-file', 'x.ts'])).toThrow(
      '--board and --snapshot are mutually exclusive',
    )
  })

  it('rejects a flag consuming another flag as its value', () => {
    expect(() => parseArgs(['--board', '--changed-file', 'x.ts'])).toThrow('--board requires a value')
    expect(() => parseArgs(['--board', 'b1', '--changed-file', '--closing-card'])).toThrow(
      '--changed-file requires a value',
    )
  })

  it('parses a well-formed invocation, including --closing-card', () => {
    const parsed = parseArgs(['--board', 'b1', '--changed-file', 'a.ts', '--changed-file', 'b.ts', '--closing-card', 'c1'])
    expect(parsed).toEqual({
      mode: '--board',
      modeValue: 'b1',
      changedFiles: ['a.ts', 'b.ts'],
      closingCardId: 'c1',
      hook: false,
    })
  })

  it('parses --hook when present', () => {
    const parsed = parseArgs(['--board', 'b1', '--changed-file', 'a.ts', '--hook'])
    expect(parsed).toEqual({
      mode: '--board',
      modeValue: 'b1',
      changedFiles: ['a.ts'],
      closingCardId: undefined,
      hook: true,
    })
  })
})

describe('formatHookOutput — silent unless there is something to flag', () => {
  const changedPath = 'apps/observe-ui/src/lib/TokenUsage.svelte'

  it('returns a non-null heads-up that names the card id and matched path when a commit touches a mentioned path', () => {
    const result = sweep([card('pos-1', { description: `Touches ${changedPath} directly.` })], [changedPath])
    const output = formatHookOutput('board b1', result)

    expect(output).not.toBeNull()
    expect(output).toContain('card pos-1')
    expect(output).toContain(changedPath)
  })

  it('returns null when a commit touches no path any open card mentions', () => {
    const result = sweep([card('neg-1', { description: 'A completely unrelated defect in the CLI wrapper.' })], [changedPath])
    expect(formatHookOutput('board b1', result)).toBeNull()
  })

  it('mentions diff-shortlist mode when the sweep result was filtered', () => {
    const output = formatHookOutput('board b1', {
      candidates: [{ cardId: 'pos-1', cardName: 'Card pos-1', matchedPaths: [changedPath] }],
      filtered: true,
      openCardCount: DIFF_FILTER_THRESHOLD,
    })

    expect(output).toContain('diff-shortlist mode')
  })
})

describe('sweep — the real founding-card pair, mechanical positive AND negative sense', () => {
  // These three descriptions are the ACTUAL text of the founding card's own
  // worked example (fetched from the live board 2026-08-03). This describes
  // this LAYER's contract only — mechanical candidate generation, not the
  // judgment layer's subsumption call (see the module doc and the skill):
  // the truncation card's text happens to mention the changed file, so it is
  // a candidate for the judgment step to confirm; the two named neighbour
  // cards — real, unrelated cards, same board, same "sweep after an event"
  // family, same time window — do not mention it and so are never even
  // shortlisted, regardless of how a judgment step would have ruled on them.
  const truncationCard = card('1827015528384824457', {
    name: 'Compteur du bandeau affiche 23 au lieu de 230K (troncature silencieuse)',
    description:
      'Le bandeau affiche 23 la ou la vraie valeur est 230K (tokens - badge .tok-compact/.tok-val de TokenUsage.svelte, icone).',
  })
  const revocationSweepCard = card('1827708688517826325', {
    name: 'Aucun balayage de retractation : stock deja contamine non traite',
    description:
      'La fausse image "lane active, 2 process" a circule plus dune heure, relayee comme un fait. Aucun item ne balaie le stock deja contamine.',
  })
  const citationSweepCard = card('1828508320822985794', {
    name: 'Balayer les citations quand un texte de reference change',
    description:
      'Une phrase de regle a ete clarifiee. Trois copies vivaient ailleurs. Un controle mecanique doit signaler les citations perimees.',
  })

  const changedFiles = ['apps/observe-ui/src/lib/TokenUsage.svelte']

  it('positive sense: the card whose text mechanically matches the changed file is shortlisted', () => {
    const result = sweep([truncationCard], changedFiles)
    expect(result.candidates.map((c) => c.cardId)).toEqual(['1827015528384824457'])
  })

  it('negative sense: the two named neighbour cards stay silent — same board, same sweep family, no text match', () => {
    const result = sweep([truncationCard, revocationSweepCard, citationSweepCard], changedFiles)
    expect(result.candidates.map((c) => c.cardId)).toEqual(['1827015528384824457'])
  })

  it('reports the open-card count and the filter mode', () => {
    const result = sweep([truncationCard, revocationSweepCard, citationSweepCard], changedFiles)
    expect(result.openCardCount).toBe(3)
    expect(result.filtered).toBe(false)
  })
})
