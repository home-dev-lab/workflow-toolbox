import { describe, expect, it } from 'vitest'

import { quoteRemedyWord } from '../../../../plugin/bin/lib/remedy-quote.mjs'

// Expectations are written out by hand, never derived from the helper's own escaping.
describe('quoteRemedyWord', () => {
  it.each([
    ['C:\\Users\\me\\repo', 'C:\\Users\\me\\repo'],
    ['C:\\Users\\John Doe\\repo', '"C:\\Users\\John Doe\\repo"'],
    ['a "quoted" repo', '"a \\"quoted\\" repo"'],
    // A backslash run before a closing quote is doubled, or the quote is read as escaped.
    ['C:\\my dir\\', '"C:\\my dir\\\\"'],
    ['C:\\my dir\\\\', '"C:\\my dir\\\\\\\\"'],
    // A backslash run before an embedded quote is doubled, then the quote is escaped.
    ['a\\"b c', '"a\\\\\\"b c"'],
    // Backslashes elsewhere stay literal.
    ['C:\\a b\\c', '"C:\\a b\\c"'],
    ['', '""'],
  ])('win32: %s', (value, expected) => {
    expect(quoteRemedyWord(value, 'win32')).toBe(expected)
  })

  it.each([
    ['/home/me/repo', '/home/me/repo'],
    ["/home/me/it's a repo", `'/home/me/it'"'"'s a repo'`],
    ['/home/me/dir\\', `'/home/me/dir\\'`],
    ['', "''"],
  ])('linux: %s', (value, expected) => {
    expect(quoteRemedyWord(value, 'linux')).toBe(expected)
  })

  it('quotes a safe word on POSIX only when asked to', () => {
    expect(quoteRemedyWord('/home/me/repo', 'linux', true)).toBe("'/home/me/repo'")
    expect(quoteRemedyWord('C:\\repo', 'win32', true)).toBe('C:\\repo')
  })
})
