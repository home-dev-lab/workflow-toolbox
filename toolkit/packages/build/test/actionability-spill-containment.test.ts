// The actionability producer hook can be handed a PATH instead of a payload: the harness
// diverts a large tool response to a file and says where it put it. That path comes from the
// tool response, so reading it unconditionally lets an untrusted value choose which file the
// hook opens.
//
// These rows lock the four bounds that make the read answerable. Each one is written so it
// FAILS if its bound is removed — the point of a containment test is that it can go red, and
// an "allowed path is read" row alone would stay green with every bound deleted.
//
// ⚠ Hermetic: every path is built under a fresh temp directory, so no machine state decides
// the verdict. The one row that must live OUTSIDE the allowed roots uses a directory the
// allow-list does not name, created and removed by the test itself.

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { readSpilledFileGuarded } from '../../../../plugin/bin/lib/spill-containment.mjs'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDirInsideAllowedRoot(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'wt-spill-'))
  made.push(d)
  return d
}

/** A directory that is deliberately NOT under tmp, the state root, or <config>/projects. */
function dirOutsideAllowedRoots(): string {
  const d = mkdtempSync(join(realpathSync(homedir()), '.wt-spill-outside-'))
  made.push(d)
  return d
}

describe('actionability spill-file containment', () => {
  it('reads a plain file inside an allowed root', () => {
    const dir = tempDirInsideAllowedRoot()
    const p = join(dir, 'payload.json')
    writeFileSync(p, '{"ok":true}')
    expect(readSpilledFileGuarded(p)).toBe('{"ok":true}')
  })

  // THE case. Without the allow-list this returns the file's content.
  it('refuses a path outside every allowed root, even when the file exists and is readable', () => {
    const dir = dirOutsideAllowedRoots()
    const p = join(dir, 'not-a-spill.txt')
    writeFileSync(p, 'content the hook must not read')
    expect(readSpilledFileGuarded(p)).toBeNull()
  })

  // ⚠ This row locks the PLAIN-FILE bound, not canonicalisation — measured, not assumed.
  // With the allow-list deleted it still passes, because `lstat` on a symlink reports a link
  // rather than a file. Naming it "canonicalisation" would have been a green proving nothing.
  it('refuses a symlink, because lstat sees a link and not a plain file', () => {
    const inside = tempDirInsideAllowedRoot()
    const outside = dirOutsideAllowedRoots()
    const target = join(outside, 'target.txt')
    writeFileSync(target, 'escaped')
    const link = join(inside, 'link.txt')
    symlinkSync(target, link)
    expect(readSpilledFileGuarded(link)).toBeNull()
  })

  // THIS is the canonicalisation row. The final path IS a plain file, so the lstat bound lets
  // it through; only realpath sees that the directory above it leaves the allowed root.
  // Deleting the realpath call turns this red and leaves the row above green.
  it('refuses a real file reached THROUGH a symlinked directory that escapes the allowed root', () => {
    const inside = tempDirInsideAllowedRoot()
    const outside = dirOutsideAllowedRoots()
    writeFileSync(join(outside, 'payload.json'), '{"escaped":true}')
    const linkedDir = join(inside, 'escape')
    symlinkSync(outside, linkedDir)
    // A plain file by lstat, inside an allowed root by string — and outside it by realpath.
    expect(readSpilledFileGuarded(join(linkedDir, 'payload.json'))).toBeNull()
  })

  // The size cap, exercised through the env knob so the test writes kilobytes, not megabytes.
  it('refuses a file larger than the cap', () => {
    const dir = tempDirInsideAllowedRoot()
    const p = join(dir, 'big.json')
    writeFileSync(p, 'x'.repeat(4096))
    const previous = process.env.WT_ACTIONABLE_MAX_SPILL_BYTES
    process.env.WT_ACTIONABLE_MAX_SPILL_BYTES = '1024'
    try {
      expect(readSpilledFileGuarded(p)).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.WT_ACTIONABLE_MAX_SPILL_BYTES
      else process.env.WT_ACTIONABLE_MAX_SPILL_BYTES = previous
    }
  })

  it('refuses a relative path', () => {
    expect(readSpilledFileGuarded('relative/payload.json')).toBeNull()
  })

  it('refuses a directory, and anything that is not a plain file', () => {
    const dir = tempDirInsideAllowedRoot()
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    expect(readSpilledFileGuarded(sub)).toBeNull()
  })

  it('refuses a missing file without throwing', () => {
    const dir = tempDirInsideAllowedRoot()
    expect(readSpilledFileGuarded(join(dir, 'absent.json'))).toBeNull()
  })

  it('refuses a non-string path without throwing', () => {
    expect(readSpilledFileGuarded(undefined as unknown as string)).toBeNull()
    expect(readSpilledFileGuarded('')).toBeNull()
  })
})
