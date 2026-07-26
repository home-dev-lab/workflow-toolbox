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
import { DELEGATION_EXPECTATIONS } from '@workflow-toolbox/debugger/external-delegation'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LADDER_HOOK = join(REPO_ROOT, 'plugin/bin/wt-delegation-ladder-hook.mjs')
const GUARD_HOOK = join(REPO_ROOT, 'plugin/bin/wt-pilot-guard-hook.mjs')
const VERIFIER_GUARD_HOOK = join(REPO_ROOT, 'plugin/bin/wt-verifier-cli-guard-hook.mjs')
const DEBUGGER_DELEGATION_SRC = join(REPO_ROOT, 'toolkit/packages/debugger/src/external-delegation.ts')
const AGENTS_DIR = join(REPO_ROOT, 'plugin/agents')

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

  it('the suggestion offers the FULL rule set (--set rules), not just the ladder', () => {
    const f = fixture('fullset')
    const r = runHook(LADDER_HOOK, start(f.proj), f.env)
    const ctx = (r.json?.['hookSpecificOutput'] as Record<string, string>)?.['additionalContext'] ?? ''
    expect(ctx).toContain('--set rules')
    expect(ctx.toLowerCase()).toContain('rule set')
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
    'BIN="/home/x/.opencode/bin/opencode"\nTASKFILE="$PWD/.oc-verify-$$.md"\n' +
    "trap 'rm -f \"$TASKFILE\"' EXIT\ntimeout 570 \"$BIN\" run \"Adversarially verify the claim\" " +
    '-f "$TASKFILE" --model openai/gpt-5.6-sol < /dev/null'
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
