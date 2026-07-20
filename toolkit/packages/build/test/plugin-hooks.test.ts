// plugin-hooks.test.ts — behavior gates for the two HAND-WRITTEN plugin hooks
// (plugin/bin/*.mjs) and the observer pairing they ship with. Like the Stop-hook
// integration test, each case drives the REAL hook script as a child process with a
// crafted stdin payload and asserts stdout/exit — the "closest to real" option, where
// a wiring regression hides. The payload shapes are the ones the live harness actually
// sends (verified on Claude Code 2.1.215: a SUBAGENT's PreToolUse stdin carries
// top-level agent_type + agent_id; a main-session call carries neither).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LADDER_HOOK = join(REPO_ROOT, 'plugin/bin/wt-delegation-ladder-hook.mjs')
const GUARD_HOOK = join(REPO_ROOT, 'plugin/bin/wt-pilot-guard-hook.mjs')
const AGENTS_DIR = join(REPO_ROOT, 'plugin/agents')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function mkRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `wt-plugin-hooks-${tag}-`))
  roots.push(r)
  return r
}

interface Run {
  stdout: string
  code: number | null
  json: Record<string, unknown> | null
}
function runHook(hookPath: string, payload: unknown, env?: NodeJS.ProcessEnv): Run {
  const res = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: env ?? process.env,
  })
  const stdout = (res.stdout ?? '').trim()
  let json: Record<string, unknown> | null = null
  try {
    const parsed: unknown = stdout ? JSON.parse(stdout) : null
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>
  } catch {
    json = null
  }
  return { stdout, code: res.status, json }
}
function permissionDecision(r: Run): string | undefined {
  const hso = r.json?.['hookSpecificOutput'] as Record<string, unknown> | undefined
  return hso?.['permissionDecision'] as string | undefined
}

// --------------------------------------------------------------------------
// PreToolUse guard (wt-pilot-guard-hook.mjs) — item 1
// --------------------------------------------------------------------------
describe('wt-pilot-guard-hook — self-scoped destructive-action guard', () => {
  const pilotBash = (command: string, agentType = 'pilot', agentId = 'a1b2c3d4e5f6') => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    agent_id: agentId,
    agent_type: agentType,
  })

  const DENY = [
    ['bare git push (no named remote)', 'git push'],
    ['flag-only push with no remote', 'git push --tags'],
    ['force push', 'git push --force public main'],
    ['short force push', 'git push -f public main'],
    ['delete push', 'git push public --delete feature'],
    ['mirror push', 'git push --mirror public'],
    ['npm publish', 'npm publish'],
    ['pnpm publish', 'pnpm publish --access public'],
    ['pkill -f pattern kill', 'pkill -f dev-api.ts'],
    ['killall', 'killall node'],
    ['git push inside a compound command', 'cd /repo && git push'],
  ] as const
  for (const [label, command] of DENY) {
    it(`DENIES a pilot's ${label}`, () => {
      const r = runHook(GUARD_HOOK, pilotBash(command))
      expect(permissionDecision(r), `stdout: ${r.stdout}`).toBe('deny')
    })
  }

  it('DENIES even when agent_type is namespaced (workflow-toolbox:pilot)', () => {
    const r = runHook(GUARD_HOOK, pilotBash('git push', 'workflow-toolbox:pilot-orchestrator'))
    expect(permissionDecision(r)).toBe('deny')
  })

  const ALLOW = [
    ['push naming an explicit remote', 'git push public main'],
    // A single positional is git's REMOTE slot (`git push <remote>`), so the remote is
    // named — the guard can't tell `git push public` from a mistyped branch without the
    // repo's remote list, and must not block the legit form; git errors harmlessly on a
    // non-remote. The guard's job is the clearly-remote-less bare/flag-only push.
    ['push naming a single explicit remote', 'git push public'],
    ['push with -u and a named remote', 'git push -u public main'],
    ['non-push git', 'git status'],
    ['a commit', 'git commit -F /tmp/msg'],
    ['a normal build', 'pnpm test && pnpm typecheck'],
  ] as const
  for (const [label, command] of ALLOW) {
    it(`ALLOWS (silent) a pilot's ${label}`, () => {
      const r = runHook(GUARD_HOOK, pilotBash(command))
      expect(r.stdout, `unexpected output: ${r.stdout}`).toBe('')
    })
  }

  it('NO-OPs for the MAIN session (no agent_id) even on a bare git push', () => {
    const r = runHook(GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
    })
    expect(r.stdout).toBe('')
  })

  it('NO-OPs for a non-pilot subagent', () => {
    const r = runHook(GUARD_HOOK, pilotBash('git push', 'some-other-agent'))
    expect(r.stdout).toBe('')
  })

  it('NO-OPs for a non-Bash tool (Write) from a pilot', () => {
    const r = runHook(GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/x', content: 'y' },
      agent_id: 'a1',
      agent_type: 'pilot',
    })
    expect(r.stdout).toBe('')
  })

  it('never blanket-denies: allow is a silent exit 0 (does not auto-approve)', () => {
    const r = runHook(GUARD_HOOK, pilotBash('git push public main'))
    expect(r.stdout).toBe('')
    expect(r.code).toBe(0)
  })
})

// --------------------------------------------------------------------------
// SessionStart delegation-ladder hook (wt-delegation-ladder-hook.mjs) — items 4, 5
// --------------------------------------------------------------------------
describe('wt-delegation-ladder-hook — conditional injection + machine calibration', () => {
  /** A project cwd carrying (or not) delegation markers; isolated HOME + config dir. */
  function fixture(tag: string, opts: { marker?: boolean; adopted?: boolean } = {}) {
    const root = mkRoot(tag)
    const proj = join(root, 'proj')
    mkdirSync(join(proj, '.claude'), { recursive: true })
    if (opts.marker ?? true) writeFileSync(join(proj, '.claude', 'planka.json'), '{}')
    if (opts.adopted) {
      mkdirSync(join(proj, '.claude', 'rules'), { recursive: true })
      writeFileSync(join(proj, '.claude', 'rules', 'wt-delegation-ladder.md'), 'x')
    }
    const home = join(root, 'home')
    const cfg = join(root, 'cfg')
    mkdirSync(home, { recursive: true })
    mkdirSync(cfg, { recursive: true })
    return { root, proj, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg } }
  }
  const start = (cwd: string) => ({ hook_event_name: 'SessionStart', source: 'startup', cwd })

  it('injects the ladder when a delegation marker is present', () => {
    const f = fixture('marker')
    const r = runHook(LADDER_HOOK, start(f.proj), f.env)
    expect(r.json?.['hookSpecificOutput']).toBeTruthy()
    const ctx = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['additionalContext'] ?? ''
    expect(ctx).toContain('Delegation ladder')
  })

  it('is a SILENT no-op where no delegation marker exists', () => {
    const f = fixture('nomarker', { marker: false })
    const r = runHook(LADDER_HOOK, start(f.proj), f.env)
    expect(r.stdout).toBe('')
  })

  it('fail-safe SILENT on empty stdin', () => {
    const res = spawnSync(process.execPath, [LADDER_HOOK], { input: '', encoding: 'utf8' })
    expect((res.stdout ?? '').trim()).toBe('')
  })

  it('fail-safe SILENT on a payload without cwd', () => {
    const r = runHook(LADDER_HOOK, { hook_event_name: 'SessionStart', source: 'startup' })
    expect(r.stdout).toBe('')
  })

  it('SUGGESTS adopt-rules when the ladder is NOT yet adopted', () => {
    const f = fixture('unadopted')
    const r = runHook(LADDER_HOOK, start(f.proj), f.env)
    const ctx = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['additionalContext'] ?? ''
    expect(ctx).toContain('adopt-rules')
  })

  it('SUPPRESSES the adopt-rules suggestion once adopted (ladder still injected)', () => {
    const f = fixture('adopted', { adopted: true })
    const r = runHook(LADDER_HOOK, start(f.proj), f.env)
    const ctx = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['additionalContext'] ?? ''
    expect(ctx).toContain('Delegation ladder')
    expect(ctx).not.toContain('adopt-rules')
  })

  it('detects a cross-family bridge found on PATH', () => {
    const f = fixture('bridge-path')
    const bin = join(f.root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    const env = { ...f.env, PATH: bin } // ONLY our fake bin on PATH
    const r = runHook(LADDER_HOOK, start(f.proj), env)
    const ctx = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['additionalContext'] ?? ''
    expect(ctx).toContain('codex')
    expect(ctx).toContain('detected on this machine')
  })

  it('detects a bridge in a FALLBACK dir the PATH misses (~/.opencode/bin) — item 5', () => {
    const f = fixture('bridge-fallback')
    const emptyBin = join(f.root, 'emptybin')
    mkdirSync(emptyBin, { recursive: true })
    const ocBin = join(f.env.HOME as string, '.opencode', 'bin')
    mkdirSync(ocBin, { recursive: true })
    writeFileSync(join(ocBin, 'opencode'), '#!/bin/sh\n', { mode: 0o755 })
    const env = { ...f.env, PATH: emptyBin } // opencode is NOT on PATH, only in the fallback dir
    const r = runHook(LADDER_HOOK, start(f.proj), env)
    const ctx = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['additionalContext'] ?? ''
    expect(ctx).toContain('opencode')
  })
})

// --------------------------------------------------------------------------
// Observer-pairing drift gate — item 7
// --------------------------------------------------------------------------
describe('plugin agent observer pairings resolve to a sibling def', () => {
  it('every `observer:` a plugin agent declares names an existing plugin/agents/*.md', () => {
    const defs = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))
    const pairings: Array<[string, string]> = []
    for (const f of defs) {
      const front = readFileSync(join(AGENTS_DIR, f), 'utf8').split('\n---', 2)[0] ?? ''
      const m = front.match(/^observer:\s*(\S+)\s*$/m)
      if (m) pairings.push([f, m[1] ?? ''])
    }
    const missing = pairings.filter(([, obs]) => !existsSync(join(AGENTS_DIR, `${obs}.md`)))
    expect(missing, `dangling observer pairings: ${JSON.stringify(missing)}`).toEqual([])
    // Anchor: the pilot↔pilot-watchdog pairing must be one of them (guards a rename
    // silently dropping the shipped pair).
    expect(pairings).toContainEqual(['pilot.md', 'pilot-watchdog'])
  })

  it('pilot-watchdog keeps its report channel: the tools fence includes ObserverReport', () => {
    const front = readFileSync(join(AGENTS_DIR, 'pilot-watchdog.md'), 'utf8').split('\n---', 2)[0] ?? ''
    const m = front.match(/^tools:\s*(.+)$/m)
    expect(m, 'pilot-watchdog has no tools: fence').toBeTruthy()
    const tools = (m?.[1] ?? '').split(',').map((t) => t.trim())
    // A read-only observer that cannot call ObserverReport observes but never reports —
    // useless. This locks the report channel into the fence so a future edit can't drop it.
    // (`claude plugin validate --strict` accepts ObserverReport in tools:; listing it
    // guarantees the observer can still report whether the channel is tools-gated or
    // role-provisioned.)
    expect(tools).toContain('ObserverReport')
    expect(tools).toContain('Read')
  })
})
