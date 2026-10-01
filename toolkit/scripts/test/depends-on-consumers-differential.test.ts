// One table of card descriptions, fed to every consumer of the Depends-on convention. What is
// compared, per consumer:
//   - orchestrator mission pick (missionIneligibilityReason, fake board): pick/refuse, and the ids it
//     asked the board for;
//   - pickable-cards (computePickable): pick/refuse, and the ids named in its exclusion reason when
//     every board card is moved out of Done;
//   - shipped triage (triageCardDependencies): pick/refuse, and its id set probed through the done
//     set (Done = exactly the expected ids picks the card; dropping any one of them blocks it);
//   - card-hygiene lens (checkBoardHygiene): the dependency edges its findings and advisories name,
//     and whether it raises a broken-dependency finding.
// Only the DEPENDENCY verdict is compared: every subject card carries the labels each picker
// requires, since label policies differ between pickers by design.
// A card with no Depends-on line is "not checked": every picker refuses it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { triageCardDependencies } from '../../../plugin/bin/lib/depends-on-parser.mjs'
import { BoardUnavailable } from '../../../plugin/bin/lib/board-http-client.mjs'
import { missionIneligibilityReason } from '../../../plugin/bin/lib/orchestrator-runner-core.mjs'
import { checkBoardHygiene } from '../card-hygiene-lens.ts'
import { computePickable } from '../pickable-cards.ts'
import type { BoardCard } from '../planka-mcp-client.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

// Board fixture. Every dependency target sits in a CLOSED list or is absent, so the lens reports
// every edge it reads (chain-coherence for Done, permanent-block for NotDoing, broken-dependency for
// absent) and its id set is observable. MENTIONED is NotDoing: a consumer that wrongly reads a
// parenthesised mention as a dependency refuses the card, and the lens reports a permanent block.
const DONE_A = '1875344230742754904'
const DONE_B = '1875344230742754911'
const MENTIONED = '1875344230742754934'
const DANGLING = '1875999999999999999'
const SUBJECT = '1875473607941948577'

const boardCards: BoardCard[] = [
  { id: DONE_A, name: 'Done dependency A', description: 'Depends-on: none', labels: [], listName: 'Done' },
  { id: DONE_B, name: 'Done dependency B', description: 'Depends-on: none', labels: [], listName: 'Done' },
  { id: MENTIONED, name: 'Only ever mentioned', description: 'Depends-on: none', labels: [], listName: 'NotDoing' },
]

interface Row {
  label: string
  description: string
  pick: boolean
  ids: string[]
  lensFlags: boolean
}

const rows: Row[] = [
  { label: 'Depends-on: none', description: 'Depends-on: none', pick: true, ids: [], lensFlags: false },
  { label: 'bare 19-digit id', description: `Depends-on: ${DONE_A}`, pick: true, ids: [DONE_A], lensFlags: false },
  { label: '#id (see also #id)', description: `Depends-on: #${DONE_A} (see also #${MENTIONED})`, pick: true, ids: [DONE_A], lensFlags: false },
  { label: 'bold label', description: `**Depends-on:** #${DONE_A}`, pick: true, ids: [DONE_A], lensFlags: false },
  { label: 'two ids comma-separated', description: `Depends-on: #${DONE_A}, #${DONE_B}`, pick: true, ids: [DONE_A, DONE_B], lensFlags: false },
  { label: 'parenthesised title with a comma and a #id', description: `Depends-on: #${DONE_A} (a title, with #${MENTIONED} inside)`, pick: true, ids: [DONE_A], lensFlags: false },
  { label: 'unparseable value', description: 'Depends-on: TBD', pick: false, ids: [], lensFlags: true },
  { label: 'none followed by a condition', description: `Depends-on: none until #${DONE_A} lands`, pick: false, ids: [], lensFlags: true },
  { label: 'dangling id', description: `Depends-on: #${DANGLING}`, pick: false, ids: [DANGLING], lensFlags: true },
  { label: 'NO Depends-on line', description: 'Some description with no declaring line.', pick: false, ids: [], lensFlags: false },
]

function fakeBoard() {
  const requested: string[] = []
  const byId = new Map(boardCards.map((card) => [card.id, card]))
  return {
    requested,
    getCard: async (id: string) => {
      requested.push(id)
      const card = byId.get(id)
      if (!card) throw new BoardUnavailable('Request failed with status code 404', 404)
      return card
    },
  }
}

async function orchestratorVerdict(description: string) {
  const board = fakeBoard()
  const card = { id: SUBJECT, listName: 'Next', labels: ['P1', 'bug', 'effort:S'], description }
  const reason: string | null = await missionIneligibilityReason(card, [], board)
  return { pick: reason === null, reason, ids: [...new Set(board.requested)].sort() }
}

function pickableVerdict(description: string) {
  const subject: BoardCard = { id: SUBJECT, name: 'Subject', description, labels: ['P1', 'feature', 'effort:M', 'product'], listName: 'Backlog' }
  const result = computePickable([...boardCards, subject])
  const picked = result.pickable.find((card) => card.cardId === SUBJECT)
  return { pick: picked !== undefined, reason: picked?.reason ?? [...result.excluded, ...result.unjudgeable].find((card) => card.cardId === SUBJECT)?.reason }
}

// Every board card moved out of Done: the exclusion reason then names each dependency id it read.
function pickableIds(description: string): string[] {
  const subject: BoardCard = { id: SUBJECT, name: 'Subject', description, labels: ['P1', 'feature', 'effort:M', 'product'], listName: 'Backlog' }
  const board = boardCards.map((card) => ({ ...card, listName: 'In Progress' }))
  const reason = computePickable([...board, subject]).excluded.find((card) => card.cardId === SUBJECT)?.reason ?? ''
  if (reason.startsWith('unparseable Depends-on line')) return []
  return [...new Set([...reason.matchAll(/#(\d{4,})/g)].map((match) => match[1]!))].sort()
}

// The id set triage reads, probed through the done set: with Done = exactly the expected ids the
// card is recommendable, and dropping any one of them blocks it.
function triageReadsExactly(description: string, ids: string[]): boolean {
  const recommendable = (done: string[]) => triageCardDependencies([{ id: SUBJECT, description }], done).recommendable.length === 1
  return recommendable(ids) && ids.every((id) => !recommendable(ids.filter((other) => other !== id)))
}

function triageVerdict(description: string) {
  const done = boardCards.filter((card) => card.listName === 'Done').map((card) => card.id)
  const result = triageCardDependencies([{ id: SUBJECT, description }], done)
  return { pick: result.recommendable.length === 1, notChecked: result.notChecked.length === 1 }
}

function lensVerdict(description: string) {
  const subject: BoardCard = { id: SUBJECT, name: 'Subject', description, labels: ['P1', 'feature', 'effort:M', 'product'], listName: 'Next' }
  const result = checkBoardHygiene([...boardCards, subject]).results.find((entry) => entry.cardId === SUBJECT)
  // An unreadable-line finding quotes the line itself: its ids are text, not edges.
  const messages = [...(result?.findings ?? []), ...(result?.advisories ?? [])]
    .map((entry) => entry.message)
    .filter((message) => !message.startsWith('Depends-on line cannot be read'))
  const ids = new Set<string>()
  for (const message of messages) for (const match of message.matchAll(/#(\d{4,})/g)) if (match[1] !== SUBJECT) ids.add(match[1]!)
  const flagged = (result?.findings ?? []).some((finding) => finding.kind === 'broken-dependency')
  return { ids: [...ids].sort(), flagged }
}

describe('Depends-on consumers agree (differential, one table)', () => {
  it.each(rows)('$label: every consumer gives the same verdict and the same ids', async (row) => {
    const expectedIds = [...row.ids].sort()
    const orchestrator = await orchestratorVerdict(row.description)
    const pickable = pickableVerdict(row.description)
    const triage = triageVerdict(row.description)
    const lens = lensVerdict(row.description)

    expect({ orchestrator: orchestrator.pick, pickable: pickable.pick, triage: triage.pick }, `reasons: ${orchestrator.reason} | ${pickable.reason}`)
      .toEqual({ orchestrator: row.pick, pickable: row.pick, triage: row.pick })
    expect(orchestrator.ids, 'orchestrator dependency reads').toEqual(expectedIds)
    expect(lens.ids, 'lens dependency edges').toEqual(expectedIds)
    expect(lens.flagged, 'lens broken-dependency finding').toBe(row.lensFlags)
    if (row.ids.length > 0 || row.pick) expect(pickableIds(row.description), 'pickable dependency ids').toEqual(expectedIds)
    if (row.pick) expect(triageReadsExactly(row.description, row.ids), 'triage dependency ids').toBe(true)
    if (row.pick) expect(pickable.reason).toBe(row.ids.length === 0 ? 'Depends-on: none' : `all ${row.ids.length} dependencies Done`)
  })

  it('the NO-line card is refused by every picker as not checked', async () => {
    const description = 'No declaring line here.'
    expect((await orchestratorVerdict(description)).reason).toBe('no Depends-on line (not checked)')
    expect(pickableVerdict(description)).toEqual({ pick: false, reason: 'no Depends-on line: not checked (add one; "Depends-on: none" qualifies)' })
    expect(triageVerdict(description)).toEqual({ pick: false, notChecked: true })
  })

  it('the dangling card is refused by every picker with a reason naming the id, and flagged by the lens', async () => {
    const description = `Depends-on: #${DANGLING}`
    expect((await orchestratorVerdict(description)).reason).toBe(`dependency ${DANGLING} not found`)
    expect(pickableVerdict(description).reason).toBe(`depends on #${DANGLING}, which does not exist on this board`)
    expect(triageVerdict(description).pick).toBe(false)
    expect(lensVerdict(description)).toEqual({ ids: [DANGLING], flagged: true })
  })

  it('the orchestrator skips an id longer than a card id allows, instead of aborting the wave', async () => {
    const tooLong = '1'.repeat(33)
    const { pick, reason } = await orchestratorVerdict(`Depends-on: #${tooLong}`)
    expect(pick).toBe(false)
    expect(reason).toContain(tooLong)
  })
})

describe('orchestrator mission eligibility — what the board answers about a dependency', () => {
  const missionCard = (description: string | undefined, text?: string) => ({ id: SUBJECT, listName: 'Next', labels: ['P1', 'bug', 'effort:S'], description, ...(text === undefined ? {} : { text }) })
  const boardAnswering = (answer: () => Promise<unknown>) => ({ getCard: answer })

  it('F2: reads the description only — a card with no description is not checked, whatever its text says', async () => {
    expect(await missionIneligibilityReason(missionCard(undefined, 'Depends-on: none'), [], fakeBoard())).toBe('no Depends-on line (not checked)')
  })

  it.each([
    ['20 digits', '99999999999999999999'],
    ['19 digits above the signed 64-bit maximum', '9223372036854775808'],
  ])('F3: an id that cannot be a Planka card id (%s) skips the card without asking the board', async (_label, id) => {
    const board = fakeBoard()
    expect(await missionIneligibilityReason(missionCard(`Depends-on: #${id}`), [], board)).toBe(`dependency id ${id} is not a valid card id`)
    expect(board.requested).toEqual([])
  })

  it('F3: the signed 64-bit maximum itself is a card id (asked, then not found)', async () => {
    expect(await missionIneligibilityReason(missionCard('Depends-on: #9223372036854775807'), [], fakeBoard())).toBe('dependency 9223372036854775807 not found')
  })

  it.each([
    ['null', async () => null],
    ['an empty object', async () => ({})],
    ['a wrapped card', async () => ({ card: { id: DONE_A, listName: 'Done' } })],
  ])('F1: a get_card answer with no valid top-level id (%s) is a board failure, never "not found"', async (_label, answer) => {
    await expect(missionIneligibilityReason(missionCard(`Depends-on: #${DONE_A}`), [], boardAnswering(answer))).rejects.toThrow(`board unavailable: malformed get_card answer for ${DONE_A}`)
  })

  it('F1: a get_card answer naming another card is a board failure', async () => {
    await expect(missionIneligibilityReason(missionCard(`Depends-on: #${DONE_A}`), [], boardAnswering(async () => ({ id: DONE_B, listName: 'Done' })))).rejects.toThrow(new RegExp(`^board unavailable: .*${DONE_B}.*${DONE_A}`))
  })

  it.each([
    ['a non-transport 503', () => new BoardUnavailable('Request failed with status code 503', 503)],
    ['a BoardUnavailable with no status', () => new BoardUnavailable('malformed MCP result JSON')],
    ['a transport 404', () => Object.assign(new BoardUnavailable('HTTP 404', 404), { transport: true })],
    ['a plain error', () => new Error('socket hang up')],
  ])('F1: %s while reading a dependency is a board failure, never a skip', async (_label, failure) => {
    await expect(missionIneligibilityReason(missionCard(`Depends-on: #${DONE_A}`), [], boardAnswering(async () => { throw failure() }))).rejects.toThrow(/^board unavailable: /)
  })
})

describe('I1: no consumer keeps its own Depends-on parsing', () => {
  const consumers = [
    'plugin/bin/lib/orchestrator-runner-core.mjs',
    'toolkit/scripts/pickable-cards.ts',
    'toolkit/scripts/card-hygiene-lens.ts',
  ]

  function regexLiterals(file: string, source: string): string[] {
    const found: string[] = []
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) found.push(node.getText())
      ts.forEachChild(node, visit)
    }
    visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS))
    return found
  }

  it('control: the scan finds the parsing the consumers used to carry', () => {
    const removed = 'const DEPENDS_ON = /depends-on\\s*:([^\\r\\n]*)/gi\nconst lines = text.filter((line) => /^\\s*Depends-on:/i.test(line))'
    expect(regexLiterals('removed.ts', removed).filter((literal) => /depends-on/i.test(literal))).toHaveLength(2)
  })

  it.each(consumers)('%s has no regex literal matching depends-on and imports the shipped parser', (file) => {
    const source = readFileSync(`${REPO_ROOT}${file}`, 'utf8')
    const literals = regexLiterals(file, source)
    expect(literals.filter((literal) => /depends-on/i.test(literal))).toEqual([])
    expect(source).toMatch(/from '[./]*(?:plugin\/bin\/lib\/)?depends-on-parser\.mjs'/)
  })
})
