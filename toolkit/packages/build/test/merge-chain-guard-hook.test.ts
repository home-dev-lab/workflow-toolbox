import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LEXER_CASES, MERGE_LEXER_CASES } from './helpers/commit-chain-lexer-fixtures.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-merge-chain-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

const REVIEW_CASES = [
  ['E1.1 unrelated condition', 'pnpm test; test -n yes && git commit -m x', 'WARN'],
  ['E1.1 stale status', 'pnpm test; echo done; test $? -eq 0 && git commit -m x', 'WARN'],
  ['E1.1 braced status', 'pnpm test; test ${?} -eq 0 && git commit -m x', 'WARN'],
  ['E1.2 conditional set', 'false && set -e; pnpm test; git commit -m x', 'WARN'],
  ['E1.2 conditional setopt', 'false && setopt ERR_EXIT; pnpm test; git commit -m x', 'WARN'],
  ['E1.2 conditional or set', 'true || set -e; pnpm test; git commit -m x', 'WARN'],
  ['E1.3 subshell option', '(set -e; true); pnpm test; git commit -m x', 'WARN'],
  ['E1.2 compound option', 'if true; then true; set -e; fi; pnpm test; git commit -m x', 'WARN'],
  ['E1.2 brace option', '{ true; set -e; }; pnpm test; git commit -m x', 'WARN'],
  ['E1.4 errexit exemption', 'set -e; pnpm test && echo passed; git commit -m x', 'WARN'],
  ['E1.5 subshell exit', 'pnpm test || (exit 1); git commit -m x', 'WARN'],
  ['E1.5 return', 'pnpm test || return 1; git commit -m x', 'WARN'],
  ['E1.6 concurrent pipeline commit', 'set -o pipefail; pnpm test | git commit -m x', 'WARN'],
  ['E1.7 mutation killer', 'set -e; pnpm test | tail -5 && git commit -m x', 'WARN'],
  ['E1.7 independent pipefail', 'set -e; set -o pipefail; pnpm test | tail -5; git commit -m x', 'WARN'],
  ['E1.8 double quoted head', '"pnpm" test; git commit -m x', 'WARN'],
  ['E1.8 single quoted head', "'pnpm' test; git commit -m x", 'WARN'],
  ['E1.9 long git flag', 'pnpm test; git --no-optional-locks commit -m x', 'WARN'],
  ['E1.9 short git flag', 'pnpm test; git -P commit -m x', 'WARN'],
  ['E1.9 git basename', 'pnpm test; /usr/bin/git commit -m x', 'WARN'],
  ['cross-platform git bash exe path', 'pnpm test; /c/Program-Files/Git/bin/git.exe commit -m x', 'WARN'],
  ['cross-platform uppercase exe', 'pnpm test; git.EXE commit -m x', 'WARN'],
  ['cross-platform exe gate', '/c/nodejs/node.exe scripts/check.mjs; git commit -m x', 'WARN'],
  ['cross-platform quoted windows git path', 'pnpm test; "C:\\Program Files\\Git\\bin\\git.exe" commit -m x', 'WARN'],
  ['cross-platform quoted windows gate path', '"C:\\nodejs\\node.exe" scripts/check.mjs; git commit -m x', 'WARN'],
  ['E1.9 command wrapper', 'pnpm test; command git commit -m x', 'WARN'],
  ['E1.9 value global', 'pnpm test; git --namespace demo --config-env x=Y commit -m x', 'WARN'],
  ['E1.10 terminated heredoc', 'cat <<EOF\nx\nEOF\npnpm test; git commit -m x', 'WARN'],
  ['E2.1 newline continuation', 'pnpm test &&\ngit commit -m x', 'SILENT'],
  ['E2.1 spaced continuation', 'pnpm test && \ngit commit -m x', 'SILENT'],
  ['E2.1 or continuation', 'pnpm test ||\ngit commit -m x', 'WARN'],
  ['E2.1 pipe continuation', 'pnpm test |\ngit commit -m x', 'WARN'],
  ['E2.2 unconditional exit', 'pnpm test; exit 1; git commit -m x', 'WARN'],
  ['E2.3 failure list', 'pnpm test || false && git commit -m x', 'WARN'],
  ['E2.4 escaped separator', 'pnpm test \\; git commit -m x', 'SILENT'],
  ['E2.5 uppercase setopt', 'setopt ERR_EXIT; pnpm test; git commit -m x', 'WARN'],
  ['E2.5 lowercase setopt', 'setopt errexit; pnpm test; git commit -m x', 'WARN'],
  ['E2.5 underscore setopt', 'setopt err_exit; pnpm test; git commit -m x', 'WARN'],
  ['E2.5 pipefail setopt', 'setopt ERR_EXIT PIPE_FAIL; pnpm test | tail -5; git commit -m x', 'WARN'],
  ['E2.5 unsetopt', 'setopt ERR_EXIT; unsetopt err_exit; pnpm test; git commit -m x', 'WARN'],
  ['E3 node inline', 'node -e "x" ; git commit -m x', 'SILENT'],
  ['E3 attached inline', "node -e'x'; git commit -m x", 'SILENT'],
  ['E3 python inline', 'python3 -c "x"\ngit commit -m x', 'SILENT'],
  ['E3 package version', 'pnpm --version; git commit -m x', 'SILENT'],
  ['E3 package install', 'pnpm install; git commit -m x', 'SILENT'],
  ['E3 node script', 'node scripts/check.mjs; git commit -m x', 'WARN'],
  ['E3 package directory', 'pnpm --dir toolkit typecheck; git commit -m x', 'WARN'],
  ['E3 script pipeline', 'node hooks.selftest.mjs 2>&1 | tail -3; git commit -m x', 'WARN'],
  ['E3 node check', 'node --check hooks.selftest.mjs; git commit -m x', 'WARN'],
  ['E3 interpreter stdin', 'node -; git commit -m x', 'SILENT'],
  ['E3 interpreter empty', 'python3; git commit -m x', 'SILENT'],
  ['E3 interpreter heredoc', 'python3 <<EOF\nx\nEOF\ngit commit -m x', 'SILENT'],
  ['E3 shell inline', 'bash -c "pnpm test"; git commit -m x', 'SILENT'],
  ['E3 curl', 'curl example.test; git commit -m x', 'SILENT'],
  ['E3 wget', 'wget example.test; git commit -m x', 'SILENT'],
  ['E3 bun', 'bun test; git commit -m x', 'WARN'],
  ['E4 balanced wrapper', '( ! time env FOO=x timeout 30 /usr/bin/pnpm test; git -c x=y --no-pager --git-dir=/g --work-tree /w commit --amend )', 'WARN'],
  ['F1 inverted status', 'pnpm test; test $? -ne 0 && git commit -m x', 'WARN'],
  ['F1 literal status', "pnpm test; test -n '$?' && git commit -m x", 'WARN'],
  ['F1 conditional disable', 'set -e; true && set +e; pnpm test; git commit -m x', 'WARN'],
  ['F1 subshell disable', 'set -e; (set +e; pnpm test; git commit -m x)', 'WARN'],
  ['F1 negated gate', '! pnpm test && git commit -m x', 'WARN'],
  ['F1 nested negated gate', '( ! pnpm test && git commit -m x )', 'WARN'],
  ['F1 timed negated gate', 'time ! pnpm test && git commit -m x', 'WARN'],
  ['F1 negated errexit', 'set -e; ! pnpm test; git commit -m x', 'WARN'],
  ['F1 pipeline exit', 'pnpm test; exit 1 | cat; git commit -m x', 'WARN'],
  ['F1 unknown failure', 'pnpm test || test -d /definitely-not-present || git commit -m x', 'WARN'],
  ['F1 skipped pipeline', 'pnpm test && echo passed | git commit -m x', 'WARN'],
  ['F1 final false', 'set -e; pnpm test || false; git commit -m x', 'WARN'],
  ['F1 local errexit', '(set -e; pnpm test; git commit -m x)', 'WARN'],
  ['F1 subshell failure list', 'pnpm test || (exit 1) && git commit -m x', 'WARN'],
  ['F1 status brackets', 'pnpm test; [ $? -eq 0 ] && git commit -m x', 'WARN'],
  ['F1 errexit', 'set -e; pnpm test; git commit -m x', 'WARN'],
  ['F1 combined options', 'set -euo pipefail; pnpm test | tail -5 && git commit -m x', 'WARN'],
  ['F1 exit handler', 'pnpm test || exit 1; git commit -m x', 'WARN'],
  ['F1 named errexit', 'set -o errexit; pnpm test; git commit -m x', 'WARN'],
  ['F1 status test', 'pnpm test; test $? -eq 0 && git commit -m x', 'WARN'],
  ['F1 double brackets', 'pnpm test; [[ $? == 0 ]] && git commit -m x', 'WARN'],
  ['F1 background gate', 'pnpm test & git commit -m x', 'WARN'],
  ['F1 redirection safe chain', 'pnpm test 2>&1 && git commit -m x', 'SILENT'],
  ['F1 ampersand redirection', 'pnpm test &>log && git commit -m x', 'SILENT'],
  ['F2 command path search', 'pnpm test; command -p git commit -m x', 'WARN'],
  ['F2 command option end', 'pnpm test; command -- git commit -m x', 'WARN'],
  ['F2 script argument', 'node scripts/check.mjs -p foo; git commit -m x', 'WARN'],
  ['F2 yarn version', 'yarn --version; git commit -m x', 'SILENT'],
  ['F2 silent install', 'pnpm --silent install; git commit -m x', 'SILENT'],
  ['F2 npm ci', 'npm ci; git commit -m x', 'SILENT'],
  ['F2 attached directory query', 'pnpm --dir=foo --version; git commit -m x', 'SILENT'],
  ['F2 package flags', 'pnpm --silent --dir=x --prefix x -w --filter y -C z typecheck; git commit -m x', 'WARN'],
  ['F2 bash syntax', 'bash -n file; git commit -m x', 'WARN'],
  ['F2 sh syntax', 'sh -n file; git commit -m x', 'WARN'],
  ['F3 tab heredoc', 'cat <<-EOF\n\tx\n\tEOF\npnpm test; git commit -m x', 'WARN'],
  ['F3 numeric heredoc', 'cat <<123\npnpm test; git commit -m x\n123', 'SILENT'],
  ['F3 double quoted heredoc', 'cat <<"123"\npnpm test; git commit -m x\n123', 'SILENT'],
  ['F3 multiple heredocs', 'cat <<A <<B\nx\nA\npnpm test; git commit -m x\nB', 'SILENT'],
  ['F3 unterminated heredoc', 'cat <<EOF\npnpm test; git commit -m x', 'WARN'],
  ['F3 unterminated header', 'cat <<EOF; pnpm test; git commit -m x', 'WARN'],
  ['F3 here string', 'cat <<< "pnpm test; git commit"; pnpm test; git commit -m x', 'WARN'],
  ['resolver timeout argument order', 'timeout env X=y pnpm lint; git commit -m x', 'SILENT'],
] as const

function run(command: string, agent_id?: string) {
  const journalDir = mkdtempSync(join(tmpdir(), 'wt-merge-chain-journal-'))
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: 'session-test-123',
        ...(agent_id ? { agent_id } : {}),
        tool_input: { command },
      }),
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir },
    })
    const entries = readdirSync(journalDir)
      .filter((file) => file.endsWith('.ndjson'))
      .flatMap((file) => readFileSync(join(journalDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    return {
      // Merge detections are journal-only; commit notices use additionalContext.
      warned: entries.some((entry) => entry.decision === 'warned'),
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
  it.each([...REVIEW_CASES, ...LEXER_CASES])('review lock: %s (%s → %s)', (_id, command, expected) => {
    const r = run(command)
    expect(r.status).toBe(0)
    const records = r.entries.filter((entry) => entry.class === 'chained-commit')
    if (expected === 'WARN') {
      expect(records).toHaveLength(1)
      const output = JSON.parse(r.stdout).hookSpecificOutput
      expect(output.additionalContext).toContain('WARNING (not blocked)')
      expect(Object.keys(output)).toEqual(['hookEventName', 'additionalContext'])
      expect(Object.keys(records[0].evidence)).toEqual(['separator', 'gate'])
      expect(['semicolon', 'newline', 'or', 'pipe', 'background', 'negated']).toContain(records[0].evidence.separator)
      if (_id === 'E2.1 or continuation') expect(records[0].evidence.separator).toBe('or')
      if (_id === 'E2.1 pipe continuation') expect(records[0].evidence.separator).toBe('pipe')
    } else {
      expect(r.stdout).toBe('')
      expect(records).toEqual([])
    }
  })

  it.each(MERGE_LEXER_CASES)('merge lexer lock: %s', (_id, command, expected) => {
    const r = run(command)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    const records = r.entries.filter((entry) => entry.class === 'chained-merge')
    if (expected === 'WARN') {
      expect(records).toMatchObject([{ decision: 'warned', evidence: { trailing: 'gate' } }])
    } else expect(records).toEqual([])
  })

  it('merge check sees commands following a terminated heredoc', () => {
    const r = run('cat <<EOF\nx\nEOF\ngit merge branch; pnpm test')
    expect(r.stdout).toBe('')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ class: 'chained-merge', decision: 'warned', evidence: { trailing: 'gate' } })
  })

  it('merge check classification is unchanged by the bash-correct word splitter', () => {
    // The merge check blanks quoted spans before reading heads, so a quoted Windows path stays
    // unclassified there; an unquoted Git Bash path with .exe is now read as the gate it is.
    const quoted = run('git merge feature; "C:\\nodejs\\node.exe" check.mjs')
    expect(quoted.entries[0]).toMatchObject({ class: 'chained-merge', evidence: { trailing: 'unclassified' } })
    const unquoted = run('git merge feature; /c/nodejs/node.exe check.mjs')
    expect(unquoted.entries[0]).toMatchObject({ class: 'chained-merge', evidence: { trailing: 'gate' } })
  })

  it('bounds commit analysis to the first 128 segments', () => {
    const safe = Array.from({ length: 128 }, () => 'true').join('; ')
    expect(run(`${safe}; pnpm test; git commit -m x`).entries).toEqual([])
    expect(run(`pnpm test; git commit -m x; ${safe}`).entries).toHaveLength(1)
  })

  it('skips commit analysis above the UTF-8 byte cap but keeps merge analysis', () => {
    expect(run(`pnpm test; git commit -m x; echo '${'é'.repeat(32768)}'`).entries).toEqual([])
    expect(run(`git merge branch; pnpm test; echo '${'x'.repeat(65536)}'`).entries)
      .toMatchObject([{ class: 'chained-merge', decision: 'warned' }])
  })

  it.each(['<<-EOF\n\tx\n\tEOF', '<<123\nx\n123'])('merge check sees commands after heredoc %s', (doc) => {
    expect(run(`cat ${doc}\ngit merge branch; pnpm test`).entries)
      .toMatchObject([{ class: 'chained-merge', decision: 'warned', evidence: { trailing: 'gate' } }])
  })

  it.each([
    ['pnpm test; git commit -m x', 'semicolon', 'pnpm'],
    ['pnpm test\ngit commit -m x', 'newline', 'pnpm'],
    ['pnpm test || git commit -m x', 'or', 'pnpm'],
    ['pnpm test | tail -5 && git commit -m x', 'pipe', 'pnpm'],
    ['node scripts/quality/run-quality.mjs --root /r; git -C /r commit -F /tmp/m', 'semicolon', 'node'],
    ['pnpm test && pnpm lint; git commit -m x', 'semicolon', 'pnpm'],
    ['cd x && pnpm typecheck; git add -A && git commit -m x', 'semicolon', 'pnpm'],
    ['pnpm test || echo failed; git commit -m x', 'or', 'pnpm'],
    ['set -e; set +e; pnpm test; git commit --amend', 'semicolon', 'pnpm'],
    ['set -o pipefail; set +o pipefail; pnpm test |& tail -5 && git commit -m x', 'pipe', 'pnpm'],
    ['( ! time env FOO=x timeout 30 /usr/bin/pnpm test; git -c x=y --no-pager --git-dir=/g --work-tree /w commit --amend )', 'negated', 'pnpm'],
  ])('commit WARN: %s', (command, separator, gate) => {
    const r = run(command)
    const output = JSON.parse(r.stdout).hookSpecificOutput
    expect(r.status).toBe(0)
    expect(output.additionalContext).toContain('[workflow-toolbox commit-chain guard] WARNING (not blocked):')
    expect(Object.keys(output)).toEqual(['hookEventName', 'additionalContext'])
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ decision: 'warned', class: 'chained-commit', evidence: { separator, gate } })
    expect(r.entries[0]).not.toHaveProperty('reason')
  })

  it.each([
    'pnpm test && git commit -m x', 'git commit -m x', 'git add -A; git commit -m x',
    'if pnpm test; then git commit -m x; fi',
    'git commit -m x; pnpm test', 'pnpm test; git commit-tree abc',
    "cat <<'MSG'\npnpm test; git commit -m x\nMSG", 'echo "pnpm test; git commit -m x"',
    'pnpm test &&\ngit commit -m x',
    'pnpm test; else git commit -m x', 'pnpm test; elif git commit -m x', 'pnpm test; do git commit -m x',
    'pnpm test; git commit-graph write',
  ])('commit SILENT: %s', (command) => {
    const r = run(command)
    expect(r.stdout).toBe('')
    expect(r.entries.filter((entry) => entry.class === 'chained-commit')).toEqual([])
  })

  it('delivers identical context to subagents without journaling commit message text', () => {
    const command = 'pnpm test; git commit -m DO_NOT_RECORD_MESSAGE'
    const main = run(command)
    const agent = run(command, 'delegate')
    expect(agent.stdout).toBe(main.stdout)
    expect(JSON.parse(agent.stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', additionalContext: expect.any(String),
    } })
    expect(JSON.stringify(agent.entries)).not.toContain('DO_NOT_RECORD_MESSAGE')
    expect(agent.entries[0]).toMatchObject({ agent: 'delegate', class: 'chained-commit' })
  })

  it.each([undefined, 'delegate'])('combined merge and commit emits exactly one context-only object (%s)', (agent) => {
    const r = run('git merge x; pnpm test; git commit -m y', agent)
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('commit-chain guard'),
    } })
    expect(r.entries.map((entry) => entry.class)).toEqual(['chained-merge', 'chained-commit'])
  })

  it.each(['git merge x; pnpm test', 'git merge x && pnpm test', 'git merge x; echo done', 'git merge x', 'git merge --abort && pnpm test'])(
    'merge-only output stays silent without granting permission: %s', (command) => {
      expect(run(command).stdout).toBe('')
    },
  )

  it('WARN: a merge chained with && is flagged, never blocked', () => {
    const r = run('git merge --no-ff branch && pnpm test')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
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

  it('SILENT: a merge chained with || to a diagnostic read is journaled', () => {
    const r = run('git merge branch || echo failed')
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ decision: 'silent', evidence: { trailing: 'diagnostic' } })
  })

  it('CLASSIFY gate: a trailing command that trusts the merged tree (pnpm test)', () => {
    const r = run('git merge branch && pnpm test')
    expect(r.warned).toBe(true)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      decision: 'warned',
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
    expect(r.stdout).toBe('')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      decision: 'silent',
      session: 'session-test-123',
      evidence: { trailing: 'diagnostic' },
    })
  })

  it('CLASSIFY diagnostic: all documented diagnostic heads stay silent and journaled', () => {
    const r = run('git merge branch; tail log; head log; cut -d: -f1 log; grep merged log; wc -l log; echo done; cat log; git log -1; git status --short; git show --stat; git diff --stat; git rev-parse HEAD; git merge-base HEAD main')
    expect(r.stdout).toBe('')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ decision: 'silent', evidence: { trailing: 'diagnostic' } })
  })

  it('CLASSIFY unclassified: a trailing command the classifier cannot place', () => {
    const r = run('git merge branch && ./scripts/custom-thing.sh')
    expect(r.warned).toBe(true)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      decision: 'warned',
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

  // Conflict with main's security lock: retained to record the branch's displaced raw-evidence contract.
  it.skip('records only trailing command heads, resolving assignments, timeout, and a quoted path without leaking arguments', () => {
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
