// cancelled-call-relay-guard-hook.test.ts — behaviour gates for
// plugin/bin/wt-cancelled-call-relay-guard-hook.mjs (SubagentStop).
//
// The hook exists because a delegate whose tool call the harness cancels receives the generic
// cancellation text ("The user doesn't want to take this action right now. STOP …"), reads it as
// a person's order, and stops in silence while nobody is waiting on the other side. Each case
// below drives the REAL script as a child process with a SubagentStop payload and a transcript
// written in the exact record shape the harness produces (assistant tool_use, `hook_cancelled`
// attachment, user tool_result with `toolDenialKind`), and asserts exit code and stderr.

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-cancelled-call-relay-guard-hook.mjs')
const GUARD_NAME = 'wt-cancelled-call-relay-guard-hook.mjs'
const CANCEL_TEXT =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."

const AGENT_ID = 'a8c92c84057233881'
const SESSION_ID = 'e242f5fd-0000-4000-8000-000000000001'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

interface Fixture {
  root: string
  stateDir: string
  journalDir: string
  sessionTranscript: string
  agentTranscript: string
  env: NodeJS.ProcessEnv
}

function fixture(tag: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `wt-cancel-relay-${tag}-`))
  roots.push(root)
  const projectDir = join(root, 'projects', 'slug')
  const sessionTranscript = join(projectDir, `${SESSION_ID}.jsonl`)
  const subagents = join(projectDir, SESSION_ID, 'subagents')
  mkdirSync(subagents, { recursive: true })
  writeFileSync(sessionTranscript, '')
  const agentTranscript = join(subagents, `agent-${AGENT_ID}.jsonl`)
  writeFileSync(agentTranscript, '')
  const stateDir = join(root, 'state')
  const journalDir = join(root, 'journal')
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'xdg'),
    WT_CANCELLED_CALL_RELAY_DIR: stateDir,
    WT_GUARD_JOURNAL_DIR: journalDir,
  }
  delete env.WT_FAIL_OPEN_TRACE_SELF_TEST
  return { root, stateDir, journalDir, sessionTranscript, agentTranscript, env }
}

// ---- transcript records, in the shape the harness writes them --------------------------------
let seq = 0
function stamp(): string {
  seq += 1
  return new Date(Date.UTC(2026, 8, 30, 7, 32, 0, seq)).toISOString()
}
let uuidSeq = 0
function uuid(): string {
  uuidSeq += 1
  return `00000000-0000-4000-8000-${String(uuidSeq).padStart(12, '0')}`
}
function toolUse(id: string, name: string, input: Record<string, unknown> = {}) {
  return {
    isSidechain: true,
    agentId: AGENT_ID,
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    uuid: uuid(),
    timestamp: stamp(),
  }
}
function hookCancelled(id: string, toolName: string) {
  return {
    isSidechain: true,
    agentId: AGENT_ID,
    type: 'attachment',
    attachment: { type: 'hook_cancelled', hookName: `PreToolUse:${toolName}`, toolUseID: id, hookEvent: 'PreToolUse' },
    uuid: uuid(),
    timestamp: stamp(),
  }
}
function denied(id: string, kind = 'cancelled', text = CANCEL_TEXT) {
  return {
    isSidechain: true,
    agentId: AGENT_ID,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: text, is_error: true, tool_use_id: id }] },
    toolUseResult: text,
    toolDenialKind: kind,
    uuid: uuid(),
    timestamp: stamp(),
  }
}
function ordinaryResult(id: string, text: string) {
  return {
    isSidechain: true,
    agentId: AGENT_ID,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: text, is_error: false, tool_use_id: id }] },
    toolUseResult: { stdout: text, stderr: '' },
    uuid: uuid(),
    timestamp: stamp(),
  }
}
function assistantText(text: string) {
  return {
    isSidechain: true,
    agentId: AGENT_ID,
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    uuid: uuid(),
    timestamp: stamp(),
  }
}
/** A record a non-turn writer adds (the harness's observer reference): grows the file, no new turn. */
function observerRef() {
  return { type: 'observer-ref', agentId: AGENT_ID, observerTaskId: 'obs1', timestamp: stamp() }
}
function writeTranscript(file: string, records: unknown[]): void {
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}
function appendTranscript(file: string, records: unknown[]): void {
  appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function payload(f: Fixture, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'SubagentStop',
    session_id: SESSION_ID,
    cwd: f.root,
    agent_id: AGENT_ID,
    agent_type: 'general-purpose',
    transcript_path: f.sessionTranscript,
    agent_transcript_path: f.agentTranscript,
    stop_hook_active: false,
    last_assistant_message: 'waiting for your instruction',
    ...extra,
  }
}

interface Run {
  code: number | null
  stderr: string
  stdout: string
}
function run(f: Fixture, p: Record<string, unknown>): Run {
  const res = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(p), encoding: 'utf8', env: f.env })
  return { code: res.status, stderr: (res.stderr ?? '').trim(), stdout: (res.stdout ?? '').trim() }
}
function runAsync(f: Fixture, p: Record<string, unknown>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: f.env })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.stdout.on('data', (d) => (stdout += d))
    child.on('close', (code) => resolve({ code, stderr: stderr.trim(), stdout: stdout.trim() }))
    child.stdin.end(JSON.stringify(p))
  })
}
function journal(f: Fixture): Array<Record<string, unknown>> {
  if (!existsSync(f.journalDir)) return []
  const out: Array<Record<string, unknown>> = []
  for (const name of readdirSync(f.journalDir)) {
    if (!name.endsWith('.ndjson')) continue
    for (const line of readFileSync(join(f.journalDir, name), 'utf8').split('\n')) if (line.trim()) out.push(JSON.parse(line))
  }
  return out
}

/** The field shape: a SendMessage whose PreToolUse hook run was cancelled, then prose, then stop. */
function cancelledSendMessage(f: Fixture, id = 'toolu_01QfibAAAA'): void {
  writeTranscript(f.agentTranscript, [
    toolUse('toolu_bash_1', 'Bash', { command: 'sleep 1', run_in_background: true }),
    ordinaryResult('toolu_bash_1', 'Command running in background with ID: b1.'),
    toolUse(id, 'SendMessage', { to: 'main', message: 'lane launched' }),
    hookCancelled(id, 'SendMessage'),
    denied(id),
    assistantText('Stopped as instructed; waiting for your instruction.'),
  ])
}

describe('wt-cancelled-call-relay-guard-hook — blocks once on an unrelayed cancellation', () => {
  it('blocks the stop with the tool name, the verbatim text and what the transcript records about the hook run', () => {
    const f = fixture('block')
    cancelledSendMessage(f)
    const r = run(f, payload(f))
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(CANCEL_TEXT)
    expect(r.stderr).toContain('\nTool: SendMessage\n')
    expect(r.stderr).toContain('PreToolUse:SendMessage')
    expect(r.stderr).toMatch(/records the hook run on this call \(PreToolUse:SendMessage\) as cancelled/)
    expect(r.stderr).toMatch(/does not record why/)
    // A2: the message states only what the transcript shows; no claim about who cancelled it.
    expect(r.stderr).not.toMatch(/not a person/i)
    expect(r.stderr).toMatch(/ONE SendMessage/)
    expect(r.stderr).toMatch(/background/i)
    expect(r.stderr).not.toMatch(/continue independent work/i)
    // Round 1, finding 5: once per call, not once ever; a later arc can be nudged about another call.
    expect(r.stderr).toContain('it will not stop you again for this call')
    // The field pilot overrode a nudge because "the user's stop outranks a hook": the message says
    // that relaying is how a delegate waits, as one full line.
    expect(r.stderr.split('\n')).toContain(
      'Relaying is how a delegate waits for instructions: your spawner is the one who can answer, and sending that one line is compatible with stopping your work.',
    )
    expect(r.stderr).not.toContain('will not stop you a second time')
    const entries = journal(f)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ guard: GUARD_NAME, decision: 'blocked' })
  })

  it('names the Agent tool when a spawn was the cancelled call (the second field shape)', () => {
    const f = fixture('agent-tool')
    writeTranscript(f.agentTranscript, [
      toolUse('toolu_agent_1', 'Agent', { description: 'chunk 00', prompt: 'x' }),
      hookCancelled('toolu_agent_1', 'Agent'),
      denied('toolu_agent_1'),
      assistantText('You declined the spawn, so I stopped.'),
    ])
    const r = run(f, payload(f))
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('\nTool: Agent\n')
    expect(r.stderr).toContain('PreToolUse:Agent')
  })

  it('says the transcript does not show who cancelled it when no hook_cancelled attachment exists', () => {
    const f = fixture('no-attachment')
    writeTranscript(f.agentTranscript, [toolUse('toolu_x', 'Bash', { command: 'ls' }), denied('toolu_x'), assistantText('waiting')])
    const r = run(f, payload(f))
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/does not show who/)
    expect(r.stderr).not.toMatch(/records the hook run/)
  })
})

describe('wt-cancelled-call-relay-guard-hook — never loops', () => {
  it('is silent on the next stop of the same agent after its nudge', () => {
    const f = fixture('second-stop')
    cancelledSendMessage(f)
    expect(run(f, payload(f)).code).toBe(2)
    appendTranscript(f.agentTranscript, [assistantText('Still waiting.')])
    const second = run(f, payload(f))
    expect(second.code).toBe(0)
    expect(journal(f)).toHaveLength(1)
  })

  it('A1: when the relay SendMessage itself is cancelled after the nudge, the next stop is silent with a one-line trace', () => {
    const f = fixture('relay-cancelled')
    cancelledSendMessage(f, 'toolu_first')
    expect(run(f, payload(f)).code).toBe(2)
    appendTranscript(f.agentTranscript, [
      toolUse('toolu_relay', 'SendMessage', { to: 'main', message: `SendMessage cancelled: ${CANCEL_TEXT}` }),
      hookCancelled('toolu_relay', 'SendMessage'),
      denied('toolu_relay'),
      assistantText('My relay was cancelled too.'),
    ])
    const second = run(f, payload(f))
    expect(second.code).toBe(0)
    expect(second.stderr.split('\n')).toHaveLength(1)
    expect(second.stderr).toContain('a SendMessage sent after this check\'s nudge was cancelled')
    expect(journal(f)).toHaveLength(1)
  })

  it('A1: the relay-cancelled exemption holds even in a LATER arc (positional on the transcript, not on the arc)', () => {
    const f = fixture('relay-cancelled-later')
    cancelledSendMessage(f, 'toolu_first')
    expect(run(f, payload(f)).code).toBe(2)
    appendTranscript(f.agentTranscript, [assistantText('noted')])
    expect(run(f, payload(f)).code).toBe(0) // the free stop after a nudge closes that arc
    appendTranscript(f.agentTranscript, [
      toolUse('toolu_relay', 'SendMessage', { to: 'main', message: 'relay' }),
      denied('toolu_relay'),
      assistantText('relay cancelled'),
    ])
    const third = run(f, payload(f))
    expect(third.code).toBe(0)
    expect(third.stderr).toContain('a SendMessage sent after this check\'s nudge was cancelled')
  })

  it('A1: racing duplicate registrations of the same stop produce exactly ONE block', async () => {
    const f = fixture('race')
    cancelledSendMessage(f)
    const results = await Promise.all([0, 1, 2, 3].map(() => runAsync(f, payload(f))))
    expect(results.filter((r) => r.code === 2)).toHaveLength(1)
    expect(results.filter((r) => r.code === 0)).toHaveLength(3)
    expect(journal(f).filter((e) => e.decision === 'blocked')).toHaveLength(1)
  })

  // Round 1, finding 1: the per-arc check alone (the claim is per call, so it cannot stop this).
  it('is silent on the next stop when, after the nudge, ANOTHER call is cancelled in the same arc', () => {
    const f = fixture('second-call-same-arc')
    cancelledSendMessage(f, 'toolu_first')
    expect(run(f, payload(f)).code).toBe(2)
    appendTranscript(f.agentTranscript, [
      toolUse('toolu_bash_y', 'Bash', { command: 'ls' }),
      denied('toolu_bash_y'),
      assistantText('That was cancelled too; waiting.'),
    ])
    const second = run(f, payload(f))
    expect(second.code).toBe(0)
    expect(journal(f)).toHaveLength(1)
  })

  // Round 1, finding 2: a duplicate delivery of ONE stop that reads a longer transcript (a non-turn
  // writer appended in between) must not open a new arc.
  it('counts one stop delivered twice at different transcript sizes as ONE arc', () => {
    const f = fixture('dup-different-size')
    cancelledSendMessage(f, 'toolu_first')
    expect(run(f, payload(f)).code).toBe(2)
    appendTranscript(f.agentTranscript, [observerRef()]) // the file grows, no new turn
    expect(run(f, payload(f)).code).toBe(0) // the duplicate delivery of the same stop
    appendTranscript(f.agentTranscript, [
      toolUse('toolu_bash_y', 'Bash', { command: 'ls' }),
      denied('toolu_bash_y'),
      assistantText('waiting'),
    ])
    const real = run(f, payload(f)) // the real next stop: still the arc that holds the nudge
    expect(real.code).toBe(0)
    expect(journal(f)).toHaveLength(1)
  })

  it('blocks again for a NEW cancellation in a later arc once the previous one was relayed', () => {
    const f = fixture('new-arc')
    cancelledSendMessage(f, 'toolu_first')
    expect(run(f, payload(f)).code).toBe(2)
    appendTranscript(f.agentTranscript, [
      toolUse('toolu_relay_ok', 'SendMessage', { to: 'main', message: 'relay' }),
      ordinaryResult('toolu_relay_ok', 'Message sent'),
      assistantText('relayed'),
    ])
    expect(run(f, payload(f)).code).toBe(0)
    appendTranscript(f.agentTranscript, [
      toolUse('toolu_bash_late', 'Bash', { command: 'ls' }),
      denied('toolu_bash_late'),
      assistantText('waiting'),
    ])
    const third = run(f, payload(f))
    expect(third.code).toBe(2)
    expect(third.stderr).toContain('\nTool: Bash\n')
  })
})

describe('wt-cancelled-call-relay-guard-hook — silent cases', () => {
  it('is silent when the agent already sent a message after the cancellation', () => {
    const f = fixture('resolved')
    cancelledSendMessage(f, 'toolu_c')
    appendTranscript(f.agentTranscript, [
      toolUse('toolu_send', 'SendMessage', { to: 'main', message: `SendMessage cancelled: ${CANCEL_TEXT}` }),
      ordinaryResult('toolu_send', 'Message sent'),
    ])
    const r = run(f, payload(f))
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(journal(f)).toHaveLength(0)
  })

  it('is silent for the main loop (no agent_id)', () => {
    const f = fixture('main')
    cancelledSendMessage(f)
    const p = payload(f)
    delete p.agent_id
    expect(run(f, p).code).toBe(0)
  })

  /** An earlier cancellation, already relayed: puts the cancelled marker in view without a block,
   *  so what decides the next records is the record filter, not the cheap pre-check. */
  function relayedCancellation(): unknown[] {
    return [
      toolUse('toolu_old', 'Bash', { command: 'ls' }),
      denied('toolu_old'),
      toolUse('toolu_old_relay', 'SendMessage', { to: 'main', message: `Bash cancelled: ${CANCEL_TEXT}` }),
      ordinaryResult('toolu_old_relay', 'Message sent'),
    ]
  }

  it('is silent for a user-rejected permission answer', () => {
    const f = fixture('user-rejected')
    writeTranscript(f.agentTranscript, [
      ...relayedCancellation(),
      toolUse('toolu_r', 'Bash', { command: 'rm x' }),
      denied('toolu_r', 'user-rejected'),
      assistantText('ok'),
    ])
    expect(run(f, payload(f)).code).toBe(0)
  })

  it('is silent when the text only appears inside an ordinary tool output', () => {
    const f = fixture('quoted')
    writeTranscript(f.agentTranscript, [
      ...relayedCancellation(),
      toolUse('toolu_g', 'Bash', { command: 'grep -r cancel' }),
      ordinaryResult('toolu_g', CANCEL_TEXT),
      assistantText('found it'),
    ])
    expect(run(f, payload(f)).code).toBe(0)
  })

  it('is silent when the denial kind is cancelled but the text is something else', () => {
    const f = fixture('other-text')
    writeTranscript(f.agentTranscript, [toolUse('toolu_o', 'Bash', {}), denied('toolu_o', 'cancelled', 'Session copied; this call was not run.'), assistantText('ok')])
    expect(run(f, payload(f)).code).toBe(0)
  })

  it('is silent for an event other than SubagentStop', () => {
    const f = fixture('other-event')
    cancelledSendMessage(f)
    expect(run(f, payload(f, { hook_event_name: 'Stop' })).code).toBe(0)
  })

  it('A4: is silent on an empty or missing agent_type', () => {
    const f = fixture('no-type')
    cancelledSendMessage(f)
    expect(run(f, payload(f, { agent_type: '' })).code).toBe(0)
    const p = payload(f)
    delete p.agent_type
    expect(run(f, p).code).toBe(0)
  })

  it('A4: is silent for a workflow subagent whose final text the harness delivers', () => {
    const f = fixture('workflow')
    cancelledSendMessage(f)
    expect(run(f, payload(f, { agent_type: 'workflow-subagent' })).code).toBe(0)
  })

  it('is silent for an agent type with no messaging tool', () => {
    const f = fixture('no-messaging')
    cancelledSendMessage(f)
    expect(run(f, payload(f, { agent_type: 'opencode-envelope' })).code).toBe(0)
  })

  it('is silent when the transcript path names a directory, not a file', () => {
    const f = fixture('directory')
    rmSync(f.agentTranscript)
    mkdirSync(f.agentTranscript) // fails the regular-file check: no read is attempted
    const r = run(f, payload(f))
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })

  // Round 1, finding 4: a REAL read failure (the file exists and is a regular file, so the read is
  // attempted). Skipped where file modes cannot deny the read: on Windows (no POSIX modes) and as
  // root (root reads a mode-000 file).
  const cannotDenyRead = process.platform === 'win32' || process.getuid?.() === 0
  it.skipIf(cannotDenyRead)('is silent when the transcript exists but cannot be read, and blocks once it can', () => {
    const f = fixture('unreadable')
    cancelledSendMessage(f)
    chmodSync(f.agentTranscript, 0o000)
    try {
      const r = run(f, payload(f))
      expect(r.code).toBe(0)
      expect(r.stderr).toBe('')
      expect(journal(f)).toHaveLength(0)
    } finally {
      chmodSync(f.agentTranscript, 0o600)
    }
    // Control: the same fixture, readable, blocks; so the silence above came from the failed read.
    expect(run(f, payload(f)).code).toBe(2)
  })

  // Round 1, finding 6: a stop with no cancellation in view is not parsed and writes no state.
  it('writes no state for a stop whose transcript shows no cancellation', () => {
    const f = fixture('no-cancel')
    writeTranscript(f.agentTranscript, [toolUse('toolu_l', 'Bash', { command: 'ls' }), ordinaryResult('toolu_l', 'a b'), assistantText('done')])
    const r = run(f, payload(f))
    expect(r.code).toBe(0)
    expect(existsSync(f.stateDir)).toBe(false)
  })
})

describe('wt-cancelled-call-relay-guard-hook — A3 transcript location', () => {
  it('derives the agent transcript from transcript_path when agent_transcript_path is absent', () => {
    const f = fixture('derived-absent')
    cancelledSendMessage(f)
    const p = payload(f)
    delete p.agent_transcript_path
    expect(run(f, p).code).toBe(2)
  })

  it('derives the agent transcript when agent_transcript_path points at a missing file', () => {
    const f = fixture('derived-missing')
    cancelledSendMessage(f)
    expect(run(f, payload(f, { agent_transcript_path: join(f.root, 'nowhere', `agent-${AGENT_ID}.jsonl`) })).code).toBe(2)
  })

  it('is silent when neither path leads to a transcript', () => {
    const f = fixture('neither')
    cancelledSendMessage(f)
    const p = payload(f)
    delete p.agent_transcript_path
    delete p.transcript_path
    const r = run(f, p)
    expect(r.code).toBe(0)
    expect(journal(f)).toHaveLength(0)
  })
})
