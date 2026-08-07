import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-pipestatus-bash-only-guard-hook.mjs')
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

describe('wt-pipestatus-bash-only-guard-hook', () => {
  it('WARN: a bare PIPESTATUS reference in a pipeline gate is flagged', () => {
    const r = run('cmd | tee log; echo "${PIPESTATUS[0]}"')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.stdout).toContain('PIPESTATUS')
    expect(r.status).toBe(0)
  })

  it('WARN: PIPESTATUS inside a conditional test is flagged', () => {
    const r = run('if [ "${PIPESTATUS[0]}" = 0 ]; then echo ok; fi')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('SILENT: the zsh-correct lowercase $pipestatus form', () => {
    const r = run('cmd | tee log; echo "${pipestatus[1]}"')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('WARN (known false-positive family, documented and accepted): a heredoc body merely documenting the trap still fires, because this guard reasons about the raw string and cannot tell prose from a real reference', () => {
    const r = run(
      [
        "cat <<'EOF'",
        'Never read PIPESTATUS in zsh — it expands empty.',
        'EOF',
      ].join('\n'),
    )
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
  })

  it('stays out of the way for an ordinary command with no PIPESTATUS', () => {
    const r = run('git status')
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
        h.command?.includes('wt-pipestatus-bash-only-guard-hook.mjs'),
      )
    expect(wired).toBe(true)
  })
})
