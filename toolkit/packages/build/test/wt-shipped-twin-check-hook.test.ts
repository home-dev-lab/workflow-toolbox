import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-shipped-twin-check-hook.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-shipped-twin-${tag}-`))
  roots.push(root)
  const projectDir = join(root, 'project')
  const stateDir = join(root, 'state')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return {
    root,
    projectDir,
    stateDir,
    env: {
      ...process.env,
      WT_SHIPPED_TWIN_GUARD_DIR: stateDir,
    },
  }
}

function runHook(payload: unknown, env: NodeJS.ProcessEnv) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
  const stdout = (res.stdout ?? '').trim()
  let context = ''
  try {
    const parsed = stdout ? JSON.parse(stdout) as Record<string, unknown> : null
    const hookSpecificOutput = parsed?.['hookSpecificOutput'] as Record<string, unknown> | undefined
    context = (hookSpecificOutput?.['additionalContext'] as string | undefined) ?? ''
  } catch {
    context = ''
  }
  return { status: res.status, stdout, context }
}

describe('wt-shipped-twin-check-hook.mjs', () => {
  it('emits the advisory on the first in-scope touch in a session directory', () => {
    const f = fixture('first-touch')
    const dir = join(f.projectDir, '.claude', 'scripts')
    const file = join(dir, 'foo.mjs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, 'export const x = 1\n')

    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      session_id: 'session-a',
      cwd: f.projectDir,
      tool_input: { file_path: file },
    }, f.env)

    expect(r.status).toBe(0)
    expect(r.stdout).not.toBe('')
    expect(r.context).toContain(file.replace(/\\/g, '/'))
    expect(r.context).toContain('cannot tell whether a shipped counterpart exists')
    expect(r.context).toContain('same pass')
  })

  it('stays silent for a second file in the same directory in the same session', () => {
    const f = fixture('throttle')
    const dir = join(f.projectDir, '.claude', 'scripts')
    const first = join(dir, 'foo.mjs')
    const second = join(dir, 'bar.ts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(first, 'export const a = 1\n')
    writeFileSync(second, 'export const b = 2\n')

    const firstRun = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      session_id: 'session-b',
      cwd: f.projectDir,
      tool_input: { file_path: first },
    }, f.env)
    const secondRun = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      session_id: 'session-b',
      cwd: f.projectDir,
      tool_input: { file_path: second },
    }, f.env)

    expect(firstRun.stdout).not.toBe('')
    expect(secondRun.status).toBe(0)
    expect(secondRun.stdout).toBe('')
  })

  it('stays silent for an out-of-scope file', () => {
    const f = fixture('out-of-scope')
    const dir = join(f.projectDir, 'plugin')
    const file = join(dir, 'helper.mjs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, 'export const local = true\n')

    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      session_id: 'session-c',
      cwd: f.projectDir,
      tool_input: { file_path: file },
    }, f.env)

    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('stays silent for an out-of-scope file even with different casing (Windows-style path)', () => {
    const f = fixture('windows-casing')
    // Windows filesystems are case-insensitive, so a real Windows path can read "Plugin\"
    // after separator normalization and still be the same excluded directory. This never
    // touches disk (the hook only pattern-matches the string it's given).
    const file = 'C:\\Users\\dev\\Plugin\\.claude\\rules\\notes.md'

    const r = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      session_id: 'session-d',
      cwd: f.projectDir,
      tool_input: { file_path: file },
    }, f.env)

    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })
})
