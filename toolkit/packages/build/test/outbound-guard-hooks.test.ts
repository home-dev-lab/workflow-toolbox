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
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
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

// Mirrors the REAL on-disk transcript layout the liveness check reads:
// <CLAUDE_CONFIG_DIR>/projects/<slug(cwd)>/<sessionId>/subagents/agent-X.{meta.json,jsonl} —
// verified against this machine's actual directory structure, not guessed. `transcriptAgeMin`
// controls the sibling `.jsonl`'s mtime (null = no transcript exists at all, e.g. an untrackable
// spawn or a session recorded before this scan existed).
function transcriptEnv(
  tag: string,
  opts: { sessionId: string; cwd: string; name: string; transcriptAgeMin: number | null }
): { env: NodeJS.ProcessEnv; dir: string } {
  const { env, dir } = guardEnv(tag)
  const configDir = mkRoot(`${tag}-config`)
  const slug = opts.cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const subagentsDir = join(configDir, 'projects', slug, opts.sessionId, 'subagents')
  mkdirSync(subagentsDir, { recursive: true })
  if (opts.transcriptAgeMin !== null) {
    const base = join(subagentsDir, `agent-a${opts.name}-deadbeef1234`)
    writeFileSync(`${base}.meta.json`, JSON.stringify({ name: opts.name, agentType: opts.name }))
    writeFileSync(`${base}.jsonl`, '{}\n')
    const mtime = new Date(Date.now() - opts.transcriptAgeMin * 60_000)
    utimesSync(`${base}.jsonl`, mtime, mtime)
  }
  return { env: { ...env, CLAUDE_CONFIG_DIR: configDir }, dir }
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

  // FAILS BEFORE THE FIX: normalizeName() used to strip ANY leading "a" unconditionally,
  // so an explicit agent name that happens to start with "a" (no trailing hex suffix, i.e.
  // not an agent-id at all) came out truncated ("archeo-disk" -> "rcheo-disk"), silently
  // breaking registry correlation for that agent. The invariant: an explicit name survives
  // UNCHANGED regardless of its first character. Paired below with the agent-id-shape case
  // (prefix + trailing hex DOES get stripped) so a fix that shifted the boundary the other
  // way would fail one of the two.
  it('an explicit agent NAME (no hex-id suffix) starting with "a" is preserved verbatim', () => {
    for (const name of ['archeo-disk', 'ancre-1530', 'apple', 'zebra']) {
      const { env, dir } = guardEnv(`explicit-name-${name}`)
      const r = run(
        GUARD_HOOK,
        { ...spawnPayload('sess-name', { childId: 'achild-3', name: 'child' }), tool_name: 'Task', agent_id: name },
        env
      )
      expect(r.code).toBe(0)
      const records = readFileSync(join(dir, 'sess-name.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      const spawn = records.find((rec) => rec.t === 'spawn')
      expect(spawn!.parentName, `normalizeName(${JSON.stringify(name)}) must stay "${name}"`).toBe(name)
    }
  })

  // The other direction of the same invariant, restated explicitly: a REAL agent-id
  // (prefix + trailing 12+ hex chars) still gets stripped to its bare name.
  it('a real agent-id (prefix + trailing hex) is still normalized to its bare name', () => {
    const { env, dir } = guardEnv('agent-id-shape')
    const r = run(
      GUARD_HOOK,
      { ...spawnPayload('sess-idshape', { childId: 'achild-4', name: 'child' }), tool_name: 'Task', agent_id: 'aarcheo-disk-2ad53e92c1b0' },
      env
    )
    expect(r.code).toBe(0)
    const records = readFileSync(join(dir, 'sess-idshape.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const spawn = records.find((rec) => rec.t === 'spawn')
    expect(spawn!.parentName).toBe('archeo-disk')
  })

  // B2 extension: capture "what effort was REQUESTED at the spawn call", named effortRequested
  // (never `effort`) so a null does not misread as "no effort applies" — real effort mostly
  // comes from the agent DEFINITION's frontmatter, not this call. The Agent tool exposes no
  // `effort` parameter today, so this reads null everywhere until the tool grows one.
  it('B2: records effortRequested as null when the spawn tool_input carries no effort field (today\'s case)', () => {
    const { env, dir } = guardEnv('effort-absent')
    const r = run(GUARD_HOOK, spawnPayload('sess-effort-absent', { childId: 'achild-ea', name: 'worker-ea' }), env)
    expect(r.code).toBe(0)
    const records = readFileSync(join(dir, 'sess-effort-absent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const spawn = records.find((rec) => rec.t === 'spawn')
    expect(spawn).toHaveProperty('effortRequested')
    expect(spawn!.effortRequested).toBeNull()
  })

  it('B2: records the effortRequested VALUE when the spawn tool_input carries one (future-proofing)', () => {
    const { env, dir } = guardEnv('effort-present')
    const payload = { ...spawnPayload('sess-effort-present', { childId: 'achild-ep', name: 'worker-ep' }) }
    ;(payload.tool_input as Record<string, unknown>).effort = 'high'
    const r = run(GUARD_HOOK, payload, env)
    expect(r.code).toBe(0)
    const records = readFileSync(join(dir, 'sess-effort-present.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const spawn = records.find((rec) => rec.t === 'spawn')
    expect(spawn!.effortRequested).toBe('high')
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

  // FAILS BEFORE THE FIX — reproduces the EXACT real production record shape from the s-fence-125
  // incident (2026-08-02, atlassian-cli session, journal cc4e1f93-...): a NAMED, trackable spawn
  // (name given explicitly at spawn time) whose SubagentStop records nonetheless carry
  // name:"general-purpose" (the underlying subagent_type), never "s-fence-125" (the explicit
  // name). This is NOT the untrackable-unnamed-spawn case tested above — the spawn record has a
  // real name and a real child id; only the STOP records are keyed wrong. Name-only correlation
  // (`stopped = lastByName('stop')`) never matches "s-fence-125", so the entry stays open forever
  // even though the agent completed, sent a message, and was nudged normally — matching the
  // measured incident (a neighboring session lost over an hour to this alert). The raw `agentId`
  // on every stop/out/nudged record DOES equal the spawn's raw `child` id, which is the fact the
  // fix must use.
  it('a NAMED spawn whose SubagentStop reports agent_type (not the name) is still recognized as accounted for, via raw-id correlation', () => {
    const dir = mkRoot('scan-name-mismatch')
    writeFileSync(
      join(dir, 'sess.jsonl'),
      [
        JSON.stringify({
          t: 'spawn', parent: '(main-loop)', parentName: '(main-loop)',
          child: 'aa877ce816e0c2b0f', childName: 's-fence-125', name: 's-fence-125',
          subagentType: 'general-purpose', model: 'sonnet', purpose: 'Implement write fence #125',
          at: '2026-08-02T11:25:25.426Z',
        }),
        JSON.stringify({ t: 'stop', agentId: 'aa877ce816e0c2b0f', name: 'general-purpose', event: 'SubagentStop', at: '2026-08-02T11:42:57.492Z' }),
        JSON.stringify({ t: 'nudged', agentId: 'aa877ce816e0c2b0f', name: 'general-purpose', event: 'SubagentStop', at: '2026-08-02T11:42:57.492Z' }),
        JSON.stringify({ t: 'out', agentId: 'aa877ce816e0c2b0f', name: 'general-purpose', tool: 'SendMessage', at: '2026-08-02T11:43:08.206Z' }),
        JSON.stringify({ t: 'stop', agentId: 'aa877ce816e0c2b0f', name: 'general-purpose', event: 'SubagentStop', at: '2026-08-02T11:43:13.649Z' }),
      ].join('\n') + '\n'
    )
    const r = runNoInput(SCAN, ['--quiet-min', '20', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code, `expected s-fence-125 accounted for; stdout: ${r.stdout}`).toBe(0)
    const parsed = JSON.parse(r.stdout) as { open: number; flagged: unknown[] }
    expect(parsed.open).toBe(0)
    expect(parsed.flagged).toHaveLength(0)
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

  // B1 extension: the untrackable block must NAME what each entry was doing, not just count them
  // — a bare number with no set. Property over the WHOLE family, not a fixed list of known cases.
  it('B1: names purpose/type/model for EVERY untrackable entry, not a fixed enumeration', () => {
    const dir = mkRoot('untrackable-detail')
    const entries = [
      { subagentType: 'general-purpose', model: 'haiku', purpose: "Record tonight's delivery on the board" },
      { subagentType: 'Explore', model: 'sonnet', purpose: 'map the auth module' },
      { subagentType: 'claude', model: 'opus', purpose: 'triage the incident' },
    ]
    writeFileSync(
      join(dir, 'sess.jsonl'),
      entries
        .map((e, i) =>
          JSON.stringify({
            t: 'spawn', parent: '(main-loop)', parentName: '(main-loop)',
            child: `achild-${i}`, childName: `childname-${i}`, name: null,
            subagentType: e.subagentType, model: e.model, purpose: e.purpose,
            at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
          })
        )
        .join('\n') + '\n'
    )
    const r = runNoInput(SCAN, [], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(0) // untrackable entries never count as open/flagged
    for (const e of entries) {
      expect(r.stdout).toContain(e.subagentType)
      expect(r.stdout).toContain(e.model)
      expect(r.stdout).toContain(e.purpose)
    }
    // still says plainly that this scan is blind to whether they ended — naming the purpose must
    // not read as "these are tracked after all"
    expect(r.stdout).toContain('blind to whether they ended')
  })

  it('B1: an untrackable entry with NO purpose is rendered legibly, not blank', () => {
    const dir = mkRoot('untrackable-no-purpose')
    writeFileSync(
      join(dir, 'sess.jsonl'),
      JSON.stringify({
        t: 'spawn', parent: '(main-loop)', parentName: '(main-loop)',
        child: 'achild-np', childName: 'childname-np', name: null,
        subagentType: 'general-purpose', model: null, purpose: null,
        at: new Date().toISOString(),
      }) + '\n'
    )
    const r = runNoInput(SCAN, [], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('general-purpose')
    expect(r.stdout).toContain('no purpose recorded')
  })

  it('B1: --json also carries untrackableDetail (subagentType/model/purpose/spawnedAt)', () => {
    const dir = mkRoot('untrackable-json')
    writeFileSync(
      join(dir, 'sess.jsonl'),
      JSON.stringify({
        t: 'spawn', parent: '(main-loop)', parentName: '(main-loop)',
        child: 'achild-j', childName: 'childname-j', name: null,
        subagentType: 'general-purpose', model: 'haiku', purpose: 'a json-mode purpose',
        at: '2026-07-26T22:31:52.233Z',
      }) + '\n'
    )
    const r = runNoInput(SCAN, ['--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    const parsed = JSON.parse(r.stdout) as {
      untrackable: number
      untrackableDetail: Array<{ subagentType: string | null; model: string | null; purpose: string | null; spawnedAt: string }>
    }
    expect(parsed.untrackable).toBe(1)
    expect(parsed.untrackableDetail).toHaveLength(1)
    expect(parsed.untrackableDetail[0]).toMatchObject({
      subagentType: 'general-purpose', model: 'haiku', purpose: 'a json-mode purpose', spawnedAt: '2026-07-26T22:31:52.233Z',
    })
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

  it('the --ack CLI mode reports the journal path it wrote to', () => {
    const dir = mkRoot('ack-cli-journal-path')
    const file = join(dir, 'sess.jsonl')
    writeFileSync(
      file,
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'path-worker', name: 'path-worker', at: minutesAgo(45) }) + '\n'
    )
    const r = runNoInput(
      SCAN,
      ['--session', 'sess', '--ack', 'path-worker'],
      { ...process.env, WT_OUTBOUND_GUARD_DIR: dir }
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`Acknowledged: path-worker (journal: ${file})`)
  })

  it('refuses ambiguous --ack without --session when multiple journals exist, and appends nothing', () => {
    const dir = mkRoot('ack-ambiguous')
    const first = join(dir, 'sess-a.jsonl')
    const second = join(dir, 'sess-b.jsonl')
    writeFileSync(
      first,
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'worker-a', name: 'worker-a', at: minutesAgo(45) }) + '\n'
    )
    writeFileSync(
      second,
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'worker-b', name: 'worker-b', at: minutesAgo(45) }) + '\n'
    )
    const firstBefore = readFileSync(first)
    const secondBefore = readFileSync(second)

    const r = runNoInput(
      SCAN,
      ['--ack', 'worker-a'],
      { ...process.env, WT_OUTBOUND_GUARD_DIR: dir }
    )

    expect(r.code).toBe(3)
    expect(r.stderr).toContain('Refusing ambiguous --ack')
    expect(r.stderr).toContain('found 2 journals')
    expect(r.stderr).toContain('re-run with --session <id>')
    expect(readFileSync(first).byteLength).toBe(firstBefore.byteLength)
    expect(readFileSync(second).byteLength).toBe(secondBefore.byteLength)
  })
})

// --------------------------------------------------------------------------
// LIVENESS — design objection (Frederic, same morning as the Stop-hook wiring): message-silence
// alone is the wrong model of this system's real dispatch (our own pilots only speak at
// milestones), so a message-silent entry must ALSO show no transcript growth before it is
// actually flagged. Three cases, matching the objection's own closure criterion exactly:
//   ROUGE   : silent by message AND transcript stale/missing -> flagged
//   VERT-1  : silent by message BUT transcript still growing -> NOT flagged (confirmedAlive)
//   VERT-2  : nothing open -> silent (already covered above; not duplicated here)
// --------------------------------------------------------------------------
describe('wt-spawn-registry-scan.mjs — liveness: transcript growth suppresses the false positive', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  const CWD = '/fake/project/for/liveness'
  const SESSION = 'sess-liveness'

  it('ROUGE: silent by message AND no transcript found at all -> still flagged (unknown = ask)', () => {
    const { env, dir } = transcriptEnv('rouge-missing', { sessionId: SESSION, cwd: CWD, name: 'stuck-worker', transcriptAgeMin: null })
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'stuck-worker', name: 'stuck-worker', at: minutesAgo(45) }) + '\n'
    )
    const r = runNoInput(SCAN, ['--session', SESSION, '--cwd', CWD, '--json'], env)
    expect(r.code).toBe(1)
    const parsed = JSON.parse(r.stdout) as { flagged: Array<{ name: string; transcriptFreshMin: number | null }>; confirmedAlive: unknown[] }
    expect(parsed.flagged.map((f) => f.name)).toContain('stuck-worker')
    expect(parsed.flagged[0]!.transcriptFreshMin).toBeNull()
    expect(parsed.confirmedAlive).toHaveLength(0)
  })

  it('ROUGE: silent by message AND transcript itself is STALE (30 min > 5 min default) -> flagged', () => {
    const { env, dir } = transcriptEnv('rouge-stale', { sessionId: SESSION, cwd: CWD, name: 'stuck-worker-2', transcriptAgeMin: 30 })
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'stuck-worker-2', name: 'stuck-worker-2', at: minutesAgo(45) }) + '\n'
    )
    const r = runNoInput(SCAN, ['--session', SESSION, '--cwd', CWD, '--json'], env)
    expect(r.code).toBe(1)
    const parsed = JSON.parse(r.stdout) as { flagged: Array<{ name: string; transcriptFreshMin: number }> }
    expect(parsed.flagged.map((f) => f.name)).toContain('stuck-worker-2')
    expect(parsed.flagged[0]!.transcriptFreshMin).toBeGreaterThanOrEqual(29)
  })

  // THE DISCRIMINATING CASE the objection asked for: this is the nominal, healthy population
  // (an agent reading code / running tests / awaiting a delegated run) that must NOT be blocked.
  it('VERT-1: silent by message BUT transcript grew 1 min ago -> NOT flagged, reported confirmedAlive', () => {
    const { env, dir } = transcriptEnv('vert1-fresh', { sessionId: SESSION, cwd: CWD, name: 'busy-worker', transcriptAgeMin: 1 })
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'busy-worker', name: 'busy-worker', at: minutesAgo(45) }) + '\n'
    )
    const r = runNoInput(SCAN, ['--session', SESSION, '--cwd', CWD, '--json'], env)
    expect(r.code, `expected NOT flagged; stdout: ${r.stdout}`).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      flagged: unknown[]
      confirmedAlive: Array<{ name: string; transcriptFreshMin: number }>
    }
    expect(parsed.flagged).toHaveLength(0)
    expect(parsed.confirmedAlive).toHaveLength(1)
    expect(parsed.confirmedAlive[0]!.name).toBe('busy-worker')
    expect(parsed.confirmedAlive[0]!.transcriptFreshMin).toBeLessThan(5)
  })

  it('VERT-1 human-text mode names the confirmed-alive agent and says why it is not asked about', () => {
    const { env, dir } = transcriptEnv('vert1-text', { sessionId: SESSION, cwd: CWD, name: 'busy-worker-2', transcriptAgeMin: 1 })
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'busy-worker-2', name: 'busy-worker-2', at: minutesAgo(45) }) + '\n'
    )
    const r = runNoInput(SCAN, ['--session', SESSION, '--cwd', CWD], env)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('CONFIRMED ALIVE')
    expect(r.stdout).toContain('busy-worker-2')
    expect(r.stdout).toContain('Nothing to ask about')
  })

  it('a MIX of one confirmed-alive and one truly stale agent flags only the stale one', () => {
    const { env, dir } = transcriptEnv('mix', { sessionId: SESSION, cwd: CWD, name: 'alive-one', transcriptAgeMin: 1 })
    // second entry's transcript is missing entirely (never written) -> stays unconfirmed
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      [
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'alive-one', name: 'alive-one', at: minutesAgo(45) }),
        JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'dead-one', name: 'dead-one', at: minutesAgo(45) }),
      ].join('\n') + '\n'
    )
    const r = runNoInput(SCAN, ['--session', SESSION, '--cwd', CWD, '--json'], env)
    expect(r.code).toBe(1) // still exit 1: at least one REAL flag remains
    const parsed = JSON.parse(r.stdout) as {
      flagged: Array<{ name: string }>
      confirmedAlive: Array<{ name: string }>
    }
    expect(parsed.flagged.map((f) => f.name)).toEqual(['dead-one'])
    expect(parsed.confirmedAlive.map((f) => f.name)).toEqual(['alive-one'])
  })

  it('an entry under the message quiet-min threshold never triggers the directory scan at all (no false confirmedAlive)', () => {
    const { env, dir } = transcriptEnv('under-threshold', { sessionId: SESSION, cwd: CWD, name: 'recent-worker', transcriptAgeMin: 1 })
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'recent-worker', name: 'recent-worker', at: minutesAgo(2) }) + '\n'
    )
    const r = runNoInput(SCAN, ['--session', SESSION, '--cwd', CWD, '--json'], env)
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout) as { flagged: unknown[]; confirmedAlive: unknown[] }
    expect(parsed.flagged).toHaveLength(0)
    expect(parsed.confirmedAlive).toHaveLength(0) // under threshold: never a candidate in the first place
  })
})

// --------------------------------------------------------------------------
// wt-registry-heartbeat-hook.mjs + liveness — the Stop hook must inherit the same fix: a
// message-silent agent with a growing transcript must NOT block the session's stop.
// --------------------------------------------------------------------------
describe('wt-registry-heartbeat-hook.mjs — liveness end-to-end: confirmed-alive agents never block Stop', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  const CWD = '/fake/project/for/heartbeat-liveness'
  const SESSION = 'sess-hb-liveness'

  it('an agent silent by message but with a growing transcript does NOT block the stop', () => {
    const { env, dir } = transcriptEnv('hb-alive', { sessionId: SESSION, cwd: CWD, name: 'hb-busy-worker', transcriptAgeMin: 1 })
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'hb-busy-worker', name: 'hb-busy-worker', at: minutesAgo(45) }) + '\n'
    )
    const r = run(HEARTBEAT_HOOK, { hook_event_name: 'Stop', session_id: SESSION, cwd: CWD, stop_hook_active: false }, env)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('{}')
  })

  it('an agent silent by message AND with a stale transcript still blocks the stop', () => {
    const { env, dir } = transcriptEnv('hb-stale', { sessionId: SESSION, cwd: CWD, name: 'hb-stuck-worker', transcriptAgeMin: 30 })
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'hb-stuck-worker', name: 'hb-stuck-worker', at: minutesAgo(45) }) + '\n'
    )
    const r = run(HEARTBEAT_HOOK, { hook_event_name: 'Stop', session_id: SESSION, cwd: CWD, stop_hook_active: false }, env)
    const out = JSON.parse(r.stdout) as { decision?: string; reason?: string }
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('hb-stuck-worker')
    expect(out.reason).toContain('transcript has stopped growing')
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

  it('the remediation command in the block reason includes the explicit session id', () => {
    const { env, dir } = guardEnv('heartbeat-ack-session')
    writeFileSync(
      join(dir, 'sess-hb-ack-session.jsonl'),
      JSON.stringify({ t: 'spawn', parentName: '(main-loop)', childName: 'frozen-worker-ack', name: 'frozen-worker-ack', at: minutesAgo(45) }) + '\n'
    )
    const r = run(HEARTBEAT_HOOK, stopEventPayload('sess-hb-ack-session'), env)
    const out = JSON.parse(r.stdout) as { reason?: string }
    expect(out.reason).toContain(`--session sess-hb-ack-session --ack <name>`)
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
