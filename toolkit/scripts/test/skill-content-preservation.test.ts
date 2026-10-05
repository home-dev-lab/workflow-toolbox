import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findDanglingReferences, findMissingLines, findUnlinkedReferences, frontmatterOf, main, normalizeLine } from '../skill-content-preservation.mjs'

describe('skill content preservation', () => {
  it('normalizes whitespace without rewording a line', () => {
    expect(normalizeLine('  alpha\t beta  ')).toBe('alpha beta')
  })

  it('accepts whitespace-only differences', () => {
    expect(findMissingLines('  alpha\t beta  \n', ['alpha beta\n'])).toEqual([])
  })

  it('accepts a line moved to a reference', () => {
    expect(findMissingLines('# Skill\nKeep me\nMove me', ['# Skill\nKeep me', '# Reference\nMove me'])).toEqual([])
  })

  it('names a deleted line and its original line number', () => {
    expect(findMissingLines('# Skill\n\n  Missing\t line  \nKeep', ['# Skill\nKeep'])).toEqual([
      { lineNumber: 3, line: 'Missing line' },
    ])
  })

  it('rejects a reworded line', () => {
    expect(findMissingLines('Read the source', ['Read a source'])).toEqual([
      { lineNumber: 1, line: 'Read the source' },
    ])
  })

  it('ignores blank lines', () => {
    expect(findMissingLines('\n \t\n\r\n', [''])).toEqual([])
  })

  it('requires whole-line membership rather than a substring', () => {
    expect(findMissingLines('keep', ['please keep this'])).toEqual([{ lineNumber: 1, line: 'keep' }])
  })

  it('counts repeated old lines, so deleting one copy of a repeated line is reported', () => {
    expect(findMissingLines('same\nsame\n', ['same'])).toEqual([{ lineNumber: 2, line: 'same' }])
  })

  it('accepts a repeated line whose copies are split between the body and a reference', () => {
    expect(findMissingLines('same\nother\nsame\n', ['same\nother', 'same'])).toEqual([])
  })

  it('preserves line numbers across CRLF and Unicode whitespace', () => {
    expect(findMissingLines('present\r\n\u00a0\r\nmissing\u2003line\r\n', ['present'])).toEqual([
      { lineNumber: 3, line: 'missing line' },
    ])
  })
})

describe('reference links', () => {
  it('reports an unlinked reference', () => {
    expect(findUnlinkedReferences('# Skill', ['details.md'])).toEqual(['details.md'])
  })

  it('accepts a linked reference', () => {
    expect(findUnlinkedReferences('Open [references/details.md](references/details.md).', ['details.md'])).toEqual([])
  })

  it('accepts sentence punctuation after a plain reference path', () => {
    expect(findUnlinkedReferences('Read references/details.md.', ['details.md'])).toEqual([])
  })

  it('accepts nested reference paths', () => {
    expect(findUnlinkedReferences('Read `references/nested/details.md`.', ['references/nested/details.md'])).toEqual([])
  })

  it('does not mistake a longer filename for the requested reference', () => {
    expect(findUnlinkedReferences('references/details.md.backup references/details.md-other', ['details.md'])).toEqual(['details.md'])
  })

  it('does not match a reference path inside a longer path', () => {
    expect(findUnlinkedReferences('other/references/details.md', ['details.md'])).toEqual(['details.md'])
  })

  it('treats regex punctuation in filenames literally', () => {
    expect(findUnlinkedReferences('references/a+b.md', ['a+b.md', 'ab.md'])).toEqual(['ab.md'])
  })

  it('does not count a mention hidden inside an HTML comment as a link', () => {
    expect(findUnlinkedReferences('# Skill\n<!-- references/details.md -->\n', ['details.md'])).toEqual(['details.md'])
  })

  it('reports a body mention whose reference file does not exist', () => {
    expect(findDanglingReferences('Open references/gone.md, then references/kept.md.', ['references/kept.md'])).toEqual([
      'references/gone.md',
    ])
  })

  it('reports no dangling mention when every named reference exists', () => {
    expect(findDanglingReferences('Open [references/a.md](references/a.md).', ['references/a.md'])).toEqual([])
  })
})

describe('frontmatter', () => {
  it('returns the frontmatter block, or an empty string when there is none', () => {
    expect(frontmatterOf('---\nname: x\ndescription: y\n---\n# Body\n')).toBe('---\nname: x\ndescription: y\n---')
    expect(frontmatterOf('# Body\n---\n')).toBe('')
  })
})

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(body = '# Skill\nKeep\nOpen references/nested/details.md\n') {
  const root = mkdtempSync(join(tmpdir(), 'skill-preservation-'))
  temporaryDirectories.push(root)
  const skillDir = join(root, 'skill')
  mkdirSync(join(skillDir, 'references', 'nested'), { recursive: true })
  writeFileSync(join(root, 'old.md'), '# Skill\nKeep\nMoved\n')
  writeFileSync(join(skillDir, 'SKILL.md'), body)
  writeFileSync(join(skillDir, 'references', 'nested', 'details.md'), '# Details\nMoved\n')
  writeFileSync(join(skillDir, 'references', 'notes.txt'), 'not a Markdown reference')
  return { root, skillDir, args: ['--old', join(root, 'old.md'), '--skill-dir', skillDir] }
}

describe('preservation CLI without child processes', () => {
  it('reads nested Markdown references and emits every successful check', () => {
    const { args } = fixture()
    const output: string[] = []
    expect(main(args, (line: string) => output.push(line))).toBe(0)
    expect(output).toEqual([
      'PRESERVATION: ok (0 missing non-blank lines)',
      'FRONTMATTER: ok',
      'LINKS: ok (1 references)',
      'SIZE: ok (47/15000 UTF-16 code units)',
      'RESULT: ok',
    ])
  })

  it('reports a missing line with its old line number and returns 1', () => {
    const { args, skillDir } = fixture()
    writeFileSync(join(skillDir, 'references', 'nested', 'details.md'), '# Details\n')
    const output: string[] = []
    expect(main(args, (line: string) => output.push(line))).toBe(1)
    expect(output).toContain('MISSING line 3: Moved')
    expect(output.at(-1)).toBe('RESULT: fail')
  })

  it('reports an unlinked reference and returns 1', () => {
    const { args } = fixture('# Skill\nKeep\n')
    const output: string[] = []
    expect(main(args, (line: string) => output.push(line))).toBe(1)
    expect(output).toContain('UNLINKED: references/nested/details.md')
    expect(output.at(-1)).toBe('RESULT: fail')
  })

  it('reports a changed frontmatter and returns 1', () => {
    const { args, root, skillDir } = fixture('---\nname: s\ndescription: new\n---\nKeep\nOpen references/nested/details.md\n')
    writeFileSync(join(root, 'old.md'), '---\nname: s\ndescription: old\n---\nKeep\nMoved\n')
    writeFileSync(join(skillDir, 'references', 'nested', 'details.md'), 'Moved\ndescription: old\n')
    const output: string[] = []
    expect(main(args, (line: string) => output.push(line))).toBe(1)
    expect(output).toContain('FRONTMATTER: fail (SKILL.md frontmatter differs from the old one)')
    expect(output.at(-1)).toBe('RESULT: fail')
  })

  it('reports a dangling reference mention and returns 1', () => {
    const { args } = fixture('# Skill\nKeep\nOpen references/nested/details.md\nOpen references/gone.md\n')
    const output: string[] = []
    expect(main(args, (line: string) => output.push(line))).toBe(1)
    expect(output).toContain('DANGLING: references/gone.md')
    expect(output.at(-1)).toBe('RESULT: fail')
  })

  it('measures JavaScript UTF-16 length and honors --max-chars', () => {
    const { args } = fixture('# Skill\nKeep\nOpen references/nested/details.md\n😀')
    const output: string[] = []
    expect(main([...args, '--max-chars', '48'], (line: string) => output.push(line))).toBe(1)
    expect(output).toContain('SIZE: fail (49/48 UTF-16 code units)')
  })

  it('accepts the exact size boundary', () => {
    const { args } = fixture()
    expect(main([...args, '--max-chars', '47'], () => {})).toBe(0)
  })

  it('accepts a skill without a references directory', () => {
    const { args, skillDir } = fixture('# Skill\nKeep\nMoved\n')
    rmSync(join(skillDir, 'references'), { recursive: true })
    expect(main(args, () => {})).toBe(0)
  })

  it.each([
    [], ['--old', 'old.md'], ['--unknown', 'value'],
    ['--old', 'old.md', '--skill-dir', 'skill', '--max-chars', 'nope'],
    ['--old', 'old.md', '--skill-dir', 'skill', '--max-chars', '0'],
    ['--old', 'old.md', '--skill-dir', 'skill', '--max-chars', '1.5'],
    ['--old', 'old.md', '--skill-dir', 'skill', '--old', 'other.md'],
  ])('returns usage exit 2 for invalid arguments %j', (...args: string[]) => {
    const output: string[] = []
    expect(main(args, (line: string) => output.push(line))).toBe(2)
    expect(output[0]).toContain('USAGE:')
    expect(output.at(-1)).toBe('RESULT: fail')
  })

  it('returns failure rather than usage error for an unreadable input', () => {
    const { args, root } = fixture()
    rmSync(join(root, 'old.md'))
    const output: string[] = []
    expect(main(args, (line: string) => output.push(line))).toBe(1)
    expect(output[0]).toContain('ERROR:')
    expect(output.at(-1)).toBe('RESULT: fail')
  })
})
