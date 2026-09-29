import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { collectLaneAttachments, copyAttachmentsForLane, explicitAttachRefusal, removeRunSnapshots, verifyAttachmentSnapshots, writeAttachmentSnapshots } from '../../../../plugin/bin/lib/host/lane-attachments.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { trustedSystemExecutable } from '../../../../plugin/bin/lib/host/lane-sandbox.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { applyLanePriority } from '../../../../plugin/bin/lib/host/lane-priority.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-attach-'))); roots.push(root)
  const main = join(root, 'main'); const dir = join(root, 'linked')
  mkdirSync(main); git(main, 'init', '-q'); git(main, 'commit', '-q', '--allow-empty', '-m', 'x'); git(main, 'worktree', 'add', '-q', '-b', 'lane', dir)
  return { root, main, dir }
}
const put = (base: string, name: string, body: string) => { mkdirSync(join(base, '.claude'), { recursive: true }); const file = join(base, '.claude', name); writeFileSync(file, body); return file }
const names = (result: ReturnType<typeof collectLaneAttachments>) => (result.items ?? []).map((item: { name: string }) => item.name)

describe('applyLanePriority (injected platform, run and setPriority)', () => {
  const call = (priority: string, options: Record<string, unknown>) => {
    const calls: unknown[][] = []
    const line = applyLanePriority(priority, { pid: 42, setPriority: (...a: unknown[]) => { calls.push(['set', ...a]) }, run: (...a: unknown[]) => { calls.push(['run', ...a]); return { status: 0 } }, resolve: () => '/usr/bin/ionice', ...options })
    return { line, calls }
  }
  it('linux success sets niceness 19 and the idle I/O class', () => {
    const { line, calls } = call('low', { platform: 'linux' })
    expect(line).toBe('priority nice=19 ionice=idle')
    expect(calls).toEqual([['set', 42, 19], ['run', '/usr/bin/ionice', ['-c', '3', '-p', '42'], expect.anything()]])
  })
  it('linux without ionice on an absolute PATH entry says so and still niceness 19', () => {
    expect(call('low', { platform: 'linux', resolve: () => null }).line).toBe('priority nice=19 ionice=unavailable (not found in a trusted system location)')
  })
  it('linux ionice failing to start or exiting non-zero is degraded, never a failure', () => {
    expect(call('low', { platform: 'linux', run: () => ({ error: new Error('boom') }) }).line).toBe('priority nice=19 ionice=unavailable (boom)')
    expect(call('low', { platform: 'linux', run: () => ({ status: 1 }) }).line).toBe('priority nice=19 ionice=unavailable (exit 1)')
  })
  it('darwin keeps niceness 19 and reports ionice unsupported', () => {
    const { line, calls } = call('low', { platform: 'darwin' })
    expect(line).toBe('priority nice=19 ionice=unsupported-platform')
    expect(calls).toEqual([['set', 42, 19]])
  })
  it('win32 uses the below-normal priority class, not 19', () => {
    const { line, calls } = call('low', { platform: 'win32' })
    expect(line).toBe('priority nice=below-normal ionice=unsupported-platform')
    expect(calls).toEqual([['set', 42, 10]])
  })
  it('a throwing setPriority is named and does not stop ionice', () => {
    const { line } = call('low', { platform: 'linux', setPriority: () => { throw new Error('EPERM') } })
    expect(line).toBe('priority nice=unavailable (EPERM) ionice=idle')
  })
  it('normal calls nothing', () => {
    const { line, calls } = call('normal', { platform: 'linux' })
    expect(line).toBe('priority normal')
    expect(calls).toEqual([])
  })
  it('resolves ionice through the trusted system-executable resolver, never a relative or user-owned PATH entry', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-path-'))); roots.push(root)
    writeFileSync(join(root, 'tool'), '#!/bin/sh\n', { mode: 0o755 }); chmodSync(join(root, 'tool'), 0o755)
    const relativeEntry = relative(process.cwd(), root)
    expect(trustedSystemExecutable('tool', ['relative-nowhere', relativeEntry].join(delimiter))).toBeNull()
    // Control: the same file on an ABSOLUTE entry is seen (and refused as untrusted), so the null above is not blindness.
    expect(() => trustedSystemExecutable('tool', root)).toThrow(/untrusted tool/)
    expect(trustedSystemExecutable('sh', '')).toMatch(/^\//)
  })
})

describe('collectLaneAttachments', () => {
  it('reads project files from the main checkout, preamble then craft patterns, ahead of explicit files', () => {
    const { root, main, dir } = repo()
    put(main, 'lane-brief-preamble.md', 'PRE'); put(main, 'lane-craft-patterns.md', 'CRAFT')
    const extra = join(root, 'extra.md'); writeFileSync(extra, 'EXTRA')
    const result = collectLaneAttachments({ dir, explicit: [extra] })
    expect(names(result)).toEqual(['lane-brief-preamble.md', 'lane-craft-patterns.md', 'extra.md'])
    expect(result.preamble).toBe(true)
  })
  it('ignores project files that exist only in the lane worktree', () => {
    const { dir } = repo()
    put(dir, 'lane-brief-preamble.md', 'FROM THE WORKTREE')
    const result = collectLaneAttachments({ dir })
    expect(result.items).toEqual([]); expect(result.preamble).toBe(false)
  })
  it('skips a symlinked project file with a reason', () => {
    const { root, main, dir } = repo()
    const secret = join(root, 'secret'); writeFileSync(secret, 'SECRET')
    mkdirSync(join(main, '.claude')); symlinkSync(secret, join(main, '.claude', 'lane-brief-preamble.md'))
    const result = collectLaneAttachments({ dir })
    expect(result.items).toEqual([])
    expect(result.notes.join('\n')).toMatch(/lane-brief-preamble\.md: .*symlink/)
  })
  it('skips a project file in a lane-writable location', () => {
    const { main, dir } = repo()
    const file = put(main, 'lane-brief-preamble.md', 'PRE')
    const result = collectLaneAttachments({ dir, writable: (candidate: string) => candidate === file })
    expect(result.items).toEqual([])
    expect(result.notes.join('\n')).toContain('lane-writable location')
  })
  it('skips everything, legibly, outside a git checkout', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-nogit-'))); roots.push(root)
    const result = collectLaneAttachments({ dir: root })
    expect(result.items).toEqual([])
    expect(result.notes[0]).toContain('project-lane-files=skipped')
  })
  it('looks for project files only from a linked worktree, never from a main checkout', () => {
    const { main } = repo()
    put(main, 'lane-brief-preamble.md', 'PRE')
    const result = collectLaneAttachments({ dir: main })
    expect(result.items).toEqual([])
    expect(result.notes.join('\n')).toContain('not a linked worktree')
  })
  it('does not let a rewritten .git/commondir in a main checkout choose another repository', () => {
    const { root, main } = repo()
    const other = join(root, 'other'); mkdirSync(other); git(other, 'init', '-q'); put(other, 'lane-brief-preamble.md', 'OTHER')
    const evil = join(root, 'evil'); mkdirSync(evil); git(evil, 'init', '-q')
    writeFileSync(join(evil, '.git', 'commondir'), join(other, '.git'))
    const result = collectLaneAttachments({ dir: evil })
    expect(result.items).toEqual([])
    expect(result.notes.join('\n')).toContain('not a linked worktree')
    expect(main).toBeTruthy()
  })
  it('names a git failure differently from "no main checkout", and runs git hardened', () => {
    const { dir } = repo()
    const calls: { args: string[], env: Record<string, string> }[] = []
    const failing = (_c: string, args: string[], options: { env: Record<string, string> }) => { calls.push({ args, env: options.env }); return { status: 128, stdout: '', stderr: 'fatal: boom\n' } }
    expect(collectLaneAttachments({ dir, run: failing }).notes.join('\n')).toContain('git failed: fatal: boom')
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'core.hooksPath=/dev/null']))
    expect(calls[0]?.env.GIT_CONFIG_GLOBAL).toBe('/dev/null'); expect(calls[0]?.env.GIT_CONFIG_NOSYSTEM).toBe('1')
    const odd = () => ({ status: 0, stdout: '/somewhere/bare.git\n', stderr: '' })
    expect(collectLaneAttachments({ dir, run: odd }).notes.join('\n')).toContain('no main checkout')
  })
  it('refuses more than 16 attachments per launch', () => {
    const { root, dir } = repo()
    const files = Array.from({ length: 17 }, (_, index) => { const file = join(root, `n${index}.md`); writeFileSync(file, `${index}`); return file })
    expect(collectLaneAttachments({ dir, explicit: files }).error).toContain('16')
  })
  it('requires the reciprocal back-pointer: a hand-written gitfile naming another repository\'s worktree gitdir is not trusted', () => {
    const { root, main } = repo()
    put(main, 'lane-brief-preamble.md', 'OTHER')
    const forged = join(root, 'forged'); mkdirSync(forged)
    const gitdir = join(git(main, 'rev-parse', '--absolute-git-dir').stdout.trim(), 'worktrees', 'linked')
    writeFileSync(join(forged, '.git'), `gitdir: ${gitdir}\n`)
    const result = collectLaneAttachments({ dir: forged })
    expect(result.items).toEqual([])
    expect(result.notes.join('\n')).toContain('worktree pointers do not match')
  })
  it('refuses an oversized explicit file', () => {
    const { root, dir } = repo()
    const big = join(root, 'big.md'); writeFileSync(big, Buffer.alloc(3 * 1024 * 1024))
    expect(collectLaneAttachments({ dir, explicit: [big] }).error).toContain(big)
  })
})

describe('attachment snapshots', () => {
  it('round-trips through snapshots and refuses a tampered one', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-snap-'))); roots.push(root)
    const entries = writeAttachmentSnapshots([{ name: 'a.md', source: '/s/a.md', bytes: Buffer.from('AAA'), sha256: createHash('sha256').update('AAA').digest('hex'), preamble: false }], root, '1-1')
    const good = verifyAttachmentSnapshots(entries, { snapshotDir: root, runId: '1-1' })
    expect(good.error).toBeUndefined()
    expect(copyAttachmentsForLane(good.verified, root)).toEqual([join(root, 'attach-0-a.md')])
    expect(entries[0].snapshot).toBe(join(root, '1-1-attach-0'))
    rmSync(entries[0].snapshot); writeFileSync(entries[0].snapshot, 'BBB')
    expect(verifyAttachmentSnapshots(entries, { snapshotDir: root, runId: '1-1' }).error).toContain('sha256 mismatch')
  })
})

describe('explicitAttachRefusal writable-root branch and snapshot receipts', () => {
  it('refuses a file the launch writable predicate covers even when it is outside the worktree', () => {
    const { root, dir } = repo()
    const file = join(root, 'elsewhere.md'); writeFileSync(file, 'x')
    expect(explicitAttachRefusal(file, dir, () => false)).toBeNull()
    expect(explicitAttachRefusal(file, dir, (candidate: string) => candidate === file)).toContain('lane-writable')
  })
  const receipt = (snapshotDir: string, name = 'a.md', snapshot = join(snapshotDir, '1-1-attach-0')) => {
    writeFileSync(snapshot, 'AAA', { flag: 'w' })
    return [{ name, source: '/s/a.md', sha256: createHash('sha256').update('AAA').digest('hex'), snapshot, preamble: false }]
  }
  it('accepts a receipt whose snapshot is exactly the expected path', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-rcpt-'))); roots.push(root)
    expect(verifyAttachmentSnapshots(receipt(root), { snapshotDir: root, runId: '1-1' }).error).toBeUndefined()
  })
  it('refuses a snapshot path that is not <dir>/<runId>-attach-<n>-<name>', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-rcpt-'))); roots.push(root)
    const elsewhere = join(root, 'other.md')
    expect(verifyAttachmentSnapshots(receipt(root, 'a.md', elsewhere), { snapshotDir: root, runId: '1-1' }).error).toContain('unexpected snapshot path')
  })
  it.each(['../evil.md', 'a/b.md', 'a\\b.md', '.', '..', ''])('refuses the attachment name %j', (name) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-rcpt-'))); roots.push(root)
    const entries = [{ name, source: '/s/x', sha256: createHash('sha256').update('AAA').digest('hex'), snapshot: join(root, '1-1-attach-0'), preamble: false }]
    expect(verifyAttachmentSnapshots(entries, { snapshotDir: root, runId: '1-1' }).error).toContain('attachment name')
  })
  it('refuses a symlinked snapshot without following it', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-rcpt-'))); roots.push(root)
    const target = join(root, 'target'); writeFileSync(target, 'AAA')
    symlinkSync(target, join(root, '1-1-attach-0'))
    const entries = [{ name: 'a.md', source: '/s/a.md', sha256: createHash('sha256').update('AAA').digest('hex'), snapshot: join(root, '1-1-attach-0'), preamble: false }]
    expect(verifyAttachmentSnapshots(entries, { snapshotDir: root, runId: '1-1' }).error).toContain('unreadable')
  })
  it('names the lane copy readably but truncates a very long basename to 100 characters', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-copy-'))); roots.push(root)
    const [copy] = copyAttachmentsForLane([{ name: `${'a'.repeat(252)}.md`, bytes: Buffer.from('x') }], root)
    const base = copy.split('/').pop() as string
    expect(base.startsWith('attach-0-')).toBe(true)
    expect(base.length - 'attach-0-'.length).toBeLessThanOrEqual(100)
    expect(base.endsWith('.md')).toBe(true)
  })
  it('cleanup never throws: one failing removal is logged once and the other files are still removed', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-rm-'))); roots.push(root)
    for (const name of ['1-1.md', '1-1-attach-0', '1-1-attach-1']) writeFileSync(join(root, name), 'x')
    const logged: string[] = []
    const rm = (file: string, options: object) => { if (file.endsWith('1-1-attach-0')) throw new Error('EBUSY'); rmSync(file, options) }
    expect(() => removeRunSnapshots(root, '1-1', { rm, log: (line: string) => logged.push(line) })).not.toThrow()
    expect(readdirSync(root)).toEqual(['1-1-attach-0'])
    expect(logged).toHaveLength(1); expect(logged[0]).toContain('EBUSY')
  })
  it('removes the brief snapshot and every attachment snapshot of ONE run and nothing else', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-rm-'))); roots.push(root)
    for (const name of ['1-1.md', '1-1-attach-0', '1-1-attach-1', '1-2.md', '1-2-attach-0', '11-1-attach-0']) writeFileSync(join(root, name), 'x')
    removeRunSnapshots(root, '1-1')
    expect(readdirSync(root).sort()).toEqual(['1-2-attach-0', '1-2.md', '11-1-attach-0'])
    expect(existsSync(join(root, '1-1.md'))).toBe(false)
  })
})
