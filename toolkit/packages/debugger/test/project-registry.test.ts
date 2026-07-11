import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readProjectRegistry, readRegistryFile, resolveProjectSlug } from '../src/project-registry.js'

// Claude Code's own registry: <configDir>/.claude.json, top-level `projects` object
// whose KEYS are real absolute project paths. File or key may be absent — every
// reader here is TOLERANT (never throws), like the rest of this package's fs layer.

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wt-registry-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeRegistry(path: string, body: unknown): void {
  writeFileSync(path, JSON.stringify(body))
}

describe('readRegistryFile', () => {
  it('returns the projects keys, in first-seen order', () => {
    const path = join(tmp, 'reg.json')
    writeRegistry(path, { projects: { '/home/u/proj-a': {}, '/home/u/proj-b': {} } })
    expect(readRegistryFile(path)).toEqual(['/home/u/proj-a', '/home/u/proj-b'])
  })

  it('dedups keys', () => {
    // JSON object keys are already unique post-parse, but the reader is explicitly
    // documented to dedup — this pins that no accidental double-counting sneaks in.
    const path = join(tmp, 'reg.json')
    writeRegistry(path, { projects: { '/home/u/proj-a': {} } })
    const out = readRegistryFile(path)
    expect(out).toEqual(['/home/u/proj-a'])
    expect(new Set(out).size).toBe(out.length)
  })

  it('returns [] when the file does not exist', () => {
    expect(readRegistryFile(join(tmp, 'missing.json'))).toEqual([])
  })

  it('returns [] on malformed JSON', () => {
    const path = join(tmp, 'bad.json')
    writeFileSync(path, '{ not json')
    expect(readRegistryFile(path)).toEqual([])
  })

  it('returns [] when `projects` is absent', () => {
    const path = join(tmp, 'reg.json')
    writeRegistry(path, { other: true })
    expect(readRegistryFile(path)).toEqual([])
  })

  it('returns [] when `projects` is an array', () => {
    const path = join(tmp, 'reg.json')
    writeRegistry(path, { projects: ['/home/u/proj-a'] })
    expect(readRegistryFile(path)).toEqual([])
  })

  it('returns [] when `projects` is null', () => {
    const path = join(tmp, 'reg.json')
    writeRegistry(path, { projects: null })
    expect(readRegistryFile(path)).toEqual([])
  })

  it('drops non-path junk keys', () => {
    const path = join(tmp, 'reg.json')
    writeRegistry(path, { projects: { '/home/u/proj-a': {}, someRandomFlag: {}, '': {} } })
    expect(readRegistryFile(path)).toEqual(['/home/u/proj-a'])
  })

  it('keeps Windows drive-letter keys', () => {
    const path = join(tmp, 'reg.json')
    writeRegistry(path, { projects: { 'C:\\Users\\fred\\proj': {}, 'D:/dev/proj2': {} } })
    expect(readRegistryFile(path)).toEqual(['C:\\Users\\fred\\proj', 'D:/dev/proj2'])
  })
})

describe('readProjectRegistry', () => {
  it('reads .claude.json under the given config dir', () => {
    writeRegistry(join(tmp, '.claude.json'), { projects: { '/home/u/proj-a': {} } })
    expect(readProjectRegistry(tmp)).toEqual(['/home/u/proj-a'])
  })

  it('returns [] when .claude.json is absent', () => {
    expect(readProjectRegistry(tmp)).toEqual([])
  })
})

describe('resolveProjectSlug', () => {
  it('resolves an exact match', () => {
    const slug = '-home-u-dwt'
    expect(resolveProjectSlug(slug, ['/home/u/dwt'])).toBe('/home/u/dwt')
  })

  it('folds a sub-cwd run slug to the registered root project', () => {
    // e.g. a run launched from toolkit/apps/observe-ui inside a repo registered at its root.
    const subSlug = '-home-u-dwt-toolkit-apps-observe-ui'
    expect(resolveProjectSlug(subSlug, ['/home/u/dwt'])).toBe('/home/u/dwt')
  })

  it('applies the "-" boundary guard — a sibling dir must NOT match', () => {
    // slug(/home/u/proj) = "-home-u-proj", which is a naive STRING prefix of
    // slug(/home/u/project) = "-home-u-project" but not at a "-" boundary.
    const siblingSlug = '-home-u-project'
    expect(resolveProjectSlug(siblingSlug, ['/home/u/proj'])).toBeNull()
  })

  it('ACCEPTED HEURISTIC LIMIT (verifier-confirmed, not desired behavior): a punctuation-sibling collides through the boundary guard', () => {
    // projectSlug() maps EVERY non-alphanumeric to '-', so the boundary guard cannot tell a
    // REAL '-' already in an unregistered sibling's name apart from the mapped '/' — an
    // unregistered /home/u/proj-secret slugs to "-home-u-proj-secret", which DOES satisfy
    // `S.startsWith(projectSlug(R) + '-')` for registered R = /home/u/proj. This is a pin,
    // not a bug report: the slug is irreversibly lossy (no algorithm change recovers the
    // distinction from the string alone), the field is display/facet-only, and in practice a
    // sibling the user actually opened would itself be registered (longest-prefix-wins then
    // rescues it) — see resolveProjectSlug's own doc for the full accepted-limit rationale.
    const siblingSlug = '-home-u-proj-secret'
    expect(resolveProjectSlug(siblingSlug, ['/home/u/proj'])).toBe('/home/u/proj')
  })

  it('picks the longest matching registry slug (deepest registered project wins)', () => {
    const slug = '-home-u-dwt-toolkit-apps-observe-ui-src'
    const registry = ['/home/u/dwt', '/home/u/dwt/toolkit/apps/observe-ui']
    expect(resolveProjectSlug(slug, registry)).toBe('/home/u/dwt/toolkit/apps/observe-ui')
  })

  it('breaks a same-length slug tie by lexicographically smallest path', () => {
    // "/home/u/proj.x" and "/home/u/proj-x" both slugify to "-home-u-proj-x".
    const slug = '-home-u-proj-x'
    const registry = ['/home/u/proj-x', '/home/u/proj.x']
    expect(resolveProjectSlug(slug, registry)).toBe('/home/u/proj-x')
  })

  it('returns null when nothing matches', () => {
    expect(resolveProjectSlug('-home-u-other', ['/home/u/dwt'])).toBeNull()
  })

  it('returns null for an empty slug', () => {
    expect(resolveProjectSlug('', ['/home/u/dwt'])).toBeNull()
  })

  it('returns null for an empty registry', () => {
    expect(resolveProjectSlug('-home-u-dwt', [])).toBeNull()
  })
})
