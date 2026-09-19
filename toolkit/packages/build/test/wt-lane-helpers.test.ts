import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/
import { briefEvidenceLines, checkGitWorktree, fallbackLauncherIdentity, windowsImage, writeLaneStage } from '../../../../plugin/bin/wt-lane.mjs'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wt-lane-helpers-'))
  roots.push(root)
  return root
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sealedPluginCliEnv(cwd, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function captureStderr() {
  const lines: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk))
    return true
  })
  return lines
}

describe('wt-lane helpers', () => {
  it('normalizes a quoted Windows executable with trailing arguments', () => {
    expect(windowsImage(String.raw`"C:\Program Files\node.exe" --foo`)).toEqual({
      name: 'node',
      path: String.raw`C:\Program Files\node.exe`,
    })
  })

  it('normalizes a bare Windows executable without claiming an absolute path', () => {
    expect(windowsImage('node')).toEqual({ name: 'node', path: null })
  })

  it('accepts a real git worktree without writing to stderr', () => {
    const root = fixtureRoot()
    git(root, 'init', '-q')
    const stderr = captureStderr()

    expect(checkGitWorktree(root)).toBe(true)
    expect(stderr).toEqual([])
  })

  it('rejects a plain directory with the exact remedy', () => {
    const root = fixtureRoot()
    const stderr = captureStderr()

    expect(checkGitWorktree(root)).toBe(false)
    expect(stderr).toEqual([
      `wt-lane: --dir is not inside a git work tree: ${root}\n`,
      'wt-lane: expected a directory inside a git work tree.\n',
      `wt-lane: remedy: git worktree add ${root} <branch>, or pass --allow-no-git for a deliberate non-repo lane.\n`,
    ])
  })

  it('reports when git is unavailable', () => {
    const root = fixtureRoot()
    const stderr = captureStderr()
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      expect(checkGitWorktree(root)).toBe(false)
    } finally {
      process.env.PATH = originalPath
    }
    expect(stderr).toEqual([`wt-lane: git is unavailable; cannot verify --dir: ${root}\n`])
  })

  it('formats lowercase brief evidence in fixed order', () => {
    const receipt = { path: '/tmp/brief.md', age: '3s', heading: '# Brief', sha256: 'abc123' }
    expect(briefEvidenceLines(receipt)).toEqual([
      'brief=/tmp/brief.md',
      'brief_age=3s',
      'brief_heading=# Brief',
      'brief_sha256=abc123',
    ])
  })

  it('formats uppercase brief evidence in fixed order', () => {
    const receipt = { path: '/tmp/brief.md', age: '3s', heading: '# Brief', sha256: 'abc123' }
    expect(briefEvidenceLines(receipt, true)).toEqual([
      'BRIEF_PATH=/tmp/brief.md',
      'BRIEF_AGE=3s',
      'BRIEF_HEADING=# Brief',
      'BRIEF_SHA256=abc123',
    ])
  })

  it('appends a timestamped stage and creates parent directories', () => {
    const file = join(fixtureRoot(), 'nested', 'lane.log')
    writeLaneStage(file, 'running')
    expect(readFileSync(file, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z stage=running\n$/)
  })

  it('preserves nonce when resetting a lane stage', () => {
    const file = join(fixtureRoot(), 'lane.log')
    writeFileSync(file, 'LANE_NONCE=fixture-nonce\nstale=true\n')
    writeLaneStage(file, 'starting', { reset: true, runId: 'run-123', header: ['owner=pilot'] })

    expect(readFileSync(file, 'utf8')).toMatch(/^LANE_NONCE=fixture-nonce\nLANE_RUN_ID=run-123\nowner=pilot\n\d{4}-\d{2}-\d{2}T.*Z stage=starting\n$/)
  })

  it('drops a non-nonce prefix when resetting a lane stage', () => {
    const file = join(fixtureRoot(), 'lane.log')
    writeFileSync(file, 'stale=true\n')
    writeLaneStage(file, 'starting', { reset: true })

    expect(readFileSync(file, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z stage=starting\n$/)
  })

  it('starts fresh when resetting a missing lane stage file', () => {
    const file = join(fixtureRoot(), 'missing', 'lane.log')
    writeLaneStage(file, 'starting', { reset: true })

    expect(readFileSync(file, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z stage=starting\n$/)
  })

  it.skipIf(process.platform === 'win32')('uses the current non-Windows launcher fallback; Windows returns an approximate start time and executable image', () => {
    // The win32 branch cannot be forced without widening the production seam.
    expect(fallbackLauncherIdentity()).toEqual({ argv: process.argv, startTime: null })
  })
})
