import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverConfigDirCandidates, readObserveConfig, writeObserveConfig } from '../src/observe-config.js'

// The hub's source-resolution FRONT DOOR — both feed the PURE resolveHubSources in
// observe-lifecycle.ts, but are themselves IMPURE fs readers (like project-registry.ts /
// config-dir.ts / source.ts elsewhere in this package), so — same convention as those —
// they're tested against a REAL tmp dir rather than an injected fs.
//
//  - readObserveConfig: the user's persistent, config-dir-independent source list
//    (<observeConfigRoot>/config.json). Tolerant by contract: never throws.
//  - discoverConfigDirCandidates: the auto-discovery RAW candidate list, before
//    existence-filtering/canonicalization/dedup (all three still happen in
//    resolveHubSources) — $CLAUDE_CONFIG_DIR (if set) + every existing `home` sibling
//    matching `.claude` or `.claude-<suffix>` (a glob, replacing the old hardcoded
//    `~/.claude-work`-only candidate), each ADDITIONALLY validated to CONTAIN a `projects/`
//    run store (the name-glob alone is too permissive — a stray `.claude-backup` or
//    `.claude-old` would otherwise be discovered and mounted as an empty source). This
//    content check applies ONLY on the discovery path (including $CLAUDE_CONFIG_DIR and
//    ~/.claude there) — explicit --source flags and config-file sources are trusted as-is,
//    never content-checked (see resolveHubSources' own doc comment).

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wt-observe-config-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('readObserveConfig', () => {
  it('returns { sources: [] } when config.json is absent', () => {
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes: [] })
  })

  it('returns { sources: [] } on malformed JSON', () => {
    writeFileSync(join(tmp, 'config.json'), '{ not json')
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes: [] })
  })

  it('returns { sources: [] } when the file is valid JSON but not an object', () => {
    writeFileSync(join(tmp, 'config.json'), '[1,2,3]')
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes: [] })
    writeFileSync(join(tmp, 'config.json'), '"just a string"')
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes: [] })
  })

  it('returns { sources: [] } when `sources` is missing or not an array', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({}))
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes: [] })
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ sources: 'nope' }))
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes: [] })
  })

  it('reads a valid sources array', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ sources: ['/a', '/b'] }))
    expect(readObserveConfig(tmp)).toEqual({ sources: ['/a', '/b'], remotes: [] })
  })

  it('drops non-string entries rather than rejecting the whole file', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ sources: ['/a', 1, null, '/b', { x: 1 }] }))
    expect(readObserveConfig(tmp)).toEqual({ sources: ['/a', '/b'], remotes: [] })
  })

  it('drops empty / whitespace-only string entries (codex review: "" canonicalizes to cwd and would mount the launch dir)', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ sources: ['', '   ', '/a', '\t'] }))
    expect(readObserveConfig(tmp)).toEqual({ sources: ['/a'], remotes: [] })
  })
})

// writeObserveConfig — the ONLY writer of the persistent source list (`wt-observe config
// add-source|remove-source`; `start` never writes here).
describe('writeObserveConfig', () => {
  it('round-trips through readObserveConfig', () => {
    writeObserveConfig(tmp, { sources: ['/a', '/b'], remotes: [] })
    expect(readObserveConfig(tmp)).toEqual({ sources: ['/a', '/b'], remotes: [] })
  })

  it('creates the config root directory when missing (mkdir -p)', () => {
    const nested = join(tmp, 'does', 'not', 'exist', 'yet')
    expect(existsSync(nested)).toBe(false)
    writeObserveConfig(nested, { sources: ['/a'], remotes: [] })
    expect(readObserveConfig(nested)).toEqual({ sources: ['/a'], remotes: [] })
  })

  it('overwrites an existing config.json (a second write replaces, not merges)', () => {
    writeObserveConfig(tmp, { sources: ['/a', '/b'], remotes: [] })
    writeObserveConfig(tmp, { sources: ['/c'], remotes: [] })
    expect(readObserveConfig(tmp)).toEqual({ sources: ['/c'], remotes: [] })
  })

  it('is atomic: no leftover temp file survives a successful write', () => {
    writeObserveConfig(tmp, { sources: ['/a'], remotes: [] })
    expect(readdirSync(tmp)).toEqual(['config.json'])
  })

  it('can persist an empty source list (e.g. after removing the last one)', () => {
    writeObserveConfig(tmp, { sources: ['/a'], remotes: [] })
    writeObserveConfig(tmp, { sources: [], remotes: [] })
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes: [] })
  })
})

// remotes — hub-federation entries ({ url, token?, tokenFile?, label? }) living NEXT TO
// sources in the same config.json (a SEPARATE, additive axis: sources stay plain strings,
// resolveHubSources never sees remotes). Same tolerant-read contract as sources.
describe('readObserveConfig — remotes (hub federation)', () => {
  it('returns remotes: [] when the field is missing or not an array', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ sources: ['/a'] }))
    expect(readObserveConfig(tmp)).toEqual({ sources: ['/a'], remotes: [] })
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ sources: ['/a'], remotes: 'nope' }))
    expect(readObserveConfig(tmp)).toEqual({ sources: ['/a'], remotes: [] })
  })

  it('reads a valid remotes array — url alone, and url with token/tokenFile/label', () => {
    const remotes = [
      { url: 'http://localhost:5175' },
      { url: 'http://localhost:5174', tokenFile: '/state/wt-observe/server.json', label: 'wsl' },
      { url: 'http://127.0.0.1:5199', token: 'abcdefabcdefabcdef' },
    ]
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ sources: [], remotes }))
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes })
  })

  it('drops entries that are not objects or lack a usable url, keeps the good ones', () => {
    writeFileSync(
      join(tmp, 'config.json'),
      JSON.stringify({
        sources: [],
        remotes: [{ url: 'http://a:1' }, 'not-an-object', 42, null, { token: 'x' }, { url: '' }, { url: '   ' }, { url: 7 }],
      }),
    )
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes: [{ url: 'http://a:1' }] })
  })

  it('drops blank/non-string OPTIONAL fields but keeps the entry (one bad field must not lose the remote)', () => {
    writeFileSync(
      join(tmp, 'config.json'),
      JSON.stringify({ sources: [], remotes: [{ url: 'http://a:1', token: '', tokenFile: 42, label: '  ' }] }),
    )
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes: [{ url: 'http://a:1' }] })
  })

  it('a bad remotes value never loses the sources (and vice versa)', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ sources: ['/a'], remotes: { url: 'x' } }))
    expect(readObserveConfig(tmp)).toEqual({ sources: ['/a'], remotes: [] })
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ sources: 'nope', remotes: [{ url: 'http://a:1' }] }))
    expect(readObserveConfig(tmp)).toEqual({ sources: [], remotes: [{ url: 'http://a:1' }] })
  })
})

describe('writeObserveConfig — remotes', () => {
  it('round-trips remotes through readObserveConfig', () => {
    const config = { sources: ['/a'], remotes: [{ url: 'http://localhost:5174', tokenFile: '/p', label: 'wsl' }] }
    writeObserveConfig(tmp, config)
    expect(readObserveConfig(tmp)).toEqual(config)
  })
})

describe('discoverConfigDirCandidates', () => {
  /** A real config-dir-shaped tmp dir: has the `projects/` run store the content-check
   *  requires. */
  function makeConfigDir(name: string): string {
    const dir = join(tmp, name)
    mkdirSync(join(dir, 'projects'), { recursive: true })
    return dir
  }

  it('finds `.claude` and every `.claude-<suffix>` sibling that HAS a projects/ run store, ignores a non-`.claude` sibling', () => {
    makeConfigDir('.claude')
    makeConfigDir('.claude-work')
    makeConfigDir('.claude-acme')
    makeConfigDir('not-claude') // has projects/ too — must still be excluded by NAME
    const out = discoverConfigDirCandidates({}, tmp)
    expect(new Set(out)).toEqual(new Set([join(tmp, '.claude'), join(tmp, '.claude-work'), join(tmp, '.claude-acme')]))
    expect(out).not.toContain(join(tmp, 'not-claude'))
  })

  it('returns glob siblings in DETERMINISTIC sorted order — `.claude` first, then `.claude-<suffix>` alphabetically (readdir order is filesystem-dependent, and this order becomes the switcher order + the default-active source)', () => {
    // Created deliberately out of order; the output must still be sorted regardless.
    makeConfigDir('.claude-work')
    makeConfigDir('.claude')
    makeConfigDir('.claude-acme')
    const out = discoverConfigDirCandidates({}, tmp)
    expect(out).toEqual([join(tmp, '.claude'), join(tmp, '.claude-acme'), join(tmp, '.claude-work')])
  })

  it('discovers a SYMLINKED `.claude-<suffix>` sibling that targets a real config dir (codex review: Dirent.isDirectory() is false for a symlink, but a symlinked config dir was supported pre-glob)', () => {
    const realTarget = join(tmp, 'real-claude-work')
    mkdirSync(join(realTarget, 'projects'), { recursive: true }) // the real dir has a projects/ store
    const link = join(tmp, '.claude-work')
    symlinkSync(realTarget, link) // ~/.claude-work is a symlink → the real dir
    const out = discoverConfigDirCandidates({}, tmp)
    expect(out).toContain(link)
  })

  it('drops a `.claude-*` sibling with NO projects/ subdirectory — the name-glob alone is not enough (a stray backup/junk dir must not be discovered)', () => {
    makeConfigDir('.claude-work')
    mkdirSync(join(tmp, '.claude-backup')) // matches the name glob, but no projects/ inside
    const out = discoverConfigDirCandidates({}, tmp)
    expect(out).toContain(join(tmp, '.claude-work'))
    expect(out).not.toContain(join(tmp, '.claude-backup'))
  })

  it('includes $CLAUDE_CONFIG_DIR when set AND it has a projects/ run store, even when its name does not match the glob at all', () => {
    const custom = makeConfigDir('somewhere-else')
    const out = discoverConfigDirCandidates({ CLAUDE_CONFIG_DIR: custom }, tmp)
    expect(out).toContain(custom)
  })

  it('drops $CLAUDE_CONFIG_DIR when it has NO projects/ run store (content-check applies to it too, on the discovery path)', () => {
    const empty = join(tmp, 'empty-dir')
    mkdirSync(empty)
    const out = discoverConfigDirCandidates({ CLAUDE_CONFIG_DIR: empty }, tmp)
    expect(out).not.toContain(empty)
  })

  it('ignores a FILE named `.claude-something` (glob candidates must be directories)', () => {
    writeFileSync(join(tmp, '.claude-notadir'), 'x')
    const out = discoverConfigDirCandidates({}, tmp)
    expect(out).not.toContain(join(tmp, '.claude-notadir'))
  })

  it('never throws when home is unreadable — degrades to an empty list (neither a bare ~/.claude guess nor a contentless $CLAUDE_CONFIG_DIR has a projects/ store to validate)', () => {
    const missingHome = join(tmp, 'does-not-exist')
    expect(() => discoverConfigDirCandidates({ CLAUDE_CONFIG_DIR: '/custom/dir-without-projects' }, missingHome)).not.toThrow()
    expect(discoverConfigDirCandidates({ CLAUDE_CONFIG_DIR: '/custom/dir-without-projects' }, missingHome)).toEqual([])
  })
})
