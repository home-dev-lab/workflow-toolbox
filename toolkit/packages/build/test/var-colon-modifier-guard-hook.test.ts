import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-var-colon-modifier-guard-hook.mjs')
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
    warned: res.stdout.includes('additionalContext'),
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
  }
}

describe('wt-var-colon-modifier-guard-hook', () => {
  it('RED: warns on a real modifier hazard', () => {
    const r = run('git show "$s:src/db-base.ts"')
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('$s:s')
    expect(r.stdout).toContain('bad substitution')
    expect(r.status).toBe(0)
  })

  it('GREEN: stays silent on a quoted-delimiter heredoc body containing the shape', () => {
    const r = run(
      [
        "git commit -F - <<'MSG'",
        'fix: watch out for "$s:src/file.ts" — a bare var-colon hazard',
        'MSG',
      ].join('\n'),
    )
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: stays silent on a single-quoted span containing the shape', () => {
    const r = run('echo \'the hazard looks like "$s:src/file.ts"\'')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('RED: warns on an UNQUOTED heredoc body containing the shape', () => {
    const r = run(
      [
        'cat <<MSG',
        'revision "$s:src/db-base.ts" would be expanded here',
        'MSG',
      ].join('\n'),
    )
    expect(r.warned).toBe(true)
  })

  it('GREEN: stays silent on a letter outside the 13-letter modifier set', () => {
    const r = run('echo "$s:z is not a documented zsh modifier"')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: stays silent on the documented safe braced form', () => {
    const r = run('git show "${s}:src/db-base.ts"')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: stays silent on a single-quoted string', () => {
    const r = run("git show '$s:src/db-base.ts'")
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('stays out of the way for an ordinary command with no var-colon shape', () => {
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
      .some((h: { command?: string }) => h.command?.includes('wt-var-colon-modifier-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})
