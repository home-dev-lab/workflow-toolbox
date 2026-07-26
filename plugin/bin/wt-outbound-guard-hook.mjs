#!/usr/bin/env node
// outbound-guard — two jobs, one script, driven entirely by hooks.
//
//   1. REGISTER the spawn edge (who launched whom), so anyone can later ask "which of the
//      agents I started are still unaccounted for?"
//   2. NUDGE a sub-agent about to finish WITHOUT having delivered anything.
//
// WHY
// An agent's plain assistant text reaches nobody: only a message it SENDS leaves its
// transcript. Agents fail this repeatedly — and, measured rather than guessed, not because they
// believe they delivered, but because the question never arises before the turn ends. Three
// agents in one evening; each said afterwards, in its own words, "the question did not come up".
// A prose clause cannot fix a question that is never asked. A hook can: it fires whether or not
// anyone thought about it.
//
// WHY THE REGISTRY IS POSSIBLE AT ALL
// No hook payload names an agent's PARENT (feature request #24505, closed not-planned). It does
// not need to: the spawner IS the caller, and the caller is named in `agent_id` on its own
// PostToolUse record — with the child's id returned in `tool_response`. One record carries both
// ends of the edge. Measured, not assumed.
//
// HOW IT DEGRADES — the property that makes it trustworthy
// Every way a closing mechanism can fail leaves the entry OPEN, and an open entry is exactly the
// signal being looked for. Killed process, quota wall, machine death: nothing writes a close, so
// the record stands there unanswered. This guard never goes quiet when it breaks.
//
// SAFETY — the guard's OWN failure modes, which are the ones people skip:
//   * At most ONE nudge per agent per session. A guard that can block twice can block forever.
//   * The main loop is never nudged (its plain text IS delivered) — but its spawns ARE recorded.
//   * Any internal error exits 0. A guard that breaks agents is worse than the defect it guards.
//   * It nudges and records; it never blocks permanently and never rewrites anything.
//
// A NUDGE STATES AN OBSERVATION, NOT A VERDICT. It cannot know whether the agent had anything
// worth sending — only that nothing left. So it says what it sees, and how to proceed either way.
//
// SHIPPED (plugin/bin/): registered on PostToolUse (SendMessage|Agent|Task) and
// SubagentStop in plugin/.claude-plugin/plugin.json — see spawn-registry-scan.mjs (reads the
// registry this hook writes) and wt-session-start-registry-hook.mjs (runs that scan at session
// start, from this same directory).

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = process.env.WT_OUTBOUND_GUARD_DIR
  || join(homedir(), '.local', 'state', 'wt-outbound-guard');

// Deliberately NARROW — and narrowed twice, both times by reading the guard's own records.
//
// `Edit` was excluded first: editing source files is WORK, not REPORTING, and counting it as
// delivery opens the very hole this closes — an implementer that modifies twenty files and then
// ends in prose would look "delivered". The one agent the guard failed to nudge, on its first
// live run, was the one editing.
//
// `Write` was excluded next, for the same reason one level up: writing a working file is not
// reporting either. An agent that produced files in a scratch directory and then went silent
// looked delivered and slipped through. And the file-report contract this guard exists to
// enforce requires BOTH halves — the report written AND a one-line message saying it exists.
// An agent that wrote but never sent has broken that contract, not half-satisfied it.
//
// So the signal is the one that actually reaches somebody: a message. The cost of the strictness
// is that an agent which genuinely had nothing to say is stopped once; the cost of the laxity was
// silence about agents that had a great deal to say. Erring toward one wasted turn is correct.
const OUTBOUND_TOOLS = new Set(['SendMessage']);
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

// DOUBLE REGISTRATION: nothing stops an adopter from ALSO registering this same hook at project
// level on top of the plugin-level registration — a natural mistake nobody notices, and it makes
// every hook event fire TWICE. Two 'stop' records per real stop corrupts the arc math further
// down (resolveArc-style slicing by `stopIdx` position): the duplicate is itself a 'stop' entry,
// so it shifts which index counts as "the previous stop" — sometimes collapsing the retry window
// to almost nothing, sometimes reopening an already-nudged window and firing a SECOND nudge on a
// still-silent agent, which the header above calls out as the one thing this guard must never do.
//
// FIX SHAPE: do not try to prevent the duplicate WRITE. Two hook processes racing on the same
// event both read the log before either appends, so any check-then-write guard is a TOCTOU race,
// and a lock file just adds a new crash-orphan failure mode. Instead the log stays append-only
// and lock-free, and duplicates are tolerated in the log and collapsed at READ time, wherever
// 'stop' records feed the arc math — for both a just-appended record and any duplicate already
// sitting in the log from a past event.
//
// WHY A TIME WINDOW AND NOT AN ID: PostToolUse hooks carry a genuinely unique `tool_use_id`
// (captured below on 'out' records) — but SubagentStop does not. Checked against the SDK's
// SubagentStopHookInput type: session_id/agent_id/agent_type/transcript_path/
// last_assistant_message/stop_hook_active/background_tasks, no per-invocation id anywhere on it.
// A real agent does not legitimately stop twice inside one second, so the window is the only
// signal available here, and a second is ample margin for two racing hook processes.
const STOP_DEDUP_WINDOW_MS = 1000;

// Drop any 'stop' record landing within STOP_DEDUP_WINDOW_MS of the immediately preceding KEPT
// 'stop' record — a duplicate delivery of the same real event. Non-stop records (out / nudged /
// spawn) pass through untouched and do NOT reset the window: a 'nudged' record written between
// two duplicate stops must not make the second stop look "far enough away" to survive.
function collapseDuplicateStops(recs) {
  let lastKeptAt = null;
  return recs.filter((r) => {
    if (r.t !== 'stop') return true;
    const t = Date.parse(r.at);
    if (lastKeptAt !== null && t - lastKeptAt < STOP_DEDUP_WINDOW_MS) return false;
    lastKeptAt = t;
    return true;
  });
}

const MAIN = '(main-loop)';

// ⚠ THE TWO ENDS OF AN EDGE DO NOT SHARE AN ID FORMAT — this cost a silent bug once already.
// A spawn's tool_response returns  "poc-spawn-shape@session-bd44b46b"
// while that same agent's own hooks report agent_id  "apoc-spawn-shape-ad9fb384ef5a7ae7".
// Correlating on the raw id therefore NEVER matches, and a registry that never matches looks
// exactly like a registry where nothing is wrong. So every record also carries a normalized
// NAME, and readers correlate on that.
function normalizeName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw;
  const at = s.indexOf('@');            // "name@session-xxxx" -> "name"
  if (at > 0) s = s.slice(0, at);
  else {
    s = s.replace(/^a/, '');            // "a<name>-<hex>" -> "<name>"
    s = s.replace(/-[0-9a-f]{12,}$/i, '');
  }
  return s || null;
}

function stateFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-');
  return join(STATE_DIR, `${safe}.jsonl`);
}

function readRecords(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function append(file, record) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + '\n');
}

let payload = null;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

try {
  const event = payload?.hook_event_name;
  const agentId = payload?.agent_id;          // absent => this turn belongs to the main loop
  const sessionId = payload?.session_id;
  const file = stateFile(sessionId);
  const now = new Date().toISOString();

  // ---- 1. spawn edges. Recorded for EVERY spawner, main loop included: main launches most
  // agents, so gating this behind agent_id would miss almost every birth.
  if (event === 'PostToolUse' && SPAWN_TOOLS.has(payload?.tool_name)) {
    const resp = payload?.tool_response;
    const child = resp?.agent_id ?? resp?.teammate_id ?? resp?.agentId ?? null;
    const childName = normalizeName(payload?.tool_input?.name ?? child);

    // ⚠ AN UNNAMED SPAWN CANNOT BE CORRELATED, AND MUST NOT BE DROPPED FOR IT.
    // A spawn made without a `name` returns no child identity, so nothing can later join it to
    // the stop record its subordinate will produce. The tempting shortcut is to skip the record
    // — and that is precisely the failure this guard exists to prevent: the registry would go
    // quiet about the very spawns it cannot follow, and a reader would see a clean board.
    // So it is recorded anyway, flagged as untrackable, and the response's shape is captured so
    // a later reader can see what identity WAS on offer rather than re-guessing.
    const untrackable = !childName;
    append(file, {
      t: 'spawn',
      parent: agentId ?? MAIN,
      parentName: agentId ? normalizeName(agentId) : MAIN,
      child,
      childName,
      untrackable: untrackable || undefined,
      responseKeys: untrackable && resp && typeof resp === 'object'
        ? Object.keys(resp).sort().slice(0, 20) : undefined,
      name: payload?.tool_input?.name ?? resp?.name ?? null,
      subagentType: payload?.tool_input?.subagent_type ?? null,
      model: payload?.tool_input?.model ?? null,
      purpose: typeof payload?.tool_input?.description === 'string'
        ? payload.tool_input.description.slice(0, 160) : null,
      at: now,
    });
    process.exit(0);
  }

  // Everything below concerns a SUB-AGENT's own turn. The main loop's text is delivered.
  if (!agentId) process.exit(0);

  // ---- 2. outbound acts: this agent made something leave its transcript.
  if (event === 'PostToolUse') {
    if (OUTBOUND_TOOLS.has(payload?.tool_name)) {
      // toolUseId is captured for a future reader that needs exact-duplicate detection on 'out'
      // records; the arc logic below only tests EXISTENCE of an 'out' record in the window, so a
      // duplicate 'out' (same double-registration) doesn't corrupt anything and needs no collapse.
      append(file, {
        t: 'out', agentId, name: normalizeName(payload?.agent_type ?? agentId),
        tool: payload.tool_name, toolUseId: payload?.tool_use_id ?? null, at: now,
      });
    }
    process.exit(0);
  }

  // ---- 3. the agent is finishing. Did anything ever leave?
  if (event === 'SubagentStop' || event === 'Stop' || event === 'StopFailure') {
    append(file, {
      t: 'stop', agentId, name: normalizeName(payload?.agent_type ?? agentId), event, at: now,
    });

    // Scope the question to THIS ARC, not to the agent's whole life. "Has it ever delivered?"
    // lets an agent that reported once and then went silent on a follow-up slip through —
    // observed live, on the second instruction of a two-instruction arc. The arc boundary is
    // the previous stop; the current stop was just appended, so drop it and look back to the
    // one before.
    // Slice the arc by POSITION, never by timestamp. Records written in the same millisecond
    // share an `at`, so a time comparison drops a record that sits exactly on the boundary —
    // which made the guard nudge the same silent arc twice. Insertion order is exact; the log
    // is append-only, so index order IS chronological order.
    //
    // collapseDuplicateStops() runs FIRST, over this agent's whole history, not just the current
    // event: a duplicate 'stop' from an earlier arc left sitting in the log would otherwise still
    // count toward `stopIdx`, shifting which stop is "the previous one" for every later arc, not
    // only the one it duplicated.
    const mine = collapseDuplicateStops(readRecords(file).filter((r) => r.agentId === agentId));
    const stopIdx = mine.reduce((acc, r, i) => (r.t === 'stop' ? [...acc, i] : acc), []);
    // The last stop is the one just appended; the arc began right after the stop before it.
    const arc = stopIdx.length >= 2 ? mine.slice(stopIdx[stopIdx.length - 2] + 1) : mine;

    // Delivered during this arc: nothing to say. Already nudged during this arc: say nothing
    // again — one nudge per arc is what makes a loop impossible.
    if (arc.some((r) => r.t === 'out') || arc.some((r) => r.t === 'nudged')) process.exit(0);

    append(file, {
      t: 'nudged', agentId, name: normalizeName(payload?.agent_type ?? agentId), event, at: now,
    });

    process.stderr.write(
      'OUTBOUND CHECK — nothing you produced has left your transcript.\n' +
      '\n' +
      'You sent no message during this arc. Your plain assistant text is delivered to\n' +
      'nobody, and a file you wrote is not a report until someone is told it exists. If you\n' +
      'have a report, a status, a decision, an escalation, a question or a finding, it has\n' +
      'not reached anyone.\n' +
      '\n' +
      'Send it now with SendMessage. If your contract also asks for a report FILE, write it\n' +
      'AND send the one line saying where it is — the file alone does not close the loop.\n' +
      'Filename caution: a sub-agent\n' +
      'cannot write a .md file whose name STARTS with report/summary/findings/analysis — the\n' +
      'harness refuses it. Put the word at the end instead: <something>-report.md\n' +
      '\n' +
      'If you genuinely had nothing to deliver, just end your turn again — this check fires\n' +
      'only once and will not stop you a second time.\n'
    );
    process.exit(2); // block the stop; stderr goes back to the model
  }

  process.exit(0);
} catch {
  process.exit(0); // never let this guard break an agent
}
