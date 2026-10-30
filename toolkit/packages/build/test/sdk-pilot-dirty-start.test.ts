import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'

// The override permits a red proof against a disposable copy of the production modules.
const modules = process.env.WT_DIRTY_START_MODULE_ROOT
  ? pathToFileURL(`${process.env.WT_DIRTY_START_MODULE_ROOT}/`).href
  : new URL('../../../../plugin/bin/lib/', import.meta.url).href
const { runPilot } = await import(`${modules}pilot-runner-core.mjs`)
const { assertCleanPilotStart, selectDeliveryPaths, stageDeliverySelection } = await import(`${modules}lifecycle-selection.mjs`)
const { artefactIdentitiesAtStart } = await import(`${modules}lifecycle-report-edge.mjs`)
const roots: string[] = []

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
}

function fixture(dirty = true) {
  const root = mkdtempSync(join(tmpdir(), 'wt-dirty-start-')); roots.push(root)
  const dir = join(root, 'repo'); mkdirSync(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fixture@example.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, '.gitignore'), '.lane/\n')
  writeFileSync(join(dir, 'release config.json'), 'base release\n')
  writeFileSync(join(dir, 'source.txt'), 'base source\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
  if (dirty) {
    writeFileSync(join(dir, 'release config.json'), 'staged release\n')
    git(dir, 'add', '--', 'release config.json')
    writeFileSync(join(dir, 'source.txt'), 'unstaged owner edit\n')
  }
  writeFileSync(join(dir, 'owner notes.txt'), 'owner scratch\n')
  const cardFile = join(root, 'card.md'); const contract = join(root, 'contract.md')
  writeFileSync(cardFile, 'Route: LITE\n## Definition of done\n- preserve owner work\n')
  writeFileSync(contract, '# Contract\n')
  return { root, dir, cardFile, contract }
}

function ownerState(dir: string) {
  return {
    index: readFileSync(join(dir, '.git', 'index')),
    staged: git(dir, 'diff', '--cached', '--binary'),
    status: git(dir, 'status', '--porcelain=v1', '-z'),
    head: git(dir, 'rev-parse', 'HEAD'),
    release: readFileSync(join(dir, 'release config.json'), 'utf8'),
    source: readFileSync(join(dir, 'source.txt'), 'utf8'),
    scratch: readFileSync(join(dir, 'owner notes.txt'), 'utf8'),
  }
}

function directRun(f: ReturnType<typeof fixture>, query: ReturnType<typeof vi.fn>) {
  return runPilot({ card: 'fixture', cardFile: f.cardFile, contract: f.contract, dir: f.dir, archiveRoot: f.root, hard: false }, {
    query, log: () => {}, rules: [], env: {}, setTimer: () => 0, clearTimer: () => {},
    decisionStateRoot: join(f.root, 'decisions'),
    resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' } }),
    prepareSdkRole: () => ({ pluginPaths: [], lsp: { available: false, reason: 'fixture' } }),
  })
}

it('direct run refuses staged and unstaged owner paths together without changing any owner state', async () => {
  const f = fixture(); const before = ownerState(f.dir)
  const query = vi.fn(() => { throw new Error('query must not start') })
  await expect(directRun(f, query)).rejects.toThrow(
    /staged or tracked modifications: .*release config\.json.*source\.txt.*commit them or move them aside, then relaunch/,
  )
  expect(query).not.toHaveBeenCalled()
  expect(ownerState(f.dir)).toEqual(before)
  expect(git(f.dir, 'ls-files', '--others', '--exclude-standard')).toBe('owner notes.txt\n')
})

it('failed direct-run admission preserves the exact prior index even when a rejecting commit hook is installed', async () => {
  const f = fixture(); const before = ownerState(f.dir)
  const hooks = join(f.root, 'hooks'); mkdirSync(hooks)
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  git(f.dir, 'config', 'core.hooksPath', hooks)
  const query = vi.fn(() => { throw new Error('query must not start') })
  await expect(directRun(f, query)).rejects.toThrow(/SDK pilot preflight failed: staged or tracked modifications/)
  expect(ownerState(f.dir)).toEqual(before)
  expect(git(f.dir, 'diff', '--cached', '--name-only', '-z')).toBe('release config.json\0')
  expect(query).not.toHaveBeenCalled()
})

it('untracked owner scratch passes clean preflight and stays outside the real delivery commit', () => {
  const f = fixture(false)
  const before = readFileSync(join(f.dir, '.git', 'index'))
  expect(() => assertCleanPilotStart(f.dir)).not.toThrow()
  const baseline = artefactIdentitiesAtStart(f.dir).untracked
  expect(readFileSync(join(f.dir, '.git', 'index'))).toEqual(before)
  writeFileSync(join(f.dir, 'source.txt'), 'run change\n')
  writeFileSync(join(f.dir, 'new delivery.txt'), 'new run file\n')
  const selection = selectDeliveryPaths(f.dir, baseline)
  stageDeliverySelection(f.dir, selection)
  const staged = git(f.dir, 'diff', '--cached', '--name-only', '-z')
  git(f.dir, 'commit', '-qm', 'delivery')
  expect(git(f.dir, 'ls-tree', '-r', '--name-only', '-z', 'HEAD').split('\0')).not.toContain('owner notes.txt')
  expect(staged).toBe('new delivery.txt\0source.txt\0')
  expect(git(f.dir, 'show', 'HEAD:source.txt')).toBe('run change\n')
  expect(git(f.dir, 'show', 'HEAD:new delivery.txt')).toBe('new run file\n')
  expect(git(f.dir, 'diff', '--cached', '--name-only')).toBe('')
  expect(git(f.dir, 'status', '--porcelain=v1', '-z')).toBe('?? owner notes.txt\0')
  expect(readFileSync(join(f.dir, 'owner notes.txt'), 'utf8')).toBe('owner scratch\n')
})
