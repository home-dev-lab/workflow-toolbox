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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'
import { DELEGATION_EXPECTATIONS } from '@workflow-toolbox/debugger/external-delegation'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LADDER_HOOK = join(REPO_ROOT, 'plugin/bin/wt-delegation-ladder-hook.mjs')
const GUARD_HOOK = join(REPO_ROOT, 'plugin/bin/wt-pilot-guard-hook.mjs')
const OBSERVER_PAIRING_HOOK = join(REPO_ROOT, 'plugin/bin/wt-observer-pairing-guard-hook.mjs')
const VERIFIER_GUARD_HOOK = join(REPO_ROOT, 'plugin/bin/wt-verifier-cli-guard-hook.mjs')
const ENVELOPE_INTERCEPT_HOOK = join(REPO_ROOT, 'plugin/bin/wt-envelope-intercept-hook.mjs')
const DEBUGGER_DELEGATION_SRC = join(REPO_ROOT, 'toolkit/packages/debugger/src/external-delegation.ts')
const AGENTS_DIR = join(REPO_ROOT, 'plugin/agents')
// The pilot suite lives here, NOT in AGENTS_DIR — Claude Code silently ignores an
// `observer:` field on a plugin-REGISTERED agent (AGENTS_DIR is what plugin.json's
// agents-loading registers), so a pilot's watchdog pairing only works as a project
// copy under a bare name (adopt). Keeping the pilots out of AGENTS_DIR removes
// the unwatched path entirely, rather than merely warning about it.
const AGENT_TEMPLATES_DIR = join(REPO_ROOT, 'plugin/agent-templates')

/** Text STRICTLY between the matchesOpencodeRun drift-lock markers of a source file (FILE TEXT,
 *  not `.toString()`, so it is immune to transpiler formatting). The three copies — debugger
 *  (canonical), patterns, and the hook — must hold byte-identical source. */
function matcherBodyOf(filePath: string): string {
  const text = readFileSync(filePath, 'utf8')
  const START = '// --- wt-drift-lock:matchesOpencodeRun START'
  const END = '// --- wt-drift-lock:matchesOpencodeRun END ---'
  const s = text.indexOf(START)
  const e = text.indexOf(END)
  if (s === -1 || e === -1) throw new Error(`matcher markers not found in ${filePath}`)
  return text.slice(text.indexOf('\n', s) + 1, e)
}

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
  stderr: string
  code: number | null
  json: Record<string, unknown> | null
}
function runHook(hookPath: string, payload: unknown, env?: NodeJS.ProcessEnv): Run {
  const res = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, WT_GUARD_JOURNAL_DIR: mkRoot('guard-journal'), ...(env ?? {}) },
  })
  const stdout = (res.stdout ?? '').trim()
  const stderr = (res.stderr ?? '').trim()
  let json: Record<string, unknown> | null = null
  try {
    const parsed: unknown = stdout ? JSON.parse(stdout) : null
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>
  } catch {
    json = null
  }
  return { stdout, stderr, code: res.status, json }
}
function permissionDecision(r: Run): string | undefined {
  const hso = r.json?.['hookSpecificOutput'] as Record<string, unknown> | undefined
  return hso?.['permissionDecision'] as string | undefined
}

function hookContext(r: Run): string | undefined {
  const hso = r.json?.['hookSpecificOutput'] as Record<string, unknown> | undefined
  return hso?.['additionalContext'] as string | undefined
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

  // A command line mixes CODE and DATA. These forms QUOTE a guarded pattern without executing
  // it — a commit message, an echoed sentence, a heredoc body. Refusing them refuses correct
  // work, and a guard that refuses correct work gets switched off with its real cases inside.
  // Measured on this guard's local twin 2026-08-04: an ordinary commit refused because its
  // message said "npm publish" — its third false refusal.
  const ALLOW_DATA = [
    ['a commit message quoting npm publish', 'git commit -m "port the npm publish guard"'],
    ['a commit message quoting a force push', "git commit -m 'document git push --force'"],
    ['a commit message quoting a merge of main', 'git commit -m "never merge main mid-arc"'],
    ['an echoed pattern-kill warning', 'echo "pkill -f is banned, kill by PID"'],
    ['a heredoc body quoting a publish', 'cat <<EOF > /tmp/notes\nnpm publish is escalated\nEOF'],
    // The stripping runs BEFORE the segment split, so a `&&` inside the data cannot manufacture
    // a segment that looks like a command.
    ['a quoted string containing a sequencing operator', 'echo "build && npm publish"'],
  ] as const
  for (const [label, command] of ALLOW_DATA) {
    it(`ALLOWS (silent) ${label} — data, not code`, () => {
      const r = runHook(GUARD_HOOK, pilotBash(command))
      expect(r.stdout, `false refusal on data: ${r.stdout}`).toBe('')
    })
  }

  // The other half of the proof, and the one that is easy to skip: relaxing a guard without
  // re-proving its bite is disarming it. Each of these puts the SAME pattern back as executed
  // code, adjacent to quoted data, and must still be refused.
  const DENY_ALONGSIDE_DATA = [
    ['a real publish after a quoted mention', 'echo "about to publish" && npm publish'],
    ['a real force push after a commit', 'git commit -m "ready" && git push --force public main'],
    ['a real publish after a heredoc', 'cat <<EOF > /tmp/n\nnotes\nEOF\npnpm publish'],
    ['a real pattern-kill after a quoted one', 'echo "pkill -f x" ; pkill -f dev-api.ts'],
  ] as const
  for (const [label, command] of DENY_ALONGSIDE_DATA) {
    it(`still DENIES ${label}`, () => {
      const r = runHook(GUARD_HOOK, pilotBash(command))
      expect(permissionDecision(r), `bite lost: ${r.stdout}`).toBe('deny')
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

  // The scope used to be an allowlist of three pilot type names, and this test asserted a
  // non-pilot subagent was left alone. That failed OPEN: a byte-identical copy of the pilot
  // definition under any other name was unguarded, silently — measured 2026-07-29, where the
  // same `git merge main` was refused for `pilot` and allowed for `pilot-verify`.
  // The invariant is not "is this a pilot" but "may a SUBAGENT publish, force-push or merge an
  // integration branch", and the answer is no for all of them: those are user-gated escalations
  // the spawning session holds. The guard now fails CLOSED — a type created tomorrow is covered
  // without anyone remembering to list it.
  // A named spawn is rerouted to the in-process-teammate path, which rebuilds the definition and
  // never reads its `observer:` — the watchdog is silently never attached, and the agent's own
  // report then honestly says "no observer findings", which reads exactly like a watchdog that
  // saw nothing. `isolation` excludes the spawn from that path and the pairing survives.
  // The guard refuses only where the remedy exists: `isolation` itself needs the session cwd to
  // be inside a git repository, so outside one it says what is lost and allows.
  const SHAPE_HOOK = GUARD_HOOK.replace('wt-pilot-guard-hook.mjs', 'wt-spawn-shape-guard-hook.mjs')
  const spawn = (ti: Record<string, unknown>, cwd: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    cwd,
    tool_input: ti,
  })
  // The toolkit dir is inside the repo; the filesystem root cannot inherit a project TMPDIR.
  const IN_REPO = process.cwd()
  const NO_REPO = '/'

  it('spawn-shape: REFUSES a named spawn with no isolation when isolation is available', () => {
    const r = runHook(SHAPE_HOOK, spawn({ subagent_type: 'pilot', name: 's-x' }, IN_REPO))
    expect(r.stdout).toContain('deny')
    expect(r.stdout).toContain('isolation')
  })

  it('spawn-shape: ALLOWS but warns when isolation is unavailable (cwd outside a git repo)', () => {
    const r = runHook(SHAPE_HOOK, spawn({ subagent_type: 'pilot', name: 's-x' }, NO_REPO))
    expect(r.stdout).toContain('systemMessage')
    expect(r.stdout).not.toContain('deny')
  })

  it('spawn-shape: SILENT for the safe shapes and for anything else', () => {
    const named = runHook(SHAPE_HOOK, spawn({ subagent_type: 'pilot', name: 's-x', isolation: 'worktree' }, IN_REPO))
    const anon = runHook(SHAPE_HOOK, spawn({ subagent_type: 'pilot' }, IN_REPO))
    const other = runHook(SHAPE_HOOK, { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: IN_REPO, tool_input: { command: 'ls' } })
    expect(named.stdout).toBe('')
    expect(anon.stdout).toBe('')
    expect(other.stdout).toBe('')
  })

  it('GUARDS an arbitrary subagent type — the scope is "a subagent", not a name list', () => {
    const r = runHook(GUARD_HOOK, pilotBash('git push', 'some-other-agent'))
    expect(r.stdout).toContain('permissionDecision')
    expect(r.stdout).toContain('deny')
  })

  it('still guards a renamed COPY of a pilot definition (the hole this closed)', () => {
    const r = runHook(GUARD_HOOK, pilotBash('git merge main', 'pilot-verify'))
    expect(r.stdout).toContain('deny')
  })

  it('leaves the MAIN session alone — no agent_id means it holds the gate itself', () => {
    const r = runHook(GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force public main' },
      agent_type: '',
    })
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

describe('wt-observer-pairing-guard-hook — delegate to the shipped checker', () => {
  function pairingFixture(tag: string) {
    const root = mkRoot(tag)
    const project = join(root, 'project')
    const config = join(root, 'config')
    const sessionId = 'sess-observer'
    const slug = project.replace(/[^a-zA-Z0-9]/g, '-')
    const subagentsDir = join(config, 'projects', slug, sessionId, 'subagents')
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true })
    mkdirSync(subagentsDir, { recursive: true })
    writeFileSync(join(project, '.claude', 'agents', 'pilot.md'), '---\nobserver: pilot-watchdog\n---\n# pilot\n')
    return {
      project,
      sessionId,
      subagentsDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    }
  }

  function hookPayload(project: string, sessionId: string, toolResponse: Record<string, unknown>) {
    return {
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      cwd: project,
      session_id: sessionId,
      tool_input: { subagent_type: 'pilot', name: 'pair-worker' },
      tool_response: toolResponse,
    }
  }

  it('stays SILENT when observerTaskId resolves to an isObserver:true sibling', () => {
    const f = pairingFixture('observer-pass')
    writeFileSync(join(f.subagentsDir, 'agent-worker.meta.json'), JSON.stringify({ name: 'pair-worker', observerTaskId: 'watcher' }))
    writeFileSync(join(f.subagentsDir, 'agent-worker.jsonl'), '')
    writeFileSync(join(f.subagentsDir, 'agent-watcher.meta.json'), JSON.stringify({ name: 'pilot-watchdog', isObserver: true }))
    writeFileSync(join(f.subagentsDir, 'agent-watcher.jsonl'), '')

    const r = runHook(OBSERVER_PAIRING_HOOK, hookPayload(f.project, f.sessionId, { agent_id: 'worker' }), f.env)

    expect(r.stdout).toBe('')
  })

  // The checker now reports this shape as 'pending', not 'unknown' — a dangling
  // observerTaskId with no sibling file yet is the race the pairing guard used to fire
  // on ~19 times a week, every one a false alarm (established by construction: a spawn
  // that genuinely drops its observer never writes an observerTaskId at all, so this
  // branch can only mean "not written yet").
  it('surfaces checker pending when observerTaskId is present but its sibling has not landed yet', () => {
    const f = pairingFixture('observer-dangling')
    writeFileSync(
      join(f.subagentsDir, 'agent-worker.meta.json'),
      JSON.stringify({ name: 'pair-worker', observerTaskId: 'missing-watchdog', taskKind: 'async' }),
    )
    writeFileSync(join(f.subagentsDir, 'agent-worker.jsonl'), '')

    const r = runHook(OBSERVER_PAIRING_HOOK, hookPayload(f.project, f.sessionId, { agent_id: 'worker' }), f.env)

    expect(hookContext(r)).toContain('checker verdict pending')
    expect(hookContext(r)).not.toContain('missing-watchdog')
  })

  it('surfaces checker flag when no ownership link or fallback match exists', () => {
    const f = pairingFixture('observer-flag')
    writeFileSync(join(f.subagentsDir, 'agent-worker.meta.json'), JSON.stringify({ name: 'pair-worker', taskKind: 'async' }))
    writeFileSync(join(f.subagentsDir, 'agent-worker.jsonl'), '')

    const r = runHook(OBSERVER_PAIRING_HOOK, hookPayload(f.project, f.sessionId, { agent_id: 'worker' }), f.env)

    expect(hookContext(r)).toContain('appears to have LOST')
    expect(hookContext(r)).toContain('checker verdict flag')
  })

  it('stays SILENT for types that do not declare an observer', () => {
    const root = mkRoot('observer-no-def')
    const project = join(root, 'project')
    const config = join(root, 'config')
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(project, '.claude', 'agents', 'leaf.md'), '---\n---\n# leaf\n')

    const r = runHook(
      OBSERVER_PAIRING_HOOK,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        cwd: project,
        session_id: 'sess-leaf',
        tool_input: { subagent_type: 'leaf', name: 'plain-worker' },
        tool_response: { agent_id: 'plain-worker' },
      },
      { ...process.env, CLAUDE_CONFIG_DIR: config },
    )

    expect(r.stdout).toBe('')
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
    const res = spawnSync(process.execPath, [LADDER_HOOK], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_JOURNAL_DIR: mkRoot('guard-journal-ladder-empty') },
    })
    expect((res.stdout ?? '').trim()).toBe('')
  })

  it('fail-safe SILENT on a payload without cwd', () => {
    const r = runHook(LADDER_HOOK, { hook_event_name: 'SessionStart', source: 'startup' })
    expect(r.stdout).toBe('')
  })

  it('SUGGESTS adopt when the ladder is NOT yet adopted', () => {
    const f = fixture('unadopted')
    const r = runHook(LADDER_HOOK, start(f.proj), f.env)
    const ctx = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['additionalContext'] ?? ''
    expect(ctx).toContain('adopt')
  })

  it('the suggestion offers the FULL rule set (--set rules), not just the ladder', () => {
    const f = fixture('fullset')
    const r = runHook(LADDER_HOOK, start(f.proj), f.env)
    const ctx = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['additionalContext'] ?? ''
    expect(ctx).toContain('--set rules')
    expect(ctx.toLowerCase()).toContain('rule set')
  })

  it('SUPPRESSES the adopt suggestion once adopted (ladder still injected)', () => {
    const f = fixture('adopted', { adopted: true })
    const r = runHook(LADDER_HOOK, start(f.proj), f.env)
    const ctx = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['additionalContext'] ?? ''
    expect(ctx).toContain('Delegation ladder')
    // Anchor on the SKILL INVOCATION, not the bare word: the ladder text this
    // hook always injects legitimately says "an adopted pilot", so asserting
    // the absence of "adopt" would fail on correct output. What must disappear
    // once the user has adopted is the suggestion to run the skill.
    expect(ctx).not.toContain('workflow-toolbox:adopt')
  })

  // Card 1835727457 (rules/wt/ subfolder migration): a project migrated to the new default
  // location must ALSO suppress the suggestion — checking only the old flat path would nag
  // a correctly-migrated project to re-adopt something it already has.
  it('SUPPRESSES the adopt suggestion when adopted at the NEW rules/wt/ location', () => {
    const f = mkRoot('adopted-wt')
    const proj = join(f, 'proj')
    mkdirSync(join(proj, '.claude', 'rules', 'wt'), { recursive: true })
    writeFileSync(join(proj, '.claude', 'planka.json'), '{}')
    writeFileSync(join(proj, '.claude', 'rules', 'wt', 'wt-delegation-ladder.md'), 'x')
    const home = join(f, 'home')
    const cfg = join(f, 'cfg')
    mkdirSync(home, { recursive: true })
    mkdirSync(cfg, { recursive: true })
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg }
    const r = runHook(LADDER_HOOK, start(proj), env)
    const ctx = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['additionalContext'] ?? ''
    expect(ctx).not.toContain('workflow-toolbox:adopt')
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
// PreToolUse verifier-CLI guard (wt-verifier-cli-guard-hook.mjs) — card #1825163461588419933
// Denies the terminal verdict tool (StructuredOutput) from an external cross-family verifier
// wrapper (opencode-verifier / codex-rescue) until a REAL external-CLI invocation is present
// in the wrapper's own transcript — killing a SELF-ANSWER before it can emit a verdict. Fail-OPEN
// on every uncertainty (never a blanket deny). The real hook is driven as a child process (the
// "closest to real" wiring test), with a synthetic transcript file on disk.
// --------------------------------------------------------------------------
describe('wt-verifier-cli-guard-hook — deny a self-answered verdict until the CLI ran', () => {
  const bashTurn = (command: string): string =>
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })

  // A REAL opencode invocation (arm 1 of the signature: an absolute-path opencode `run`).
  const OPENCODE_RUN = '/home/x/.opencode/bin/opencode run "verify the claim" -f "$TASKFILE" < /dev/null'
  // A REAL codex invocation (codex-companion task).
  const CODEX_TASK = 'node /home/x/plugins/codex/lib/codex-companion.mjs task --json'
  // A SELF-ANSWER: probes the binary + greps the repo itself, never `opencode run`.
  const SELF_ANSWER = 'BIN=/home/x/.opencode/bin/opencode; "$BIN" providers list; grep -rn foo src/'

  function transcriptFile(tag: string, ...lines: string[]): string {
    const dir = mkRoot(tag)
    const p = join(dir, 'agent-verify.jsonl')
    writeFileSync(p, lines.join('\n'))
    return p
  }
  const soPayload = (agentType: string, transcriptPath?: string, agentId: string | undefined = 'a1b2c3d4') => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'StructuredOutput',
    tool_input: { verdict: 'confirmed', reason: 'ok' },
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
    agent_type: agentType,
    ...(transcriptPath !== undefined ? { transcript_path: transcriptPath } : {}),
  })
  const decisionOf = (r: Run): string | undefined =>
    (r.json?.['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['permissionDecision'] as string | undefined

  // A VERBATIM opencode-run command form from the real probe wf_0b6cfa3f-f7a (the BIN= arm the
  // haiku wrappers actually used). Root cause of the probe's 20 false-refusals was flush timing:
  // this ran successfully but its Bash tool_use line was not yet in the per-subagent transcript
  // when the StructuredOutput PreToolUse fired. The fix is a PostToolUse marker (flush-immune).
  const PROBE_OPENCODE_RUN =
    'BIN="/home/x/.opencode/bin/opencode"\nTASKFILE="$PWD/.oc-verify-$$.md"\nSTREAMFILE="/tmp/wt-opencode-json-stream-probe.jsonl"\n' +
    "trap 'rm -f \"$TASKFILE\"' EXIT\ntimeout 570 \"$BIN\" run \"Adversarially verify the claim\" " +
    '--agent plan --model openai/gpt-5.6-sol --format json -f "$TASKFILE" > "$STREAMFILE" < /dev/null\nEXIT=$?\n' +
    'if [ "$EXIT" -eq 0 ]; then node "$CLAUDE_PLUGIN_ROOT/bin/wt-opencode-json-extractor.mjs" "$STREAMFILE"; fi'
  const postBash = (agentType: string, command: string, transcriptPath: string, agentId = 'a1b2c3d4') => ({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    agent_id: agentId,
    agent_type: agentType,
    transcript_path: transcriptPath,
  })
  // Fresh, ISOLATED marker dir per test so a PostToolUse write is seen by a later PreToolUse of
  // the SAME test, and never leaks across tests (via WT_VERIFIER_MARKER_DIR).
  const markerEnv = (tag: string): NodeJS.ProcessEnv => ({ ...process.env, WT_VERIFIER_MARKER_DIR: mkRoot(`marker-${tag}`) })

  it('DENIES StructuredOutput from an opencode-verifier whose transcript shows NO CLI invocation (self-answer)', () => {
    const tp = transcriptFile('selfanswer', bashTurn(SELF_ANSWER))
    const r = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp))
    expect(decisionOf(r)).toBe('deny')
    const reason = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['permissionDecisionReason'] ?? ''
    expect(reason).toContain('opencode')
  })

  it('ALLOWS (silent) when the transcript contains a real opencode run', () => {
    const tp = transcriptFile('ocrun', bashTurn(OPENCODE_RUN))
    const r = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp))
    expect(r.stdout).toBe('')
    expect(r.code).toBe(0)
  })

  it('ALLOWS (silent) a codex wrapper whose transcript contains a real codex-companion task', () => {
    const tp = transcriptFile('codextask', bashTurn(CODEX_TASK))
    const r = runHook(VERIFIER_GUARD_HOOK, soPayload('codex:codex-rescue', tp))
    expect(r.stdout).toBe('')
  })

  it('NO-OPs (silent) for a non-StructuredOutput tool (Bash) from the verifier', () => {
    const tp = transcriptFile('bashtool', bashTurn(SELF_ANSWER))
    const r = runHook(VERIFIER_GUARD_HOOK, {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' },
      agent_id: 'a1', agent_type: 'workflow-toolbox:opencode-verifier', transcript_path: tp,
    })
    expect(r.stdout).toBe('')
  })

  it('NO-OPs (silent) for the MAIN session (no agent_type AND no agent_id) even with a self-answer transcript', () => {
    const tp = transcriptFile('main', bashTurn(SELF_ANSWER))
    // A true main-session call carries NEITHER agent_type NOR agent_id → the wrapper-sig check
    // (now FIRST) returns null → allow. (A wrapper agent_type WITHOUT agent_id is a different case:
    // fail-CLOSED → deny — locked in the FAIL-CLOSED test below.)
    const r = runHook(VERIFIER_GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'StructuredOutput',
      tool_input: { verdict: 'confirmed', reason: 'ok' },
      transcript_path: tp,
    })
    expect(r.stdout).toBe('')
  })

  it('NO-OPs (silent) for a non-external subagent (a pilot emitting StructuredOutput)', () => {
    const tp = transcriptFile('pilot', bashTurn(SELF_ANSWER))
    const r = runHook(VERIFIER_GUARD_HOOK, soPayload('pilot', tp))
    expect(r.stdout).toBe('')
  })

  // ACCEPTANCE CRITERION (user, card #1825163461588419933): leaf/lean agents stay BARE — a
  // non-wrapper agent's StructuredOutput call passes UNTOUCHED (silent exit 0, verdict emitted),
  // and the script no-ops at the agent-type check BEFORE any transcript read. (The registration
  // is ALSO matcher-narrowed to StructuredOutput so the hook never even spawns on other tools —
  // asserted in launch-agents-identity.test.ts.)
  for (const leaf of ['workflow-toolbox:leaf', 'workflow-toolbox:lean', 'leaf', 'lean']) {
    it(`keeps a leaf/lean agent BARE: '${leaf}' StructuredOutput passes untouched (verdict emitted)`, () => {
      const tp = transcriptFile('leafbare', bashTurn(SELF_ANSWER))
      const r = runHook(VERIFIER_GUARD_HOOK, soPayload(leaf, tp))
      expect(r.stdout).toBe('')
      expect(r.code).toBe(0)
    })
  }

  it('fails OPEN (silent) when transcript_path is missing', () => {
    const r = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', undefined))
    expect(r.stdout).toBe('')
  })

  it('fails OPEN (silent) when transcript_path points at a nonexistent file', () => {
    const r = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', join(tmpdir(), 'wt-nonexistent-xyz.jsonl')))
    expect(r.stdout).toBe('')
  })

  // ── FIX ROUND 2 (probe wf_0b6cfa3f-f7a): the PostToolUse marker rescues the flush-timing
  // false-refusal that voided the probe (20 real-CLI votes wrongly denied) ─────────────────
  it('FAIL-BEFORE: a mid-flight transcript (CLI ran but its Bash line is NOT yet flushed) with NO marker → DENY (reproduces the probe false-refuse)', () => {
    const env = markerEnv('failbefore')
    // Empty transcript = the mid-flight state the probe hit: the opencode run completed but its
    // tool_use line was not yet on disk when the SO PreToolUse fired.
    const tp = transcriptFile('midflight1')
    const r = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp), env)
    expect(decisionOf(r)).toBe('deny')
  })

  it('PASS-AFTER: PostToolUse marks the real opencode run, so the SAME mid-flight StructuredOutput is ALLOWED (the fix)', () => {
    const env = markerEnv('passafter') // shared marker dir across the two calls of THIS test
    const tp = transcriptFile('midflight2') // still empty (unflushed) at SO time
    // 1) the wrapper's opencode run completes → PostToolUse writes the flush-immune marker.
    const post = runHook(VERIFIER_GUARD_HOOK, postBash('workflow-toolbox:opencode-verifier', PROBE_OPENCODE_RUN, tp), env)
    expect(post.stdout).toBe('') // PostToolUse never emits a decision
    // 2) the SAME wrapper emits its verdict while the transcript is still unflushed → ALLOW.
    const pre = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp), env)
    expect(pre.stdout).toBe('')
    expect(pre.code).toBe(0)
  })

  it('PostToolUse does NOT mark a non-CLI Bash command (ls), so a mid-flight self-answer STAYS denied', () => {
    const env = markerEnv('noncli')
    const tp = transcriptFile('midflight3')
    const post = runHook(VERIFIER_GUARD_HOOK, postBash('workflow-toolbox:opencode-verifier', 'ls -la "$PWD"', tp), env)
    expect(post.stdout).toBe('')
    const pre = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp), env)
    expect(decisionOf(pre)).toBe('deny') // no real CLI ran → correctly refused
  })

  // ── CARD #1825363023930328542: the a50c1510 false-refuse — the real `run` sat past the old 20k
  // scan cap (a 33K heredoc precedes `"$BIN" run`), so signatureForCommand missed it, no marker was
  // written, and the verdict was DENIED. The linear matcher scans the FULL command (head/tail
  // window) → the tail `run` is seen → marker written → verdict ALLOWED. ───────────────────────────
  it('a50c1510 SHAPE: a real opencode run whose `run` is FAR past 20k (33K heredoc) writes the marker → SO ALLOWED', () => {
    const env = markerEnv('longrun')
    const tp = transcriptFile('longrun') // empty (mid-flight, like the probe)
    const longRun =
      'BIN=/home/x/.opencode/bin/opencode\n' + 'x'.repeat(33_000) + '\ntimeout 570 "$BIN" run "verify" -f "$TASKFILE" < /dev/null'
    const post = runHook(VERIFIER_GUARD_HOOK, postBash('workflow-toolbox:opencode-verifier', longRun, tp), env)
    expect(post.stdout).toBe('') // PostToolUse records provenance, never decides
    const pre = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp), env)
    expect(pre.stdout).toBe('') // marker present → ALLOWED (was DENIED under the 20k cap)
    expect(pre.code).toBe(0)
  })

  it('REAL PROBE TRANSCRIPT replay: a verbatim opencode-run line is detected by the flushed-transcript fallback → ALLOW (no marker)', () => {
    const env = markerEnv('replayflush') // fresh empty marker dir → the marker path is NOT the reason
    // The FLUSHED transcript carries the REAL probe command form; the fallback scan must parse it.
    const tp = transcriptFile('flushed', bashTurn(PROBE_OPENCODE_RUN))
    const r = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp), env)
    expect(r.stdout).toBe('') // fallback scan finds the real invocation → allowed
  })

  // ── FIX ROUND 3 (re-probe): the marker MUST be keyed PER-SUBAGENT (agent_id), not just by
  // transcript_path — which in Path B is the SHARED delegated-session transcript, so a
  // transcript_path-only key is ONE run-global marker and a sibling's CLI run allow-markers
  // every self-answer (6 leaked in the re-probe). ─────────────────────────────────────────────
  it('BLEED GUARD: agent B self-answering is DENIED even after sibling agent A ran opencode (no cross-agent marker bleed)', () => {
    const env = markerEnv('bleed') // one delegated session's marker dir, shared by ALL its agents
    // In Path B transcript_path is the SHARED delegated-session transcript (re-probe census: 0
    // opencode calls in it — the calls live in per-subagent files), so it is the SAME for A and B.
    const sharedTp = transcriptFile('shared-delegated') // empty, like the real shared transcript
    // Agent A runs opencode → its PostToolUse writes A's marker.
    const postA = runHook(VERIFIER_GUARD_HOOK, postBash('workflow-toolbox:opencode-verifier', PROBE_OPENCODE_RUN, sharedTp, 'AAAAAAAAAAAAAAAA'), env)
    expect(postA.stdout).toBe('')
    // Agent B NEVER ran opencode; it emits a verdict with the SAME shared transcript_path but its
    // OWN agent_id → must be DENIED. A transcript_path-only key would ALLOW it via A's marker.
    const preB = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', sharedTp, 'BBBBBBBBBBBBBBBB'), env)
    expect(decisionOf(preB)).toBe('deny')
  })

  it('SAME-AGENT ALLOW (anti-pendulum): agent A that ran opencode has its OWN StructuredOutput ALLOWED via its marker', () => {
    const env = markerEnv('sameagent')
    const sharedTp = transcriptFile('shared-delegated-2') // shared transcript, empty of opencode calls
    // A runs opencode → PostToolUse writes A's marker (keyed by transcript_path + A).
    const postA = runHook(VERIFIER_GUARD_HOOK, postBash('workflow-toolbox:opencode-verifier', PROBE_OPENCODE_RUN, sharedTp, 'AAAAAAAAAAAAAAAA'), env)
    expect(postA.stdout).toBe('')
    // A emits ITS OWN verdict (SAME agent_id) → ALLOW. Locks agent_id write<->read stability: if the
    // write/read agent_id ever diverged for one subagent, credit would collapse to a round-1
    // false-refuse-ALL. This is the positive path the census must still see (~credited preserved).
    const preA = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', sharedTp, 'AAAAAAAAAAAAAAAA'), env)
    expect(preA.stdout).toBe('')
    expect(preA.code).toBe(0)
  })

  it('FAIL-CLOSED: a wrapper StructuredOutput with an agent_type but NO agent_id is DENIED (a missing per-vote key never widens allow)', () => {
    const env = markerEnv('failclosed')
    const tp = transcriptFile('noaid')
    const r = runHook(VERIFIER_GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'StructuredOutput',
      tool_input: { verdict: 'confirmed', reason: 'ok' },
      agent_type: 'workflow-toolbox:opencode-verifier',
      transcript_path: tp,
      // NO agent_id → cannot establish a per-vote key → fail-CLOSED
    }, env)
    expect(decisionOf(r)).toBe('deny')
  })

  // ── CARD #1825363023930328542 (step 2): the deny-path TERMINAL counter. A persistent no-CLI
  // self-answer is refused 1..2 with an actionable message, and its 3rd refusal is TERMINAL (stop
  // retrying, return text). A real-CLI vote is ALLOWED on its first post-run SO (step-1 fix), so it
  // never accrues a count — the cap only bites a true self-answer. ─────────────────────────────────
  const reasonOf = (r: Run): string =>
    ((r.json?.['hookSpecificOutput'] as Record<string, string> | undefined)?.['permissionDecisionReason'] ?? '')

  it('DENY COUNTER: the 3rd consecutive no-CLI deny of the SAME agent is TERMINAL (1st/2nd are not)', () => {
    const env = markerEnv('terminal') // shared counter+marker dir across the 3 calls of THIS test
    const tp = transcriptFile('terminal-self') // empty — the CLI never ran
    const so = () => runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp, 'CCCCCCCCCCCCCCCC'), env)
    const r1 = so()
    expect(decisionOf(r1)).toBe('deny')
    expect(reasonOf(r1)).not.toContain('TERMINAL')
    const r2 = so()
    expect(decisionOf(r2)).toBe('deny')
    expect(reasonOf(r2)).not.toContain('TERMINAL')
    const r3 = so()
    expect(decisionOf(r3)).toBe('deny')
    expect(reasonOf(r3)).toContain('TERMINAL')
    expect(reasonOf(r3)).toContain('STOP')
  })

  it('DENY COUNTER recovery (aafb024d): a real opencode run before the 3rd attempt → ALLOWED, never terminal', () => {
    const env = markerEnv('recover')
    const tp = transcriptFile('recover-self') // empty (mid-flight)
    const aid = 'DDDDDDDDDDDDDDDD'
    // Two mid-flight denies (the CLI has not run yet)…
    expect(decisionOf(runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp, aid), env))).toBe('deny')
    expect(decisionOf(runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp, aid), env))).toBe('deny')
    // …then the wrapper actually runs opencode → PostToolUse writes the per-subagent marker…
    runHook(VERIFIER_GUARD_HOOK, postBash('workflow-toolbox:opencode-verifier', PROBE_OPENCODE_RUN, tp, aid), env)
    // …so its 3rd StructuredOutput is ALLOWED (a real-CLI vote never reaches the terminal cap).
    const r3 = runHook(VERIFIER_GUARD_HOOK, soPayload('workflow-toolbox:opencode-verifier', tp, aid), env)
    expect(r3.stdout).toBe('')
    expect(r3.code).toBe(0)
  })

  it('drift-lock: the hook embeds the canonical opencode+codex CLI signatures verbatim', () => {
    const src = readFileSync(VERIFIER_GUARD_HOOK, 'utf8')
    // The provenance gate + this hook + the shipped debugger registry must agree on the CLI
    // signature. DELEGATION_EXPECTATIONS is the canonical source; assert each id's regex
    // SOURCE appears verbatim in the hook file (it embeds them as /…/im literals), so any
    // divergence from the canonical signal fails a gate here.
    expect(DELEGATION_EXPECTATIONS.map((s) => s.id).sort()).toEqual(['codex', 'opencode'])
    for (const sig of DELEGATION_EXPECTATIONS) {
      expect(src, `${sig.id} typeRe drifted from the canonical registry`).toContain(sig.typeRe.source)
      expect(src, `${sig.id} commandRe drifted from the canonical registry`).toContain(sig.commandRe.source)
    }
  })

  it('drift-lock: the hook matchesOpencodeRun body is byte-identical to the canonical debugger copy', () => {
    // opencode detection now runs through an EXECUTABLE linear matcher, not the (ReDoS-prone,
    // display-only) commandRe. The commandRe drift-lock above no longer covers the real signal;
    // this asserts the hook's matcher SOURCE matches the canonical debugger copy byte-for-byte
    // (the same body patterns holds — chained via the patterns↔debugger drift-lock).
    const hookBody = matcherBodyOf(VERIFIER_GUARD_HOOK)
    const canonical = matcherBodyOf(DEBUGGER_DELEGATION_SRC)
    expect(hookBody).toBe(canonical)
    expect(hookBody).toContain('function matchesOpencodeRun(')
  })
})

// --------------------------------------------------------------------------
// WT_VERIFIER_DEBUG env-gated logging (guard-debug task). The guard is a SHIPPED provenance
// hook, so the CRITICAL invariant is ZERO side-effect when the env is unset; when set to a
// logfile it appends one JSON line per decision, carrying the EXACT untruncated transcript_path
// (the evidence that grounds the step-3 checker marker-key reconstruction) + the new
// matcher_hit / deny_count / terminal fields.
// --------------------------------------------------------------------------
describe('wt-verifier-cli-guard-hook — WT_VERIFIER_DEBUG env-gated logging', () => {
  const VERIFIER_GUARD_HOOK2 = join(REPO_ROOT, 'plugin/bin/wt-verifier-cli-guard-hook.mjs')
  const soPay = (agentType: string, transcriptPath: string, agentId: string) => ({
    hook_event_name: 'PreToolUse', tool_name: 'StructuredOutput', tool_input: { verdict: 'confirmed', reason: 'ok' },
    agent_id: agentId, agent_type: agentType, transcript_path: transcriptPath,
  })
  const postBash2 = (agentType: string, command: string, transcriptPath: string, agentId: string) => ({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, agent_id: agentId, agent_type: agentType, transcript_path: transcriptPath,
  })

  it('INVARIANT: env UNSET ⇒ ZERO debug writes (a shipped guard has no default side-effect)', () => {
    const dir = mkRoot('dbg-unset')
    const logPath = join(dir, 'debug.jsonl') // where it WOULD write if the env were set
    const tp = join(dir, 'agent.jsonl'); writeFileSync(tp, '')
    const markers = join(dir, 'markers'); mkdirSync(markers, { recursive: true })
    const env: NodeJS.ProcessEnv = { ...process.env, WT_VERIFIER_MARKER_DIR: markers }
    delete env.WT_VERIFIER_DEBUG // ensure it is unset even if the parent shell has it
    // Drive BOTH a deny and a real marker-write — the two hottest log points — with the env unset.
    runHook(VERIFIER_GUARD_HOOK2, soPay('workflow-toolbox:opencode-verifier', tp, 'AIDX'), env)
    runHook(VERIFIER_GUARD_HOOK2, postBash2('workflow-toolbox:opencode-verifier', '/x/opencode run "y"', tp, 'AIDX'), env)
    expect(existsSync(logPath)).toBe(false) // nothing written anywhere the debug log would go
  })

  it('env SET ⇒ appends JSONL: marker-written (matcher_hit + exact transcript), allow-marker, deny (deny_count/terminal)', () => {
    const dir = mkRoot('dbg-set')
    const logPath = join(dir, 'debug.jsonl')
    const markers = join(dir, 'markers'); mkdirSync(markers, { recursive: true })
    const tp = join(dir, 'agent.jsonl'); writeFileSync(tp, '') // shared, empty (mid-flight)
    const env: NodeJS.ProcessEnv = { ...process.env, WT_VERIFIER_MARKER_DIR: markers, WT_VERIFIER_DEBUG: logPath }
    // 1) an a50c1510-shape run (33K heredoc, `run` past 20k) → marker-written, matcher_hit indirect-BIN
    const longRun = 'BIN=/home/x/.opencode/bin/opencode\n' + 'x'.repeat(33_000) + '\ntimeout 570 "$BIN" run "verify" -f "$T" < /dev/null'
    runHook(VERIFIER_GUARD_HOOK2, postBash2('workflow-toolbox:opencode-verifier', longRun, tp, 'AID1'), env)
    // 2) that same agent's SO is ALLOWED via its marker → allow-marker
    runHook(VERIFIER_GUARD_HOOK2, soPay('workflow-toolbox:opencode-verifier', tp, 'AID1'), env)
    // 3) a DIFFERENT agent with no CLI → deny (count 1, not terminal)
    runHook(VERIFIER_GUARD_HOOK2, soPay('workflow-toolbox:opencode-verifier', tp, 'AID2'), env)

    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const written = lines.find((l) => l.decision === 'marker-written')
    expect(written, 'marker-written line present').toBeTruthy()
    expect(written!.matcher_hit).toBe('indirect-BIN')
    expect(written!.transcript).toBe(tp) // EXACT transcript_path, untruncated (step-3 grounding evidence)
    expect(written!.agent_id).toBe('AID1')
    expect(typeof written!.markerPath).toBe('string')
    expect(lines.some((l) => l.decision === 'allow-marker')).toBe(true)
    const deny = lines.find((l) => l.decision === 'deny')
    expect(deny, 'deny line present').toBeTruthy()
    expect(deny!.deny_count).toBe(1)
    expect(deny!.terminal).toBe(false)
    expect(deny!.agent_id).toBe('AID2')
  })
})

// --------------------------------------------------------------------------
// Observer-pairing drift gate — item 7
// --------------------------------------------------------------------------
describe('plugin agent observer pairings resolve to a sibling def', () => {
  it('no plugin-REGISTERED agent (plugin/agents/*.md) declares `observer:` — the field is silently ignored there', () => {
    // Claude Code silently ignores `observer:` on an agent a plugin REGISTERS — a
    // workflow-toolbox:pilot spawned that way would run with no watchdog and no
    // warning. This is the invariant, not an enumeration of today's agents: it stays
    // green regardless of which/how-many agents plugin/agents/ holds, and it catches
    // the day someone drops an observer-declaring def back in there.
    const defs = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))
    const offenders = defs.filter((f) => {
      const front = readFileSync(join(AGENTS_DIR, f), 'utf8').split('\n---', 2)[0] ?? ''
      return /^observer:\s*\S+\s*$/m.test(front)
    })
    expect(offenders, `plugin/agents/*.md declaring observer: (ignored silently there): ${offenders.join(', ')}`).toEqual([])
  })

  it('every `observer:` a plugin-TEMPLATE agent declares names an existing plugin/agent-templates/*.md', () => {
    const defs = readdirSync(AGENT_TEMPLATES_DIR).filter((f) => f.endsWith('.md'))
    const pairings: Array<[string, string]> = []
    for (const f of defs) {
      const front = readFileSync(join(AGENT_TEMPLATES_DIR, f), 'utf8').split('\n---', 2)[0] ?? ''
      const m = front.match(/^observer:\s*(\S+)\s*$/m)
      if (m) pairings.push([f, m[1] ?? ''])
    }
    const missing = pairings.filter(([, obs]) => !existsSync(join(AGENT_TEMPLATES_DIR, `${obs}.md`)))
    expect(missing, `dangling observer pairings: ${JSON.stringify(missing)}`).toEqual([])
    // Anchor: the pilot↔pilot-watchdog pairing must be one of them (guards a rename
    // silently dropping the shipped pair).
    expect(pairings).toContainEqual(['pilot.md', 'pilot-watchdog'])
  })

  it('pilot-watchdog keeps its report channel: the tools fence includes ObserverReport', () => {
    const front = readFileSync(join(AGENT_TEMPLATES_DIR, 'pilot-watchdog.md'), 'utf8').split('\n---', 2)[0] ?? ''
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

// --------------------------------------------------------------------------
// safeTmpDir / looksLikeProjectDir (root-hygiene follow-up, card: temp dirs leaking into the
// wt-suite umbrella root). markerDir() used to trust `os.tmpdir()` unconditionally — on
// 2026-07-27 a process whose os.tmpdir() resolved to a PROJECT directory (not a real system
// temp dir) wrote its marker files straight into the repo root. safeTmpDir() rejects an
// os.tmpdir() result that is an ancestor of (or equal to) the current working directory,
// which a genuine system temp dir never is. See also
// toolkit/scripts/test/wt-suite-root-hygiene.test.ts (the whitelist sweep on the real root).
// --------------------------------------------------------------------------
describe('wt-verifier-cli-guard-hook — safeTmpDir rejects a project-rooted os.tmpdir()', () => {
  // A plain `node` subprocess (not vite's module runner, which refuses to serve a dynamic
  // import outside its configured root) that imports the real hook file by its file:// URL
  // and drives the exported pure functions — same "closest to real" spirit as `runHook`
  // above, just for functions instead of the hook's stdin/stdout contract.
  function evalInHook(expr: string): unknown {
    const hookUrl = pathToFileURL(VERIFIER_GUARD_HOOK).href
    const script = `
      import * as mod from ${JSON.stringify(hookUrl)}
      import os from 'node:os'
      const result = (${expr})
      process.stdout.write(JSON.stringify(result === undefined ? null : result))
    `
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_JOURNAL_DIR: mkRoot('guard-journal-eval') },
    })
    if (res.status !== 0) throw new Error(`subprocess failed: ${res.stderr}`)
    return JSON.parse(res.stdout)
  }

  it('looksLikeProjectDir: true when candidate === cwd, or is an ancestor of cwd', () => {
    expect(evalInHook("mod.looksLikeProjectDir('/home/x/projects/wt-suite', '/home/x/projects/wt-suite')")).toBe(true)
    expect(
      evalInHook(
        "mod.looksLikeProjectDir('/home/x/projects/wt-suite', '/home/x/projects/wt-suite/workflow-toolbox')"
      )
    ).toBe(true)
  })

  it('looksLikeProjectDir: false for a real temp dir unrelated to cwd', () => {
    expect(evalInHook("mod.looksLikeProjectDir('/tmp', '/home/x/projects/wt-suite/workflow-toolbox')")).toBe(false)
    // A cwd that merely SHARES A PREFIX with the candidate (sibling dir, not a descendant)
    // must not false-positive — this is the case a naive `startsWith` (no separator) would
    // wrongly flag: /tmp/wt-suite-other is NOT inside /tmp/wt-suite.
    expect(evalInHook("mod.looksLikeProjectDir('/tmp/wt-suite', '/tmp/wt-suite-other/sub')")).toBe(false)
  })

  it('safeTmpDir: falls back to the OS temp dir when os.tmpdir() would equal cwd (RED without the guard)', () => {
    const expected = process.platform === 'win32'
      ? (process.env['SystemRoot'] ? join(process.env['SystemRoot'], 'Temp') : 'C:\\Windows\\Temp')
      : '/tmp'
    const result = evalInHook(
      "(() => { const fake = '/home/x/projects/wt-suite/workflow-toolbox'; " +
        "process.cwd = () => fake; os.tmpdir = () => '/home/x/projects/wt-suite'; " +
        'return mod.safeTmpDir() })()'
    )
    expect(result).not.toBe('/home/x/projects/wt-suite')
    expect(result).toBe(expected)
  })

  it('safeTmpDir: passes through a real os.tmpdir() untouched', () => {
    expect(evalInHook('mod.safeTmpDir()')).toBe(tmpdir())
  })
})

// --------------------------------------------------------------------------
// A workflow's LANE CALL becomes a node: on PostToolUse the guard writes the two artefacts the
// observatory builds an agent node from (a transcript line + its meta), into the delegated
// session's single run directory. Hooks are PER SESSION, so this is the only vantage point that
// sees a workflow agent's `opencode run` at all.
// --------------------------------------------------------------------------
describe('wt-verifier-cli-guard-hook — lane-call artefacts for a workflow run', () => {
  const LANE_RUN = '/home/x/.opencode/bin/opencode run "verify the claim" --model openai/gpt-5.4 < /dev/null'
  const AID = 'EEEEEEEEEEEEEEEE'

  /** Build `<root>/<session>.jsonl` plus `<root>/<session>/subagents/workflows/<runId>/` for each
   *  id given — zero, one, or several, which is what the refuse-to-guess branch turns on. */
  function session(tag: string, runIds: string[]): { transcriptPath: string; runDir: (id: string) => string } {
    const root = mkRoot(tag)
    const transcriptPath = join(root, 'sess.jsonl')
    writeFileSync(transcriptPath, '')
    const workflows = join(root, 'sess', 'subagents', 'workflows')
    for (const id of runIds) mkdirSync(join(workflows, id), { recursive: true })
    return { transcriptPath, runDir: (id: string) => join(workflows, id) }
  }
  const post = (transcriptPath: string, toolResponse: unknown) => ({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: LANE_RUN },
    tool_response: toolResponse,
    agent_id: AID,
    agent_type: 'workflow-toolbox:opencode-verifier',
    transcript_path: transcriptPath,
  })
  const isolated = (tag: string): NodeJS.ProcessEnv => ({ ...process.env, WT_VERIFIER_MARKER_DIR: mkRoot(`lane-${tag}`) })

  const LANE = `${AID}-lane`

  it('writes the transcript line AND its meta into the single run dir, carrying the lane output verbatim', () => {
    const s = session('lane-one', ['wf_abc123'])
    const r = runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, { stdout: 'VERDICT: confirmed\nthe claim holds' }), isolated('one'))
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('') // PostToolUse never speaks; it only records

    const dir = s.runDir('wf_abc123')
    const lines = readFileSync(join(dir, `agent-${LANE}.jsonl`), 'utf8').trim().split('\n')
    // TWO lines: what was asked, then what came back. A node showing only the answer leaves its
    // reader unable to judge it — the Input/Output panel reads "No input/output captured".
    expect(lines).toHaveLength(2)
    const asked = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(asked['type']).toBe('user')
    expect((asked['message'] as Record<string, unknown>)['content']).toContain('opencode')
    const entry = JSON.parse(lines[1] ?? '') as Record<string, unknown>
    expect(entry['type']).toBe('assistant')
    expect(entry['agentId']).toBe(LANE)
    expect(entry['isSidechain']).toBe(true)
    expect((entry['message'] as Record<string, unknown>)['content']).toBe('VERDICT: confirmed\nthe claim holds')
    // The meta is what names the node — without it the transcript renders untyped. Asserted by
    // PROPERTY, not by deep equality: the meta gains fields as more about a call becomes knowable,
    // and a whole-object match would fail on every one of them while testing nothing extra.
    const meta = JSON.parse(readFileSync(join(dir, `agent-${LANE}.meta.json`), 'utf8')) as Record<string, unknown>
    expect(meta['agentType']).toBe('scripted:opencode')
    expect(meta['description']).toContain(AID)
  })

  // RED before the derived-id fix, and the only test that could have caught it: measured on run
  // wf_aa4fb03d-e90, writing at `agent-<agentId>.*` TRUNCATED the envelope's own transcript and
  // relabelled its node. A second node beside the envelope, never a node replacing it.
  it('LEAVES THE ENVELOPE ALONE: the harness\'s own transcript and meta for that agent are untouched', () => {
    const s = session('lane-envelope', ['wf_env'])
    const dir = s.runDir('wf_env')
    // What the harness has already written for the wrapper agent by the time the lane call returns.
    writeFileSync(join(dir, `agent-${AID}.jsonl`), '{"type":"user","message":{"role":"user","content":"the brief"}}\n')
    writeFileSync(join(dir, `agent-${AID}.meta.json`), JSON.stringify({ agentType: 'workflow-toolbox:opencode-verifier' }))

    runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, { stdout: 'lane output' }), isolated('envelope'))

    expect(readFileSync(join(dir, `agent-${AID}.jsonl`), 'utf8')).toContain('the brief')
    expect(JSON.parse(readFileSync(join(dir, `agent-${AID}.meta.json`), 'utf8'))).toEqual({
      agentType: 'workflow-toolbox:opencode-verifier',
    })
    expect(existsSync(join(dir, `agent-${LANE}.jsonl`))).toBe(true) // and the lane node exists beside it
  })

  it('APPENDS: a second lane call adds an entry instead of erasing the first', () => {
    const s = session('lane-twice', ['wf_twice'])
    runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, { stdout: 'first call' }), isolated('twice-a'))
    runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, { stdout: 'second call' }), isolated('twice-b'))
    const body = readFileSync(join(s.runDir('wf_twice'), `agent-${LANE}.jsonl`), 'utf8')
    expect(body.trim().split('\n')).toHaveLength(4) // two calls x (asked + answered)
    expect(body).toContain('first call')
    expect(body).toContain('second call')
  })

  // The batching shape: ONE envelope, N external calls, N nodes. Keyed by tool_use_id because the
  // calls of a batch complete concurrently — a counter over existing files would let two hook
  // processes pick the same index and silently merge two calls into one node.
  it('ONE NODE PER CALL: two calls with distinct tool_use_ids write two separate lane nodes', () => {
    const s = session('lane-percall', ['wf_percall'])
    const dir = s.runDir('wf_percall')
    const withId = (id: string, out: string) => ({ ...post(s.transcriptPath, { stdout: out }), tool_use_id: id })

    runHook(VERIFIER_GUARD_HOOK, withId('toolu_AAA', 'review of file one'), isolated('percall-a'))
    runHook(VERIFIER_GUARD_HOOK, withId('toolu_BBB', 'review of file two'), isolated('percall-b'))

    const laneFiles = readdirSync(dir).filter((f) => f.includes('-lane') && f.endsWith('.jsonl'))
    expect(laneFiles).toHaveLength(2)
    const bodies = laneFiles.map((f) => readFileSync(join(dir, f), 'utf8'))
    // each node holds exactly its own call, and neither absorbed the other
    expect(bodies.filter((b) => b.includes('review of file one'))).toHaveLength(1)
    expect(bodies.filter((b) => b.includes('review of file two'))).toHaveLength(1)
    for (const b of bodies) expect(b.trim().split('\n')).toHaveLength(2) // asked + answered
    // and each node is named, so the graph can label them
    expect(readdirSync(dir).filter((f) => f.includes('-lane') && f.endsWith('.meta.json'))).toHaveLength(2)
  })

  // The facts a renderer needs to place the node in its phase and price it. Each is recorded ONLY
  // when genuinely known — the alternative to an absent field is an invented one.
  it('records the PARENT, the model and the real duration on the node', () => {
    const s = session('lane-facts', ['wf_facts'])
    const payload = {
      ...post(s.transcriptPath, { stdout: 'review text' }),
      tool_use_id: 'toolu_FACTS',
      duration_ms: 20767,
    }
    runHook(VERIFIER_GUARD_HOOK, payload, isolated('facts'))
    const metaFile = readdirSync(s.runDir('wf_facts')).find((f) => f.includes('-lane') && f.endsWith('.meta.json'))
    const meta = JSON.parse(readFileSync(join(s.runDir('wf_facts'), metaFile ?? ''), 'utf8')) as Record<string, unknown>
    expect(meta['parentAgentId']).toBe(AID) // without this the node cannot be placed in its phase
    expect(meta['model']).toBe('openai/gpt-5.4')
    expect(meta['durationMs']).toBe(20767) // never 0.0s when the harness measured it
    expect(meta['lane']).toBe('opencode')
    expect(meta['description']).toContain('openai/gpt-5.4')
  })

  it('records external tokens when the call emitted them, and NOTHING when it did not', () => {
    const jsonStream = [
      JSON.stringify({ type: 'start', sessionID: 'ses_abc123' }),
      JSON.stringify({ type: 'step', metadata: { tokens: { total: 10, input: 5, output: 1, reasoning: 0, cache: { read: 4, write: 0 } } } }),
      JSON.stringify({ type: 'end', metadata: { tokens: { total: 7420, input: 231, output: 8, reasoning: 13, cache: { read: 7168, write: 0 } } } }),
    ].join('\n')

    const s1 = session('lane-tok', ['wf_tok'])
    runHook(VERIFIER_GUARD_HOOK, { ...post(s1.transcriptPath, { stdout: jsonStream }), tool_use_id: 'toolu_T1' }, isolated('tok'))
    const f1 = readdirSync(s1.runDir('wf_tok')).find((f) => f.includes('-lane') && f.endsWith('.meta.json'))
    const m1 = JSON.parse(readFileSync(join(s1.runDir('wf_tok'), f1 ?? ''), 'utf8')) as Record<string, unknown>
    // the LAST usage line wins: the stream is cumulative, so the first would under-report
    expect(m1['laneTokens']).toEqual({ input: 231, output: 8, reasoning: 13, cacheRead: 7168, cacheWrite: 0 })
    expect(m1['laneSessionId']).toBe('ses_abc123')

    // A plain-text call measures nothing. The field must be ABSENT, never zero — a zero renders as
    // a measurement, which is the failure the cost-split card exists to prevent.
    const s2 = session('lane-notok', ['wf_notok'])
    runHook(VERIFIER_GUARD_HOOK, { ...post(s2.transcriptPath, { stdout: 'plain output' }), tool_use_id: 'toolu_T2' }, isolated('notok'))
    const f2 = readdirSync(s2.runDir('wf_notok')).find((f) => f.includes('-lane') && f.endsWith('.meta.json'))
    const m2 = JSON.parse(readFileSync(join(s2.runDir('wf_notok'), f2 ?? ''), 'utf8')) as Record<string, unknown>
    expect(m2).not.toHaveProperty('laneTokens')
    expect(m2['parentAgentId']).toBe(AID) // the rest is still recorded
  })

  it('prefers the redirected JSON stream file named in the command, then unlinks it', () => {
    const s = session('lane-streamfile', ['wf_streamfile'])
    const dir = mkRoot('lane-stream-src')
    const streamPath = join(dir, 'wt-opencode-json-stream-test.jsonl')
    const stream = [
      JSON.stringify({ type: 'start', sessionID: 'ses_stream' }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'streamed answer' } }),
      JSON.stringify({ type: 'end', metadata: { tokens: { input: 11, output: 7, reasoning: 3, cache: { read: 5, write: 0 } } } }),
    ].join('\n')
    writeFileSync(streamPath, stream)
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {
        command:
          'STREAMFILE=' + JSON.stringify(streamPath) + '\n' +
          'timeout 570 "/home/x/.opencode/bin/opencode" run "verify" --format json -f "$TASKFILE" > "$STREAMFILE" < /dev/null',
      },
      tool_response: { stdout: 'fallback plain output' },
      tool_use_id: 'toolu_STREAMFILE',
      duration_ms: 123,
      agent_id: AID,
      agent_type: 'workflow-toolbox:opencode-verifier',
      transcript_path: s.transcriptPath,
    }
    runHook(VERIFIER_GUARD_HOOK, payload, isolated('streamfile'))
    const metaFile = readdirSync(s.runDir('wf_streamfile')).find((f) => f.includes('-lane') && f.endsWith('.meta.json'))
    const meta = JSON.parse(readFileSync(join(s.runDir('wf_streamfile'), metaFile ?? ''), 'utf8')) as Record<string, unknown>
    expect(meta['laneTokens']).toEqual({ input: 11, output: 7, reasoning: 3, cacheRead: 5, cacheWrite: 0 })
    const transcriptFile = readdirSync(s.runDir('wf_streamfile')).find((f) => f.includes('-lane') && f.endsWith('.jsonl') && !f.endsWith('.opencode.jsonl'))
    const entry = JSON.parse(readFileSync(join(s.runDir('wf_streamfile'), transcriptFile ?? ''), 'utf8').trim().split('\n').at(-1) ?? '') as Record<string, unknown>
    expect((entry['message'] as Record<string, unknown>)['content']).toBe('streamed answer')
    expect(existsSync(streamPath)).toBe(false)
  })

  // The transcript is what a human opens the node to READ. A `--format json` call — the one that
  // carries the tokens — would otherwise leave a stream of step markers, ids and timestamps there.
  it('the transcript carries the model ANSWER, not the raw JSON transport', () => {
    const stream = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_x', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { type: 'text', text: 'the claim holds, here is why' } }),
      JSON.stringify({ type: 'step_finish', sessionID: 'ses_x', part: { type: 'step-finish' }, metadata: { tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 1, write: 0 } } } }),
    ].join('\n')

    const s = session('lane-answer', ['wf_answer'])
    runHook(VERIFIER_GUARD_HOOK, { ...post(s.transcriptPath, { stdout: stream }), tool_use_id: 'toolu_ANS' }, isolated('answer'))
    const f = readdirSync(s.runDir('wf_answer')).find((x) => x.includes('-lane') && x.endsWith('.jsonl'))
    const entry = JSON.parse(readFileSync(join(s.runDir('wf_answer'), f ?? ''), 'utf8').trim().split('\n').at(-1) ?? '') as Record<string, unknown>
    const content = (entry['message'] as Record<string, unknown>)['content']
    expect(content).toBe('the claim holds, here is why')
    expect(content).not.toContain('step_start') // the transport must not reach the reader
    expect(content).not.toContain('sessionID')
  })

  // The raw stream is kept beside the transcript so the OBSERVATORY's own converter can format it —
  // it emits a properly chained transcript and maps the usage into the shape every agent's header
  // already renders. Duplicating that here would fork a format with one owner.
  it('keeps the RAW event stream beside the transcript when the call emitted one', () => {
    const stream = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_side', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', sessionID: 'ses_side', part: { type: 'text', text: 'the answer' } }),
    ].join('\n')
    const s = session('lane-side', ['wf_side'])
    runHook(VERIFIER_GUARD_HOOK, { ...post(s.transcriptPath, { stdout: stream }), tool_use_id: 'toolu_SIDE' }, isolated('side'))
    const dir = s.runDir('wf_side')
    const side = readdirSync(dir).find((f) => f.endsWith('.opencode.jsonl'))
    expect(side, 'the raw stream must be kept for the converter that owns this format').toBeDefined()
    const body = readFileSync(join(dir, side ?? ''), 'utf8')
    expect(body).toContain('step_start') // RAW — the events, not the extracted text
    expect(body.endsWith('\n')).toBe(true)
    // and the hook's own fallback transcript still exists beside it
    expect(readdirSync(dir).some((f) => f.includes('-lane') && f.endsWith('.jsonl') && !f.endsWith('.opencode.jsonl'))).toBe(true)
  })

  it('writes NO sidecar for a plain-text call — an empty one would read as "converted to nothing"', () => {
    const s = session('lane-noside', ['wf_noside'])
    runHook(VERIFIER_GUARD_HOOK, { ...post(s.transcriptPath, { stdout: 'plain answer' }), tool_use_id: 'toolu_NOSIDE' }, isolated('noside'))
    expect(readdirSync(s.runDir('wf_noside')).some((f) => f.endsWith('.opencode.jsonl'))).toBe(false)
  })

  it('keeps the RAW output when nothing text-shaped is in it — an empty transcript is worse than a noisy one', () => {
    const s = session('lane-raw', ['wf_raw'])
    runHook(VERIFIER_GUARD_HOOK, { ...post(s.transcriptPath, { stdout: 'plain non-json answer' }), tool_use_id: 'toolu_RAW' }, isolated('raw'))
    const f = readdirSync(s.runDir('wf_raw')).find((x) => x.includes('-lane') && x.endsWith('.jsonl'))
    const entry = JSON.parse(readFileSync(join(s.runDir('wf_raw'), f ?? ''), 'utf8').trim().split('\n').at(-1) ?? '') as Record<string, unknown>
    expect((entry['message'] as Record<string, unknown>)['content']).toBe('plain non-json answer')
  })

  it('accepts a bare-string tool_response (the shape is narrowed, never assumed)', () => {
    const s = session('lane-str', ['wf_str'])
    runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, 'plain output'), isolated('str'))
    const entry = JSON.parse(readFileSync(join(s.runDir('wf_str'), `agent-${LANE}.jsonl`), 'utf8').trim().split('\n').at(-1) ?? '') as Record<string, unknown>
    expect((entry['message'] as Record<string, unknown>)['content']).toBe('plain output')
  })

  it('REFUSES TO GUESS: two run dirs ⇒ nothing is written into EITHER (never sort by mtime)', () => {
    // The anti-runaway guard makes one run per delegated session the real case. If that ever
    // relaxes, writing into the newest would put one run's lane call inside another run's DAG —
    // silently, since both dirs exist and both are writable. Refusing is the correct degradation.
    const s = session('lane-two', ['wf_first', 'wf_second'])
    const r = runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, { stdout: 'output' }), isolated('two'))
    expect(r.code).toBe(0) // still a clean no-op — a hook never fails a run
    for (const id of ['wf_first', 'wf_second']) {
      expect(existsSync(join(s.runDir(id), `agent-${AID}-lane.jsonl`))).toBe(false)
      expect(existsSync(join(s.runDir(id), `agent-${AID}-lane.meta.json`))).toBe(false)
    }
  })

  it('writes NOTHING when the lane produced no output (an empty transcript would render as a blank node)', () => {
    const s = session('lane-empty', ['wf_empty'])
    runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, { stdout: '' }), isolated('empty'))
    expect(existsSync(join(s.runDir('wf_empty'), `agent-${AID}-lane.jsonl`))).toBe(false)
  })

  it('an ORDINARY session (no delegated-run layout) is untouched — exit 0, no directories created', () => {
    const root = mkRoot('lane-plain')
    const tp = join(root, 'sess.jsonl')
    writeFileSync(tp, '')
    const r = runHook(VERIFIER_GUARD_HOOK, post(tp, { stdout: 'output' }), isolated('plain'))
    expect(r.code).toBe(0)
    expect(existsSync(join(root, 'sess'))).toBe(false)
    expect(readdirSync(root)).toEqual(['sess.jsonl'])
  })
})

// --------------------------------------------------------------------------
// The BATCH envelope (wt-opencode-envelope.mjs) makes N external calls behind ONE Bash tool call.
// `signatureForCommand` never matches ITS command line — the script spawns `opencode run` itself,
// in a child process the Bash tool never sees the argv of — so the single-call path above is
// structurally blind to it (card #1839472753636279587: N calls, ZERO nodes, measured on
// wf_fa4afff2-f74). This describe block covers the fix: reading the manifest the script already
// writes and turning each of its tasks into its own node, the same two artefacts per task.
// --------------------------------------------------------------------------
describe('wt-verifier-cli-guard-hook — batch envelope: N external calls become N nodes', () => {
  const AID = 'BBBBBBBBBBBBBBBB'

  function session(tag: string, runIds: string[]): { transcriptPath: string; runDir: (id: string) => string } {
    const root = mkRoot(tag)
    const transcriptPath = join(root, 'sess.jsonl')
    writeFileSync(transcriptPath, '')
    const workflows = join(root, 'sess', 'subagents', 'workflows')
    for (const id of runIds) mkdirSync(join(workflows, id), { recursive: true })
    return { transcriptPath, runDir: (id: string) => join(workflows, id) }
  }
  const isolated = (tag: string): NodeJS.ProcessEnv => ({ ...process.env, WT_VERIFIER_MARKER_DIR: mkRoot(`envbatch-${tag}`) })

  const ENVELOPE_COMMAND =
    'TASKSFILE="/repo/.oc-envelope-tasks-$$.json"\n' +
    'cat > "$TASKSFILE" <<\'EOF\'\n[]\nEOF\n' +
    'node "$CLAUDE_PLUGIN_ROOT/bin/wt-opencode-envelope.mjs" "$TASKSFILE" --dir "/repo" ; rm -f "$TASKSFILE"'

  function writeManifest(root: string, tasks: unknown[]): string {
    const manifestPath = join(root, 'tasks.json.manifest.json')
    writeFileSync(manifestPath, JSON.stringify({ tasks }), 'utf8')
    return manifestPath
  }

  function post(transcriptPath: string, manifestPath: string, toolUseId = 'toolu_BATCH', command = ENVELOPE_COMMAND) {
    return {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: `MANIFEST: ${manifestPath}\n` },
      tool_use_id: toolUseId,
      agent_id: AID,
      agent_type: 'workflow-toolbox:opencode-envelope',
      transcript_path: transcriptPath,
    }
  }

  function writeAgentTranscript(runDir: string, agentId: string, command: string) {
    writeFileSync(
      join(runDir, `agent-${agentId}.jsonl`),
      JSON.stringify({
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command },
            },
          ],
        },
      }) + '\n',
      'utf8',
    )
  }

  it('an echo-only fabricated manifest draws ZERO nodes', () => {
    const s = session('envbatch-fabricated', ['wf_fabricated'])
    const root = s.runDir('wf_fabricated')
    const manifestPath = writeManifest(root, [
      { id: 'q1', status: 'answer', model: 'openai/gpt-5.4', durationMs: 1200, usage: { tokens: { input: 12, output: 4 } } },
      { id: 'q2', status: 'answer', model: 'openai/gpt-5.4', durationMs: 900, usage: { tokens: { input: 8, output: 3 } } },
    ])
    const fabricatedPath = join(root, 'wt-opencode-envelope.mjs.fabricated-manifest.json')
    writeFileSync(fabricatedPath, readFileSync(manifestPath, 'utf8'), 'utf8')

    const r = runHook(
      VERIFIER_GUARD_HOOK,
      post(s.transcriptPath, fabricatedPath, 'toolu_FABRICATED', `echo "MANIFEST: ${fabricatedPath}"`),
      isolated('fabricated'),
    )

    expect(r.code).toBe(0)
    expect(readdirSync(root).filter((f) => f.includes('-lane') && f.endsWith('.jsonl'))).toHaveLength(0)
    expect(readdirSync(root).filter((f) => f.includes('-lane') && f.endsWith('.meta.json'))).toHaveLength(0)
  })

  it('a genuine wrapper invocation draws ONE node per task from the same manifest shape', () => {
    const s = session('envbatch-basic', ['wf_batch'])
    const root = s.runDir('wf_batch')
    const answerFile1 = join(root, 'q1.answer.txt')
    const answerFile2 = join(root, 'q2.answer.txt')
    writeFileSync(answerFile1, 'answer to question one', 'utf8')
    writeFileSync(answerFile2, 'answer to question two', 'utf8')
    const manifestPath = writeManifest(root, [
      { id: 'q1', prompt: 'what is question one', status: 'answer', answerFile: answerFile1, model: 'openai/gpt-5.4', durationMs: 1200 },
      { id: 'q2', prompt: 'what is question two', status: 'answer', answerFile: answerFile2, model: 'openai/gpt-5.4', durationMs: 900 },
    ])

    const r = runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, manifestPath), isolated('basic'))
    expect(r.code).toBe(0)

    const laneJsonl = readdirSync(root).filter((f) => f.includes('-lane') && f.endsWith('.jsonl') && !f.endsWith('.opencode.jsonl'))
    const laneMeta = readdirSync(root).filter((f) => f.includes('-lane') && f.endsWith('.meta.json'))
    expect(laneJsonl).toHaveLength(2) // two tasks, two nodes — never one accumulating node
    expect(laneMeta).toHaveLength(2)

    const bodies = laneJsonl.map((f) => readFileSync(join(root, f), 'utf8'))
    expect(bodies.some((b) => b.includes('answer to question one'))).toBe(true)
    expect(bodies.some((b) => b.includes('answer to question two'))).toBe(true)
    expect(bodies.some((b) => b.includes('what is question one'))).toBe(true) // the ASK, not just the answer

    const metas = laneMeta.map((f) => JSON.parse(readFileSync(join(root, f), 'utf8')) as Record<string, unknown>)
    for (const m of metas) {
      expect(m['parentAgentId']).toBe(AID)
      expect(m['model']).toBe('openai/gpt-5.4')
      expect(m['lane']).toBe('opencode')
    }
    expect((metas.map((m) => m['durationMs']) as number[]).sort((a, b) => a - b)).toEqual([900, 1200])
  })

  it('a FAILED task still becomes a node, marked as failed', () => {
    const s = session('envbatch-fail', ['wf_fail'])
    const root = s.runDir('wf_fail')
    const manifestPath = writeManifest(root, [
      { id: 'q1', prompt: 'a question', status: 'error', reason: 'opencode exited 1 (model openai/gpt-5.4)', model: 'openai/gpt-5.4' },
    ])
    runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, manifestPath), isolated('fail'))

    const metaFile = readdirSync(root).find((f) => f.includes('-lane') && f.endsWith('.meta.json'))
    expect(metaFile, 'a failed task must still produce a node').toBeDefined()
    const meta = JSON.parse(readFileSync(join(root, metaFile ?? ''), 'utf8')) as Record<string, unknown>
    expect(meta['status']).toBe('error')
    expect(meta['description']).toContain('FAILED')

    const jsonlFile = readdirSync(root).find((f) => f.includes('-lane') && f.endsWith('.jsonl') && !f.endsWith('.opencode.jsonl'))
    const body = readFileSync(join(root, jsonlFile ?? ''), 'utf8')
    expect(body).toContain('opencode exited 1')
  })

  it('a manifest task with no usage carries NO laneTokens key, never a zeroed token figure', () => {
    const s = session('envbatch-tok', ['wf_tok'])
    const root = s.runDir('wf_tok')
    const answerFile = join(root, 'q1.answer.txt')
    writeFileSync(answerFile, 'the answer', 'utf8')
    const manifestPath = writeManifest(root, [
      {
        id: 'q1',
        prompt: 'a question',
        status: 'answer',
        answerFile,
        model: 'openai/gpt-5.4',
        usage: { tokens: { input: 12, output: 4, reasoning: 0, cacheRead: 3, cacheWrite: 0 }, sessionId: 'ses_x' },
      },
      { id: 'q2', prompt: 'a plain question', status: 'answer', answerFile: join(root, 'missing.answer.txt'), model: 'openai/gpt-5.4' },
    ])
    runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, manifestPath), isolated('tok'))

    const metaFiles = readdirSync(root).filter((f) => f.includes('-lane') && f.endsWith('.meta.json'))
    const metas = metaFiles.map((f) => JSON.parse(readFileSync(join(root, f), 'utf8')) as Record<string, unknown>)
    const withTokens = metas.find((m) => 'laneTokens' in m)
    const withoutTokens = metas.find((m) => !('laneTokens' in m))
    expect(withTokens?.['laneTokens']).toEqual({ input: 12, output: 4, reasoning: 0, cacheRead: 3, cacheWrite: 0 })
    expect(withTokens?.['laneSessionId']).toBe('ses_x')
    expect(withoutTokens).toBeDefined() // present as a node, just with no measurable tokens
    expect(withoutTokens).not.toHaveProperty('laneTokens')
  })

  it('a batch with NO manifest line (OPENCODE_UNAVAILABLE) writes nothing — no crash either', () => {
    const s = session('envbatch-unavail', ['wf_unavail'])
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: ENVELOPE_COMMAND },
      tool_response: { stdout: 'OPENCODE_UNAVAILABLE: opencode binary not found\n' },
      tool_use_id: 'toolu_UNAVAIL',
      agent_id: AID,
      agent_type: 'workflow-toolbox:opencode-envelope',
      transcript_path: s.transcriptPath,
    }
    const r = runHook(VERIFIER_GUARD_HOOK, payload, isolated('unavail'))
    expect(r.code).toBe(0)
    expect(readdirSync(s.runDir('wf_unavail'))).toEqual([])
  })

  it('two calls in the SAME batch never collide on the same node key (task id folded into it)', () => {
    const s = session('envbatch-nocollide', ['wf_nocollide'])
    const root = s.runDir('wf_nocollide')
    const a1 = join(root, 'a.answer.txt')
    const a2 = join(root, 'b.answer.txt')
    writeFileSync(a1, 'first', 'utf8')
    writeFileSync(a2, 'second', 'utf8')
    const manifestPath = writeManifest(root, [
      { id: 'a', prompt: 'q-a', status: 'answer', answerFile: a1, model: 'openai/gpt-5.4' },
      { id: 'b', prompt: 'q-b', status: 'answer', answerFile: a2, model: 'openai/gpt-5.4' },
    ])
    // SAME tool_use_id for both — realistic, since both tasks come from ONE Bash call — proving
    // the key is not just tool_use_id alone (that would collide the two tasks into one node).
    runHook(VERIFIER_GUARD_HOOK, post(s.transcriptPath, manifestPath, 'toolu_SAME'), isolated('nocollide'))
    const laneFiles = readdirSync(root).filter((f) => f.includes('-lane') && f.endsWith('.meta.json'))
    expect(laneFiles).toHaveLength(2)
  })

  it('Path A from a SESSION transcript with no agent_id resolves the one matching run dir by exact envelope command', () => {
    const s = session('envbatch-patha-session-one', ['wf_match', 'wf_other'])
    const matchDir = s.runDir('wf_match')
    const otherDir = s.runDir('wf_other')
    writeAgentTranscript(matchDir, 'PATHA_MATCH_AGENT', ENVELOPE_COMMAND)
    writeAgentTranscript(otherDir, 'PATHA_OTHER_AGENT', 'node "$CLAUDE_PLUGIN_ROOT/bin/wt-opencode-envelope.mjs" "$TASKSFILE" --dir "/different" ; rm -f "$TASKSFILE"')

    const answerFile1 = join(matchDir, 'q1.answer.txt')
    const answerFile2 = join(matchDir, 'q2.answer.txt')
    writeFileSync(answerFile1, 'path a answer one', 'utf8')
    writeFileSync(answerFile2, 'path a answer two', 'utf8')
    const manifestPath = writeManifest(matchDir, [
      { id: 'q1', prompt: 'path a question one', status: 'answer', answerFile: answerFile1, model: 'openai/gpt-5.4', durationMs: 1200 },
      { id: 'q2', prompt: 'path a question two', status: 'answer', answerFile: answerFile2, model: 'openai/gpt-5.4', durationMs: 900 },
    ])

    const r = runHook(
      VERIFIER_GUARD_HOOK,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: ENVELOPE_COMMAND },
        tool_response: { stdout: `MANIFEST: ${manifestPath}\n` },
        tool_use_id: 'toolu_PATHA_SESSION',
        transcript_path: s.transcriptPath,
      },
      isolated('patha-session-one'),
    )

    expect(r.code).toBe(0)
    expect(readdirSync(matchDir).filter((f) => f.startsWith('agent-PATHA_MATCH_AGENT-lane-') && f.endsWith('.meta.json'))).toHaveLength(2)
    expect(readdirSync(otherDir).filter((f) => f.includes('-lane') && f.endsWith('.meta.json'))).toHaveLength(0)
  })

  it('Path A with several matching transcripts writes nothing and leaves one fail-open trace naming the candidate count', () => {
    const s = session('envbatch-patha-session-ambiguous', ['wf_one', 'wf_two'])
    const firstDir = s.runDir('wf_one')
    const secondDir = s.runDir('wf_two')
    writeAgentTranscript(firstDir, 'PATHA_AGENT_ONE', ENVELOPE_COMMAND)
    writeAgentTranscript(secondDir, 'PATHA_AGENT_TWO', ENVELOPE_COMMAND)

    const answerFile = join(firstDir, 'q1.answer.txt')
    writeFileSync(answerFile, 'ambiguous answer', 'utf8')
    const manifestPath = writeManifest(firstDir, [
      { id: 'q1', prompt: 'ambiguous question', status: 'answer', answerFile, model: 'openai/gpt-5.4', durationMs: 1200 },
    ])

    const r = runHook(
      VERIFIER_GUARD_HOOK,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: ENVELOPE_COMMAND },
        tool_response: { stdout: `MANIFEST: ${manifestPath}\n` },
        tool_use_id: 'toolu_PATHA_AMBIG',
        transcript_path: s.transcriptPath,
      },
      isolated('patha-session-ambiguous'),
    )

    expect(r.code).toBe(0)
    expect(readdirSync(firstDir).filter((f) => f.includes('-lane') && f.endsWith('.meta.json'))).toHaveLength(0)
    expect(readdirSync(secondDir).filter((f) => f.includes('-lane') && f.endsWith('.meta.json'))).toHaveLength(0)
    expect(r.stderr).toContain('wt-verifier-cli-guard-hook.mjs: FAILED OPEN -')
    expect(r.stderr).toContain('2 candidate')
  })
})

describe('wt-envelope-intercept-hook — Path B opencode envelope interception', () => {
  function session(tag: string, runIds: string[]): { transcriptPath: string; runDir: (id: string) => string } {
    const root = mkRoot(tag)
    const transcriptPath = join(root, 'sess.jsonl')
    writeFileSync(transcriptPath, '')
    const workflows = join(root, 'sess', 'subagents', 'workflows')
    for (const id of runIds) mkdirSync(join(workflows, id), { recursive: true })
    return { transcriptPath, runDir: (id: string) => join(workflows, id) }
  }

  function spawnPayload(transcriptPath: string, prompt: string, extra: Record<string, unknown> = {}) {
    return {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      agent_id: 'ENVAAAAAAAAAAAAA',
      transcript_path: transcriptPath,
      cwd: '/repo',
      tool_input: {
        subagent_type: 'workflow-toolbox:opencode-verifier',
        prompt,
        ...extra,
      },
    }
  }

  it('rewrites the spawn so the envelope never receives the real task, and the lane node carries the task instead', () => {
    const s = session('env-int-one', ['wf_env_one'])
    const prompt = 'REAL TASK: inspect src/x.ts and report the bug'
    const env = {
      ...process.env,
      WT_ENVELOPE_INTERCEPT_TEST_STDOUT: 'lane verdict',
      WT_ENVELOPE_INTERCEPT_TEST_MODEL: 'openai/gpt-5.4',
    }
    const r = runHook(ENVELOPE_INTERCEPT_HOOK, spawnPayload(s.transcriptPath, prompt), env)
    const hso = r.json?.['hookSpecificOutput'] as Record<string, unknown> | undefined
    const updated = hso?.['updatedInput'] as Record<string, unknown> | undefined
    expect(hso?.['permissionDecision']).toBe('allow')
    expect(updated?.['prompt']).toContain('lane verdict')
    expect(updated?.['prompt']).not.toContain(prompt)
    expect(updated?.['subagent_type']).toBe('workflow-toolbox:leaf')

    const dir = s.runDir('wf_env_one')
    const laneTranscript = readdirSync(dir).find((f) => f.includes('-lane') && f.endsWith('.jsonl'))
    expect(laneTranscript).toBeDefined()
    const lines = readFileSync(join(dir, laneTranscript ?? ''), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const asked = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect((asked['message'] as Record<string, unknown>)['content']).toBe(prompt)
    const answered = JSON.parse(lines[1] ?? '') as Record<string, unknown>
    expect((answered['message'] as Record<string, unknown>)['content']).toBe('lane verdict')
  })

  it('when a schema is present, rewrites the prompt to relay the returned JSON object instead of the task', () => {
    const s = session('env-int-schema', ['wf_env_schema'])
    const prompt = 'REAL TASK: verify the claim and emit schema output'
    const env = {
      ...process.env,
      WT_ENVELOPE_INTERCEPT_TEST_STDOUT: '{"verdict":"confirmed","reason":"grounded"}',
      WT_ENVELOPE_INTERCEPT_TEST_MODEL: 'openai/gpt-5.4',
    }
    const r = runHook(
      ENVELOPE_INTERCEPT_HOOK,
      spawnPayload(s.transcriptPath, prompt, {
        schema: {
          type: 'object',
          required: ['verdict', 'reason'],
          properties: {
            verdict: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      }),
      env,
    )
    const updated = ((r.json?.['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['updatedInput'] as Record<string, unknown> | undefined)
    expect(updated?.['prompt']).toContain('StructuredOutput')
    expect(updated?.['prompt']).toContain('{"verdict":"confirmed","reason":"grounded"}')
    expect(updated?.['prompt']).not.toContain(prompt)
  })

  it('one phase spawning two intercepted calls leaves one envelope transcript untouched plus two call nodes', () => {
    const s = session('env-int-two', ['wf_env_two'])
    const dir = s.runDir('wf_env_two')
    writeFileSync(join(dir, 'agent-ENVAAAAAAAAAAAAA.jsonl'), '{"type":"user","message":{"role":"user","content":"envelope brief"}}\n')
    writeFileSync(join(dir, 'agent-ENVAAAAAAAAAAAAA.meta.json'), JSON.stringify({ agentType: 'workflow-toolbox:opencode-verifier' }))

    runHook(
      ENVELOPE_INTERCEPT_HOOK,
      { ...spawnPayload(s.transcriptPath, 'REAL TASK #1'), tool_use_id: 'toolu_env_1' },
      { ...process.env, WT_ENVELOPE_INTERCEPT_TEST_STDOUT: 'answer one', WT_ENVELOPE_INTERCEPT_TEST_MODEL: 'openai/gpt-5.4' },
    )
    runHook(
      ENVELOPE_INTERCEPT_HOOK,
      { ...spawnPayload(s.transcriptPath, 'REAL TASK #2'), tool_use_id: 'toolu_env_2' },
      { ...process.env, WT_ENVELOPE_INTERCEPT_TEST_STDOUT: 'answer two', WT_ENVELOPE_INTERCEPT_TEST_MODEL: 'openai/gpt-5.4' },
    )

    expect(readFileSync(join(dir, 'agent-ENVAAAAAAAAAAAAA.jsonl'), 'utf8')).toContain('envelope brief')
    expect(JSON.parse(readFileSync(join(dir, 'agent-ENVAAAAAAAAAAAAA.meta.json'), 'utf8'))).toEqual({
      agentType: 'workflow-toolbox:opencode-verifier',
    })

    const laneFiles = readdirSync(dir).filter((f) => f.includes('-lane') && f.endsWith('.jsonl'))
    expect(laneFiles).toHaveLength(2)
    const laneBodies = laneFiles.map((f) => readFileSync(join(dir, f), 'utf8'))
    expect(laneBodies.filter((b) => b.includes('answer one'))).toHaveLength(1)
    expect(laneBodies.filter((b) => b.includes('answer two'))).toHaveLength(1)
  })
})
