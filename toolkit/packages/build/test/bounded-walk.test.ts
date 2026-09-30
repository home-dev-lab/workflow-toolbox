import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { createBudget, walkFiles } from '../../../../plugin/bin/lib/bounded-walk.mjs'

function withWalkRoot(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-walk-race-'))
  try { run(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
const acceptMarkdown = (_rel: string, name: string) => name.endsWith('.md')

describe('bounded walk', () => {
  it('ignores a listed child deleted before lstat after confirming its absence', () => withWalkRoot((root) => {
    const gone = path.join(root, 'a-gone.md'), sibling = path.join(root, 'z-live.md')
    fs.writeFileSync(gone, 'gone')
    fs.writeFileSync(sibling, 'live')
    const vanished: string[] = []
    const injected = { ...fs, lstatSync: (file: string) => {
      if (file === gone) { vanished.push(file); fs.unlinkSync(file) }
      return fs.lstatSync(file)
    } }
    const result = walkFiles([root], { fs: injected, accept: acceptMarkdown })
    expect(vanished).toEqual([gone])
    expect(fs.existsSync(gone)).toBe(false)
    expect(result).toEqual({ files: [{ root, file: sibling, rel: 'z-live.md' }], errors: [], exhausted: null })
  }))

  it('records ENOENT when a listed child is renamed before lstat', () => withWalkRoot((root) => {
    const old = path.join(root, 'pilot.md'), renamed = path.join(root, 'lead.md')
    fs.writeFileSync(old, 'agent')
    const injected = { ...fs, lstatSync: (file: string) => {
      if (file === old) fs.renameSync(old, renamed)
      return fs.lstatSync(file)
    } }
    const result = walkFiles([root], { fs: injected })
    expect(fs.existsSync(renamed)).toBe(true)
    expect(result.errors).toEqual([{ path: old, code: 'ENOENT' }])
  }))

  it('records ENOENT when the failed child is still in the second listing', () => withWalkRoot((root) => {
    const file = path.join(root, 'pilot.md')
    fs.writeFileSync(file, 'agent')
    const injected = { ...fs, lstatSync: (name: string) => {
      if (name === file) throw Object.assign(new Error('unstatable name'), { code: 'ENOENT' })
      return fs.lstatSync(name)
    } }
    expect(walkFiles([root], { fs: injected }).errors).toEqual([{ path: file, code: 'ENOENT' }])
  }))

  it('keeps a dangling root absent while refusing a dangling non-agent child', () => withWalkRoot((root) => {
    const link = path.join(root, 'broken')
    fs.symlinkSync(path.join(root, 'missing'), link)
    expect(walkFiles([link], { accept: acceptMarkdown })).toEqual({ files: [], errors: [], exhausted: null })
    expect(walkFiles([root], { accept: acceptMarkdown }).errors).toEqual([{ path: link, code: 'ENOENT' }])
  }))

  it.skipIf(process.platform === 'win32')('ignores a non-accepted FIFO child (requires POSIX mkfifo)', () => withWalkRoot((root) => {
    execFileSync('mkfifo', [path.join(root, 'pipe')])
    expect(walkFiles([root], { accept: acceptMarkdown })).toEqual({ files: [], errors: [], exhausted: null })
  }))

  it.skipIf(process.platform === 'win32')('refuses an accepted FIFO child and every FIFO root (requires POSIX mkfifo)', () => withWalkRoot((root) => {
    const pipe = path.join(root, 'pipe.md')
    execFileSync('mkfifo', [pipe])
    expect(walkFiles([root], { accept: acceptMarkdown }).errors).toEqual([{ path: pipe, code: 'NOT_REGULAR' }])
    expect(walkFiles([pipe], { accept: () => false }).errors).toEqual([{ path: pipe, code: 'NOT_REGULAR' }])
  }))

  it.each(['dirs', 'entries'])('charges the confirmation listing to the %s budget', (limit) => withWalkRoot((root) => {
    const gone = path.join(root, 'a-gone.md')
    fs.writeFileSync(gone, 'gone')
    fs.writeFileSync(path.join(root, 'z-live.md'), 'live')
    const injected = { ...fs, lstatSync: (file: string) => {
      if (file === gone) fs.unlinkSync(file)
      return fs.lstatSync(file)
    } }
    const budget = createBudget(limit === 'dirs' ? { maxDirs: 1 } : { maxEntries: 3 })
    expect(walkFiles([root], { fs: injected, budget }).exhausted).toBe(limit)
  }))

  it.each(['open', 'read', 'close'])('fails closed when the confirmation listing cannot %s', (failure) => withWalkRoot((root) => {
    const gone = path.join(root, 'gone.md')
    fs.writeFileSync(gone, 'gone')
    let listings = 0
    const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
    const injected = { ...fs, lstatSync: (file: string) => {
      if (file === gone) fs.unlinkSync(file)
      return fs.lstatSync(file)
    }, opendirSync: (dir: string) => {
      const confirming = ++listings === 2
      if (confirming && failure === 'open') denied()
      const handle = fs.opendirSync(dir)
      return {
        readSync: () => confirming && failure === 'read' ? denied() : handle.readSync(),
        closeSync: () => { handle.closeSync(); if (confirming && failure === 'close') denied() },
      }
    } }
    expect(walkFiles([root], { fs: injected }).errors).toEqual([{ path: root, code: 'EACCES' }, { path: gone, code: 'ENOENT' }])
  }))

  it('enumerates seeded generated trees despite broken siblings and cycles', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-generated-walk-'))
    let state = 0x714d2
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
    const expected: string[] = []
    try {
      for (let i = 0; i < 60; i++) {
        const folder = path.join(root, `dir-${String(i).padStart(3, '0')}`)
        fs.mkdirSync(folder)
        for (let j = 0; j < 1 + random() % 4; j++) {
          const file = path.join(folder, `agent-${j}.md`)
          fs.writeFileSync(file, `---\nname: agent-${i}-${j}\n---\n`)
          expected.push(file)
        }
        fs.writeFileSync(path.join(folder, 'ignore.txt'), 'ignored')
        fs.symlinkSync(path.join(folder, 'gone'), path.join(folder, 'broken.md'))
        fs.symlinkSync(root, path.join(folder, 'loop'))
        if (i === 0) {
          fs.symlinkSync(path.join(folder, 'agent-0.md'), path.join(folder, 'linked.md'))
          if (process.platform !== 'win32') execFileSync('mkfifo', [path.join(folder, 'pipe.md')])
        }
      }
      const result = walkFiles([root], { accept: (_rel: string, name: string) => name.endsWith('.md') })
      expect(result.exhausted).toBeNull()
      expect(result.files.map((f: { file: string }) => f.file).sort()).toEqual([...expected, path.join(root, 'dir-000', 'linked.md')].sort())
      expect(result.errors.length).toBeGreaterThanOrEqual(60)
      expect(walkFiles([root], { budget: createBudget({ maxDirs: 4 }) }).exhausted).toBe('dirs')
      expect(walkFiles([root], { budget: createBudget({ maxEntries: 12 }) }).exhausted).toBe('entries')
      const deep = path.join(root, 'deep')
      fs.mkdirSync(deep)
      let cursor = deep
      for (let i = 0; i < 16; i++) { cursor = path.join(cursor, 'x'); fs.mkdirSync(cursor) }
      expect(walkFiles([deep], { budget: createBudget({ maxDepth: 3 }) }).exhausted).toBe('depth')
      const injected = { ...fs, opendirSync: (dir: string) => {
        if (dir.endsWith('dir-000')) { const error = Object.assign(new Error('denied'), { code: 'EACCES' }); throw error }
        return fs.opendirSync(dir)
      } }
      const isolated = walkFiles([root], { fs: injected, budget: createBudget({ maxDepth: 20 }), accept: (_rel: string, name: string) => name.endsWith('.md') })
      expect(isolated.files.map((f: { file: string }) => f.file).sort()).toEqual(expected.filter((f) => !f.includes('dir-000')).sort())
      expect(isolated.errors.some((e: { code: string }) => e.code === 'EACCES')).toBe(true)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  it('preserves a valid sibling of a dangling symlink and bounds entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-walk-'))
    try {
      fs.writeFileSync(path.join(root, 'pilot.md'), 'ok')
      fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'z-broken'))
      const result = walkFiles([root], { accept: (_rel: string, name: string) => name.endsWith('.md') })
      expect(result.files.map((f: { file: string }) => path.basename(f.file))).toEqual(['pilot.md'])
      expect(result.errors.length).toBeGreaterThan(0)
      expect(walkFiles([root], { budget: createBudget({ maxEntries: 1 }) }).exhausted).toBe('entries')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
