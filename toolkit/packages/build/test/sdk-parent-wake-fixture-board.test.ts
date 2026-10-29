import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error runtime ESM fixture helper
import { createFixtureBoard, fixtureBoardContract } from '../../../scripts/lib/sdk-parent-wake-fixture-board.mjs'
// @ts-expect-error runtime ESM runner
import { loadBoardContract } from '../../../../plugin/bin/lib/pilot-runner-core.mjs'
// @ts-expect-error runtime ESM lifecycle server
import { createLifecycleServer } from '../../../../plugin/bin/lib/sdk-pilot-lifecycle-server.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const finding = { title: 'Fixture follow-up', l4Reason: 'different subsystem: fixture reporting', risk: 'P1', effort: 'S' }

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sdk-parent-wake-board-'))
  roots.push(root)
  return root
}

function routedLines(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, 'routed-findings.jsonl'), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
}

it('supplies a complete local board contract accepted by the runner', () => {
  expect(loadBoardContract(fixtureBoardContract)).toEqual(expect.objectContaining({ boardId: 'fixture-board', listId: 'fixture-list' }))
})

it('accepts route_finding with the fixture board instead of ending partial without a board contract', async () => {
  const root = fixtureRoot()
  const worktree = join(root, 'worktree')
  mkdirSync(join(worktree, '.lane'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, '.gitignore'), '.claude/reports/\n')
  const board = createFixtureBoard(root)
  const server = createLifecycleServer({ worktree, archiveRoot: root, route: 'FULL', models: {}, cardId: 'wake-fixture', sessionTag: 'fixture', rules: [],
    boardContract: loadBoardContract(fixtureBoardContract), routeFinding: (args: Record<string, unknown>) => board.createRoutedCard(args),
    resolveRoutedFinding: (card: Record<string, unknown>) => board.resolveRoutedCard(card) })
  const result = await server.instance._registeredTools.route_finding.handler(finding)
  expect(result.content[0].text).toBe('routed card fixture-routed-1 — Fixture follow-up')
  expect(server.state().partial).toBeNull()
  expect(server.state().phase).toBe('discovery')
  expect(JSON.parse(readFileSync(join(worktree, '.lane', 'lifecycle.json'), 'utf8')).routed_cards).toEqual([
    { id: 'fixture-routed-1', title: finding.title, l4Reason: finding.l4Reason, dependencyVerified: true },
  ])
  expect(routedLines(root)).toEqual([expect.objectContaining({ ...finding, id: 'fixture-routed-1', dependencyVerified: true, boardContract: fixtureBoardContract })])
})

it('keeps card ids and append-only receipts local to each board and resolves without board access', async () => {
  const root = fixtureRoot()
  const board = createFixtureBoard(root)
  const first = await board.createRoutedCard(finding)
  const second = await board.createRoutedCard({ ...finding, title: 'Second follow-up' })
  expect(first).toEqual({ id: 'fixture-routed-1', title: finding.title, dependencyVerified: true })
  expect(second).toEqual({ id: 'fixture-routed-2', title: 'Second follow-up', dependencyVerified: true })
  expect(await board.resolveRoutedCard(first)).toBeUndefined()
  expect(routedLines(root)).toEqual([{ ...finding, ...first }, { ...finding, ...second }])
  expect(await createFixtureBoard(fixtureRoot()).createRoutedCard(finding)).toEqual(first)
})
