// transcript-meta.test.ts — readMetaWithMtime, the one host read the arc watch uses to pair a
// sub-agent meta.json with that same file's mtime.

import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error TS7016 -- plain-JS plugin module with no declaration file (same escape as stop-correlation.test.ts)
import { readMetaWithMtime } from '../../../../plugin/bin/lib/host/transcript-meta.mjs'

const roots: string[] = []
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wt-transcript-meta-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readMetaWithMtime', () => {
  it('returns the parsed meta with the mtime of the same file', () => {
    const file = path.join(scratch(), 'agent-a1.meta.json')
    writeFileSync(file, JSON.stringify({ agentType: 'h-chore', finished: true }))
    const at = Date.parse('2026-11-08T09:11:13.500Z') / 1000
    utimesSync(file, at, at)
    const result = readMetaWithMtime(file)
    expect(result?.meta).toEqual({ agentType: 'h-chore', finished: true })
    expect(result?.mtimeMs).toBe(statSync(file).mtimeMs)
  })
  it('returns null for a missing file', () => {
    expect(readMetaWithMtime(path.join(scratch(), 'absent.meta.json'))).toBeNull()
  })
  it('returns null for content that is not JSON', () => {
    const file = path.join(scratch(), 'agent-a2.meta.json')
    writeFileSync(file, '{"finished": tr')
    expect(readMetaWithMtime(file)).toBeNull()
  })
})
