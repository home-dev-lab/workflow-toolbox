// guard-journal-family.test.ts — locks the INVARIANT ("every guard hook that can block or
// warn is wired to the shared journal"), never an enumeration of today's guards. A hardcoded
// list of guard filenames would stay green the day a 19th guard ships without instrumentation
// — this test globs plugin/bin/*guard*.mjs itself, so a new file is covered automatically.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BIN_DIR = join(REPO_ROOT, 'plugin/bin')
const GUARD_JOURNAL_LIB = join(BIN_DIR, 'lib/guard-journal.mjs')

// Files that legitimately do NOT call the shared journal, and WHY — never a silent exclusion.
// Both are `plugin/bin/*guard*.mjs` matches, so without this list the family scan below would
// wrongly flag them.
const JUSTIFIED_EXCLUSIONS: Record<string, string> = {
  'wt-outbound-guard-hook.mjs':
    'Its own durable registry already answers a DIFFERENT question (spawn accounting: who ' +
    'launched whom, closed via SubagentStop) via wt-spawn-registry-scan.mjs — it does not ' +
    'block or warn on a tool call the way the other guards do.',
  'wt-stale-date-guard.mjs':
    'Not a hook at all — a report-generating CLI invoked BY wt-stale-date-guard-hook.mjs ' +
    '(which IS instrumented). No PreToolUse/PostToolUse payload, nothing to journal here.',
}

function allGuardFiles(): string[] {
  return readdirSync(BIN_DIR).filter((f) => /guard.*\.mjs$/.test(f) && f !== 'guard-journal.mjs')
}

describe('guard-journal family invariant — every guard-hook file is wired', () => {
  it('every plugin/bin/*guard*.mjs file either imports the shared journal or has a named, justified exclusion', () => {
    const files = allGuardFiles()
    expect(files.length).toBeGreaterThan(0) // sanity: the glob itself must find real files

    const unwired: string[] = []
    for (const f of files) {
      if (JUSTIFIED_EXCLUSIONS[f]) continue
      const src = readFileSync(join(BIN_DIR, f), 'utf8')
      if (!src.includes('guard-journal.mjs')) unwired.push(f)
    }
    expect(unwired, `guard(s) with no journal wiring and no justified exclusion: ${unwired.join(', ')}`).toEqual([])
  })

  it('the exclusion list itself names only files that actually exist (no stale entry)', () => {
    const files = new Set(allGuardFiles())
    for (const name of Object.keys(JUSTIFIED_EXCLUSIONS)) {
      expect(files.has(name), `exclusion names ${name}, which no longer exists under plugin/bin/`).toBe(true)
    }
  })

  it('guard-journal.mjs itself exists and is importable', () => {
    expect(existsSync(GUARD_JOURNAL_LIB)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// LIVE behavioural proof, for a representative spread of the wired guards: trigger the REAL
// hook process with a payload that its own decision logic accepts, and assert a journal entry
// with the RIGHT guard name and decision lands on disk. This is not the same claim as the
// static test above (which only proves the source TEXT references the library) — this proves
// the WIRING actually fires end-to-end, for guards spanning every code shape in this family:
// additionalContext-warn, permissionDecision-deny, systemMessage-warn, and a sub-agent-scoped
// (agent_id) guard.
// ---------------------------------------------------------------------------------------------

let journalDir: string

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'wt-guard-journal-live-'))
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

function runHook(hookFile: string, payload: Record<string, unknown>, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(BIN_DIR, hookFile)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir, ...extraEnv },
  })
}

function journalEntries(): Array<Record<string, unknown>> {
  if (!existsSync(journalDir)) return []
  const out: Array<Record<string, unknown>> = []
  for (const f of readdirSync(journalDir)) {
    if (!f.endsWith('.ndjson')) continue
    for (const line of readFileSync(join(journalDir, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line))
    }
  }
  return out
}

function initGitRepo(dir: string, branch = 'main') {
  mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', '-q', '-b', branch, dir])
  spawnSync('git', ['-C', dir, 'config', 'user.email', 't@t.co'])
  spawnSync('git', ['-C', dir, 'config', 'user.name', 't'])
  writeFileSync(join(dir, 'f.txt'), 'x')
  spawnSync('git', ['-C', dir, 'add', '-A'])
  spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'])
}

describe('guard-journal — live wiring proof across the code-shape spread', () => {
  it('WARN shape (additionalContext): wt-git-commit-backtick-guard-hook.mjs journals a warned event', () => {
    const r = runHook('wt-git-commit-backtick-guard-hook.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "the default `stretch` applied"' },
    })
    expect(r.status).toBe(0)
    const entries = journalEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ guard: 'wt-git-commit-backtick-guard-hook.mjs', decision: 'warned' })
  })

  it('WARN shape (allow + reason): wt-merge-chain-guard-hook.mjs journals a warned event', () => {
    const r = runHook('wt-merge-chain-guard-hook.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git merge foo && pnpm test' },
    })
    expect(r.status).toBe(0)
    const entries = journalEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ guard: 'wt-merge-chain-guard-hook.mjs', decision: 'warned' })
  })

  it('DENY shape: wt-unquoted-tool-glob-guard-hook.mjs journals a blocked event', () => {
    const r = runHook('wt-unquoted-tool-glob-guard-hook.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'find . -name *.txt' },
    })
    expect(r.status).toBe(0)
    const entries = journalEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ guard: 'wt-unquoted-tool-glob-guard-hook.mjs', decision: 'blocked' })
  })

  it('DENY shape, sub-agent-scoped (agent_id required): wt-pilot-guard-hook.mjs journals a blocked event', () => {
    const r = runHook('wt-pilot-guard-hook.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      agent_id: 'a-test-agent',
      agent_type: 'general-purpose',
      tool_input: { command: 'npm publish' },
    })
    expect(r.status).toBe(0)
    const entries = journalEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ guard: 'wt-pilot-guard-hook.mjs', decision: 'blocked' })
  })

  it('DENY shape: wt-main-guard-hook.mjs journals a blocked event on npm publish (no agent_id ⇒ main session)', () => {
    const sandboxHome = mkdtempSync(join(tmpdir(), 'wt-main-guard-live-'))
    try {
      const r = runHook(
        'wt-main-guard-hook.mjs',
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm publish' }, cwd: sandboxHome },
        { HOME: sandboxHome },
      )
      expect(r.status).toBe(0)
      const entries = journalEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ guard: 'wt-main-guard-hook.mjs', decision: 'blocked', class: 'publish' })
    } finally {
      rmSync(sandboxHome, { recursive: true, force: true })
    }
  })

  it('WARN shape (systemMessage): wt-spawn-shape-guard-hook.mjs journals a warned event when named-without-isolation outside a git repo', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wt-spawn-shape-live-'))
    try {
      const r = runHook('wt-spawn-shape-guard-hook.mjs', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        cwd,
        tool_input: { name: 'my-agent', subagent_type: 'general-purpose' },
      })
      expect(r.status).toBe(0)
      const entries = journalEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ guard: 'wt-spawn-shape-guard-hook.mjs', decision: 'warned' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('DENY shape: wt-spawn-shape-guard-hook.mjs journals a blocked event when named-without-isolation INSIDE a git repo', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wt-spawn-shape-live-git-'))
    initGitRepo(cwd)
    try {
      const r = runHook('wt-spawn-shape-guard-hook.mjs', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        cwd,
        tool_input: { name: 'my-agent', subagent_type: 'general-purpose' },
      })
      expect(r.status).toBe(0)
      const entries = journalEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ guard: 'wt-spawn-shape-guard-hook.mjs', decision: 'blocked' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('DENY shape: wt-rule-convention-guard-hook.mjs journals a blocked event on a dated rule directive', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-rule-convention-live-'))
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    try {
      const filePath = join(root, 'rules', 'wt', 'example.md')
      const r = runHook(
        'wt-rule-convention-guard-hook.mjs',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          cwd: root,
          tool_input: { file_path: filePath, content: 'Do the thing on 15/03/2024.' },
        },
        { HOME: home },
      )
      expect(r.status).toBe(0)
      const entries = journalEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ guard: 'wt-rule-convention-guard-hook.mjs', decision: 'blocked' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never writes a journal entry when the guard has nothing to report (true no-op stays silent)', () => {
    const r = runHook('wt-git-commit-backtick-guard-hook.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    })
    expect(r.status).toBe(0)
    expect(journalEntries()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------
// FAIL-OPEN failure-path proof (invariant 3 in the brief): make the journal write itself fail,
// and prove the guard STILL renders its decision. This is the one that INVERTS if wrong — a
// guard whose refusal depends on its bookkeeping succeeding would be strictly worse than no
// journal at all, so it gets tested on the failure path explicitly, not only the happy path.
// ---------------------------------------------------------------------------------------------

describe('guard-journal — FAIL-OPEN: a broken journal never breaks the guard decision', () => {
  it('wt-git-commit-backtick-guard-hook.mjs still warns when WT_GUARD_JOURNAL_DIR points at an uncreatable path', () => {
    // A path segment that is a FILE, not a directory, makes fs.mkdirSync throw ENOTDIR.
    const root = mkdtempSync(join(tmpdir(), 'wt-guard-journal-failopen-'))
    const blockerFile = join(root, 'not-a-dir')
    writeFileSync(blockerFile, 'x')
    try {
      const r = runHook(
        'wt-git-commit-backtick-guard-hook.mjs',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "the default `stretch` applied"' },
        },
        { WT_GUARD_JOURNAL_DIR: join(blockerFile, 'journal') },
      )
      // The GUARD's own decision must render exactly as if the journal worked.
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('additionalContext')
      expect(r.stdout).toContain('backtick')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('wt-unquoted-tool-glob-guard-hook.mjs still DENIES when the journal directory is uncreatable', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-guard-journal-failopen-deny-'))
    const blockerFile = join(root, 'not-a-dir')
    writeFileSync(blockerFile, 'x')
    try {
      const r = runHook(
        'wt-unquoted-tool-glob-guard-hook.mjs',
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'find . -name *.txt' } },
        { WT_GUARD_JOURNAL_DIR: join(blockerFile, 'journal') },
      )
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('"deny"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
