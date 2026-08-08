import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

type HookRun = {
  stdout: string
  stderr: string
  status: number | null
  error: Error | undefined
}

type Sandbox = {
  root: string
  env: NodeJS.ProcessEnv
  projectDir: string
  transcriptPath: string
}

// Discover the shipped set by reading the directory, NOT by shelling out to a glob.
// `/bin/sh` does not exist on Windows, and this repo runs a cross-OS CI matrix — a
// shell-glob discovery would throw ENOENT there. A directory read also avoids the
// shell's own quirk of returning the literal pattern when nothing matches, which
// would otherwise satisfy the non-empty guard with a filename that does not exist.
function discoverHookPaths(): string[] {
  const binDir = join(REPO_ROOT, 'plugin', 'bin')
  return readdirSync(binDir)
    .filter((name) => name.endsWith('-hook.mjs'))
    .sort()
    .map((name) => join(binDir, name))
}

function makeSandbox(tag: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `wt-hook-selftest-${tag}-`))
  const homeDir = join(root, 'home')
  const stateDir = join(root, 'xdg-state')
  const configDir = join(root, 'claude-config')
  const projectDir = join(root, 'project')
  const transcriptPath = join(root, 'transcript.jsonl')

  for (const dir of [homeDir, stateDir, configDir, projectDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(transcriptPath, '')

  return {
    root,
    projectDir,
    transcriptPath,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_STATE_HOME: stateDir,
      CLAUDE_CONFIG_DIR: configDir,
      WT_OUTBOUND_GUARD_DIR: join(stateDir, 'outbound-guard'),
      WT_HOOK_DRIFT_DIR: join(stateDir, 'hook-drift'),
      WT_QUEUE_GATE_DIR: join(stateDir, 'queue-gate'),
      WT_VERIFIER_MARKER_DIR: join(stateDir, 'verifier-markers'),
      WT_ACTIONABLE_GATE_DIR: join(stateDir, 'actionable-gate'),
      DWT_WORKFLOW_LOG_DIR: join(stateDir, 'workflow-logs'),
    },
  }
}

function cleanupSandbox(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true })
}

function hasUncaughtExceptionStack(stderr: string): boolean {
  return /(^|\n)[A-Za-z0-9_.:$-]*Error: .*\n(?:\s+at .+\n?)+/m.test(stderr)
}

function payloadFor(hookPath: string, sandbox: Sandbox): unknown {
  const file = basename(hookPath)

  switch (file) {
    case 'wt-actionable-gate-hook.mjs':
      return {
        hook_event_name: 'Stop',
        session_id: 'selftest-session',
        cwd: sandbox.projectDir,
        transcript_path: sandbox.transcriptPath,
      }
    case 'wt-adopt-check-hook.mjs':
    // The deprecated name is a shim that side-effect-imports the line above, so it takes the
    // identical payload. Listed explicitly rather than pattern-matched: this switch failing
    // closed on an unknown file is what forces every new plugin/bin entry to be considered
    // here, and a wildcard would quietly re-open that.
    case 'wt-adopt-rules-check-hook.mjs':
      return {
        hook_event_name: 'SessionStart',
        cwd: sandbox.projectDir,
      }
    case 'wt-env-prerequisite-drift-hook.mjs':
      return {
        hook_event_name: 'SessionStart',
        cwd: sandbox.projectDir,
      }
    // No WT_GUARD_JOURNAL_DIR in this sandbox and the real journal path (under sandbox.env's
    // HOME) does not exist — the exact "no guard has ever fired" case this hook must meet with
    // silence, never a crash.
    case 'wt-guard-recurrence-hook.mjs':
      return {
        hook_event_name: 'SessionStart',
        cwd: sandbox.projectDir,
      }
    case 'wt-lane-saturation-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: sandbox.projectDir,
        tool_input: { command: 'ls -la' },
      }
    case 'wt-check-commit-signatures-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: sandbox.projectDir,
        tool_input: { command: 'git status' },
      }
    case 'wt-live-config-tree-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: sandbox.projectDir,
        tool_input: { command: 'git status' },
      }
    case 'wt-hook-registration-drift-hook.mjs':
      return {
        hook_event_name: 'SessionStart',
        session_id: 'selftest-session',
        cwd: sandbox.projectDir,
      }
    case 'wt-delegation-ladder-hook.mjs':
      return {
        hook_event_name: 'SessionStart',
        cwd: sandbox.projectDir,
      }
    case 'wt-memory-index-check-hook.mjs':
      return {
        hook_event_name: 'SessionStart',
        cwd: sandbox.projectDir,
      }
    // The sandbox project has no report directories, which is the case this hook meets in most
    // sessions: it must walk nothing, find nothing, and exit silently rather than throw on a
    // directory that is not there.
    case 'wt-lesson-harvest-hook.mjs':
      return {
        hook_event_name: 'Stop',
        cwd: sandbox.projectDir,
      }
    case 'wt-lane-consent-check-hook.mjs':
      return {
        hook_event_name: 'SessionStart',
        cwd: sandbox.projectDir,
      }
    case 'wt-observer-pairing-guard-hook.mjs':
      return {
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        cwd: sandbox.projectDir,
        session_id: 'selftest-session',
        tool_input: { name: 'helper', subagent_type: 'general' },
        tool_response: { agent_id: 'agent-helper-1' },
      }
    case 'wt-outbound-guard-hook.mjs':
      return {
        hook_event_name: 'Stop',
        session_id: 'selftest-session',
      }
    case 'wt-pilot-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        agent_id: 'agent-pilot-1',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
      }
    case 'wt-main-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        // No agent_id: this guard is main-session-scoped, the opposite of the pilot guard above.
        tool_name: 'Bash',
        cwd: sandbox.projectDir,
        tool_input: { command: 'git status' },
      }
    case 'wt-probe-claim-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'SendMessage',
        tool_input: { message: 'ordinary message' },
      }
    case 'wt-rule-convention-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        cwd: sandbox.projectDir,
        tool_input: {
          file_path: join(sandbox.projectDir, '.claude', 'rules', 'foo.md'),
          content: 'Keep the directive and the invariant.',
        },
      }
    case 'wt-queue-not-empty-gate-hook.mjs':
      return {
        hook_event_name: 'Stop',
        session_id: 'selftest-session',
        cwd: sandbox.projectDir,
        transcript_path: sandbox.transcriptPath,
      }
    case 'wt-registry-heartbeat-hook.mjs':
      return {
        hook_event_name: 'Stop',
        session_id: 'selftest-session',
        cwd: sandbox.projectDir,
        stop_hook_active: false,
      }
    case 'wt-session-start-registry-hook.mjs':
      return null
    case 'wt-spawn-capability-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        cwd: sandbox.projectDir,
        tool_input: {
          subagent_type: 'verify-strict',
          prompt: 'Inspect the code and report what you find.',
        },
      }
    case 'wt-spawn-shape-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
      }
    case 'wt-stale-date-guard-hook.mjs':
      return {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(sandbox.projectDir, 'notes.txt') },
      }
    case 'wt-rule-edit-horizon-hook.mjs':
      return {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        cwd: sandbox.projectDir,
        tool_input: { file_path: join(sandbox.projectDir, '.claude', 'rules', 'foo.md') },
      }
    case 'wt-shipped-twin-check-hook.mjs':
      mkdirSync(join(sandbox.projectDir, '.claude', 'scripts'), { recursive: true })
      return {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        session_id: 'selftest-session',
        cwd: sandbox.projectDir,
        tool_input: { file_path: join(sandbox.projectDir, '.claude', 'scripts', 'foo.mjs') },
      }
    case 'wt-stop-hook.mjs':
      return {
        hook_event_name: 'Stop',
        session_id: 'selftest-session',
        cwd: sandbox.projectDir,
        background_tasks: [],
      }
    case 'wt-verifier-cli-guard-hook.mjs':
      return {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        agent_id: 'agent-verifier-1',
        transcript_path: sandbox.transcriptPath,
        tool_input: { command: 'git status' },
      }
    case 'wt-unquoted-tool-glob-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: "grep -rn foo --include=*.ts ." },
      }
    case 'wt-var-colon-modifier-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git show "$s:src/db-base.ts"' },
      }
    case 'wt-merge-chain-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git merge branch && pnpm test' },
      }
    case 'wt-missing-package-script-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm totally-made-up-script' },
        cwd: sandbox.projectDir,
      }
    case 'wt-pipestatus-bash-only-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cmd | tee log; echo ${PIPESTATUS[0]}' },
      }
    case 'wt-find-newermt-format-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'find . -newermt "5 minutes ago"' },
      }
    case 'wt-git-commit-backtick-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "the default `stretch` applied"' },
      }
    case 'wt-isolated-spawn-report-path-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: {
          name: 'selftest-agent',
          isolation: 'worktree',
          prompt: 'Write your report to /home/selftest/report.md when done.',
        },
      }
    case 'wt-pgrep-env-dump-guard-hook.mjs':
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pgrep -af zsh' },
      }
    case 'wt-propagation-reminder-hook.mjs':
      return {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(sandbox.projectDir, 'plugin', 'bin', 'foo-hook.mjs') },
      }
    case 'wt-actionable-snapshot-producer-hook.mjs':
      // No .claude/scripts/lib/depends-on-parser.mjs in this sandbox project — the hook
      // must no-op cleanly rather than crash, which is exactly what a project without the
      // dependency-parser convention should see (see actionability-planka-producer.test.ts
      // for the full write/no-write behavior matrix).
      return {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__planka__get_board',
        cwd: sandbox.projectDir,
        tool_input: { boardId: 'b1' },
        tool_response: {
          content: [{ type: 'text', text: JSON.stringify({ id: 'board-1', lists: [{ name: 'Next', cards: [] }] }) }],
        },
      }
    default:
      throw new Error(`No synthetic payload defined for ${file}`)
  }
}

function runHook(hookPath: string, payload: unknown, sandbox: Sandbox): HookRun {
  const input = payload === null ? undefined : `${JSON.stringify(payload)}\n`
  const res = spawnSync(process.execPath, [hookPath], {
    cwd: sandbox.projectDir,
    env: sandbox.env,
    input,
    encoding: 'utf8',
    timeout: 10_000,
  })

  return {
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    status: res.status,
    error: res.error,
  }
}

function sourceUsesFailOpenTrace(hookPath: string): boolean {
  const source = readFileSync(hookPath, 'utf8')
  return source.includes('runFailOpenHook(') || source.includes('runFailOpenHookAsync(') || source.includes('FAILED OPEN')
}

describe('plugin hook crash safety', () => {
  const hookPaths = discoverHookPaths()

  it('discovers the shipped hook set by glob, and the match set is non-empty', () => {
    expect(hookPaths.length).toBeGreaterThan(0)
    for (const hookPath of hookPaths) expect(existsSync(hookPath)).toBe(true)
  })

  it('every discovered hook passes node --check', () => {
    for (const hookPath of hookPaths) {
      const res = spawnSync(process.execPath, ['--check', hookPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })

      expect(
        { status: res.status, stderr: (res.stderr ?? '').trim() },
        `${basename(hookPath)} failed node --check`,
      ).toEqual({ status: 0, stderr: '' })
    }
  })

  it('every discovered hook loads and runs without an uncaught exception stack trace on stderr', () => {
    for (const hookPath of hookPaths) {
      const sandbox = makeSandbox(basename(hookPath, '.mjs'))
      try {
        const result = runHook(hookPath, payloadFor(hookPath, sandbox), sandbox)

        expect(result.error, `${basename(hookPath)} should not hang or fail to spawn`).toBeUndefined()
        expect(result.status, `${basename(hookPath)} exited via signal`).not.toBeNull()
        expect(
          hasUncaughtExceptionStack(result.stderr),
          `${basename(hookPath)} crashed with stderr:\n${result.stderr}`,
        ).toBe(false)
      } finally {
        cleanupSandbox(sandbox)
      }
    }
  })

  it('healthy decline stays green: a hook that decides the event is irrelevant remains silent and non-crashing', () => {
    const hookPath = join(REPO_ROOT, 'plugin/bin/wt-spawn-shape-guard-hook.mjs')
    const sandbox = makeSandbox('decline-case')

    try {
      const result = runHook(hookPath, payloadFor(hookPath, sandbox), sandbox)

      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    } finally {
      cleanupSandbox(sandbox)
    }
  })

  it('healthy deny stays green: a hook may exit non-zero to block without being classified as a crash', () => {
    const hookPath = join(REPO_ROOT, 'plugin/bin/wt-outbound-guard-hook.mjs')
    const sandbox = makeSandbox('deny-case')

    try {
      const result = runHook(
        hookPath,
        {
          hook_event_name: 'SubagentStop',
          session_id: 'selftest-session',
          agent_id: 'agent-silent-1',
          agent_type: 'general',
        },
        sandbox,
      )

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('OUTBOUND CHECK')
      expect(hasUncaughtExceptionStack(result.stderr)).toBe(false)
    } finally {
      cleanupSandbox(sandbox)
    }
  })

  it('a fail-open hook whose own wiring breaks leaves one trace instead of looking healthy-quiet', () => {
    for (const hookPath of hookPaths.filter(sourceUsesFailOpenTrace)) {
      const sandbox = makeSandbox(`fail-open-${basename(hookPath, '.mjs')}`)
      sandbox.env.WT_FAIL_OPEN_TRACE_SELF_TEST = basename(hookPath)

      try {
        const result = runHook(hookPath, payloadFor(hookPath, sandbox), sandbox)

        expect(result.error, `${basename(hookPath)} should still spawn under forced fail-open self-test`).toBeUndefined()
        expect(result.status, `${basename(hookPath)} exited via signal under forced fail-open self-test`).not.toBeNull()
        expect(result.status, `${basename(hookPath)} should fail open under forced fail-open self-test`).toBe(0)
        expect(result.stderr, `${basename(hookPath)} should trace its forced fail-open path`).toContain(
          `${basename(hookPath)}: FAILED OPEN - forced fail-open self-test for ${basename(hookPath)}`,
        )
        expect(hasUncaughtExceptionStack(result.stderr)).toBe(false)
      } finally {
        cleanupSandbox(sandbox)
      }
    }
  })
})
