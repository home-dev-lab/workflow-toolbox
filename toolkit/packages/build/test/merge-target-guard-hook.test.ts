import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-merge-target-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

function run(command: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const journalDir = mkdtempSync(join(tmpdir(), 'wt-merge-target-journal-'))
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: 'session-test-123',
        tool_input: { command },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        WT_GUARD_JOURNAL_DIR: journalDir,
        WT_GUARD_JOURNAL_TEST_ORIGIN: '1',
        ...extraEnv,
      },
    })
    const entries = readdirSync(journalDir)
      .filter((file) => file.endsWith('.ndjson'))
      .flatMap((file) => readFileSync(join(journalDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    return {
      warned: res.stdout.includes('WARNING (not blocked)'),
      denied: res.stdout.includes('"deny"'),
      stdout: res.stdout,
      stderr: res.stderr,
      status: res.status,
      entries,
    }
  } finally {
    rmSync(journalDir, { recursive: true, force: true })
  }
}

describe('wt-merge-target-guard-hook', () => {
  it('WARN: two refs after git merge are flagged but never blocked', () => {
    const r = run('git merge --ff-only abc123 develop')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      guard: 'wt-merge-target-guard-hook.mjs',
      decision: 'warned',
      class: 'multi-ref-merge',
      evidence: { refs: 'multiple' },
    })
  })

  it('SILENT: a single-quoted -m subject is blanked before argument tokenisation', () => {
    const r = run("git merge --no-ff -m 'merge: card X into develop' branch")
    expect(r.stdout).toBe('')
    expect(r.entries).toHaveLength(0)
  })

  it('SILENT: a double-quoted -m subject is blanked before argument tokenisation', () => {
    const r = run('git merge --no-ff -m "merge: card X into develop" branch')
    expect(r.stdout).toBe('')
    expect(r.entries).toHaveLength(0)
  })

  it('SILENT: one ref with git -C is not a multi-ref merge', () => {
    const r = run('git -C /tmp/project merge abc123')
    expect(r.stdout).toBe('')
  })

  it('classifies option values separately from refs', () => {
    expect(run('git merge -s ours branch').stdout).toBe('')
    expect(run('git merge -s ours source target').warned).toBe(true)
  })

  it('WARN: valid git global options do not hide a multi-ref merge', () => {
    expect(run('git -c merge.conflictStyle=diff3 merge source target').warned).toBe(true)
    expect(run('git --no-pager merge source target').warned).toBe(true)
  })

  it('WARN: quoted refs remain merge arguments', () => {
    expect(run('git merge "source" target').warned).toBe(true)
  })

  it('SILENT: heredoc body text is not parsed as a command', () => {
    expect(run("cat <<'EOF' > script.sh\ngit merge source target\nEOF").stdout).toBe('')
  })

  it('SILENT: separate values for merge options are not counted as refs', () => {
    expect(run('git merge --cleanup strip source').stdout).toBe('')
    expect(run('git merge --log 20 source').stdout).toBe('')
  })

  it('SILENT: merge state operations are excluded', () => {
    for (const operation of ['--abort', '--continue', '--quit']) {
      const r = run(`git merge ${operation}`)
      expect(r.stdout, operation).toBe('')
    }
  })

  it('SILENT: merge-base is an exact-subcommand regression lock', () => {
    const r = run('git merge-base --is-ancestor A B')
    expect(r.stdout).toBe('')
  })

  it('SILENT: merge-tree is not the merge subcommand', () => {
    const r = run('git merge-tree a b c')
    expect(r.stdout).toBe('')
  })

  it('fails open with a trace when the hook entry path breaks', () => {
    const r = run('git merge source target', {
      WT_FAIL_OPEN_TRACE_SELF_TEST: 'wt-merge-target-guard-hook.mjs',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('wt-merge-target-guard-hook.mjs: FAILED OPEN')
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((entry: { matcher?: string }) => entry.matcher === 'Bash')
      .flatMap((entry: { hooks?: { command?: string }[] }) => entry.hooks ?? [])
      .some((hook: { command?: string }) => hook.command === 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-merge-target-guard-hook.mjs"')
    expect(wired).toBe(true)
  })
})
