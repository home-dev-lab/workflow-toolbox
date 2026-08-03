import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkCitationMarkers } from '../citation-marker-check.ts'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const REPO_TREES = [
  'plugin/rules',
  'plugin/agent-templates',
  'plugin/launch-agents/agents',
  'plugin/skills',
]
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
    const result = checkCitationMarkers(REPO_ROOT, REPO_TREES)

    expect(result.scannedTrees).toEqual(REPO_TREES)
    expect(result.citations).toHaveLength(4)
    expect(result.findings).toEqual([])
  })
})
