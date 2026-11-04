import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error runtime module
import { fixture, fingerprint, repository, sweepModule } from '../../../test-support/worktree-sweep-fixture.mjs'
const url = sweepModule('bin/lib/worktree-sweep/trigger.mjs')
const hooks = await import(/* @vite-ignore */ url).catch(() => null)
const workerUrl = sweepModule('bin/lib/worktree-sweep/worker.mjs')
const worker = await import(/* @vite-ignore */ workerUrl).catch(() => null)
const stateUrl = sweepModule('bin/lib/worktree-sweep/state.mjs')
const state = await import(/* @vite-ignore */ stateUrl).catch(() => null)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() { const f = fixture(execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]); roots.push(f.root); return f }

  it('ships report-mode triggers', () => { expect(hooks).not.toBeNull() })
  it('G24 old report spawns one detached report within a 50ms injected budget', () => {
    const f = setup(); const unref = vi.fn(); const spawn = vi.fn(() => ({ unref, once: vi.fn() }))
    const stat = vi.fn(() => ({ mtimeMs: f.now - 7 * 3600_000 }))
    const clock = vi.fn(() => f.now)
    const before = clock()
    const result = hooks!.tick({ project: f.project, env: f.env, now: clock(), stat, spawn, claim: () => true, stateDir: f.root })
    expect(result).toBe(true) // An async/await-child implementation returns a Promise here.
    expect(clock() - before).toBeLessThan(50)
    expect(stat).toHaveBeenCalledTimes(1); expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]).toEqual(expect.arrayContaining([expect.any(String), expect.arrayContaining(['run', '--mode', 'report']),
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true })]))
    expect(unref).toHaveBeenCalledTimes(1)
  })
  it('G24 recent report or failed exclusive claim spawns nothing', () => {
    const f = setup(); const spawn = vi.fn(() => ({ once: vi.fn(), unref: vi.fn() }))
    hooks!.tick({ project: f.project, env: f.env, now: f.now, stat: () => ({ mtimeMs: f.now }), spawn, stateDir: f.root })
    hooks!.tick({ project: f.project, env: f.env, now: f.now, stat: () => ({ mtimeMs: 0 }), spawn, claim: () => false, stateDir: f.root })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('G21 apply option is refused by the trigger too', () => {
    const f = setup(); const spawn = vi.fn()
    expect(() => hooks!.tick({ project: f.project, env: { ...f.env, WT_WORKTREE_SWEEP_MODE: 'apply' }, spawn, stateDir: f.root })).toThrow('apply is not available')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('refuses trigger state inside the project before spawning', () => {
    const f = setup(); const spawn = vi.fn()
    expect(() => hooks!.tick({ project: f.project, env: f.env, spawn, stateDir: f.project })).toThrow('outside the project')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('G26 the complete background report worker preserves the project too', () => {
    const f = setup(); repository(f); const before = fingerprint(f.project)
    worker!.reportWorker(f.project, f.root, f.env)
    expect(fingerprint(f.project)).toEqual(before)
    expect(state!.lockHeld(f.root)).toBe(false)
    expect(JSON.parse(readFileSync(join(f.root, 'last.json'), 'utf8'))).toMatchObject({ mode: 'report', entries: [{ name: 'clean', verdict: 'KEEP' }] })
  })
  it('the direct worker refuses apply before producing any report or claim', () => {
    const f = setup(); repository(f); const before = fingerprint(f.project)
    expect(() => worker!.reportWorker(f.project, f.root, { ...f.env, WT_WORKTREE_SWEEP_MODE: 'apply' })).toThrow('apply is not available')
    expect(existsSync(join(f.root, 'last.json'))).toBe(false)
    expect(state!.lockHeld(f.root)).toBe(false)
    expect(fingerprint(f.project)).toEqual(before)
  })
  it('an existing external claim cannot be stolen by another report worker', () => {
    const f = setup(); const release = state!.claimState(f.project, f.root, f.procfs)
    expect(state!.claimState(f.project, f.root, f.procfs)).toBeNull()
    expect(state!.lockHeld(f.root)).toBe(true)
    release()
    expect(state!.lockHeld(f.root)).toBe(false)
  })
  it('a crashed external claim is retained and named even without a completed report', () => {
    const f = setup(); const dir = state!.externalState(f.project, f.env)
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: 2147483647 }))
    expect(state!.claimState(f.project, dir, f.procfs)).toBeNull()
    expect(hooks!.sessionSummary(f.project, f.env)).toContain('external claim present')
  })
