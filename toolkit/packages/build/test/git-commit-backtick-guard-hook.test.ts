import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-git-commit-backtick-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

function run(command: string) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
  })
  return {
    // This guard ships WARN-ONLY — it never emits a "deny" decision.
    warned: res.stdout.includes('hookSpecificOutput'),
    denied: res.stdout.includes('"deny"'),
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
  }
}

describe('wt-git-commit-backtick-guard-hook', () => {
  it('WARN: an unescaped backtick pair in a plain double-quoted -m is flagged (the real, measured 2026-08-04 case)', () => {
    const r = run('git commit -m "the default `stretch` applied"')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.stdout).toContain('backtick')
    expect(r.status).toBe(0)
  })

  it('WARN: --message spelled out, same hazard', () => {
    const r = run('git commit --message "renamed `oldName` to newName"')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('WARN: git tag with the same hazard', () => {
    const r = run('git tag -m "cuts `release` branch" v1.2.3')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('SILENT: a single-quoted -m argument (no substitution risk)', () => {
    const r = run("git commit -m 'the default `stretch` applied'")
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: an escaped backtick', () => {
    const r = run('git commit -m "the default \\`stretch\\` applied"')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: the documented -F heredoc safe form', () => {
    const r = run(
      ["git commit -F - <<'MSG'", 'the default `stretch` applied', 'MSG'].join('\n'),
    )
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: the -m "$(cat <<\'EOF\' ... EOF)" heredoc-in-command-substitution form — this project\'s own dominant convention, fixed after the measured 12/16 false-positive rate', () => {
    const r = run(
      [
        'git commit -m "$(cat <<\'EOF\'',
        'fix(auth): serialize refresh across processes',
        '',
        'Uses `expiresAt` to decide staleness; no change to the `retry` policy.',
        "EOF",
        ')"',
      ].join('\n'),
    )
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('stays out of the way for an ordinary commit with no backtick', () => {
    const r = run('git commit -m "fix: tighten the retry window"')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Bash')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) =>
        h.command?.includes('wt-git-commit-backtick-guard-hook.mjs'),
      )
    expect(wired).toBe(true)
  })
})
