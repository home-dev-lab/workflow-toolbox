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

  // Lexical containment is not semantic containment — both of these would
  // defeat the caller's "relative ⇒ inside the root" assumption, so the
  // helper rejects them rather than silently normalizing.
  it('returns null for a doubled separator (the remainder would look absolute)', () => {
    expect(relativizeUnder('/repo', '/repo//x.ts')).toBeNull()
  })

  it('returns null for a ".." segment (resolves outside the root)', () => {
    expect(relativizeUnder('/repo', '/repo/../etc/passwd')).toBeNull()
    expect(relativizeUnder('/repo', '/repo/a/../../etc/x')).toBeNull()
    expect(relativizeUnder('/repo', '/repo/..')).toBeNull()
  })

  it('does not reject dotted names that merely CONTAIN dots', () => {
    expect(relativizeUnder('/repo', '/repo/a..b/x..ts')).toBe('a..b/x..ts')
    expect(relativizeUnder('/repo', '/repo/.hidden/x.ts')).toBe('.hidden/x.ts')
  })
})
