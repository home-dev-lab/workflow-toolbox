import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkCitationMarkers,
  formatCitationSweepReport,
  REPO_PROSE_TREES,
  sha256,
  sweepCitationMarkers,
} from '../citation-marker-check.ts'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const FIXTURES_ROOT = resolve(import.meta.dirname, 'fixtures/citation-marker-check')

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'citation-marker-check-'))
  tempDirs.push(dir)
  cpSync(join(FIXTURES_ROOT, name), dir, { recursive: true })
  return dir
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function commitAll(root: string, message: string): void {
  runGit(root, ['add', '.'])
  runGit(root, ['commit', '-m', message])
}

function writeCitationFixture(root: string, text: string): void {
  mkdirSync(join(root, 'docs'), { recursive: true })
  const sourceClause = `\n${text}\n`
  const target = [
    '# Target',
    '',
    `<!-- cite: docs/source.md#canonical-rule sha256:${sha256(sourceClause)} -->`,
    '',
    '> copied text',
    '',
  ].join('\n')
  const source = [
    '# Source',
    '',
    '<!-- clause: canonical-rule:start -->',
    text,
    '<!-- clause: canonical-rule:end -->',
    '',
  ].join('\n')
  writeFileSync(join(root, 'docs/source.md'), source)
  writeFileSync(join(root, 'docs/target.md'), target)
}

function createBranchSweepRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'citation-branch-sweep-'))
  tempDirs.push(root)
  runGit(root, ['init', '-b', 'main'])
  runGit(root, ['config', 'user.name', 'Test User'])
  runGit(root, ['config', 'user.email', 'test@example.com'])

  writeCitationFixture(root, 'Canonical text that is still current.')
  commitAll(root, 'seed clean citation')

  runGit(root, ['checkout', '-b', 'feature-stale'])
  writeFileSync(
    join(root, 'docs/source.md'),
    [
      '# Source',
      '',
      '<!-- clause: canonical-rule:start -->',
      'Canonical text that changed only on this branch.',
      '<!-- clause: canonical-rule:end -->',
      '',
    ].join('\n'),
  )
  commitAll(root, 'make citation stale on branch')

  runGit(root, ['checkout', 'main'])
  runGit(root, ['checkout', '-b', 'feature-clean'])
  writeFileSync(join(root, 'docs/extra.md'), '# Extra\n\nNo citations here.\n')
  commitAll(root, 'add unrelated prose')
  runGit(root, ['checkout', 'main'])

  return root
}

function createSingleBranchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'citation-single-branch-'))
  tempDirs.push(root)
  runGit(root, ['init', '-b', 'main'])
  runGit(root, ['config', 'user.name', 'Test User'])
  runGit(root, ['config', 'user.email', 'test@example.com'])
  writeCitationFixture(root, 'Canonical text that is still current.')
  commitAll(root, 'seed clean citation')
  return root
}

describe('citation-marker-check', () => {
  it('flags a citation whose source clause changed, naming both files', () => {
    const root = copyFixture('stale')
    const result = checkCitationMarkers(root, ['.'])

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      kind: 'stale',
      citedFile: 'target.md',
      sourceFile: 'source.md',
      clauseId: 'canonical-rule',
    })
    expect(result.findings[0]?.message).toContain('target.md')
    expect(result.findings[0]?.message).toContain('source.md#canonical-rule')
  })

  it('stays silent when a cited source clause is unchanged', () => {
    const root = copyFixture('clean')
    const result = checkCitationMarkers(root, ['.'])

    expect(result.findings).toEqual([])
    expect(result.citations).toHaveLength(1)
  })

  it('flags a citation whose source clause no longer exists as dangling', () => {
    const root = copyFixture('dangling-clause')
    const result = checkCitationMarkers(root, ['.'])

    expect(result.findings).toEqual([
      {
        kind: 'dangling',
        citedFile: 'target.md',
        sourceFile: 'source.md',
        clauseId: 'canonical-rule',
        message: 'Dangling citation in target.md: source.md#canonical-rule was not found.',
      },
    ])
  })

  it('stays silent when a file is edited but cited nowhere', () => {
    const root = copyFixture('uncited-edit')
    const edited = join(root, 'notes.md')
    writeFileSync(edited, readFileSync(edited, 'utf8') + '\nEdited after the fact.\n')

    const result = checkCitationMarkers(root, ['.'])
    expect(result.findings).toEqual([])
    expect(result.citations).toEqual([])
  })

  it('stays silent, and does not throw, when there are no markers anywhere in the tree', () => {
    const root = copyFixture('empty-tree')
    expect(() => checkCitationMarkers(root, ['.'])).not.toThrow()
    expect(checkCitationMarkers(root, ['.'])).toMatchObject({ citations: [], findings: [] })
  })

  it('validates the seeded citations in this working tree across the enumerated prose trees only', () => {
    const result = checkCitationMarkers(REPO_ROOT, [...REPO_PROSE_TREES])

    expect(result.scannedTrees).toEqual([...REPO_PROSE_TREES])
    expect(result.citations).toHaveLength(4)
    expect(result.findings).toEqual([])
  })

  it('reports a citation that went stale on an unmerged branch, naming that branch', () => {
    const root = createBranchSweepRepo()

    const result = sweepCitationMarkers(root, { trees: ['docs'] })

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      kind: 'stale',
      tree: 'feature-stale',
      citedFile: 'docs/target.md',
      sourceFile: 'docs/source.md',
      clauseId: 'canonical-rule',
    })
    expect(formatCitationSweepReport(result)).toContain('feature-stale')
  })

  it('is silent about findings but explicit about scope when every covered tree is up to date', () => {
    const root = createSingleBranchRepo()

    const result = sweepCitationMarkers(root, { trees: ['docs'] })
    const output = formatCitationSweepReport(result)

    expect(result.findings).toEqual([])
    expect(output).toContain('scope: covered 1 tree(s): working tree')
    expect(output).toContain('DECLARED LIMIT outside-git copies')
    expect(output).toContain('No stale or dangling citations across covered trees.')
  })

  it('keeps the single-branch case working without any required branch flag', () => {
    const root = createSingleBranchRepo()

    const result = sweepCitationMarkers(root, { trees: ['docs'] })

    expect(result.treeReports.filter((report) => report.status === 'checked')).toHaveLength(1)
    expect(result.treeReports).not.toContainEqual(expect.objectContaining({ kind: 'git-branch', tree: 'main' }))
  })

  it('reports an unreadable branch as UNKNOWN instead of folding it into clean', () => {
    const root = createSingleBranchRepo()

    const result = sweepCitationMarkers(root, { trees: ['docs'], branchMode: 'none', branches: ['missing-branch'] })
    const output = formatCitationSweepReport(result)

    expect(result.findings).toEqual([])
    expect(result.treeReports).toContainEqual(
      expect.objectContaining({ kind: 'git-branch', tree: 'missing-branch', status: 'unknown' }),
    )
    expect(output).toContain('scope: UNKNOWN missing-branch')
    expect(output).not.toContain('covered 2 tree(s)')
  })
})
