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

  it('CLASSIFY gate: a trailing command that trusts the merged tree (pnpm test)', () => {
    const r = run('git merge branch && pnpm test')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      session: 'session-test-123',
      evidence: { trailing: 'gate' },
    })
  })

  it('CLASSIFY gate: ANY gate segment in the chain wins, even alongside diagnostic reads', () => {
    // The documented safe pattern's own log/exit-code read (`echo`) sits right next to a real
    // gate (`pnpm test`) here — one blind gate in the chain is still the hazard.
    const r = run('git merge branch > log 2>&1 && echo "merge: $?" && pnpm test')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].evidence).toEqual({ trailing: 'gate' })
  })

  it('CLASSIFY diagnostic: the project\'s documented safe pattern (log/exit-code read only)', () => {
    const r = run('git merge branch > log 2>&1; echo "merge: $?"; cat log')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      session: 'session-test-123',
      evidence: { trailing: 'diagnostic' },
    })
  })

  it('CLASSIFY unclassified: a trailing command the classifier cannot place', () => {
    const r = run('git merge branch && ./scripts/custom-thing.sh')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      session: 'session-test-123',
      evidence: { trailing: 'unclassified' },
    })
  })

  it('SECURITY LOCK: no raw command text — of any trailing segment, in any resolution path (assignment, timeout, quoted path) — ever reaches the journal record', () => {
    const secret = 'sk_live_DO_NOT_JOURNAL'
    const r = run(
      `git merge branch && FOO=bar pnpm test --token ${secret}; timeout 570 git log --password ${secret}; "/opt/tools/npx" run task --secret ${secret}`,
    )
    expect(r.entries).toHaveLength(1)
    const entry = r.entries[0]
    // Positive assertion: the record's evidence is EXACTLY the closed-set classification —
    // nothing else, so there is no field a secret or an argument could have hidden in.
    expect(entry).toMatchObject({
      session: 'session-test-123',
      evidence: { trailing: 'gate' },
    })
    // The merge segment itself is raw command text too (branch names, paths): it must not be
    // recorded as `reason` either. The classification is the whole record.
    expect(entry).not.toHaveProperty('reason')
    expect(JSON.stringify(entry)).not.toContain('git merge branch')
    expect(Object.keys(entry.evidence)).toEqual(['trailing'])
    expect(['gate', 'diagnostic', 'unclassified']).toContain(entry.evidence.trailing)
    // Belt: none of the trailing segments' own text — command names, flags, or the secret —
    // appears anywhere in the serialized record.
    const serialized = JSON.stringify(entry)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('--token')
    expect(serialized).not.toContain('--password')
    expect(serialized).not.toContain('--secret')
    expect(serialized).not.toContain('pnpm')
    expect(serialized).not.toContain('npx')
    expect(serialized).not.toContain('FOO=bar')
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
