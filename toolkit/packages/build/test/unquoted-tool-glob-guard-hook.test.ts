import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-unquoted-tool-glob-guard-hook.mjs')
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
    denied: res.stdout.includes('"deny"'),
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
  }
}

describe('wt-unquoted-tool-glob-guard-hook', () => {
  it('RED: denies a real option-value glob', () => {
    const r = run("grep -rn 'foo' --include=*.ts .")
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('Unquoted glob passed to a tool flag')
    expect(r.stdout).toContain("--include='*.ts'")
    expect(r.status).toBe(0)
  })

  it('RED: denies find -name with an unquoted glob', () => {
    const r = run('find . -name *.mjs')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('name')
    expect(r.status).toBe(0)
  })

  it('GREEN: stays silent on a single-quoted glob', () => {
    const r = run("grep -rn 'foo' --include='*.ts' .")
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: stays silent on a double-quoted glob', () => {
    const r = run('find . -name "*.mjs"')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: stays silent on an ordinary shell-argument glob (not a covered flag)', () => {
    const r = run('ls path/prefix*')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: stays silent when the glob shape sits inside an unrelated quoted span', () => {
    // The dangerous form is `--include=*.ts` with the glob directly unquoted. Here the WHOLE
    // flag=value pair is embedded inside a double-quoted echo argument, so nothing the shell
    // parses is actually unquoted — only the data-span stripping (not the per-flag negative
    // lookahead, which only rules out a quote immediately after `=`) can tell the two apart.
    const r = run('echo "example: --include=*.ts is the risky form"')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: stays silent on a heredoc body describing the shape', () => {
    const r = run(
      [
        "git commit -F - <<'MSG'",
        'fix: quote your globs, e.g. --include=*.ts is wrong',
        'MSG',
      ].join('\n'),
    )
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: stays silent on prose in backticks describing the shape', () => {
    // Deliberately NOT wrapped in an outer quote — a quote-stripping mutation must not be
    // able to explain this one away; only the backtick-span stripping can.
    const r = run('echo see `--include=*.ts` in the docs')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('stays out of the way for an ordinary command with no glob flags', () => {
    const r = run('git status')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Bash')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) => h.command?.includes('wt-unquoted-tool-glob-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})
