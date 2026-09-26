import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { confinedToWorktree, lifecycleCanUseTool, loadBoardContract } from '../../../../plugin/bin/lib/pilot-runner-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { pathWithin } from '../../../../plugin/bin/lib/host/path-within.mjs'

const roots: string[] = []

it('refuses a cross-drive Windows path for both direct reads and wildcard prefix containment', () => {
  expect(confinedToWorktree('D:\\repo', 'C:\\Users\\u\\state', win32)).toBe(false)
  expect(confinedToWorktree('D:\\repo', 'D:\\repo\\src', win32)).toBe(true)
  expect(lifecycleCanUseTool('D:\\repo', 'Read', { file_path: 'C:\\Users\\u\\state' }, { pathOps: win32 }).behavior).toBe('deny')
  expect(lifecycleCanUseTool('D:\\repo', 'Glob', { path: 'C:\\Users\\u', pattern: 'state\\*.json' }, { pathOps: win32 }).behavior).toBe('deny')
})

it('uses one cross-drive-aware containment predicate for lifecycle directories and citations', () => {
  expect(pathWithin('D:\\repo', 'C:\\escape', win32)).toBe(false)
  expect(pathWithin('D:\\repo', 'D:\\repo\\.lane', win32)).toBe(true)
  expect(pathWithin('D:\\repo', 'D:\\repo', win32)).toBe(true)
})

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'wt-pilot-confinement-'))
  roots.push(parent)
  const root = join(parent, 'worktree')
  mkdirSync(root)
  return { parent, root }
}

function boardContract() {
  return {
    boardId: 'board',
    listId: 'list',
    labels: {
      category: 'category',
      priority: { P0: 'priority-0', P1: 'priority-1', P2: 'priority-2' },
      type: { bug: 'type-bug', chore: 'type-chore', feature: 'type-feature', research: 'type-research' },
      effort: { S: 'effort-small', M: 'effort-medium', L: 'effort-large' },
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pilot runner worktree confinement', () => {
  it('accepts the default path and a path strictly inside the root', () => {
    const { root } = fixture()
    const inside = join(root, 'inside')
    mkdirSync(inside)

    expect(confinedToWorktree(root)).toBe(true)
    expect(confinedToWorktree(root, inside)).toBe(true)
  })

  it('rejects a path that resolves outside the root through ..', () => {
    const { root } = fixture()

    expect(confinedToWorktree(root, '..')).toBe(false)
  })

  it('accepts a path equal to the root', () => {
    const { root } = fixture()

    expect(confinedToWorktree(root, root)).toBe(true)
  })

  it('uses symlink targets rather than lexical locations', () => {
    const { parent, root } = fixture()
    const inside = join(root, 'inside')
    const outside = join(parent, 'outside')
    mkdirSync(inside)
    mkdirSync(outside)
    const outsideLinkToInside = join(outside, 'link-to-inside')
    const insideLinkToOutside = join(root, 'link-to-outside')
    // A directory junction needs no privilege on Windows, where a symlink does; both resolve through realpath.
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(inside, outsideLinkToInside, linkType)
    symlinkSync(outside, insideLinkToOutside, linkType)

    expect(confinedToWorktree(root, outsideLinkToInside)).toBe(true)
    expect(confinedToWorktree(root, insideLinkToOutside)).toBe(false)
  })

  it('resolves an existing ancestor for non-existent tails', () => {
    const { parent, root } = fixture()

    expect(confinedToWorktree(root, join(root, 'missing', 'file.txt'))).toBe(true)
    expect(confinedToWorktree(root, join(parent, 'missing', 'file.txt'))).toBe(false)
  })
})

describe('pilot runner board contract loading', () => {
  it('returns null when no contract is provided', () => {
    expect(loadBoardContract(null)).toBeNull()
    expect(loadBoardContract(undefined)).toBeNull()
  })

  it('reports invalid JSON from a contract file', () => {
    const { parent } = fixture()
    const file = join(parent, 'board-contract.json')
    writeFileSync(file, '{not valid JSON')

    expect(() => loadBoardContract(file)).toThrow(/^cannot read --board-contract:/)
  })

  it('parses a valid contract file', () => {
    const { parent } = fixture()
    const file = join(parent, 'board-contract.json')
    const contract = boardContract()
    writeFileSync(file, JSON.stringify(contract))

    expect(loadBoardContract(file)).toEqual(contract)
  })

  it('returns a valid object unchanged', () => {
    const contract = boardContract()

    expect(loadBoardContract(contract)).toBe(contract)
  })

  it.each([
    ['boardId', (contract: ReturnType<typeof boardContract>) => { contract.boardId = '' }],
    ['labels.priority.P1', (contract: ReturnType<typeof boardContract>) => { contract.labels.priority.P1 = undefined as unknown as string }],
    ['labels.effort.L', (contract: ReturnType<typeof boardContract>) => { contract.labels.effort.L = '' }],
  ])('names the invalid required field %s', (field, invalidate) => {
    const contract = boardContract()
    invalidate(contract)

    expect(() => loadBoardContract(contract)).toThrow(`--board-contract requires non-empty ${field}`)
  })
})
