// outbound-guard-hooks.test.ts — behavior gates for the two hooks + the scan script moved into
// the plugin tonight (previously project-local at wt-suite/.claude/{hooks,scripts}/):
//   - plugin/bin/wt-outbound-guard-hook.mjs        (PostToolUse + SubagentStop)
//   - plugin/bin/wt-session-start-registry-hook.mjs (SessionStart)
//   - plugin/bin/wt-spawn-registry-scan.mjs         (read-only scan, invoked by the hook above
//     and runnable standalone)
//
// Like plugin-hooks.test.ts, each case drives the REAL script as a child process with a crafted
// stdin payload / fixture file and asserts stdout, stderr, and exit code — the "closest to real"
// option, where a wiring regression (a hook that silently stops firing after a move) hides.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GUARD_HOOK = join(REPO_ROOT, 'plugin/bin/wt-outbound-guard-hook.mjs')
const SCAN = join(REPO_ROOT, 'plugin/bin/wt-spawn-registry-scan.mjs')
const SESSION_START_HOOK = join(REPO_ROOT, 'plugin/bin/wt-session-start-registry-hook.mjs')
const HEARTBEAT_HOOK = join(REPO_ROOT, 'plugin/bin/wt-registry-heartbeat-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function mkRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `wt-outbound-guard-${tag}-`))
  roots.push(r)
  return r
}
/** A fresh, isolated WT_OUTBOUND_GUARD_DIR per test — never shares state across tests. */
function guardEnv(tag: string): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkRoot(tag)
  return { env: { ...process.env, WT_OUTBOUND_GUARD_DIR: dir }, dir }
}

interface Run {
  stdout: string
  stderr: string
  code: number | null
}
function run(script: string, payload: unknown, env: NodeJS.ProcessEnv): Run {
  const res = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8', env })
  return { stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim(), code: res.status }
}
function runNoInput(script: string, args: string[], env: NodeJS.ProcessEnv): Run {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env })
  return { stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim(), code: res.status }
}

const stopPayload = (agentId: string | undefined, sessionId: string, agentType = 'some-agent') => ({
  hook_event_name: 'SubagentStop',
  ...(agentId !== undefined ? { agent_id: agentId } : {}),
  agent_type: agentType,
  session_id: sessionId,
})
const outboundPayload = (agentId: string, sessionId: string, tool: 'SendMessage' | 'Write', agentType = 'some-agent') => ({
  hook_event_name: 'PostToolUse',
  tool_name: tool,
  agent_id: agentId,
  agent_type: agentType,
  session_id: sessionId,
})
const spawnPayload = (
  sessionId: string,
  opts: { parentAgentId?: string; childId: string; name: string; subagentType?: string }
) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Agent',
  ...(opts.parentAgentId !== undefined ? { agent_id: opts.parentAgentId } : {}),
  session_id: sessionId,
  tool_input: { name: opts.name, subagent_type: opts.subagentType, description: 'a purpose' },
  tool_response: { agent_id: opts.childId },
})

// --------------------------------------------------------------------------
// wt-outbound-guard-hook.mjs — item 1 (spawn edges) + item 2 (nudge on silence)
// --------------------------------------------------------------------------
describe('wt-outbound-guard-hook — spawn edges, delivery detection, one nudge per arc', () => {
  // POSITIVE CONTROL FIRST: prove a silent subagent DOES produce a nudge before trusting any
  // "silence" result elsewhere in this suite (a broken invocation and a genuine non-match both
  // look like "no output" otherwise).
  it('POSITIVE CONTROL: nudges a subagent that delivered NOTHING before its SubagentStop', () => {
    const { env } = guardEnv('nudge-control')
    const r = run(GUARD_HOOK, stopPayload('agent-silent-1', 'sess-1'), env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('OUTBOUND CHECK')
    expect(r.stderr).toContain('nothing you produced has left your transcript')
  })

  it('stays SILENT for a subagent that sent a SendMessage before its SubagentStop', () => {
    const { env } = guardEnv('delivered-sendmessage')
    const out = run(GUARD_HOOK, outboundPayload('agent-2', 'sess-2', 'SendMessage'), env)
    expect(out.stdout).toBe('')
    expect(out.code).toBe(0)
    const stop = run(GUARD_HOOK, stopPayload('agent-2', 'sess-2'), env)
    expect(stop.stderr).toBe('')
    expect(stop.code).toBe(0)
  })

  // Writing a working file is not reporting, and the file-report contract requires BOTH halves:
  // the file written AND the one line saying it exists. An agent that wrote and went silent has
  // broken that contract, not half-satisfied it — so a Write must NOT buy silence from the guard.
  it('still NUDGES a subagent that only wrote a file and never sent a message', () => {
    const { env } = guardEnv('wrote-but-never-sent')
    run(GUARD_HOOK, outboundPayload('agent-3', 'sess-3', 'Write'), env)
    const stop = run(GUARD_HOOK, stopPayload('agent-3', 'sess-3'), env)
    expect(stop.stderr).toContain('OUTBOUND CHECK')
    expect(stop.code).toBe(2)
  })

  it('NEVER nudges the main loop (no agent_id) even on its own Stop', () => {
    const { env } = guardEnv('main-loop')
    const r = run(GUARD_HOOK, { hook_event_name: 'Stop', session_id: 'sess-4' }, env)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
  })

  it('records a spawn edge when the MAIN LOOP launches an agent (Agent tool, no agent_id)', () => {
    const { env, dir } = guardEnv('spawn-from-main')
    const r = run(GUARD_HOOK, spawnPayload('sess-5', { childId: 'achild-abc123def456', name: 'my-worker' }), env)
    expect(r.code).toBe(0)
    const file = join(dir, 'sess-5.jsonl')
    expect(existsSync(file)).toBe(true)
    const records = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const spawn = records.find((rec) => rec.t === 'spawn')
    expect(spawn, `no spawn record in ${JSON.stringify(records)}`).toBeTruthy()
    expect(spawn!.parentName).toBe('(main-loop)')
    expect(spawn!.name).toBe('my-worker')
  })

  it('records a spawn edge when a SUB-AGENT launches another agent (Task tool, agent_id present)', () => {
    const { env, dir } = guardEnv('spawn-from-subagent')
    const r = run(
      GUARD_HOOK,
      { ...spawnPayload('sess-6', { childId: 'achild-2', name: 'nested-worker' }), tool_name: 'Task', agent_id: 'aparent-9f8e7d6c5b4a' },
      env
    )
    expect(r.code).toBe(0)
    const records = readFileSync(join(dir, 'sess-6.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const spawn = records.find((rec) => rec.t === 'spawn')
    expect(spawn!.parentName).toBe('parent') // normalizeName("aparent-9f8e7d6c5b4a") -> "parent"
    expect(spawn!.name).toBe('nested-worker')
  })

  // FAILS BEFORE THE FIX: an unnamed spawn's tool_response carries the raw agent id (e.g.
  // "a2600ff39954b6472"), and normalizeName() strips its leading "a" into something that LOOKS
  // like a valid handle ("2600ff39954b6472"). But the agent later reports under its agent_type
  // ("general-purpose") on its 'out'/'stop' records, which never matches that fabricated id-based
  // name — so the spawn can never be marked accounted for. It must be marked untrackable instead,
  // exactly like a spawn with no child id at all.
  it('an UNNAMED spawn is marked untrackable, never given a fabricated id-derived name', () => {
    const { env, dir } = guardEnv('spawn-unnamed')
    const r = run(
      GUARD_HOOK,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        session_id: 'sess-unnamed',
        tool_input: { subagent_type: 'general-purpose', description: 'a purpose' }, // no `name`
        tool_response: { agent_id: 'a2600ff39954b6472' },
      },
      env
    )
    expect(r.code).toBe(0)
    const records = readFileSync(join(dir, 'sess-unnamed.jsonl'), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const spawn = records.find((rec) => rec.t === 'spawn')
    expect(spawn!.name).toBeNull()
    expect(spawn!.childName).toBeNull() // never fabricated from the raw child id
    expect(spawn!.untrackable).toBe(true)
  })

  it('nudges only ONCE per arc: a second SubagentStop for the same still-silent agent stays quiet', () => {
    const { env } = guardEnv('once-per-arc')
    const first = run(GUARD_HOOK, stopPayload('agent-7', 'sess-7'), env)
    expect(first.code).toBe(2)
    const second = run(GUARD_HOOK, stopPayload('agent-7', 'sess-7'), env)
    expect(second.stderr).toBe('')
    expect(second.code).toBe(0)
  })

  it('never throws: malformed stdin exits 0 silently', () => {
    const { env } = guardEnv('malformed')
    const res = spawnSync(process.execPath, [GUARD_HOOK], { input: 'not json', encoding: 'utf8', env })
    expect((res.stdout ?? '').trim()).toBe('')
    expect(res.status).toBe(0)
  })
})

// --------------------------------------------------------------------------
// Duplicate hook registration — nothing stops an adopter registering this hook at BOTH plugin
// and project level, which fires every event TWICE. The log stays append-only (never skip a
// write); these cases prove the READ-side collapse makes the doubled stream behave exactly like
// the single-fire stream.
// --------------------------------------------------------------------------
describe('wt-outbound-guard-hook — tolerates a duplicate-registered hook firing every event twice', () => {
  it('DUPLICATE STREAM: doubled SendMessage + doubled stop stays silent, same as single-fire delivery', () => {
    const { env } = guardEnv('dup-delivered')
    run(GUARD_HOOK, outboundPayload('agent-dup1', 'sess-dup1', 'SendMessage'), env)
    run(GUARD_HOOK, outboundPayload('agent-dup1', 'sess-dup1', 'SendMessage'), env) // duplicate fire
    const stop1 = run(GUARD_HOOK, stopPayload('agent-dup1', 'sess-dup1'), env)
    const stop2 = run(GUARD_HOOK, stopPayload('agent-dup1', 'sess-dup1'), env) // duplicate fire
    expect(stop1.code).toBe(0)
    expect(stop1.stderr).toBe('')
    expect(stop2.code).toBe(0)
    expect(stop2.stderr).toBe('')
  })

  it('DUPLICATE STREAM: doubled stop with NO delivery nudges exactly once, not twice', () => {
    const { env } = guardEnv('dup-silent')
    const first = run(GUARD_HOOK, stopPayload('agent-dup2', 'sess-dup2'), env)
    const dup = run(GUARD_HOOK, stopPayload('agent-dup2', 'sess-dup2'), env) // duplicate fire, same real stop
    expect(first.code).toBe(2)
    expect(first.stderr).toContain('OUTBOUND CHECK')
    expect(dup.code).toBe(0) // the duplicate of that SAME stop must not nudge again
    expect(dup.stderr).toBe('')
  })

  // FAILS BEFORE THE FIX, PASSES AFTER: a duplicate 'stop' record left over from an EARLIER arc
  // shifts `stopIdx` (see the guard's own header comment) so a later, genuinely-silent retry gets
  // nudged a SECOND time. Reproduced by seeding arc 0 directly (stop, nudged, duplicate-stop, all
  // timestamped far in the past) so the live retry below is unambiguously a new, separate event —
  // no reliance on real-time sleeps.
  it('FAILS BEFORE THE FIX: a stale duplicate stop from an earlier arc must not cause a second nudge on a later silent retry', () => {
    const { env, dir } = guardEnv('dup-cross-arc')
    const file = join(dir, 'sess-dup3.jsonl')
    const t0 = Date.now() - 10 * 60_000 // 10 minutes ago
    writeFileSync(
      file,
      [
        JSON.stringify({ t: 'stop', agentId: 'agent-dup3', name: 'agent-dup3', event: 'SubagentStop', at: new Date(t0).toISOString() }),
        JSON.stringify({ t: 'nudged', agentId: 'agent-dup3', name: 'agent-dup3', event: 'SubagentStop', at: new Date(t0 + 1).toISOString() }),
        // the duplicate stop, recorded by the SAME real event via the second hook registration
        JSON.stringify({ t: 'stop', agentId: 'agent-dup3', name: 'agent-dup3', event: 'SubagentStop', at: new Date(t0 + 2).toISOString() }),
      ].join('\n') + '\n'
    )

    // The real retry after the nudge, still delivering nothing. Doubled too, as a duplicate
    // registration would double-fire this stop as well.
    const retry = run(GUARD_HOOK, stopPayload('agent-dup3', 'sess-dup3'), env)
    const retryDup = run(GUARD_HOOK, stopPayload('agent-dup3', 'sess-dup3'), env)
    expect(retry.code, `expected no second nudge; stderr: ${retry.stderr}`).toBe(0)
    expect(retry.stderr).toBe('')
    expect(retryDup.code).toBe(0)
    expect(retryDup.stderr).toBe('')
  })
})

// --------------------------------------------------------------------------
// wt-spawn-registry-scan.mjs — read-only reader of the registry the hook above writes
// --------------------------------------------------------------------------
describe('wt-spawn-registry-scan.mjs — reports what is unaccounted for', () => {
  it('exits 2 when no registry directory exists', () => {
    const dir = join(mkRoot('scan-none'), 'nonexistent')
    const r = runNoInput(SCAN, [], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('No registry')
  })

  it('exits 0 when every spawned agent has a recorded stop', () => {
    const dir = mkRoot('scan-clean')
    const now = new Date().toISOString()
    writeFileSync(
      join(dir, 'sess.jsonl'),
      [
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'done-worker', name: 'done-worker', at: now }),
        JSON.stringify({ t: 'stop', name: 'done-worker', at: now }),
      ].join('\n') + '\n'
    )
    const r = runNoInput(SCAN, [], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Nothing open.') // 0 open agents (all stopped) => this branch, not "Nothing to ask about"
  })

  // FAILS BEFORE THE FIX — reproduces the exact real production sequence (registry excerpt from
  // 2026-07-26): an UNNAMED spawn, whose child later reports and stops under its agent_type
  // ("general-purpose"), never sharing a name with the spawn record. This must be reported as
  // untrackable, never as an open-and-silent ghost — even though it actually finished 9+ hours
  // ago. Also proves backward compatibility: this record is written in the OLD (buggy) format,
  // exactly as it sits in an already-written registry file — `childName` is the fabricated
  // id-derived value, `name` is null. The scan must recognize it as untrackable from `name`
  // alone, not crash, and not fabricate an entry.
  it('an old-format UNNAMED spawn that actually finished is reported as untrackable, never as an open ghost', () => {
    const dir = mkRoot('scan-unnamed-finished')
    writeFileSync(
      join(dir, 'sess.jsonl'),
      [
        JSON.stringify({
          t: 'spawn', parent: '(main-loop)', parentName: '(main-loop)',
          child: 'a2600ff39954b6472', childName: '2600ff39954b6472', name: null,
          subagentType: 'general-purpose', model: 'haiku', purpose: "Record tonight's delivery on the board",
          at: '2026-07-26T22:31:52.233Z',
        }),
        JSON.stringify({ t: 'out', agentId: 'a2600ff39954b6472', name: 'general-purpose', tool: 'SendMessage', at: '2026-07-26T22:32:55.347Z' }),
        JSON.stringify({ t: 'stop', agentId: 'a2600ff39954b6472', name: 'general-purpose', event: 'SubagentStop', at: '2026-07-26T22:32:57.904Z' }),
      ].join('\n') + '\n'
    )
    const r = runNoInput(SCAN, ['--quiet-min', '20', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code, `expected no ghost; stdout: ${r.stdout}`).toBe(0)
    const parsed = JSON.parse(r.stdout) as { open: number; flagged: unknown[]; untrackable: number }
    expect(parsed.open).toBe(0)
    expect(parsed.flagged).toHaveLength(0)
    expect(parsed.untrackable).toBe(1)
  })

  it('exits 1 and names an agent that is OPEN and silent past the threshold', () => {
    const dir = mkRoot('scan-flagged')
    const longAgo = new Date(Date.now() - 45 * 60_000).toISOString() // 45 min ago
    writeFileSync(
      join(dir, 'sess.jsonl'),
      JSON.stringify({
        t: 'spawn', parentName: '(main-loop)', childName: 'stuck-worker', name: 'stuck-worker',
        purpose: 'investigate the thing', at: longAgo,
      }) + '\n'
    )
    const r = runNoInput(SCAN, ['--quiet-min', '20'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('stuck-worker')
    expect(r.stdout).toContain('worth asking about')
  })

  it('does not double-list the same agent when a duplicate-registered hook double-fires the spawn record', () => {
    const dir = mkRoot('scan-dup-spawn')
    const now = new Date().toISOString()
    writeFileSync(
      join(dir, 'sess.jsonl'),
      [
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'dup-worker', name: 'dup-worker', at: now }),
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'dup-worker', name: 'dup-worker', at: now }), // duplicate fire
      ].join('\n') + '\n'
    )
    const r = runNoInput(SCAN, ['--quiet-min', '0', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    const parsed = JSON.parse(r.stdout) as { open: number; flagged: Array<{ name: string }> }
    expect(parsed.open).toBe(1) // not 2 -- one duplicated spawn edge, one real open agent
    expect(parsed.flagged.filter((f) => f.name === 'dup-worker')).toHaveLength(1)
  })
})

// --------------------------------------------------------------------------
// wt-spawn-registry-scan.mjs --ack — a human verdict scoped to ONE spawn, never a name forever.
// Each fixture below is built with explicit, ORDERED, past timestamps (spawn, then ack, then
// re-spawn) rather than by calling `--ack` mid-fixture: an ack written "now" is newer than any
// past-dated spawn, so building the fixture that way silently tests the opposite of what it looks
// like. `acked.at > spawn.at` is the whole scoping rule, so timestamps must be clearly separated.
// --------------------------------------------------------------------------
describe('wt-spawn-registry-scan.mjs --ack — records a verdict scoped to one spawn, not a name', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

  it('BASELINE: an open, silent entry with no ack is reported (exit 1) -- without this, nothing else proves anything', () => {
    const dir = mkRoot('ack-baseline')
    writeFileSync(
      join(dir, 'sess.jsonl'),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'baseline-worker', name: 'baseline-worker', at: minutesAgo(45) }) + '\n'
    )
    const r = runNoInput(SCAN, ['--quiet-min', '20'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('baseline-worker')
  })

  it('after an ack (ack.at after spawn.at), the same entry is NOT reported (exit 0)', () => {
    const dir = mkRoot('ack-suppress')
    writeFileSync(
      join(dir, 'sess.jsonl'),
      [
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'acked-worker', name: 'acked-worker', at: minutesAgo(45) }),
        JSON.stringify({ t: 'ack', name: 'acked-worker', at: minutesAgo(40) }),
      ].join('\n') + '\n'
    )
    const r = runNoInput(SCAN, ['--quiet-min', '20', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout) as { open: number; flagged: unknown[] }
    expect(parsed.open).toBe(0)
    expect(parsed.flagged).toHaveLength(0)
  })

  // FAILS BEFORE THE FIX: a first-wins dedup-by-name would drop this later spawn record entirely,
  // so an acked name would stay suppressed FOREVER -- a real agent relaunched under a reused name
  // would never be reported again. This is the exact bug the first implementation had.
  it('a LATER spawn of the same name IS reported again after an earlier ack settles the first one', () => {
    const dir = mkRoot('ack-relaunch')
    writeFileSync(
      join(dir, 'sess.jsonl'),
      [
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'relaunched-worker', name: 'relaunched-worker', at: minutesAgo(45) }),
        JSON.stringify({ t: 'ack', name: 'relaunched-worker', at: minutesAgo(40) }),
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'relaunched-worker', name: 'relaunched-worker', at: minutesAgo(30) }),
      ].join('\n') + '\n'
    )
    const r = runNoInput(SCAN, ['--quiet-min', '20', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code, `expected the relaunch to be reported; stdout: ${r.stdout}`).toBe(1)
    const parsed = JSON.parse(r.stdout) as { open: number; flagged: Array<{ name: string }> }
    expect(parsed.open).toBe(1)
    expect(parsed.flagged.filter((f) => f.name === 'relaunched-worker')).toHaveLength(1)
  })

  // Behaviour 3 (above) and behaviour 4 (the plain duplicate-registration test earlier in this
  // file) pull in OPPOSITE directions on the same dedupeSpawnsByChild logic: one must treat a
  // later same-name spawn as a NEW fact, the other must treat a near-simultaneous same-name spawn
  // as the SAME fact twice. This fixture combines them -- the post-ack relaunch, duplicate-fired a
  // few ms apart (well inside SPAWN_DEDUP_WINDOW_MS), as a hook registered at both plugin and
  // project level would produce -- to prove fixing one did not re-break the other.
  it('a duplicate-fired relaunch (post-ack) is still counted ONCE, not twice', () => {
    const dir = mkRoot('ack-relaunch-dup')
    const respawnAt = new Date(Date.now() - 30 * 60_000)
    writeFileSync(
      join(dir, 'sess.jsonl'),
      [
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'dup-relaunch-worker', name: 'dup-relaunch-worker', at: minutesAgo(45) }),
        JSON.stringify({ t: 'ack', name: 'dup-relaunch-worker', at: minutesAgo(40) }),
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'dup-relaunch-worker', name: 'dup-relaunch-worker', at: respawnAt.toISOString() }),
        JSON.stringify({
          t: 'spawn', parentName: '(main-loop)', childName: 'dup-relaunch-worker', name: 'dup-relaunch-worker',
          at: new Date(respawnAt.getTime() + 5).toISOString(), // duplicate fire, same real spawn
        }),
      ].join('\n') + '\n'
    )
    const r = runNoInput(SCAN, ['--quiet-min', '20', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(1)
    const parsed = JSON.parse(r.stdout) as { open: number; flagged: Array<{ name: string }> }
    expect(parsed.open).toBe(1) // not 2 -- the duplicate fire must not double-count the relaunch
    expect(parsed.flagged.filter((f) => f.name === 'dup-relaunch-worker')).toHaveLength(1)
  })

  it('the --ack CLI mode appends a verdict record without touching prior lines', () => {
    const dir = mkRoot('ack-cli')
    const file = join(dir, 'sess.jsonl')
    writeFileSync(
      file,
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'cli-worker', name: 'cli-worker', at: minutesAgo(45) }) + '\n'
    )
    const r = runNoInput(
      SCAN,
      ['--session', 'sess', '--ack', 'cli-worker', '--reason', 'checked, still running'],
      { ...process.env, WT_OUTBOUND_GUARD_DIR: dir }
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Acknowledged: cli-worker')
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.t).toBe('spawn') // original line untouched
    expect(lines[1]).toMatchObject({ t: 'ack', name: 'cli-worker', reason: 'checked, still running' })
  })
})

// --------------------------------------------------------------------------
// wt-session-start-registry-hook.mjs — SessionStart: answers the question instead of
// reminding someone to arm a scan. Its SCAN path must resolve to its SIBLING in plugin/bin/
// (the fix this move required: the script previously walked to a `../scripts/` dir that no
// longer exists in the shipped layout).
// --------------------------------------------------------------------------
describe('wt-session-start-registry-hook.mjs — runs the scan at session start', () => {
  it('resolves its sibling scan script correctly after the move (no open agents => coverage line only)', () => {
    const dir = mkRoot('sess-start-clean')
    const r = run(SESSION_START_HOOK, { hook_event_name: 'SessionStart', source: 'startup' }, { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Agent-liveness coverage')
    expect(r.stdout).not.toContain('UNFINISHED AGENT ARCS')
    // The advice command must point at the REAL resolved path of the sibling script, not a
    // stale project-relative guess (`.claude/scripts/spawn-registry-scan.mjs`).
    expect(r.stdout).toContain(SCAN)
  })

  it('POSITIVE CONTROL: surfaces UNFINISHED AGENT ARCS when the registry has an open+silent entry', () => {
    const dir = mkRoot('sess-start-open')
    const longAgo = new Date(Date.now() - 45 * 60_000).toISOString()
    writeFileSync(
      join(dir, 'sess.jsonl'),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'frozen-worker', name: 'frozen-worker', at: longAgo }) + '\n'
    )
    const r = run(SESSION_START_HOOK, { hook_event_name: 'SessionStart', source: 'startup' }, { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('UNFINISHED AGENT ARCS')
    expect(r.stdout).toContain('frozen-worker')
    expect(r.stdout).toContain('Agent-liveness coverage') // both blocks present, not just one
  })

  it('never fails a session start: malformed stdin exits 0 silently', () => {
    const res = spawnSync(process.execPath, [SESSION_START_HOOK], { input: 'not json', encoding: 'utf8', env: process.env })
    expect(res.status).toBe(0)
  })
})

// --------------------------------------------------------------------------
// wt-registry-heartbeat-hook.mjs — Stop: the periodic invocation the card asked for, without
// anyone arming a loop. Fires on every attempted Stop of the session; a hit BLOCKS so the finding
// reaches something that can act (the session itself), never a log file.
// --------------------------------------------------------------------------
describe('wt-registry-heartbeat-hook.mjs — mid-session silence surfaces on Stop, never on a log file', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  const stopEventPayload = (sessionId: string, stopHookActive = false) => ({
    hook_event_name: 'Stop',
    session_id: sessionId,
    stop_hook_active: stopHookActive,
  })

  it('GREEN: nothing open => stays silent, never blocks', () => {
    const { env } = guardEnv('heartbeat-clean')
    const r = run(HEARTBEAT_HOOK, stopEventPayload('sess-hb-clean'), env)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('{}')
  })

  it('GREEN: an open agent that spoke recently (under threshold) stays silent', () => {
    const { env, dir } = guardEnv('heartbeat-recent')
    writeFileSync(
      join(dir, 'sess-hb-recent.jsonl'),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'busy-worker', name: 'busy-worker', at: minutesAgo(2) }) + '\n'
    )
    const r = run(HEARTBEAT_HOOK, stopEventPayload('sess-hb-recent'), env)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('{}')
  })

  // POSITIVE CONTROL: an agent open and silent past the threshold DOES block the stop, and the
  // reason names it — this is the discriminating case the whole card exists for.
  it('RED->GREEN discriminator: an open+silent agent BLOCKS the stop and names it in the reason', () => {
    const { env, dir } = guardEnv('heartbeat-flagged')
    writeFileSync(
      join(dir, 'sess-hb-flagged.jsonl'),
      JSON.stringify({
        t: 'spawn', parentName: '(main-loop)', childName: 'frozen-worker', name: 'frozen-worker',
        purpose: 'investigate the incident', at: minutesAgo(45),
      }) + '\n'
    )
    const r = run(HEARTBEAT_HOOK, stopEventPayload('sess-hb-flagged'), env)
    expect(r.code).toBe(0) // the block is carried in the JSON decision, not the exit code
    const out = JSON.parse(r.stdout) as { decision?: string; reason?: string }
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('frozen-worker')
    expect(out.reason).toContain('SendMessage')
    expect(out.reason).toContain('--ack')
  })

  // LOOP SAFETY: the harness re-enters this same hook with stop_hook_active:true when the FIRST
  // block is being reprocessed. That re-entry must inform, never block again — otherwise a still-
  // unacked entry would hang the session shut instead of just nudging it once per stop attempt.
  it('LOOP SAFETY: stop_hook_active=true reports the same finding but never blocks again', () => {
    const { env, dir } = guardEnv('heartbeat-reentry')
    writeFileSync(
      join(dir, 'sess-hb-reentry.jsonl'),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'frozen-worker-2', name: 'frozen-worker-2', at: minutesAgo(45) }) + '\n'
    )
    const r = run(HEARTBEAT_HOOK, stopEventPayload('sess-hb-reentry', true), env)
    const out = JSON.parse(r.stdout) as { decision?: string; systemMessage?: string }
    expect(out.decision).toBeUndefined()
    expect(out.systemMessage).toContain('frozen-worker-2')
  })

  it('an acked entry does not block the stop, exactly like the scan itself', () => {
    const { env, dir } = guardEnv('heartbeat-acked')
    writeFileSync(
      join(dir, 'sess-hb-acked.jsonl'),
      [
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'acked-worker', name: 'acked-worker', at: minutesAgo(45) }),
        JSON.stringify({ t: 'ack', name: 'acked-worker', at: minutesAgo(40) }),
      ].join('\n') + '\n'
    )
    const r = run(HEARTBEAT_HOOK, stopEventPayload('sess-hb-acked'), env)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('{}')
  })

  it('never throws: malformed stdin emits {} and exits 0', () => {
    const { env } = guardEnv('heartbeat-malformed')
    const res = spawnSync(process.execPath, [HEARTBEAT_HOOK], { input: 'not json', encoding: 'utf8', env })
    expect(res.status).toBe(0)
    expect((res.stdout ?? '').trim()).toBe('{}')
  })

  it('no registry directory yet (fresh machine) => stays silent, never blocks', () => {
    const dir = join(mkRoot('heartbeat-no-registry'), 'nonexistent')
    const r = run(HEARTBEAT_HOOK, stopEventPayload('sess-hb-none'), { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('{}')
  })
})

// --------------------------------------------------------------------------
// Manifest wiring — plugin/.claude-plugin/plugin.json actually registers both hooks, and no
// longer relies on the project-level settings.local.json entries that were removed.
// --------------------------------------------------------------------------
describe('plugin.json registers the outbound-guard + session-start-registry hooks', () => {
  it('PostToolUse carries a SendMessage|Agent|Task group pointing at wt-outbound-guard-hook.mjs', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
    }
    const group = (manifest.hooks?.['PostToolUse'] ?? []).find((g) =>
      (g.hooks ?? []).some((h) => (h.command ?? '').includes('wt-outbound-guard-hook.mjs'))
    )
    expect(group, 'no PostToolUse group registers wt-outbound-guard-hook.mjs').toBeTruthy()
    // Write is deliberately NOT matched: writing a working file is not reporting, so a Write
    // must neither be recorded as delivery nor cost a hook invocation.
    expect(group!.matcher).toBe('SendMessage|Agent|Task')
  })

  it('SubagentStop is matcher "*" pointing at wt-outbound-guard-hook.mjs', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
    }
    const groups = manifest.hooks?.['SubagentStop'] ?? []
    expect(groups).toHaveLength(1)
    expect(groups[0]!.matcher).toBe('*')
    expect(groups[0]!.hooks?.[0]?.command ?? '').toContain('wt-outbound-guard-hook.mjs')
  })

  it('SessionStart registers wt-session-start-registry-hook.mjs alongside the delegation-ladder hook', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    }
    const groups = manifest.hooks?.['SessionStart'] ?? []
    const commands = groups.flatMap((g) => g.hooks ?? []).map((h) => h.command ?? '')
    expect(commands.some((c) => c.includes('wt-delegation-ladder-hook.mjs'))).toBe(true)
    expect(commands.some((c) => c.includes('wt-session-start-registry-hook.mjs'))).toBe(true)
  })

  it('all three referenced scripts exist in plugin/bin/', () => {
    expect(existsSync(GUARD_HOOK)).toBe(true)
    expect(existsSync(SESSION_START_HOOK)).toBe(true)
    expect(existsSync(SCAN)).toBe(true)
  })

  it('Stop registers wt-registry-heartbeat-hook.mjs alongside wt-stop-hook.mjs (both must fire)', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    }
    const groups = manifest.hooks?.['Stop'] ?? []
    const commands = groups.flatMap((g) => g.hooks ?? []).map((h) => h.command ?? '')
    expect(commands.some((c) => c.includes('wt-stop-hook.mjs'))).toBe(true)
    expect(commands.some((c) => c.includes('wt-registry-heartbeat-hook.mjs'))).toBe(true)
    expect(existsSync(HEARTBEAT_HOOK)).toBe(true)
  })
})
