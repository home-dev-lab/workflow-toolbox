import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { declaredHookPaths } from '../../../../plugin/bin/lib/hook-manifest.mjs'

type HookPathEntry = { event: string; rel: string }

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const REAL_PLUGIN_ROOT = join(REPO_ROOT, 'plugin')
const REAL_MANIFEST = join(REAL_PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
const REAL_HOOK = join(REAL_PLUGIN_ROOT, 'bin', 'wt-hook-registration-drift-hook.mjs')

function makeSandbox(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-hook-drift-${tag}-`))
  const pluginRoot = join(root, 'plugin')
  const binDir = join(pluginRoot, 'bin')
  const libDir = join(binDir, 'lib')
  const manifestDir = join(pluginRoot, '.claude-plugin')
  const stateDir = join(root, 'state')

  mkdirSync(libDir, { recursive: true })
  mkdirSync(manifestDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  for (const file of [
    REAL_HOOK,
    join(REAL_PLUGIN_ROOT, 'bin', 'lib', 'fail-open-trace.mjs'),
    join(REAL_PLUGIN_ROOT, 'bin', 'lib', 'hook-manifest.mjs'),
  ]) {
    writeFileSync(join(file === REAL_HOOK ? binDir : libDir, basename(file)), readFileSync(file, 'utf8'))
  }

  return {
    root,
    pluginRoot,
    binDir,
    manifestDir,
    stateDir,
    hookPath: join(binDir, basename(REAL_HOOK)),
    manifestPath: join(manifestDir, 'plugin.json'),
  }
}

function cleanupSandbox(root: string) {
  rmSync(root, { recursive: true, force: true })
}

function writeHookFile(pluginRoot: string, rel: string) {
  const file = join(pluginRoot, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '#!/usr/bin/env node\n')
  return file
}

function runHook(hookPath: string, payload: unknown, stateDir: string) {
  return spawnSync(process.execPath, [hookPath], {
    cwd: dirname(dirname(hookPath)),
    env: {
      ...process.env,
      HOME: process.env.HOME || homedir(),
      WT_HOOK_DRIFT_DIR: stateDir,
    },
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    timeout: 10_000,
  })
}

describe('hook registration drift detector', () => {
  it('SessionStart writes a snapshot containing every declared hook path resolved to absolute', () => {
    const sandbox = makeSandbox('snapshot')
    try {
      writeHookFile(sandbox.pluginRoot, 'bin/wt-alpha-hook.mjs')
      writeHookFile(sandbox.pluginRoot, 'bin/wt-beta-hook.mjs')
      writeHookFile(sandbox.pluginRoot, 'bin/wt-gamma-hook.mjs')
      writeFileSync(
        sandbox.manifestPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-alpha-hook.mjs"' }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-beta-hook.mjs"' }] }],
            Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-gamma-hook.mjs"' }] }],
          },
        }, null, 2),
      )

      const sessionId = 'session/snapshot'
      const result = runHook(
        sandbox.hookPath,
        { hook_event_name: 'SessionStart', session_id: sessionId },
        sandbox.stateDir,
      )
      expect(result.status).toBe(0)
      expect(result.stderr.trim()).toBe('')
      expect(result.stdout.trim()).toBe('')

      const snapshotPath = join(sandbox.stateDir, 'session-snapshot.json')
      expect(existsSync(snapshotPath)).toBe(true)
      expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toEqual({
        hooks: [
          { event: 'SessionStart', rel: '/bin/wt-alpha-hook.mjs', abs: join(sandbox.pluginRoot, 'bin', 'wt-alpha-hook.mjs') },
          { event: 'UserPromptSubmit', rel: '/bin/wt-beta-hook.mjs', abs: join(sandbox.pluginRoot, 'bin', 'wt-beta-hook.mjs') },
          { event: 'Stop', rel: '/bin/wt-gamma-hook.mjs', abs: join(sandbox.pluginRoot, 'bin', 'wt-gamma-hook.mjs') },
        ],
        reportedAt: null,
      })
    } finally {
      cleanupSandbox(sandbox.root)
    }
  })

  it('UserPromptSubmit detects a path that has since gone missing and emits additionalContext naming it', () => {
    const sandbox = makeSandbox('missing')
    try {
      const alpha = writeHookFile(sandbox.pluginRoot, 'bin/wt-alpha-hook.mjs')
      const beta = writeHookFile(sandbox.pluginRoot, 'bin/wt-beta-hook.mjs')
      writeFileSync(
        sandbox.manifestPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-alpha-hook.mjs"' }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-beta-hook.mjs"' }] }],
          },
        }),
      )

      runHook(sandbox.hookPath, { hook_event_name: 'SessionStart', session_id: 'missing-once' }, sandbox.stateDir)
      rmSync(beta)

      const result = runHook(
        sandbox.hookPath,
        { hook_event_name: 'UserPromptSubmit', session_id: 'missing-once' },
        sandbox.stateDir,
      )
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
      expect(parsed.hookSpecificOutput.additionalContext).toContain('UserPromptSubmit: wt-beta-hook.mjs')
      expect(parsed.hookSpecificOutput.additionalContext).toContain('stale')
      expect(parsed.hookSpecificOutput.additionalContext).toContain('restart')

      const snapshot = JSON.parse(readFileSync(join(sandbox.stateDir, 'missing-once.json'), 'utf8'))
      expect(snapshot.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(alpha).toBe(join(sandbox.pluginRoot, 'bin', 'wt-alpha-hook.mjs'))
    } finally {
      cleanupSandbox(sandbox.root)
    }
  })

  it('UserPromptSubmit stays silent when nothing is missing', () => {
    const sandbox = makeSandbox('clean')
    try {
      writeHookFile(sandbox.pluginRoot, 'bin/wt-alpha-hook.mjs')
      writeHookFile(sandbox.pluginRoot, 'bin/wt-beta-hook.mjs')
      writeFileSync(
        sandbox.manifestPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-alpha-hook.mjs"' }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-beta-hook.mjs"' }] }],
          },
        }),
      )

      runHook(sandbox.hookPath, { hook_event_name: 'SessionStart', session_id: 'clean-session' }, sandbox.stateDir)
      const result = runHook(
        sandbox.hookPath,
        { hook_event_name: 'UserPromptSubmit', session_id: 'clean-session' },
        sandbox.stateDir,
      )

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('')
      expect(JSON.parse(readFileSync(join(sandbox.stateDir, 'clean-session.json'), 'utf8')).reportedAt).toBeNull()
    } finally {
      cleanupSandbox(sandbox.root)
    }
  })

  it('UserPromptSubmit reports only once for the same missing path', () => {
    const sandbox = makeSandbox('once')
    try {
      writeHookFile(sandbox.pluginRoot, 'bin/wt-alpha-hook.mjs')
      const beta = writeHookFile(sandbox.pluginRoot, 'bin/wt-beta-hook.mjs')
      writeFileSync(
        sandbox.manifestPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-alpha-hook.mjs"' }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-beta-hook.mjs"' }] }],
          },
        }),
      )

      runHook(sandbox.hookPath, { hook_event_name: 'SessionStart', session_id: 'once-session' }, sandbox.stateDir)
      rmSync(beta)

      const first = runHook(
        sandbox.hookPath,
        { hook_event_name: 'UserPromptSubmit', session_id: 'once-session' },
        sandbox.stateDir,
      )
      const second = runHook(
        sandbox.hookPath,
        { hook_event_name: 'UserPromptSubmit', session_id: 'once-session' },
        sandbox.stateDir,
      )

      expect(first.stdout).not.toBe('')
      expect(second.status).toBe(0)
      expect(second.stdout.trim()).toBe('')
    } finally {
      cleanupSandbox(sandbox.root)
    }
  })

  it('the extracted manifest reader returns the real manifest\'s non-empty declared set', () => {
    const declared = declaredHookPaths(REAL_MANIFEST) as HookPathEntry[]
    expect(declared.length).toBeGreaterThan(0)
    expect(declared.some(({ rel }: HookPathEntry) => rel === '/bin/wt-delegation-ladder-hook.mjs')).toBe(true)
  })

  it('collects EVERY ${CLAUDE_PLUGIN_ROOT} reference in one command, not just the first', () => {
    const sandbox = makeSandbox('multi-ref')
    try {
      writeFileSync(
        sandbox.manifestPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{
              hooks: [{
                type: 'command',
                command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/first.mjs" --lib "${CLAUDE_PLUGIN_ROOT}/bin/lib/second.mjs"',
              }],
            }],
          },
        }),
      )
      const declared = declaredHookPaths(sandbox.manifestPath) as HookPathEntry[]
      expect(declared).toEqual([
        { event: 'SessionStart', rel: '/bin/first.mjs' },
        { event: 'SessionStart', rel: '/bin/lib/second.mjs' },
      ])
    } finally {
      cleanupSandbox(sandbox.root)
    }
  })
})
