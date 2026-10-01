#!/usr/bin/env node
// cancelled-call-relay guard — SubagentStop.
//
// WHY IT EXISTS
// When the harness aborts a tool call inside a delegate (for example a PreToolUse hook run that
// gets cancelled), the delegate receives the same generic text a declined permission prompt
// produces: "The user doesn't want to take this action right now. STOP what you are doing and
// wait for the user to tell you how to proceed." A delegate has no user on the other side. It
// reads the text as an order, writes "waiting for your instruction" into its own transcript —
// which reaches nobody — and ends its turn. Its spawner never hears of it, and background work
// the delegate launched (lanes, gates, watchers) is left unattended or killed. Observed on two
// delegates of one session, one on a SendMessage call and one on an Agent call; one of them then
// overrode the generic outbound-delivery nudge twice, because it believed a person had said stop.
//
// WHAT IT DOES
// On a sub-agent's stop it reads the sub-agent's own transcript (tail-bounded) and finds the
// newest tool result the harness marked `toolDenialKind: "cancelled"` whose text is that generic
// cancellation text. If the agent has not sent a message since, the stop is blocked ONCE (exit 2)
// with a message that states only what the transcript shows — the tool name, the verbatim text,
// and, when a `hook_cancelled` attachment exists for that call, that the transcript records the
// hook run on it as cancelled (it cannot say why) — and asks for ONE SendMessage to the spawner
// carrying the tool name and the verbatim text, background work kept running, then a wait for the
// spawner's answer. Each block is recorded in the shared guard journal so its firings are counted.
//
// LOOP SAFETY — the guard's own failure modes
//   * At most ONE block per agent per arc. An arc ends at the agent's previous stop, sliced by
//     position in an append-only log. A stop is identified by the uuid of the last assistant record
//     in view: a duplicate delivery of the same stop (double registration) sees the same last turn
//     even when another writer has grown the file meanwhile, and is collapsed, so it cannot reopen
//     an arc; a real later stop follows a new turn and so a new record. A turn not yet on disk
//     (lag) makes two real stops share an id: that merges two arcs, which can only suppress a
//     nudge, never add one.
//   * A stop whose transcript tail does not contain the literal `"toolDenialKind":"cancelled"` is
//     neither parsed nor recorded: no block is possible there. Leaving it out of the log can only
//     merge arcs, the same suppress-only direction.
//   * The block is claimed atomically per cancelled call (exclusive-create file), so two racing
//     registrations of this hook produce one message, never two.
//   * When the newest cancellation is a SendMessage issued after this hook's own nudge (typically
//     the relay itself), it exits 0 with a one-line stderr trace instead of blocking again.
//   * A transcript that exists but cannot be read exits 0 silently (no block).
//   * Any internal error fails open with one stderr trace (runFailOpenHook).
//
// WHAT IT DELIBERATELY DOES NOT COVER
//   * The main loop (no agent_id): its user is present and its text is delivered.
//   * `toolDenialKind` values other than "cancelled" ("user-rejected" is a real answer to a
//     permission prompt), and "cancelled" results whose text is anything else.
//   * Agents with no messaging tool, an empty agent type, and Workflow subagents whose final text
//     the harness itself delivers.
//   * The cause of the abort, and retrying the call: it relays, it does not repair.
//   * A transcript that lags the hook: the transcript file is written asynchronously, so the
//     cancelled result may not be on disk yet when the stop fires. A missed nudge is accepted.
//   * A cancellation older than the last 4 MB of the transcript.
//
// CROSS-PLATFORM VERDICT — pure Node, no shelled-out binary, no /proc. All file access goes through
// lib/host/cancelled-call-relay-files.mjs (plus the shared stdin and home-directory helpers).
//   * node:fs (statSync, openSync/readSync, appendFileSync, openSync 'wx'): available on Linux,
//     macOS and Windows. 'wx' exclusive create is atomic on local filesystems on all three; on a
//     network filesystem it may not be — two racing registrations could then both block once
//     (a duplicated message, never a loop). Any fs error fails open (exit 0, one trace line).
//   * node:path / os home directory: native separators; `~/` expansion matches the model-fallback
//     hook's reading of the same payload field.
//   * State and claim files are created with the process default mode; no POSIX mode is relied on.
//   * Nothing returns a plausible value on an unsupported platform: an unreadable or missing
//     transcript makes it silent (no block), the safe direction.

import { basename, dirname, join } from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'
import { appendJsonl, claimOnce, isRegularFile, parseJsonl, readJsonl, readTailText } from './lib/host/cancelled-call-relay-files.mjs'
import { homeDirectory } from './lib/host/home-directory.mjs'
import { expandHome } from './lib/host/model-fallback-files.mjs'
import { readStdinJson } from './lib/host/read-stdin-json.mjs'
import { pluginName, resolvePluginDataDir } from './lib/plugin-data-dir.mjs'
import { agentHasNoMessagingTool, finalTextIsDeliveredByHarness } from './lib/subagent-delivery-shape.mjs'

const HOOK_NAME = 'wt-cancelled-call-relay-guard-hook.mjs'
const CANCEL_PREFIX = "The user doesn't want to take this action right now"
// How the harness serialises the denial kind in a transcript record (compact JSON, no spaces).
const CANCEL_MARKER = '"toolDenialKind":"cancelled"'
const TAIL_BYTES = 4 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9_-]+$/

function stateDir() {
  return process.env.WT_CANCELLED_CALL_RELAY_DIR
    || resolvePluginDataDir({ fallback: join(homeDirectory(), '.local', 'state', 'wt-cancelled-call-relay'), pluginName: pluginName() }).dir
}

function safe(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-')
}

// The agent's own transcript: the payload field first, then the documented layout
// <session transcript without .jsonl>/subagents/agent-<agent_id>.jsonl — used only if it exists.
function locateTranscript(payload, agentId) {
  const given = expandHome(payload?.agent_transcript_path)
  if (given && /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(basename(given)) && isRegularFile(given)) return given
  const session = expandHome(payload?.transcript_path)
  if (!session) return null
  const derived = join(dirname(session), basename(session, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`)
  return isRegularFile(derived) ? derived : null
}

function contentItems(record) {
  const content = record?.message?.content
  return Array.isArray(content) ? content : []
}

function resultText(item) {
  const c = item?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
  return ''
}

// Both conditions: the denial kind alone also covers other texts, and the text alone can appear
// quoted inside an unrelated tool output.
function cancellationIn(record) {
  if (record?.type !== 'user' || record?.toolDenialKind !== 'cancelled') return null
  for (const item of contentItems(record)) {
    if (item?.type !== 'tool_result' || typeof item.tool_use_id !== 'string') continue
    const text = resultText(item)
    if (text.startsWith(CANCEL_PREFIX)) return { toolUseId: item.tool_use_id, text }
  }
  return null
}

function analyse(records) {
  const toolNames = new Map()
  const sendIdx = []
  const cancellations = []
  const hookCancelled = new Map()
  records.forEach((record, index) => {
    if (record?.type === 'assistant') {
      for (const item of contentItems(record)) {
        if (item?.type !== 'tool_use' || typeof item.id !== 'string') continue
        toolNames.set(item.id, item.name)
        if (item.name === 'SendMessage') sendIdx.push({ index, id: item.id })
      }
    }
    const att = record?.attachment
    if (record?.type === 'attachment' && att?.type === 'hook_cancelled' && typeof att.toolUseID === 'string') {
      hookCancelled.set(att.toolUseID, typeof att.hookName === 'string' ? att.hookName : 'a hook')
    }
    const c = cancellationIn(record)
    if (c) cancellations.push({ ...c, index })
  })
  return { toolNames, sendIdx, cancellations, hookCancelled }
}

// The identity of a stop: the uuid of the last assistant record in view (see LOOP SAFETY), else
// the transcript size when no assistant record carries one.
function stopKey(records, size) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r?.type === 'assistant' && typeof r.uuid === 'string' && r.uuid) return `assistant:${r.uuid}`
  }
  return `size:${size}`
}

// A 'stop' with the same key as the previous kept stop is a duplicate delivery of that event,
// collapsed at read time (the log stays append-only and lock-free).
function collapseDuplicateStops(recs) {
  let lastKey = null
  return recs.filter((r) => {
    if (r.t !== 'stop') return true
    if (lastKey !== null && r.key === lastKey) return false
    lastKey = r.key
    return true
  })
}

function main() {
  const payload = readStdinJson()
  if (payload?.hook_event_name !== 'SubagentStop') return
  const agentId = payload?.agent_id
  if (typeof agentId !== 'string' || !SAFE_ID.test(agentId)) return
  const agentType = typeof payload?.agent_type === 'string' ? payload.agent_type : ''
  if (!agentType) return
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : ''
  if (agentHasNoMessagingTool(agentType, cwd) || finalTextIsDeliveredByHarness(payload)) return

  const transcript = locateTranscript(payload, agentId)
  if (!transcript) return
  const tail = readTailText(transcript, TAIL_BYTES)
  if (tail.error) return // exists but unreadable: silent, the safe direction
  // Cheap pre-check: nothing to do, and nothing recorded, without a cancelled result in view.
  if (!tail.text.includes(CANCEL_MARKER)) return
  const records = parseJsonl(tail.text)

  const sessionId = safe(payload?.session_id)
  const dir = stateDir()
  const log = join(dir, `cancelled-relay-${sessionId}.jsonl`)
  appendJsonl(log, { t: 'stop', agentId, key: stopKey(records, tail.size), at: new Date().toISOString() })

  const { toolNames, sendIdx, cancellations, hookCancelled } = analyse(records)
  const newest = cancellations.at(-1)
  if (!newest) return
  // Already relayed: a SendMessage issued after the cancelled result. (Were that SendMessage
  // cancelled too, it would itself be the newest cancellation.)
  if (sendIdx.some((s) => s.index > newest.index)) return

  const toolName = toolNames.get(newest.toolUseId) ?? 'an unidentified tool'
  const mine = collapseDuplicateStops(readJsonl(log).filter((r) => r.agentId === agentId))

  // The relay itself was cancelled: the newest cancellation is a SendMessage issued after this
  // hook's last nudge, with no SendMessage between them that went through.
  const lastNudge = mine.filter((r) => r.t === 'nudged').at(-1)
  if (lastNudge && toolName === 'SendMessage' && lastNudge.toolUseId !== newest.toolUseId) {
    const nudgedAt = cancellations.find((c) => c.toolUseId === lastNudge.toolUseId)?.index ?? -1
    const cancelledIds = new Set(cancellations.map((c) => c.toolUseId))
    const wentThrough = sendIdx.some((s) => s.index > nudgedAt && s.index < newest.index && !cancelledIds.has(s.id))
    if (nudgedAt < newest.index && !wentThrough) {
      process.stderr.write(`${HOOK_NAME}: a SendMessage sent after this check's nudge was cancelled; not blocking again.\n`)
      return
    }
  }

  // One block per arc: the arc began right after the previous kept stop.
  const stopIdx = mine.reduce((acc, r, i) => (r.t === 'stop' ? [...acc, i] : acc), [])
  const arc = stopIdx.length >= 2 ? mine.slice(stopIdx[stopIdx.length - 2] + 1) : mine
  if (arc.some((r) => r.t === 'nudged')) return

  // Atomic claim, per cancelled call: two racing registrations produce one message.
  if (!claimOnce(join(dir, 'claims', `${sessionId}--${safe(agentId)}--${safe(newest.toolUseId)}`))) return
  appendJsonl(log, { t: 'nudged', agentId, toolUseId: newest.toolUseId, tool: toolName, at: new Date().toISOString() })

  const hookName = hookCancelled.get(newest.toolUseId)
  const provenance = hookName
    ? `The transcript records the hook run on this call (${hookName}) as cancelled; it does not record why.`
    : 'The transcript does not show who or what cancelled it.'
  recordGuardEvent({
    guard: HOOK_NAME,
    decision: 'blocked',
    class: 'cancelled-call-not-relayed',
    reason: `${toolName} call cancelled and not relayed to the spawner`,
    cwd,
    session: payload?.session_id,
    agent: agentId,
    evidence: { tool: toolName, hookCancelled: hookName ? 'yes' : 'no' },
  })
  process.stderr.write(
    'CANCELLED CALL CHECK — a tool call of yours was cancelled and your spawner has not been told.\n' +
    '\n' +
    `Tool: ${toolName}\n` +
    `Result, verbatim: ${newest.text}\n` +
    `${provenance}\n` +
    '\n' +
    'Your plain text reaches nobody. Send ONE SendMessage to the agent that spawned you, one line,\n' +
    'with the tool name and the verbatim text above. Keep your background work (lanes, gates,\n' +
    'watchers) running and do not kill anything because of this result. Then wait for your\n' +
    "spawner's answer.\n" +
    'Relaying is how a delegate waits for instructions: your spawner is the one who can answer, and sending that one line is compatible with stopping your work.\n' +
    '\n' +
    'This check fires once per cancelled call; it will not stop you again for this call.\n',
  )
  process.exitCode = 2
}

runFailOpenHook(HOOK_NAME, main)
