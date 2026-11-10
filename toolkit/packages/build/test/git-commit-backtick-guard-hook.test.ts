import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// Same hook, with the guard journal redirected to a scratch directory so a warning's journal
// rows can be read back; `extraEnv` and `agentId` drive observe mode and subagent payloads.
function runJournaled(command: string, extraEnv: Record<string, string> = {}, agentId?: string) {
  const journalDir = mkdtempSync(join(tmpdir(), 'wt-commit-backtick-journal-'))
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        ...(agentId ? { agent_id: agentId } : {}),
      }),
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv, WT_GUARD_JOURNAL_DIR: journalDir },
    })
    const entries = readdirSync(journalDir)
      .filter((file) => file.endsWith('.ndjson'))
      .flatMap((file) =>
        readFileSync(join(journalDir, file), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      )
    const parsed = res.stdout ? (JSON.parse(res.stdout) as { hookSpecificOutput?: { additionalContext?: string } }) : null
    return {
      warned: res.stdout.includes('hookSpecificOutput'),
      denied: res.stdout.includes('"deny"'),
      stdout: res.stdout,
      context: parsed?.hookSpecificOutput?.additionalContext ?? '',
      status: res.status,
      entries,
    }
  } finally {
    rmSync(journalDir, { recursive: true, force: true })
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

const EMPTY_CLASS = 'empty-commit-claims-delivery'

describe('wt-git-commit-backtick-guard-hook: empty commit that claims delivery', () => {
  it('WARN: --allow-empty with a double-quoted message naming no marker', () => {
    const r = runJournaled('git commit --allow-empty -m "feat: ship the new importer"')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
    expect(r.context).toContain('--allow-empty')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ decision: 'warned', class: EMPTY_CLASS })
  })

  it('WARN: single-quoted message, and the --message=<text> spelling', () => {
    expect(runJournaled("git commit --allow-empty -m 'feat: ship the new importer'").warned).toBe(true)
    expect(runJournaled('git commit --allow-empty --message="feat: ship it"').warned).toBe(true)
  })

  it('SILENT: a message that names the marker (every marker word, any case)', () => {
    for (const word of ['marker', 'no code written', 'empty', 'wip', 'checkpoint', 'CI', 'placeholder', 'no-op', 'trigger']) {
      const r = runJournaled(`git commit --allow-empty -m "${word}: re-run the pipeline"`)
      expect(r.stdout, word).toBe('')
      expect(r.entries, word).toHaveLength(0)
    }
  })

  it('SILENT: one marker message among several -m arguments', () => {
    const r = runJournaled('git commit --allow-empty -m "feat: ship it" -m "marker only"')
    expect(r.stdout).toBe('')
  })

  it('SILENT: --allow-empty-message is a different flag, and a -F source has no readable message', () => {
    expect(runJournaled('git commit --allow-empty-message -m "feat: ship it"').stdout).toBe('')
    expect(runJournaled('git commit --allow-empty -F notes.txt').stdout).toBe('')
  })

  it('SILENT: a git commit written inside a heredoc body is data', () => {
    const r = runJournaled(["cat <<'EOF'", 'git commit --allow-empty -m "feat: ship it"', 'EOF'].join('\n'))
    expect(r.stdout).toBe('')
    expect(r.entries).toHaveLength(0)
  })
})

describe('wt-git-commit-backtick-guard-hook: each git commit is judged alone', () => {
  it.each([
    'git commit --allow-empty -m "ship it"; git commit -m "marker"',
    'git commit -m "marker"\ngit commit --allow-empty -m "ship it"',
    'git commit -m "marker" && git commit --allow-empty -m "ship it"',
    'git commit --allow-empty -mship-it',
    'git commit --allow-empty -am "ship it"',
    'git commit --allow-empty --message "ship it"',
  ])('WARN: %s', (command) => {
    const r = runJournaled(command)
    expect(r.entries.map((e) => e.class)).toEqual([EMPTY_CLASS])
    expect(r.denied).toBe(false)
  })

  it.each([
    `echo 'git commit --allow-empty -m "ship it"'`,
    'printf "%s" "git commit --allow-empty -m ship"',
    'git commit --allow-empty -mmarker',
  ])('SILENT: %s', (command) => {
    const r = runJournaled(command)
    expect(r.stdout).toBe('')
    expect(r.entries).toHaveLength(0)
  })

  it('the notice says the commit MAY record no change, never that it is empty', () => {
    const r = runJournaled('git commit --allow-empty -m "feat: ship it"')
    expect(r.context).toContain('may record NO change')
    expect(r.context).not.toMatch(/commit is EMPTY/i)
    expect(r.context).toContain('delivery')
  })

  it('WARN: --message="..." with a backtick raises the backtick hazard', () => {
    const r = runJournaled('git commit --message="the `thing`"')
    expect(r.entries.map((e) => e.class)).toEqual(['unescaped-backtick'])
  })
})

describe('wt-git-commit-backtick-guard-hook: empty commit and backtick notices', () => {
  it('ONE notice carries BOTH warnings when the command has both hazards', () => {
    const r = runJournaled('git commit --allow-empty -m "ship the `thing` now"')
    expect(r.stdout.match(/hookSpecificOutput/g)).toHaveLength(1)
    expect(r.context).toContain('may record NO change')
    expect(r.context).toContain('contains an unescaped backtick')
    expect(r.entries.map((e) => e.class).sort()).toEqual([EMPTY_CLASS, 'unescaped-backtick'])
  })

  it('a backtick-only command still gets just the backtick warning', () => {
    const r = runJournaled('git commit -m "the default `stretch` applied"')
    expect(r.context).not.toContain('may record NO change')
    expect(r.entries.map((e) => e.class)).toEqual(['unescaped-backtick'])
  })

  it('WT_GUARD_MODE=observe stays silent on stdout for the empty-commit case, journal kept', () => {
    const r = runJournaled('git commit --allow-empty -m "feat: ship it"', { WT_GUARD_MODE: 'observe' })
    expect(r.stdout).toBe('')
    expect(r.entries[0]).toMatchObject({ class: EMPTY_CLASS })
  })

  it('a subagent gets the notice as context only', () => {
    const r = runJournaled('git commit --allow-empty -m "feat: ship it"', {}, 'agent-1')
    expect(r.context).toContain('--allow-empty')
    expect(r.stdout).not.toContain('permissionDecision')
  })
})
