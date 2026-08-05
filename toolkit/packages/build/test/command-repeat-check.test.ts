import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { classifyCommandShape, classifyVerdict, fingerprintResult, normalizeCommandShape, observeCommandRepeat } from '../../../../plugin/bin/lib/command-repeat-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(REPO_ROOT, 'plugin/bin/wt-command-repeat-check.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-command-repeat-${tag}-`))
  roots.push(root)
  return root
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
}

function cliArgs({
  session,
  cwd,
  command,
  exitCode,
  stdout,
  stateDir,
}: {
  session: string
  cwd: string
  command: string
  exitCode: number
  stdout: string
  stateDir: string
}) {
  return [
    '--session',
    session,
    '--cwd',
    cwd,
    '--command',
    command,
    '--exit-code',
    String(exitCode),
    '--stdout',
    stdout,
    '--state-dir',
    stateDir,
    '--json',
  ]
}

describe('command-repeat-core', () => {
  it('classifyCommandShape derives the four hollow corpus signatures from verb+flags alone (not just "they differ")', () => {
    const commands = [
      'find .claude/watchers -maxdepth 2 -newermt 2026-08-04T20:00:00',
      'pgrep -cf "opencode run"',
      "grep -c 'not' output.log",
      'claude -p "did the tool call happen" | grep -c toolu_',
    ]
    const signatures = commands.map((command) => classifyCommandShape({ command }).classSignature)

    // Exact expected values, not just distinctness — a regression that keeps
    // literal arguments in the signature would still produce 4 distinct
    // strings and slip past a bare uniqueness check.
    expect(signatures).toEqual([
      'find -maxdepth -newermt',
      'pgrep -cf',
      'grep -c',
      'claude -p | grep -c',
    ])
  })

  it('classifyCommandShape ignores literal grep patterns and files while preserving verb plus ordered flags', () => {
    const signatures = [
      "grep -c 'not' output.log",
      "grep -c 'never' other.log",
      "grep -c 'foo' third.log",
    ].map((command) => classifyCommandShape({ command }).classSignature)

    expect(new Set(signatures)).toEqual(new Set(['grep -c']))
  })

  it('classifyCommandShape normalizes flag ORDER so equivalent invocations cannot dodge the class key by reordering options', () => {
    const signatures = [
      'grep -c -i -n needle one',
      'grep -i -n -c needle two',
      'grep -n -c -i needle three',
    ].map((command) => classifyCommandShape({ command }).classSignature)

    expect(new Set(signatures)).toEqual(new Set(['grep -c -i -n']))
  })

  it('classifyCommandShape strips a long-flag VALUE so --include=*.js and --include=*.ts share a class', () => {
    const signatures = [
      'grep --include=*.js needle one',
      'grep --include=*.ts needle two',
    ].map((command) => classifyCommandShape({ command }).classSignature)

    expect(new Set(signatures)).toEqual(new Set(['grep --include']))
  })

  it('classifyCommandShape stops collecting flags at a bare -- terminator (POSIX end-of-options)', () => {
    const signatures = [
      'grep -c -- -one file',
      'grep -c -- -two b',
    ].map((command) => classifyCommandShape({ command }).classSignature)

    expect(new Set(signatures)).toEqual(new Set(['grep -c']))
  })

  it('classifyCommandShape does not let an escaped quote inside a quoted argument split the pipeline early', () => {
    // The `\"` inside the double-quoted pattern is a LITERAL quote in shell
    // syntax; the pipe right after it stays inside the quoted string and must
    // not be treated as a pipeline separator.
    const signature = classifyCommandShape({
      command: 'grep -c "foo\\" | bar" input | grep -c needle',
    }).classSignature

    expect(signature).toBe('grep -c | grep -c')
  })

  it('classifyVerdict treats exit 1 with non-empty stderr as a real error, never hollow', () => {
    expect(classifyVerdict({ stdout: '' })).toBe('hollow')
    expect(classifyVerdict({ stdout: '0' })).toBe('hollow')
    expect(classifyVerdict({ exitCode: 1, stdout: ' ', stderr: '' })).toBe('hollow')
    expect(classifyVerdict({ exitCode: 0, stdout: '4', stderr: '' })).toBe('non-hollow')
    expect(classifyVerdict({ exitCode: 1, stdout: '', stderr: 'real error' })).toBe('non-hollow')
  })

  it('classifyVerdict does not call exit-1-with-empty-stderr hollow when stdout carries real, meaningful content', () => {
    // The diff / git-diff --exit-code convention: exit 1 with a genuine,
    // substantive diff on stdout and nothing on stderr. This is the exact
    // shape an earlier version of classifyVerdict misclassified as hollow.
    const diffLikeStdout = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n'
    expect(classifyVerdict({ exitCode: 1, stdout: diffLikeStdout, stderr: '' })).toBe('non-hollow')
  })

  it('normalizes only volatile path/time noise, not meaningful numeric arguments', () => {
    const first = normalizeCommandShape({
      cwd: '/home/alice/projects/wt-suite/worktrees/repeat-20260804/toolkit',
      command:
        'git -C /home/alice/projects/wt-suite/worktrees/repeat-20260804/toolkit status > /tmp/wt-run-1722981111222.42424.log 2>&1',
    })
    const second = normalizeCommandShape({
      cwd: '/home/alice/projects/wt-suite/worktrees/review-20260805/toolkit',
      command:
        'git -C /home/alice/projects/wt-suite/worktrees/review-20260805/toolkit status > /tmp/wt-run-1723999999999.51515.log 2>&1',
    })
    const third = normalizeCommandShape({ command: 'sleep 30' })
    const fourth = normalizeCommandShape({ command: 'sleep 300' })

    expect(first.shapeHash).toBe(second.shapeHash)
    expect(first.normalizedCommand).toContain('/worktrees/<worktree>/toolkit')
    expect(first.normalizedCommand).toContain('/tmp/<tmp>')
    expect(third.shapeHash).not.toBe(fourth.shapeHash)
  })

  it('fingerprints the same output identically and a changed output differently', () => {
    const sameA = fingerprintResult({ exitCode: 1, stdout: 'same', stderr: 'still same' })
    const sameB = fingerprintResult({ exitCode: 1, stdout: 'same', stderr: 'still same' })
    const different = fingerprintResult({ exitCode: 1, stdout: 'changed', stderr: 'still same' })

    expect(sameA.resultFingerprint).toBe(sameB.resultFingerprint)
    expect(sameA.resultFingerprint).not.toBe(different.resultFingerprint)
  })

  it('flags on the third identical shape plus identical result', () => {
    const inputs = [
      {
        cwd: '/repo/worktrees/repeat-a/toolkit',
        command: 'pnpm test > /tmp/test-1722981111222.42424.log 2>&1',
        exitCode: 1,
        stdout: 'FAIL fixed assertion count: 1',
      },
      {
        cwd: '/repo/worktrees/repeat-b/toolkit',
        command: 'pnpm test > /tmp/test-1722981111888.43434.log 2>&1',
        exitCode: 1,
        stdout: 'FAIL fixed assertion count: 1',
      },
      {
        cwd: '/repo/worktrees/repeat-c/toolkit',
        command: 'pnpm test > /tmp/test-1722981111999.44444.log 2>&1',
        exitCode: 1,
        stdout: 'FAIL fixed assertion count: 1',
      },
    ]

    let state = {}
    const seen = inputs.map((input, index) => {
      const report = observeCommandRepeat({ state, nowMs: index + 1, ...input })
      state = report.state
      return report
    })

    expect(seen[0].flagged).toBe(false)
    expect(seen[1].flagged).toBe(false)
    expect(seen[2].flagged).toBe(true)
    expect(seen[2].newlyFlagged).toBe(true)
  })

  it('stays silent when the command shape repeats but the result changes each time', () => {
    let state = {}
    const outputs = ['fail before fix', 'fail after partial fix', 'pass after full fix']
    const statuses = [1, 1, 0]
    const seen = outputs.map((stdout, index) => {
      const report = observeCommandRepeat({
        state,
        cwd: '/repo/worktrees/repeat-a/toolkit',
        command: 'pnpm test',
        exitCode: statuses[index],
        stdout,
        nowMs: index + 1,
      })
      state = report.state
      return report
    })

    expect(seen.every((entry) => entry.flagged === false)).toBe(true)
    expect(Object.keys((state as { seen: Record<string, unknown> }).seen)).toHaveLength(3)
  })

  it('flags the class axis on the third differently-patterned hollow grep -c call while the shape axis stays silent', () => {
    const inputs = [
      "grep -c 'not' output.log",
      "grep -c 'never' other.log",
      "grep -c 'foo' third.log",
    ]

    let state = {}
    const seen = inputs.map((command, index) => {
      const report = observeCommandRepeat({
        state,
        cwd: '/repo/worktrees/repeat-a/toolkit',
        command,
        exitCode: 0,
        stdout: '0',
        nowMs: index + 1,
      })
      state = report.state
      return report
    })

    expect(seen[0].shapeFlagged).toBe(false)
    expect(seen[1].shapeFlagged).toBe(false)
    expect(seen[2].shapeFlagged).toBe(false)
    expect(seen[0].classFlagged).toBe(false)
    expect(seen[1].classFlagged).toBe(false)
    expect(seen[2].classFlagged).toBe(true)
    expect(seen[2].classNewlyFlagged).toBe(true)
    expect(seen[2].flaggedAxis).toBe('class')
  })

  it('keeps the class axis silent for repeated grep -c work when each run is non-hollow real output', () => {
    const inputs = [
      { command: "grep -c 'not' output.log", stdout: '4' },
      { command: "grep -c 'never' other.log", stdout: '7' },
      { command: "grep -c 'foo' third.log", stdout: '12' },
    ]

    let state = {}
    const seen = inputs.map((input, index) => {
      const report = observeCommandRepeat({
        state,
        cwd: '/repo/worktrees/repeat-a/toolkit',
        command: input.command,
        exitCode: 0,
        stdout: input.stdout,
        nowMs: index + 1,
      })
      state = report.state
      return report
    })

    expect(seen.every((entry) => entry.classFlagged === false)).toBe(true)
    expect(seen.every((entry) => entry.flaggedAxis === null)).toBe(true)
  })

  it('deliberately does not unify hollow checks across verbs, so four different command families repeated three times each stay class-silent even though the literal-repeat axis may still fire', () => {
    const commands = [
      'find .claude/watchers -maxdepth 2 -newermt 2026-08-04T20:00:00',
      'pgrep -cf "opencode run"',
      "grep -c 'not' output.log",
      'claude -p "did the tool call happen" | grep -c toolu_',
    ]

    let state = {}
    const seen = commands.flatMap((command, commandIndex) => Array.from({ length: 3 }, (_, repeatIndex) => {
      const report = observeCommandRepeat({
        state,
        cwd: '/repo/worktrees/repeat-a/toolkit',
        command,
        exitCode: 0,
        stdout: '0',
        nowMs: commandIndex * 3 + repeatIndex + 1,
      })
      state = report.state
      return report
    }))

    expect(seen.every((entry) => entry.classFlagged === false)).toBe(true)
    expect(seen.every((entry) => entry.classNewlyFlagged === false)).toBe(true)
    expect(seen.every((entry) => entry.flaggedAxis !== 'class' && entry.flaggedAxis !== 'both')).toBe(true)
  })

  it('caps the remembered shapeHashes for one class bucket instead of growing it without bound', () => {
    let state = {}
    const cap = 5
    let last
    for (let i = 0; i < 20; i += 1) {
      const report = observeCommandRepeat({
        state,
        cwd: '/repo/worktrees/repeat-a/toolkit',
        command: `grep -c needle file${i}`,
        exitCode: 0,
        stdout: '0',
        nowMs: i + 1,
        maxClassShapes: cap,
      })
      state = report.state
      last = report
    }

    expect(last).toBeDefined()
    const stored = (state as { seenClasses: Record<string, { shapeHashes: string[] }> }).seenClasses[last!.classPairKey]
    expect(stored).toBeDefined()
    expect(stored!.shapeHashes).toHaveLength(cap)
    // classCount still reflects "at least `cap` distinct shapes" — well above
    // the default threshold, so flagging is unaffected by the cap.
    expect(last!.classCount).toBe(cap)
    expect(last!.classFlagged).toBe(true)
  })
})

describe('wt-command-repeat-check.mjs', () => {
  it('persists cross-turn state and exits 1 on the third identical shape/result pair', () => {
    const stateDir = mkRoot('cli-third')
    const first = runCli(
      cliArgs({
        session: 'session-1',
        cwd: '/repo/worktrees/repeat-a/toolkit',
        command: 'pnpm lint > /tmp/lint-1722981111222.42424.log 2>&1',
        exitCode: 1,
        stdout: 'same lint failure',
        stateDir,
      }),
    )
    const second = runCli(
      cliArgs({
        session: 'session-1',
        cwd: '/repo/worktrees/repeat-b/toolkit',
        command: 'pnpm lint > /tmp/lint-1722981111999.51515.log 2>&1',
        exitCode: 1,
        stdout: 'same lint failure',
        stateDir,
      }),
    )
    const third = runCli(
      cliArgs({
        session: 'session-1',
        cwd: '/repo/worktrees/repeat-c/toolkit',
        command: 'pnpm lint > /tmp/lint-1722981112777.61616.log 2>&1',
        exitCode: 1,
        stdout: 'same lint failure',
        stateDir,
      }),
    )

    expect(first.status).toBe(0)
    expect(second.status).toBe(0)
    expect(third.status).toBe(1)
    expect(JSON.parse(third.stdout).newlyFlagged).toBe(true)
  })

  it('stays silent across repeated shapes when each result fingerprint differs', () => {
    const stateDir = mkRoot('cli-green')
    const reports = [
      runCli([
        '--session',
        'session-2',
        '--cwd',
        '/repo/toolkit',
        '--command',
        'pnpm typecheck',
        '--exit-code',
        '1',
        '--stdout',
        'type error A',
        '--state-dir',
        stateDir,
        '--json',
      ]),
      runCli([
        '--session',
        'session-2',
        '--cwd',
        '/repo/toolkit',
        '--command',
        'pnpm typecheck',
        '--exit-code',
        '1',
        '--stdout',
        'type error B',
        '--state-dir',
        stateDir,
        '--json',
      ]),
      runCli([
        '--session',
        'session-2',
        '--cwd',
        '/repo/toolkit',
        '--command',
        'pnpm typecheck',
        '--exit-code',
        '0',
        '--stdout',
        'all clear',
        '--state-dir',
        stateDir,
        '--json',
      ]),
    ]

    for (const res of reports) expect(res.status).toBe(0)
    const parsed = reports.map((res) => JSON.parse(res.stdout))
    expect(parsed.every((report) => report.flagged === false)).toBe(true)
  })

  it('fails open when the state file cannot be written', () => {
    const stateDir = mkRoot('cli-fail-open')
    const locked = join(stateDir, 'locked')
    writeFileSync(locked, 'not a directory\n')
    const res = runCli([
      '--session',
      'session-3',
      '--cwd',
      '/repo/toolkit',
      '--command',
      'pnpm test',
      '--exit-code',
      '1',
      '--stdout',
      'same failure',
      '--state-dir',
      locked,
      '--json',
    ])

    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout).degraded).toBe('state-unwritable-fail-open')
  })

  it('reads stdout/stderr from files when asked', () => {
    const stateDir = mkRoot('cli-files')
    const stdoutPath = join(stateDir, 'stdout.txt')
    const stderrPath = join(stateDir, 'stderr.txt')
    writeFileSync(stdoutPath, 'line from file\n')
    writeFileSync(stderrPath, 'stderr from file\n')
    const res = runCli([
      '--session',
      'session-4',
      '--cwd',
      '/repo/toolkit',
      '--command',
      'pnpm test',
      '--exit-code',
      '1',
      '--stdout-file',
      stdoutPath,
      '--stderr-file',
      stderrPath,
      '--state-dir',
      stateDir,
      '--json',
    ])

    expect(res.status).toBe(0)
    const report = JSON.parse(res.stdout)
    const state = JSON.parse(readFileSync(report.statePath, 'utf8'))
    const onlyEntry = Object.values(state.seen as Record<string, { resultFingerprint: string }>)[0]
    expect(onlyEntry).toBeDefined()
  })

  it('exits 1 on the third hollow grep -c class match even when each literal command differs', () => {
    const stateDir = mkRoot('cli-class-third')
    const first = runCli(
      cliArgs({
        session: 'session-class-1',
        cwd: '/repo/worktrees/repeat-a/toolkit',
        command: "grep -c 'not' output.log",
        exitCode: 0,
        stdout: '0',
        stateDir,
      }),
    )
    const second = runCli(
      cliArgs({
        session: 'session-class-1',
        cwd: '/repo/worktrees/repeat-a/toolkit',
        command: "grep -c 'never' other.log",
        exitCode: 0,
        stdout: '0',
        stateDir,
      }),
    )
    const third = runCli(
      cliArgs({
        session: 'session-class-1',
        cwd: '/repo/worktrees/repeat-a/toolkit',
        command: "grep -c 'foo' third.log",
        exitCode: 0,
        stdout: '0',
        stateDir,
      }),
    )

    expect(first.status).toBe(0)
    expect(second.status).toBe(0)
    expect(third.status).toBe(1)
    const report = JSON.parse(third.stdout)
    expect(report.shapeFlagged).toBe(false)
    expect(report.classFlagged).toBe(true)
    expect(report.flaggedAxis).toBe('class')
  })
})
