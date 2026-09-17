import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-concurrent-test-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

let journalDir: string

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'wt-concurrent-test-journal-'))
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

function run(command: string, env: NodeJS.ProcessEnv = process.env, executable = process.execPath) {
  const result = spawnSync(executable, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'concurrent-test-session',
      tool_input: { command },
    }),
    encoding: 'utf8',
    env: { ...env, WT_GUARD_JOURNAL_DIR: journalDir },
  })
  const entries = readdirSync(journalDir)
    .filter((file) => file.endsWith('.ndjson'))
    .flatMap((file) => readFileSync(join(journalDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
  return { ...result, entries }
}

function injectedProcessListing(listing: string): NodeJS.ProcessEnv {
  const ps = join(journalDir, 'ps')
  writeFileSync(ps, `#!/bin/sh\n${listing}\n`)
  chmodSync(ps, 0o755)
  return { ...process.env, PATH: journalDir }
}

describe('wt-concurrent-test-guard-hook', () => {
  it.skipIf(process.platform === 'win32')('SILENT + SELF-MATCH RED PROOF: reports zero from an injected self listing', () => {
    // `ps` is resolved from PATH. Its parent is the hook, so this record proves the hook excludes itself.
    const result = run('vitest run', injectedProcessListing("printf '%s 1 vitest vitest run\\n' \"$PPID\""))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      decision: 'silent',
      class: 'solo-test-start',
      evidence: { count: '0' },
    })
  })

  it.skipIf(process.platform === 'win32')('WARN: an injected concurrent runner is counted, legible, and never blocked', () => {
    const result = run('pnpm test', injectedProcessListing("printf '999999 1 vitest vitest run\\n'"))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('1 test-runner process(es) are already running')
    expect(result.stdout).toContain('WARNING (not blocked)')
    expect(result.stdout).toContain('"permissionDecision":"allow"')
    expect(result.stdout).not.toContain('"deny"')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ decision: 'warned', evidence: { count: '1' } })
  })

  it.skipIf(process.platform === 'win32')('REAL MACHINE: reports the runner count it discovers without assuming it is alone', () => {
    const result = run('pnpm test')
    expect(result.status).toBe(0)
    expect(result.entries).toHaveLength(1)
    const count = Number(result.entries[0].evidence.count)
    expect(Number.isInteger(count)).toBe(true)
    expect(count).toBeGreaterThanOrEqual(0)
    expect(result.entries[0]).toMatchObject({ decision: count > 0 ? 'warned' : 'silent', evidence: { count: String(count) } })
    if (count > 0) expect(result.stdout).toContain(`${count} test-runner process(es) are already running`)
    else expect(result.stdout).toBe('')
  })

  it.each(['pnpm -r test', 'pnpm vitest', 'pnpm exec vitest', 'pnpm --recursive test'])(
    'recognises required test-start form: %s',
    (command) => {
      const result = run(command, { ...process.env, PATH: '' })
      expect(result.stdout).toContain('could not enumerate existing test-runner processes')
    },
  )

  it('does not enumerate for mere mentions such as grep vitest', () => {
    const result = run('grep vitest README.md', { ...process.env, PATH: '' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.entries).toHaveLength(0)
  })

  it('WARN: unavailable process enumeration is unknown, never a silent zero', () => {
    const result = run('pnpm test', { ...process.env, PATH: '' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('unknown, not a zero count')
    expect(result.stdout).toContain('"permissionDecision":"allow"')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      decision: 'warned',
      class: 'enumeration-unavailable',
      evidence: { status: 'unavailable' },
    })
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const wired = (manifest.hooks?.PreToolUse ?? [])
      .filter((entry: { matcher?: string }) => entry.matcher === 'Bash')
      .flatMap((entry: { hooks?: { command?: string }[] }) => entry.hooks ?? [])
      .some((hook: { command?: string }) => hook.command?.includes('wt-concurrent-test-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})
