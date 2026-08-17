import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-merge-chain-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

function run(command: string) {
  const journalDir = mkdtempSync(join(tmpdir(), 'wt-merge-chain-journal-'))
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: 'session-test-123',
        tool_input: { command },
      }),
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir },
    })
    const entries = readdirSync(journalDir)
      .filter((file) => file.endsWith('.ndjson'))
      .flatMap((file) => readFileSync(join(journalDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    return {
      // This guard ships WARN-ONLY (permissionDecision: 'allow' + a reason), never 'deny' — see
      // the header comment for the measured precision that decided it. `warned` means the
      // predicate matched and a non-blocking reason was emitted; the tool call itself is never
      // refused, so `denied` (a "deny" decision) must NEVER be true for this hook.
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

describe('wt-merge-chain-guard-hook', () => {
  it('WARN: a merge chained with && is flagged, never blocked', () => {
    const r = run('git merge --no-ff branch && pnpm test')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.stdout).toContain('git merge --no-ff branch')
    expect(r.stdout).toContain('"allow"')
    expect(r.status).toBe(0)
  })

  it('WARN: a merge chained with ; is flagged', () => {
    const r = run('git merge branch ; pnpm test')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('WARN: a merge chained on a separate line of the same command is flagged', () => {
    const r = run('git merge branch\npnpm test')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('WARN: a merge on a repo named with -C, chained with &&, is flagged', () => {
    const r = run('git -C /abs/path merge branch && pnpm test')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('WARN: a merge chained with a pipe is flagged', () => {
    const r = run('git merge branch | tee merge.log')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('WARN: a merge chained with || is flagged', () => {
    const r = run('git merge branch || echo failed')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('records only trailing command heads, resolving assignments, timeout, and a quoted path without leaking arguments', () => {
    const secret = 'sk_live_DO_NOT_JOURNAL'
    const r = run(
      `git merge branch && FOO=bar pnpm test --token ${secret}; timeout 570 git log --password ${secret}; "/opt/tools/npx" run task --secret ${secret}`,
    )
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      session: 'session-test-123',
      evidence: { after: 'pnpm,git,/opt/tools/npx' },
    })
    expect(JSON.stringify(r.entries[0])).not.toContain(secret)
    expect(JSON.stringify(r.entries[0])).not.toContain('--token')
    expect(JSON.stringify(r.entries[0])).not.toContain('--password')
    expect(JSON.stringify(r.entries[0])).not.toContain('--secret')
  })

  it('SILENT: a merge run alone', () => {
    const r = run('git merge --no-ff branch')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: a merge preceded by other commands', () => {
    const r = run('cd repo && git merge branch')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: git merge --abort chained with a following command', () => {
    const r = run('git merge --abort && echo done')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: git merge --continue chained with a following command', () => {
    const r = run('git merge --continue && pnpm test')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: git merge --quit chained with a following command', () => {
    const r = run('git merge --quit && pnpm test')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: a trailing separator with nothing after it', () => {
    const r = run('git merge branch;')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: `git merge-base` is a different subcommand, never flagged', () => {
    // Regression test for the anchor bug found during real-history measurement: `merge\b`
    // alone also matches the boundary inside `merge-base`/`merge-tree`/`merge-file`. This was
    // the single most common false-positive shape found scanning real session transcripts.
    const r = run('git merge-base --is-ancestor abc123 main && echo yes || echo no')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: the exact chained shape inside a heredoc body (no backticks, no prose prefix — only heredoc stripping can save it)', () => {
    const r = run(
      [
        "git commit -F - <<'MSG'",
        'git merge branch && pnpm test',
        'MSG',
      ].join('\n'),
    )
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: "merge" inside a shell comment', () => {
    const r = run('# git merge branch && pnpm test is wrong\npnpm test')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: a trailing comment after && is not a real chained command (only comment stripping saves it)', () => {
    // Without comment stripping, the segment split sees TWO non-empty segments here — the
    // merge, and the comment text — and would wrongly read the comment as a real chained
    // command. Comment stripping empties the second segment, leaving only the merge, which is
    // then the LAST real segment and therefore not chained with anything.
    const r = run('git merge branch && # gate below, nothing else runs on this line')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: "merge" inside a quoted string', () => {
    const r = run('echo "run git merge branch && pnpm test is wrong"')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: a `;`/`&&`-carrying quoted commit message is not a real chain (only quote stripping saves it)', () => {
    // Without quote stripping, splitting on `;`/`&&` cuts INSIDE this quoted commit message,
    // producing a spurious segment `git merge branch` immediately followed by a spurious
    // `pnpm test` segment — a false positive. Quote stripping collapses the whole double-quoted
    // span into one token first, so the split never lands inside it.
    const r = run('git commit -m "before; git merge branch && pnpm test; after"')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('stays out of the way for an ordinary command with no merge', () => {
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
      .some((h: { command?: string }) => h.command?.includes('wt-merge-chain-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})
