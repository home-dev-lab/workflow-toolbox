import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { fetchBoardCards } from '../planka-mcp-client.ts'
import {
  checkBoard,
  checkLabelIntent,
  handleCliError,
  main,
  type CardSnapshot,
} from '../label-intent-lens.ts'

vi.mock('../planka-mcp-client.ts', () => ({
  fetchBoardCards: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(fetchBoardCards).mockReset()
})

function card(description: string, labels: string[] = [], id = 'card-1'): CardSnapshot {
  return { id, description, labels }
}

describe('label-intent-lens — card detection fixtures', () => {
  it('1. flags the full trio in a closing paragraph with "Labels suggérés"', () => {
    const result = checkLabelIntent(card('...texte de contexte...\n\nLabels suggérés : P2 / chore / effort:M.'))
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P2'],
      ['type', 'chore'],
      ['effort', 'effort:M'],
    ])
    expect(result.advisories).toEqual([])
  })

  it('2. ignores unrelated applied labels and still reports the trio', () => {
    const result = checkLabelIntent(
      card('...\n\nLabels: P2 feature effort:M (repo: acme-widget-service).', ['tooling']),
    )
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P2'],
      ['type', 'feature'],
      ['effort', 'effort:M'],
    ])
    expect(result.advisories).toEqual([])
  })

  it('3. skips already-applied priority while flagging the missing type and effort', () => {
    const result = checkLabelIntent(card('...\n\nLabels: P2 bug effort:S.', ['P2']))
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['type', 'bug'],
      ['effort', 'effort:S'],
    ])
    expect(result.advisories).toEqual([])
  })

  it('4. stays silent when all three labels are already applied', () => {
    const result = checkLabelIntent(
      card('...\n\nLabels: P2 research effort:L', ['P2', 'research', 'effort:L']),
    )
    expect(result.findings).toEqual([])
    expect(result.advisories).toEqual([])
  })

  it('5. matches the compact slash-separated trio form', () => {
    const result = checkLabelIntent(card('...\n\nLabels : P1/bug/effort:S (le filing ; le repro existe déjà…).'))
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P1'],
      ['type', 'bug'],
      ['effort', 'effort:S'],
    ])
    expect(result.advisories).toEqual([])
  })

  it('6. reports an advisory, not a guessed finding, for an effort range', () => {
    const result = checkLabelIntent(card('...\n\nP2 feature, effort:M-L, toolkit.'))
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P2'],
      ['type', 'feature'],
    ])
    expect(result.advisories.map((a) => a.field)).toEqual(['effort'])
    expect(result.advisories[0]?.message).toBe(
      'effort ambigu suggéré dans le texte (fourchette effort:M-L) — jugement requis, non bloquant',
    )
  })

  it('7. does not require a "Labels:" prefix for feature', () => {
    const result = checkLabelIntent(card('...\n\nP2 feature, effort:L.'))
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P2'],
      ['type', 'feature'],
      ['effort', 'effort:L'],
    ])
  })

  it('8. does not require a "Labels:" prefix for chore', () => {
    const result = checkLabelIntent(card('...\n\nP2 chore, effort:M, toolkit.'))
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P2'],
      ['type', 'chore'],
      ['effort', 'effort:M'],
    ])
  })

  it('9. stays silent on the repaired real-card shape where the text remains but labels are present', () => {
    const result = checkLabelIntent(
      card('...\n\nLabels: P2 chore effort:M.', ['tooling', 'P2', 'chore', 'effort:M']),
    )
    expect(result.findings).toEqual([])
    expect(result.advisories).toEqual([])
  })

  it('10. matches another naked closing trio form', () => {
    const result = checkLabelIntent(card('...\n\nP1 chore, effort:L (plusieurs sessions probables).'))
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P1'],
      ['type', 'chore'],
      ['effort', 'effort:L'],
    ])
  })

  it('11. matches the real slash-separated bug form', () => {
    const result = checkLabelIntent(card('...\n\nLabels : P2/bug/effort:M (observatory).'))
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P2'],
      ['type', 'bug'],
      ['effort', 'effort:M'],
    ])
  })

  it('12. strips sr-meta before scanning and remains silent when labels are applied', () => {
    const result = checkLabelIntent(
      card(
        '...\n\nLabels: P2 feature effort:M (repo: acme-widget-service).\n\n<!-- sr-meta v1 -->\nLast-worked: 2026-07-24\nNext: ...\n<!-- /sr-meta -->\n',
        ['tooling', 'P2', 'feature', 'effort:M'],
      ),
    )
    expect(result.findings).toEqual([])
    expect(result.advisories).toEqual([])
  })

  it('13. treats "à confirmer" text as ordinary comparison and stays silent when labels match', () => {
    const result = checkLabelIntent(
      card(
        '...\n\n⚠ Labels à confirmer par main : P2 / chore / effort:S (posés par le pilote). Repo : toolbox.',
        ['P2', 'chore', 'effort:S'],
      ),
    )
    expect(result.findings).toEqual([])
    expect(result.advisories).toEqual([])
  })

  it('14. stays silent on prose with no trio at all', () => {
    const result = checkLabelIntent(card('Prose normale, sans ligne Labels, sans trio nu, juste du texte.'))
    expect(result.findings).toEqual([])
    expect(result.advisories).toEqual([])
  })

  it('15. strips markdown bold and emits an advisory when two type values are present', () => {
    const result = checkLabelIntent(card('**P1 · research + feature · effort:L · workflow-toolbox.'))
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P1'],
      ['effort', 'effort:L'],
    ])
    expect(result.advisories.map((a) => a.field)).toEqual(['type'])
  })

  it('16. treats type alternatives as an advisory while still keeping firm priority and effort findings', () => {
    const result = checkLabelIntent(card('... P2/research (ou bug perf)/effort:M. Lié : #18183862197...'))
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P2'],
      ['effort', 'effort:M'],
    ])
    expect(result.advisories.map((a) => a.field)).toEqual(['type'])
  })

  it('17. requires a literal effort:value token for the whole trio to match', () => {
    const result = checkLabelIntent(
      card(
        "Cette carte dépend de la carte #123 qui est en P1 sur le board. Le type ici reste incertain (peut-être un chore), et l'effort n'est pas encore mesuré.",
      ),
    )
    expect(result.findings).toEqual([])
    expect(result.advisories).toEqual([])
  })

  it('18. does not match informal P3 at all, even if bug and effort tokens follow', () => {
    const result = checkLabelIntent(card('P3 bug UX, effort:S'))
    expect(result.findings).toEqual([])
    expect(result.advisories).toEqual([])
  })

  it('19. does not match a type value outside the closed vocabulary', () => {
    const result = checkLabelIntent(card('P1 polish effort:S'))
    expect(result.findings).toEqual([])
    expect(result.advisories).toEqual([])
  })

  it('20. scans only the last two paragraphs and ignores a trio quoted earlier in the description', () => {
    const result = checkLabelIntent(
      card(
        'Premier paragraphe de contexte, sans trio.\n\nDeuxième paragraphe qui CITE un exemple : « Labels : P2 chore effort:M » — ceci n\'est qu\'une illustration d\'un autre trou, pas une suggestion pour CETTE carte-ci.\n\nTroisième paragraphe, prose de clôture normale, sans aucun trio, juste des phrases.',
      ),
    )
    expect(result.findings).toEqual([])
    expect(result.advisories).toEqual([])
  })

  it('21. turns contradictory firm type suggestions across matches into one advisory instead of guessing', () => {
    const result = checkLabelIntent(
      card('Avis initial : P2 feature, effort:M.\n\nCorrection après relecture : P2 bug, effort:M.'),
    )
    expect(result.findings.map((f) => [f.field, f.suggested])).toEqual([
      ['priority', 'P2'],
      ['effort', 'effort:M'],
    ])
    expect(result.advisories.map((a) => [a.field, a.message])).toEqual([
      [
        'type',
        'valeurs contradictoires suggérées dans le texte pour type (feature vs bug) — jugement requis, non bloquant',
      ],
    ])
  })

  it('22. ignores a middle-paragraph trio even without any quoted-example cue word', () => {
    const result = checkLabelIntent(
      card(
        'Premier paragraphe, contexte normal.\n\nUn trio non désiré traîne ici sans lien avec cette carte : P2 chore effort:M. Ce paragraphe n\'est ni le premier ni le dernier.\n\nTroisième paragraphe, encore du contexte, toujours sans trio.\n\nDernier paragraphe, clôture normale, aucun trio ici non plus.',
      ),
    )
    expect(result.findings).toEqual([])
    expect(result.advisories).toEqual([])
  })
})

describe('label-intent-lens — board aggregation', () => {
  it('returns ok=false and only the flagged card when one card has findings and the other is clean', () => {
    const result = checkBoard([
      card('...\n\nLabels: P2 chore effort:M.', [], 'bad-card'),
      card('...\n\nLabels: P2 research effort:L', ['P2', 'research', 'effort:L'], 'good-card'),
    ])
    expect(result.ok).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.cardId).toBe('bad-card')
  })

  it('keeps advisories in results but remains ok=true when no blocking finding exists anywhere', () => {
    const result = checkBoard([card('...\n\nP2 feature, effort:M-L, toolkit.', ['P2', 'feature'], 'advisory-card')])
    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.findings).toEqual([])
    expect(result.results[0]?.advisories.map((a) => a.field)).toEqual(['effort'])
  })
})

describe('label-intent-lens — CLI exit code gate', () => {
  const script = fileURLToPath(new URL('../label-intent-lens.ts', import.meta.url))

  it('exits 1 when at least one finding exists, and 0 when the snapshot is clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'label-intent-lens-'))
    const bad = join(dir, 'bad.json')
    const good = join(dir, 'good.json')
    writeFileSync(bad, JSON.stringify([card('...\n\nLabels: P2 chore effort:M.')]), 'utf8')
    writeFileSync(
      good,
      JSON.stringify([card('...\n\nLabels: P2 research effort:L', ['P2', 'research', 'effort:L'])]),
      'utf8',
    )

    const badRun = spawnSync('pnpm', ['exec', 'tsx', script, bad], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
    })
    const goodRun = spawnSync('pnpm', ['exec', 'tsx', script, good], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
    })

    expect(badRun.status).toBe(1)
    expect(goodRun.status).toBe(0)
  })

  it('fetches and checks BoardCards in --board mode without requiring a snapshot', async () => {
    vi.mocked(fetchBoardCards).mockResolvedValue([
      {
        id: 'bad-board-card',
        name: 'Missing labels',
        description: '...\n\nLabels: P2 chore effort:M.',
        labels: ['P2'],
        listName: 'Next',
      },
      {
        id: 'good-board-card',
        name: 'Complete labels',
        description: '...\n\nLabels: P2 research effort:L.',
        labels: ['P2', 'research', 'effort:L'],
        listName: 'Done',
      },
    ])
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await main(['--board', 'board-123', '--mcp-url', 'http://planka.test/mcp'])

    expect(fetchBoardCards).toHaveBeenCalledWith({
      boardId: 'board-123',
      mcpUrl: 'http://planka.test/mcp',
    })
    expect(log).toHaveBeenCalledWith('card bad-board-card')
    expect(log).toHaveBeenCalledWith('TOTAL: 2 finding(s), 0 advisory/advisories, 1 card(s)')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits non-zero and reports a fetch failure in --board mode', async () => {
    vi.mocked(fetchBoardCards).mockRejectedValue(new Error('Planka MCP unavailable'))
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await main(['--board', 'board-123']).catch(handleCliError)

    expect(error).toHaveBeenCalledWith('Planka MCP unavailable')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
