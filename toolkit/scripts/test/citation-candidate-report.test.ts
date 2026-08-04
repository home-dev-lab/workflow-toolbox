import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIN_SHARED_WORDS, findCitationCandidates, tokenizeNonTrivialWords } from '../citation-candidate-report.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'citation-candidate-report-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'plugin', 'rules'), { recursive: true })
  mkdirSync(join(root, 'plugin', 'agent-templates'), { recursive: true })
  mkdirSync(join(root, 'plugin', 'launch-agents', 'agents'), { recursive: true })
  mkdirSync(join(root, 'plugin', 'skills', 'demo', 'references'), { recursive: true })
  return root
}

describe('tokenizeNonTrivialWords', () => {
  it('keeps only non-trivial words and tracks the line number where each token starts', () => {
    const tokens = tokenizeNonTrivialWords('One two\nAlpha beta CLI\nGamma')
    expect(tokens.map((token) => [token.word, token.line])).toEqual([
      ['alpha', 2],
      ['beta', 2],
      ['gamma', 3],
    ])
  })
})

describe('findCitationCandidates', () => {
  it('groups one repeated block across more than two files and ignores same-file-only repeats', () => {
    const root = makeRepo()
    const shared = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet.'

    writeFileSync(join(root, 'plugin', 'rules', 'source.md'), `# Source\n\n${shared}\n`)
    writeFileSync(join(root, 'plugin', 'agent-templates', 'pilot.md'), `# Pilot\n\n${shared}\n`)
    writeFileSync(join(root, 'plugin', 'launch-agents', 'agents', 'pilot.md'), `# Agent\n\n${shared}\n`)
    writeFileSync(
      join(root, 'plugin', 'skills', 'demo', 'SKILL.md'),
      '# Demo\n\nrepeat repeat repeat repeat repeat repeat repeat repeat\nrepeat repeat repeat repeat repeat repeat repeat repeat\n',
    )

    const report = findCitationCandidates(root)

    expect(report.candidateGroups).toHaveLength(1)
    expect(report.candidateGroups[0]?.wordCount).toBeGreaterThanOrEqual(MIN_SHARED_WORDS)
    expect(report.candidateGroups[0]?.occurrences.map((occurrence) => occurrence.file)).toEqual([
      'plugin/agent-templates/pilot.md',
      'plugin/launch-agents/agents/pilot.md',
      'plugin/rules/source.md',
    ])
  })

  it('counts overlap with a marked citation separately from genuinely unmarked groups', () => {
    const root = makeRepo()
    const marked = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet.'
    const unmarked = 'Kilo lima mike november oscar papa quebec romeo sierra tango.'

    writeFileSync(
      join(root, 'plugin', 'rules', 'source.md'),
      '# Source\n\n<!-- clause: rule:start -->\n' +
        `${marked}\n` +
        '<!-- clause: rule:end -->\n\n' +
        'Zulu yankee xray whiskey victor uniform tango sierra romeo quebec.\n',
    )
    writeFileSync(
      join(root, 'plugin', 'agent-templates', 'pilot.md'),
      '# Pilot\n\n' +
        '<!-- cite: plugin/rules/source.md#rule sha256:41dc44c122f5b576bf5674c8f301503f5416ff104d92a1f6324f07fb998eb01e -->\n' +
        `${marked}\n\n` +
        `${unmarked}\n`,
    )
    writeFileSync(join(root, 'plugin', 'launch-agents', 'agents', 'pilot.md'), `# Agent\n\n${unmarked}\n`)

    const report = findCitationCandidates(root)

    expect(report.candidateGroups).toHaveLength(2)
    expect(report.markedOverlapGroups).toBe(1)
    expect(report.markedCitationCount).toBe(1)
    expect(report.genuinelyUnmarkedGroups).toBe(1)
  })
})
