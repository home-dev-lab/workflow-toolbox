// suite-lock-bypass-guard-hook.test.ts — the warn-only guard that tells an Agent-tool sub-agent
// it is bypassing the machine suite lock. Every case spawns the real hook with a real-shaped
// PreToolUse payload and a pinned child environment, then reads BOTH what the hook printed and
// what it journaled.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-suite-lock-bypass-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const GUARD = 'wt-suite-lock-bypass-guard-hook.mjs'
const BYPASS_TEXT = 'Never bypass the machine suite lock'
const ISOLATED_TEXT = 'An isolated lock dir is legitimate only for a bounded mutation or red-proof run'

let scratch: string
let journalDir: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wt-suite-lock-bypass-guard-'))
  journalDir = join(scratch, 'journal')
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

interface RunOptions {
  agentId?: string | null
  agentType?: string
  transcriptPath?: string
  env?: Record<string, string>
  rawInput?: string
}

function run(command: string, opts: RunOptions = {}) {
  const payload: Record<string, unknown> = {
    session_id: 'test-session',
    transcript_path: opts.transcriptPath ?? join(scratch, 'session', 'main.jsonl'),
    cwd: join(scratch, 'project'),
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'toolu_test',
  }
  const agentId = opts.agentId === undefined ? 'agent-impl-1' : opts.agentId
  if (agentId !== null) {
    payload.agent_id = agentId
    payload.agent_type = opts.agentType ?? 'general-purpose'
  }
  // A clean, pinned environment: the machine running the suite must not decide a verdict.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: join(scratch, 'home'),
    WT_GUARD_JOURNAL_DIR: journalDir,
    // The lock's platform semantics are pinned, so a verdict never depends on the CI host's OS.
    WT_SUITE_LOCK_BYPASS_GUARD_PLATFORM: 'linux',
    ...opts.env,
  }
  const res = spawnSync(process.execPath, [HOOK], {
    input: opts.rawInput ?? JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
  const out = res.stdout.trim() === '' ? null : JSON.parse(res.stdout)
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    out,
    context: String(out?.hookSpecificOutput?.additionalContext ?? ''),
  }
}

function journal(): Array<Record<string, unknown>> {
  if (!existsSync(journalDir)) return []
  return readdirSync(journalDir)
    .filter((name) => name.endsWith('.ndjson'))
    .flatMap((name) => readFileSync(join(journalDir, name), 'utf8').split('\n').filter((line) => line.trim()))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function expectWarned(command: string, cls: string, opts: RunOptions = {}) {
  const r = run(command, opts)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stderr).not.toContain('FAILED OPEN')
  expect(r.out?.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
  expect(r.out?.hookSpecificOutput).not.toHaveProperty('permissionDecision')
  expect(r.stdout).not.toMatch(/"(?:deny|allow)"/)
  const entries = journal()
  expect(entries.map((entry) => entry.class)).toContain(cls)
  for (const entry of entries) {
    expect(entry).toMatchObject({ guard: GUARD, decision: 'warned' })
    expect((entry.evidence as Record<string, unknown>)?.agentType).toBe(opts.agentType ?? 'general-purpose')
  }
  return r
}

function expectSilent(command: string, opts: RunOptions = {}) {
  const r = run(command, opts)
  expect(r.status, r.stderr).toBe(0)
  // A hook that crashed and failed open is silent too; only a hook that ran can prove silence.
  expect(r.stderr).not.toContain('FAILED OPEN')
  expect(r.stdout).toBe('')
  expect(journal()).toEqual([])
  return r
}

describe('wt-suite-lock-bypass-guard-hook — lock-disabled (WT_SUITE_LOCK=0)', () => {
  it.each([
    ['inline', 'WT_SUITE_LOCK=0 pnpm test'],
    ['after cd', 'cd toolkit && WT_SUITE_LOCK=0 pnpm vitest run packages/build/test/a.test.ts'],
    ['export', 'export WT_SUITE_LOCK=0; pnpm test'],
    ['bare assignment', 'WT_SUITE_LOCK=0; pnpm test'],
    ['env', 'env WT_SUITE_LOCK=0 pnpm test'],
    ['env with flags', 'env -u CI -i PATH="$PATH" WT_SUITE_LOCK=0 pnpm test'],
    ['cross-env', 'cross-env WT_SUITE_LOCK=0 vitest run'],
    ['after a wrapper', 'timeout 600 env WT_SUITE_LOCK=0 pnpm test'],
    ['single-quoted value', "WT_SUITE_LOCK='0' pnpm test"],
    ['double-quoted value', 'WT_SUITE_LOCK="0" pnpm test'],
    ['bash -c', "bash -c 'WT_SUITE_LOCK=0 pnpm test'"],
    ['sh -lc', 'sh -lc "cd toolkit && WT_SUITE_LOCK=0 pnpm test"'],
    ['zsh -c with export', "zsh -c 'export WT_SUITE_LOCK=0; pnpm test'"],
    ['command substitution', 'OUT=$(WT_SUITE_LOCK=0 pnpm test 2>&1)'],
    ['cmd /c set with no space before &&', 'cmd /c "set WT_SUITE_LOCK=0&& pnpm test"'],
    ['cmd /c set "NAME=value"', 'cmd /c set "WT_SUITE_LOCK=0"'],
    ['cmd /c case-insensitive', 'cmd.exe /C "SET wt_suite_lock=0&& pnpm test"'],
    ['powershell -Command', `powershell -Command "$env:WT_SUITE_LOCK='0'; pnpm test"`],
    ['pwsh -c case-insensitive, unquoted value', "pwsh -c '$env:wt_suite_lock = 0; pnpm test'"],
    ['sudo', 'sudo -u ci WT_SUITE_LOCK=0 pnpm test'],
    ['declare -x', 'declare -x WT_SUITE_LOCK=0; pnpm test'],
    ['npx cross-env', 'npx cross-env WT_SUITE_LOCK=0 vitest run'],
    ['backtick substitution', 'OUT=`WT_SUITE_LOCK=0 pnpm test`'],
    ['cmd /k', 'cmd /k "set WT_SUITE_LOCK=0&& pnpm test"'],
    ['Git Bash cmd //c', 'cmd //c "set WT_SUITE_LOCK=0&& pnpm test"'],
    ['cmd set /a arithmetic assignment', 'cmd /c "set /a WT_SUITE_LOCK=0&& pnpm test"'],
  ])('warns for the %s form', (_form, command) => {
    const r = expectWarned(command, 'lock-disabled')
    expect(r.context).toContain(BYPASS_TEXT)
    expect(r.context).toContain('wt-suite-lock status')
    expect(r.context).toContain('exit 75')
    expect(r.context).toContain('arbiter')
  })

  it.each([
    ['top-level set is the bash builtin', 'set WT_SUITE_LOCK=0 && pnpm test'],
    ['cmd stores "0 " before a spaced &&', 'cmd /c "set WT_SUITE_LOCK=0 && pnpm test"'],
    ['value 1', 'WT_SUITE_LOCK=1 pnpm test'],
    ['empty value', 'WT_SUITE_LOCK= pnpm test'],
    ['POSIX name is case-sensitive', 'wt_suite_lock=0 pnpm test'],
    ['wait seconds', 'WT_SUITE_LOCK_WAIT_S=0 pnpm test'],
    ['custom lock command', 'WT_SUITE_LOCK_CMD=/usr/bin/true pnpm test'],
    ['broker alone', 'WT_SUITE_LOCK_BROKER=/run/broker.sock pnpm test'],
    ['grep pattern', 'grep -rn "WT_SUITE_LOCK=0" .'],
    ['echo text', 'echo WT_SUITE_LOCK=0'],
    ['commit message', 'git commit -m "docs: never run with WT_SUITE_LOCK=0 again"'],
    ['heredoc body', "cat > /tmp/notes.md <<'EOF'\nWT_SUITE_LOCK=0 pnpm test\nEOF"],
    ['comment', 'pnpm test # not WT_SUITE_LOCK=0'],
    ['cmd set /p reads its value from input', 'cmd /c "set /p WT_SUITE_LOCK=Value?&& pnpm test"'],
    ['unrelated command', 'git status'],
  ])('stays silent: %s', (_why, command) => {
    expectSilent(command)
  })
})

describe('wt-suite-lock-bypass-guard-hook — lock directory', () => {
  it.each([
    ['home path', 'WT_SUITE_LOCK_DIR=/home/someone/lock pnpm test'],
    ['normalised out of the temp root', 'WT_SUITE_LOCK_DIR=/tmp/../home/x pnpm test'],
    ['home tilde', 'export WT_SUITE_LOCK_DIR=~/lock; pnpm test'],
    ['HOME expansion', 'WT_SUITE_LOCK_DIR="$HOME/lock" pnpm test'],
    ['braced HOME expansion', 'WT_SUITE_LOCK_DIR=${HOME}/lock pnpm test'],
    ['Windows drive path', `pwsh -c '$env:WT_SUITE_LOCK_DIR = "C:\\Users\\u\\lock"; pnpm test'`],
  ])('warns lock-dir-elsewhere for a %s', (_why, command) => {
    const r = expectWarned(command, 'lock-dir-elsewhere')
    expect(r.context).toContain(BYPASS_TEXT)
  })

  it.each([
    ['literal temp path', 'WT_SUITE_LOCK_DIR=/tmp/x pnpm vitest run a.test.ts'],
    ['mktemp substitution', 'WT_SUITE_LOCK_DIR=$(mktemp -d) pnpm vitest run a.test.ts'],
    ['TMPDIR expansion', 'WT_SUITE_LOCK_DIR="$TMPDIR/lock" pnpm vitest run a.test.ts'],
    ['braced TMPDIR expansion', 'WT_SUITE_LOCK_DIR=${TMPDIR:-/tmp}/lock pnpm test'],
    ['cmd %TEMP%', 'cmd /c "set WT_SUITE_LOCK_DIR=%TEMP%\\lock&& pnpm test"'],
    ['powershell $env:TEMP', 'pwsh -c "$env:WT_SUITE_LOCK_DIR = $env:TEMP + \'/lock\'; pnpm test"'],
  ])('warns lock-dir-temp with the isolated-dir text for a %s', (_why, command) => {
    const r = expectWarned(command, 'lock-dir-temp')
    expect(r.context).toContain(ISOLATED_TEXT)
    expect(r.context).toContain('timeout N')
    expect(r.context).not.toContain(BYPASS_TEXT)
  })

  it('warns lock-dir-unresolved with the isolated-dir text for any other expansion', () => {
    const r = expectWarned('WT_SUITE_LOCK_DIR=$D pnpm test', 'lock-dir-unresolved')
    expect(r.context).toContain(ISOLATED_TEXT)
    expect(r.context).not.toContain(BYPASS_TEXT)
  })

  it('stays silent for an empty lock dir', () => {
    expectSilent('WT_SUITE_LOCK_DIR= pnpm test')
  })
})

describe('wt-suite-lock-bypass-guard-hook — forged lease', () => {
  it.each([
    ['inline file-domain marker', "WT_SUITE_LEASE='/home/u/.local/state/wt-suite-lock|abc' pnpm test"],
    ['exported broker marker', "export WT_SUITE_LEASE='broker:/run/b.sock|abc'; pnpm vitest run"],
    ['cmd form', 'cmd /c "set WT_SUITE_LEASE=x|y&& pnpm test"'],
  ])('warns lease-forged for an %s', (_why, command) => {
    expectWarned(command, 'lease-forged')
  })

  it('stays silent for an empty lease', () => {
    expectSilent('WT_SUITE_LEASE= pnpm test')
  })
})

describe('wt-suite-lock-bypass-guard-hook — forced release and stale reclaim', () => {
  it.each([
    ['bare CLI', 'wt-suite-lock release --force'],
    ['node script path', 'node plugin/bin/wt-suite-lock.mjs release --force'],
    ['after cd', 'cd toolkit && node ../plugin/bin/wt-suite-lock.mjs release --force'],
  ])('warns lock-released-forced for the %s', (_why, command) => {
    const r = expectWarned(command, 'lock-released-forced')
    expect(r.context).toContain(BYPASS_TEXT)
  })

  it.each([
    ['plain release', 'wt-suite-lock release'],
    ['status', 'node plugin/bin/wt-suite-lock.mjs status'],
    ['echoed text', 'echo wt-suite-lock release --force'],
    ['run with a stale bound on POSIX', 'wt-suite-lock run --stale-s 0 -- pnpm test'],
  ])('stays silent for %s', (_why, command) => {
    expectSilent(command)
  })

  it.each([
    ['run', 'node ../plugin/bin/wt-suite-lock.mjs run --stale-s 0 -- pnpm test'],
    ['release', 'wt-suite-lock release --stale-s=0'],
  ])('warns lock-stale-reclaim for %s --stale-s 0 only on win32', (_why, command) => {
    expectWarned(command, 'lock-stale-reclaim', { env: { WT_SUITE_LOCK_BYPASS_GUARD_PLATFORM: 'win32' } })
  })

  it('stays silent for a non-zero stale bound on win32', () => {
    expectSilent('wt-suite-lock run --stale-s 600 -- pnpm test', { env: { WT_SUITE_LOCK_BYPASS_GUARD_PLATFORM: 'win32' } })
  })
})

describe('wt-suite-lock-bypass-guard-hook — state root moved under a locked gate', () => {
  const LINUX = { WT_SUITE_LOCK_BYPASS_GUARD_PLATFORM: 'linux' }
  const DARWIN = { WT_SUITE_LOCK_BYPASS_GUARD_PLATFORM: 'darwin' }
  const WIN32 = { WT_SUITE_LOCK_BYPASS_GUARD_PLATFORM: 'win32' }

  it.each([
    ['HOME inline on pnpm test (linux)', 'HOME=/tmp/h pnpm test', LINUX],
    ['HOME inline on pnpm test (darwin)', 'HOME=/tmp/h pnpm test', DARWIN],
    ['XDG_STATE_HOME on vitest run', 'XDG_STATE_HOME=/tmp/s pnpm vitest run a.test.ts', LINUX],
    ['XDG_STATE_HOME on win32', 'XDG_STATE_HOME=/tmp/s pnpm test', WIN32],
    ['exported LOCALAPPDATA before pnpm -r test on win32', 'export LOCALAPPDATA=/tmp/l; pnpm -r test', WIN32],
    ['USERPROFILE on a bare vitest run on win32', 'USERPROFILE=/tmp/u vitest run', WIN32],
    ['HOME on pnpm typecheck', 'HOME=/tmp/h pnpm typecheck', LINUX],
    ['HOME on pnpm lint', 'env HOME=/tmp/h pnpm lint', LINUX],
    ['XDG_STATE_HOME on pnpm quality', 'XDG_STATE_HOME=/tmp/s pnpm quality:host', LINUX],
    ['HOME on a non-watch vitest without run', 'HOME=/tmp/h pnpm vitest a.test.ts', LINUX],
    ['HOME on the wt-suite-lock-run runner', 'HOME=/tmp/h node plugin/bin/wt-suite-lock-run.mjs pnpm test', LINUX],
    ['HOME through command -p', 'HOME=/tmp/h command -p pnpm test', LINUX],
    ['cmd set before a gate', 'cmd /c "set XDG_STATE_HOME=C:/t&& pnpm test"', LINUX],
    ['PowerShell $env: before a gate', `pwsh -c "$env:XDG_STATE_HOME = 'C:/t'; pnpm test"`, LINUX],
  ])('warns state-root-moved for %s', (_why, command, env) => {
    const r = expectWarned(command, 'state-root-moved', { env })
    expect(r.context).toContain(BYPASS_TEXT)
  })

  it.each([
    ['HOME on git', 'HOME=/tmp/h git status', LINUX],
    ['HOME on a script', 'HOME=/tmp/h node scripts/x.mjs', LINUX],
    ['inline HOME on another command before a gate', 'HOME=/tmp/h git status && pnpm test', LINUX],
    ['plain gate', 'pnpm test', LINUX],
    ['HOME exported after the gate', 'pnpm test; export HOME=/tmp/h', LINUX],
    ['vitest in watch mode', 'HOME=/tmp/h pnpm vitest watch', LINUX],
    ['USERPROFILE on linux, where it does not move the lock', 'USERPROFILE=/tmp/u vitest run', LINUX],
    ['LOCALAPPDATA on darwin', 'export LOCALAPPDATA=/tmp/l; pnpm -r test', DARWIN],
    ['HOME on win32, where the home directory comes from USERPROFILE', 'HOME=/tmp/h pnpm test', WIN32],
  ])('stays silent for %s', (_why, command, env) => {
    expectSilent(command, { env })
  })
})

describe('wt-suite-lock-bypass-guard-hook — who is covered', () => {
  it('main session (no agent_id): no output and no journal', () => {
    expectSilent('WT_SUITE_LOCK=0 pnpm test', { agentId: null })
  })

  it('Workflow subagent by its harness label: no output, journal silent', () => {
    const r = run('WT_SUITE_LOCK=0 pnpm test', { agentType: 'workflow-subagent@abc' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(journal()).toEqual([expect.objectContaining({ guard: GUARD, decision: 'silent', class: 'lock-disabled' })])
  })

  it('Workflow subagent by its transcript path inside a run directory: no output, journal silent', () => {
    const transcriptPath = join(scratch, 'session', 'main', 'subagents', 'workflows', 'run-1', 'agent-wf-1.jsonl')
    const r = run('WT_SUITE_LOCK=0 pnpm test', { agentId: 'wf-1', agentType: 'workflow-toolbox:dev-fixer', transcriptPath })
    expect(r.stdout).toBe('')
    expect(journal()).toEqual([expect.objectContaining({ decision: 'silent', class: 'lock-disabled' })])
  })

  it('Workflow agent with a registered type whose own transcript sits in one of several run directories: silent', () => {
    const sessionDir = join(scratch, 'session', 'main')
    mkdirSync(join(sessionDir, 'subagents', 'workflows', 'run-a'), { recursive: true })
    mkdirSync(join(sessionDir, 'subagents', 'workflows', 'run-b'), { recursive: true })
    writeFileSync(join(sessionDir, 'subagents', 'workflows', 'run-b', 'agent-fixer-7.jsonl'), '')
    const r = run('WT_SUITE_LOCK=0 pnpm test', {
      agentId: 'fixer-7',
      agentType: 'workflow-toolbox:dev-fixer',
      transcriptPath: join(scratch, 'session', 'main.jsonl'),
    })
    expect(r.stdout).toBe('')
    expect(journal()).toEqual([expect.objectContaining({ decision: 'silent', class: 'lock-disabled' })])
  })

  it('Agent-tool sub-agent in a session with exactly one Workflow run still warns (no single-run shortcut)', () => {
    const sessionDir = join(scratch, 'session', 'main')
    mkdirSync(join(sessionDir, 'subagents', 'workflows', 'run-only'), { recursive: true })
    writeFileSync(join(sessionDir, 'subagents', 'workflows', 'run-only', 'agent-someone-else.jsonl'), '')
    expectWarned('WT_SUITE_LOCK=0 pnpm test', 'lock-disabled', {
      agentId: 'impl-9',
      agentType: 's-implementer',
      transcriptPath: join(scratch, 'session', 'main.jsonl'),
    })
  })

  it('observe mode: no output, journal silent', () => {
    const r = run('WT_SUITE_LOCK=0 pnpm test', { env: { WT_GUARD_MODE: 'observe' } })
    expect(r.stdout).toBe('')
    expect(journal()).toEqual([expect.objectContaining({ decision: 'silent', class: 'lock-disabled' })])
  })

  it('a hook that failed open is never read as a correct silence', () => {
    expect(() => expectSilent('git status', { env: { WT_FAIL_OPEN_TRACE_SELF_TEST: GUARD } })).toThrow()
  })

  it('malformed stdin: exit 0, no output', () => {
    const r = run('', { rawInput: '{not json' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('ignores a non-Bash tool and a non-PreToolUse event', () => {
    const notBash = run('', {
      rawInput: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'a', tool_input: { command: 'WT_SUITE_LOCK=0 pnpm test' } }),
    })
    expect(notBash.stdout).toBe('')
    const notPre = run('', {
      rawInput: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'a', tool_input: { command: 'WT_SUITE_LOCK=0 pnpm test' } }),
    })
    expect(notPre.stdout).toBe('')
    expect(journal()).toEqual([])
  })

  it('journals one record per distinct class and names every class in one message', () => {
    const r = run("WT_SUITE_LOCK=0 WT_SUITE_LEASE='x|y' pnpm test")
    expect(r.context).toContain(BYPASS_TEXT)
    expect(journal().map((entry) => entry.class).sort()).toEqual(['lease-forged', 'lock-disabled'])
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const commands = (manifest.hooks?.PreToolUse ?? [])
      .filter((entry: { matcher?: string }) => entry.matcher === 'Bash')
      .flatMap((entry: { hooks?: { command?: string }[] }) => entry.hooks ?? [])
      .map((hook: { command?: string }) => hook.command ?? '')
    expect(commands.some((command: string) => command.includes(GUARD))).toBe(true)
  })
})
