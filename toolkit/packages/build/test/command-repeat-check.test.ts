import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { fingerprintResult, normalizeCommandShape, observeCommandRepeat } from '../../../../plugin/bin/lib/command-repeat-core.mjs'

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
})
