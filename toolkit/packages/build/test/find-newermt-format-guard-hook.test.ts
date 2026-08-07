import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-find-newermt-format-guard-hook.mjs')
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

describe('wt-find-newermt-format-guard-hook', () => {
  it('WARN: a natural-language -newermt argument is flagged', () => {
    const r = run('find . -newermt "5 minutes ago" 2>/dev/null | wc -l')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.stdout).toContain('5 minutes ago')
    expect(r.status).toBe(0)
  })

  it('WARN: a relative shorthand form is flagged', () => {
    const r = run("find . -newermt '-20 seconds' -type f")
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('SILENT: an ISO-8601 date-only argument', () => {
    const r = run('find . -newermt "2026-08-06"')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: an ISO-8601 full timestamp built via command substitution', () => {
    const r = run(
      "find . -newermt \"$(date -d '5 minutes ago' +%Y-%m-%dT%H:%M:%S)\"",
    )
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('WARN (known false-positive family, documented and accepted): a heredoc body merely documenting the trap still fires, because this guard reasons about the raw string and cannot tell prose from a real invocation', () => {
    const r = run(
      [
        "cat <<'EOF'",
        'find . -newermt "5 minutes ago" silently finds nothing on bfs.',
        'EOF',
      ].join('\n'),
    )
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
  })

  it('stays out of the way for an ordinary find with no -newermt', () => {
    const r = run('find . -name "*.ts"')
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
        h.command?.includes('wt-find-newermt-format-guard-hook.mjs'),
      )
    expect(wired).toBe(true)
  })
})
