import { describe, it, expect } from 'vitest'
import { relativizeUnder } from '../src/paths.js'

describe('relativizeUnder', () => {
  it('relativizes an absolute path under an absolute root', () => {
    expect(relativizeUnder('/repo', '/repo/src/x.ts')).toBe('src/x.ts')
  })

  it('handles deep nesting', () => {
    expect(relativizeUnder('/repo', '/repo/a/b/c.ts')).toBe('a/b/c.ts')
  })

  it('is boundary-safe: an adjacent prefix never matches', () => {
    expect(relativizeUnder('/a/b', '/a/bc/file')).toBeNull()
  })

  it('strips trailing slashes from the root before matching', () => {
    expect(relativizeUnder('/repo/', '/repo/src/x.ts')).toBe('src/x.ts')
    expect(relativizeUnder('/repo///', '/repo/src/x.ts')).toBe('src/x.ts')
  })

  it('returns null for the filesystem root (nothing is mappable under "/")', () => {
    expect(relativizeUnder('/', '/etc/passwd')).toBeNull()
  })

  it('returns null when the root is relative', () => {
    expect(relativizeUnder('.', '/abs/x.ts')).toBeNull()
    expect(relativizeUnder('rel/dir', '/rel/dir/x.ts')).toBeNull()
    expect(relativizeUnder('', '/x.ts')).toBeNull()
  })

  it('returns null when the path equals the root (empty remainder)', () => {
    expect(relativizeUnder('/repo', '/repo')).toBeNull()
    expect(relativizeUnder('/repo', '/repo/')).toBeNull()
  })

  it('returns null for a relative path (nothing to relativize)', () => {
    expect(relativizeUnder('/repo', 'src/x.ts')).toBeNull()
    expect(relativizeUnder('/repo', '')).toBeNull()
  })

  it('returns null for an absolute path outside the root', () => {
    expect(relativizeUnder('/repo', '/elsewhere/x.ts')).toBeNull()
  })

  // Pins the slice semantics shared by all three dev-workflow call sites:
  // a doubled separator survives into the remainder (POSIX callers should
  // not produce "//", but the helper must not silently normalize either).
  it('preserves a doubled separator in the remainder', () => {
    expect(relativizeUnder('/repo', '/repo//x.ts')).toBe('/x.ts')
  })
})
