#!/usr/bin/env node
// spawn-registry-scan — read the spawn registry and report what is UNACCOUNTED FOR.
//
// The registry is written by wt-outbound-guard-hook.mjs from hook events. This script only
// READS it. Together they cover what no single hook can:
//
//   * a hook fires when an agent stops        -> the registry closes the entry
//   * NOTHING fires when an agent is frozen, killed, or dies with the machine
//     -> the entry simply stays OPEN, and that silence is the signal this scan surfaces.
//
// That is the whole point: this scan is the only thing that can see the two failure modes the
// harness cannot report. Run it periodically (a /loop) or at the top of a turn. It is also run
// automatically at session start by wt-session-start-registry-hook.mjs, its sibling in this dir.
//
// IT ASKS, IT NEVER CONCLUDES. An agent silent for twenty minutes may be reading a large file,
// waiting on a delegated run, or dead. Nothing here can tell those apart, so the output is phrased
// as a question and names what it does NOT know. A scan that announced deaths would be wrong often
// enough to be ignored, and a signal that gets ignored is worse than no signal.
//
// Usage:
//   node wt-spawn-registry-scan.mjs [--session <id>] [--quiet-min <n>] [--stale-transcript-min <n>] [--cwd <path>] [--json]
//     --session              which session's registry to read (default: the most recently written)
//     --quiet-min            minutes of message-silence before an open agent is a CANDIDATE (default 20)
//     --stale-transcript-min minutes with no transcript growth before a candidate is actually
//                            flagged (default 5) — see LIVENESS below
//     --cwd                  the project cwd used to locate this session's transcripts
//                            (default: process.cwd()) — only used for the liveness check
//     --json                 machine-readable output
//     --ack <name>           mark one agent as dealt with, so later scans stop reporting it
//
// WHY --ack EXISTS. An entry nothing ever closed keeps surfacing, correctly, every single scan.
// That is right the first time and corrosive by the fifth: a signal that repeats what the reader
// has already handled stops being read, and the day it says something true nobody looks. So a
// human verdict is recordable — as one more append-only line, never by editing history. An ack
// says "I looked, this one is dealt with"; it does not say the agent finished, and it is scoped
// to the entry it names, so a LATER spawn of the same name is reported again.
//
// LIVENESS (added after a design objection, same day as the Stop-hook wiring): message-silence
// alone is the WRONG model of this system's real dispatch — an agent that reads code, runs a
// test suite, or awaits a delegated run legitimately sends nothing for a long time; our own
// pilots only speak at milestones. A guard whose model of "silent" means "in trouble" INVERTS on
// exactly that population (see guard-must-model-real-dispatch). So `--quiet-min` alone no longer
// flags: it only makes an entry a CANDIDATE. A candidate is flagged only if its transcript ALSO
// shows no growth for `--stale-transcript-min` — an agent still writing to its own transcript is
// demonstrably alive, which is a strictly better signal than "did it send a message". This mirrors
// the harness's own liveness convention: freshness proves LIFE, never proves death (a transcript
// can go quiet while an agent legitimately waits on a background exec) — so staleness still only
// asks a question, it never asserts a death. See CONFIRMED-ALIVE below for the suppressed set.
//
// Exit codes:  0 = nothing to ask about   ·   1 = at least one open+silent agent   ·   2 = no registry
//              3 = refused ambiguous --ack without --session (new: distinct from "no registry")

import { readFileSync, existsSync, readdirSync, statSync, appendFileSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = process.env.WT_OUTBOUND_GUARD_DIR
  || join(homedir(), '.local', 'state', 'wt-outbound-guard');

const argv = process.argv.slice(2);
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const QUIET_MIN = Number(arg('--quiet-min', '20'));
const STALE_TRANSCRIPT_MIN = Number(arg('--stale-transcript-min', '5'));
const CWD = arg('--cwd', null) || process.cwd();
const AS_JSON = argv.includes('--json');

// ⚠ Where transcripts actually live — VERIFIED against this machine's real directory layout, not
// guessed: `~/.claude/projects/<slug(cwd)>/<sessionId>/subagents/agent-<X>.meta.json` + its
// sibling `.jsonl`. `<X>` is NOT any id already sitting on the spawn record (neither the raw
// `child` nor the normalized `childName`) — a THIRD id shape, unrelated to the other two. The
// meta.json's OWN `name` field is what matches the registry's `childName` exactly; an UNNAMED
// spawn's meta carries no `name` field at all (confirmed on a real one), which is fine — this
// check only ever runs for entries that already passed the `s.name` trackability gate above.
function resolveConfigDir() {
  const raw = process.env.CLAUDE_CONFIG_DIR;
  const base = raw && raw.length > 0 ? raw : join(homedir(), '.claude');
  try { return realpathSync(base); } catch { return base; }
}
function projectSlug(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }
function subagentsDirFor(sessionId) {
  return join(resolveConfigDir(), 'projects', projectSlug(CWD), sessionId, 'subagents');
}
// Minutes since the freshest transcript matching this childName last grew, or null if none is
// found / readable. NEVER a death signal — only ever used to SUPPRESS a false positive when a
// live transcript proves the agent is working; staleness or absence changes nothing, the entry
// is asked about exactly as before.
function transcriptFreshnessMin(sessionId, childName, nowMs) {
  const dir = subagentsDirFor(sessionId);
  if (!existsSync(dir)) return null;
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  let freshest = null;
  for (const f of entries) {
    if (!f.endsWith('.meta.json')) continue;
    let meta;
    try { meta = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (meta?.name !== childName) continue;
    try {
      const m = statSync(join(dir, f.replace(/\.meta\.json$/, '.jsonl'))).mtimeMs;
      if (freshest === null || m > freshest) freshest = m;
    } catch { /* transcript file missing/unreadable — skip this candidate meta */ }
  }
  return freshest === null ? null : (nowMs - freshest) / 60000;
}

if (!existsSync(STATE_DIR)) {
  console.log(`No registry at ${STATE_DIR} — nothing has been recorded yet.`);
  process.exit(2);
}

const requestedSession = arg('--session', null);
const ackName = arg('--ack', null);
const journals = readdirSync(STATE_DIR).filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f: join(STATE_DIR, f), m: statSync(join(STATE_DIR, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);

let file = requestedSession;
if (file) {
  file = join(STATE_DIR, `${file}.jsonl`);
} else {
  if (!journals.length) { console.log('Registry directory is empty.'); process.exit(2); }
  if (ackName && journals.length > 1) {
    console.error(`Refusing ambiguous --ack: found ${journals.length} journals in ${STATE_DIR}; re-run with --session <id>.`);
    process.exit(3);
  }
  file = journals[0].f;
  if (!ackName && journals.length > 1) {
    console.error(`No --session given; using most recent journal: ${file}`);
  }
}
if (!existsSync(file)) { console.log(`No registry file: ${file}`); process.exit(2); }
const sessionId = basename(file, '.jsonl');

// --- acknowledge and exit: append a verdict, change nothing that was already written.
if (ackName) {
  const rec = {
    t: 'ack', name: ackName, at: new Date().toISOString(),
    reason: arg('--reason', null) || undefined,
  };
  appendFileSync(file, JSON.stringify(rec) + '\n');
  console.log(`Acknowledged: ${ackName} (journal: ${file}) — later scans will not report this entry.`);
  console.log('(The entry stays in the log. An ack records that you looked, not that the agent finished.)');
  process.exit(0);
}

const records = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

// Correlate on NAME, never on raw id: the two ends of an edge use different id formats, and an
// id-keyed join silently matches nothing — which reads exactly like a clean board.
//
// DUPLICATE-REGISTRATION SAFETY: a hook registered at BOTH plugin and project level fires every
// event twice, including the 'spawn' record itself (same PostToolUse event, same Agent/Task
// call). `stopped` and `spoke` below are existence/max-by-name lookups — a repeated 'stop' or
// 'out' record for the same name changes nothing they report, so they are duplicate-safe BY
// CONSTRUCTION and need no change. The raw `spawns` list is NOT: iterating it unchanged would
// list the same still-open agent TWICE in `open`/`flagged` below (one entry per duplicate spawn
// record), so it is deduped by childName here — first record wins, repeats dropped.
const SPAWN_DEDUP_WINDOW_MS = 1000;
const spawns = dedupeSpawnsByChild(records.filter((r) => r.t === 'spawn'));
// ⚠ The window is what makes this a DUPLICATE filter rather than a first-wins filter. A double
// registration emits its two copies of the same event within milliseconds; a genuine RE-spawn of
// the same name happens much later and is a different fact. Collapsing by name alone would drop
// the later one — and then an entry acknowledged earlier would keep the name suppressed forever,
// so a real agent relaunched under a reused name would never be reported again. Found by the test
// that relaunches an acked name: it stayed silent when it should have spoken.
function dedupeSpawnsByChild(spawnRecords) {
  const lastAt = new Map();
  const out = [];
  for (const s of spawnRecords) {
    const key = s.childName || s.child;
    if (key) {
      const prev = lastAt.get(key);
      const t = Date.parse(s.at);
      if (prev !== undefined && t - prev < SPAWN_DEDUP_WINDOW_MS) continue;
      lastAt.set(key, t);
    }
    out.push(s);
  }
  return out;
}
const lastByName = (t) => {
  const m = new Map();
  for (const r of records) {
    if (r.t !== t || !r.name) continue;
    const prev = m.get(r.name);
    if (!prev || r.at > prev) m.set(r.name, r.at);
  }
  return m;
};
const stopped = lastByName('stop');
// An acknowledged entry is excluded from the report — the reader has already dealt with it.
const acked = lastByName('ack');
const spoke = lastByName('out');

// ⚠ RAW-ID FALLBACK CORRELATION — needed because name-based correlation silently fails for one
// real spawn shape. A plain `Agent`/`Task` spawn given an explicit `name:` but no teammate/
// isolation registration reports `agent_type` on its OWN stop/out hooks as its underlying
// `subagent_type` (e.g. "general-purpose"), never the explicit name — confirmed on the real
// s-fence-125 incident (2026-08-02): the spawn record carries `child:"aa877ce816e0c2b0f"`,
// `childName:"s-fence-125"`, but every stop/out record for that SAME raw agentId carries
// `name:"general-purpose"`. Name-only correlation (`stopped.has(name)`) never matches, so the
// entry stays open forever even though the agent completed and reported normally. The raw id
// DOES match on both sides for this shape (`stop.agentId === spawn.child`), which a genuine
// named-teammate spawn (raw id shape `name@session-xxx`) does NOT share — so this is a fallback,
// never a replacement: name correlation still covers the teammate shape it was built for.
const lastByAgentId = (t) => {
  const m = new Map();
  for (const r of records) {
    if (r.t !== t || !r.agentId) continue;
    const prev = m.get(r.agentId);
    if (!prev || r.at > prev) m.set(r.agentId, r.at);
  }
  return m;
};
const stoppedById = lastByAgentId('stop');
const spokeById = lastByAgentId('out');

// WAITING-FOR — read side of the convention wt-outbound-guard-hook.mjs writes (see its own
// comment for the wire format and the idempotence/erasure invariants).
//
// ⚠ RESOLVED BY POSITION, NEVER BY TIMESTAMP — same fix shape as the arc-slicing logic in
// wt-outbound-guard-hook.mjs ("Records written in the same millisecond share an `at`, so a time
// comparison drops a record that sits exactly on the boundary"). A cross-family review (opencode
// gpt-5.6-terra) caught the same defect here: two DISTINCT real SendMessage calls landing in the
// same millisecond (plausible — ISO timestamps are millisecond-resolution and two calls can be
// hook-processed back to back) would tie under a `w.at < lastOutboundAt` comparison, and the tie
// resolved toward "still waiting" regardless of which call was ACTUALLY later — silently
// re-opening the exact false-positive class the erasure design exists to close. File order IS
// chronological order for records sharing a name (append-only log, sequential tool calls), so a
// single forward pass that overwrites state on every 'out'/'waiting' record — last write in FILE
// ORDER wins — is immune to millisecond ties. It is also idempotence-safe under duplicate
// registration: replays of the SAME real event write the SAME (type, name) pair again in
// immediate succession, so a chain of identical overwrites lands on the same final value as one.
const waitingState = new Map(); // name -> {artifact, path} | null, walked in file (chronological) order
const waitingStateById = new Map(); // raw agent id fallback, same correlation shape as stop/out
for (const r of records) {
  if (r.t === 'spawn') {
    if (r.childName) waitingState.set(r.childName, null);
    if (r.child) waitingStateById.set(r.child, null);
    continue;
  }
  const next = r.t === 'out' ? null : r.t === 'waiting' ? { artifact: r.artifact ?? null, path: r.path ?? null } : undefined;
  if (next === undefined) continue;
  if (r.name) waitingState.set(r.name, next);
  if (r.agentId) waitingStateById.set(r.agentId, next);
}
function waitingForOf(name, rawAgentId) {
  return waitingState.get(name) || (rawAgentId ? waitingStateById.get(rawAgentId) : null) || null;
}

const now = Date.now();
const open = [];
// Spawns made without a name return no child identity, so nothing can join them to the stop
// record their subordinate produces. They are NOT dropped: a scan that silently omits what it
// cannot follow reports a clean board while blind to part of it — the exact failure this exists
// to catch. They are counted and stated instead, so the reader knows the reach of the answer.
const untrackable = [];
for (const s of spawns) {
  // ⚠ Trackability is decided from `s.name` (the EXPLICIT name given at spawn time), never from
  // `s.childName` alone. An already-written registry can carry the OLD-format bug: a spawn with
  // no explicit name (`name: null`) whose `childName` was wrongly fabricated from the raw child
  // id — a value that looks like a valid handle but can never match what the child later reports
  // itself under. Gating on `s.name` catches those old records too, without needing to know they
  // were buggy: no explicit name was ever given, so the spawn cannot be correlated, full stop.
  const name = s.name ? s.childName : null;
  if (!name) { untrackable.push(s); continue; }
  const stoppedAt = stopped.get(name) || (s.child ? stoppedById.get(s.child) : undefined);
  if (stoppedAt !== undefined) continue;                 // accounted for: it ended
  // Acked AFTER this spawn: a human said they dealt with it. A later spawn of the same name has
  // a newer `at` than the ack and is therefore reported again — the ack settles one entry, not
  // a name forever.
  if (acked.has(name) && acked.get(name) > s.at) continue;
  const spokenAt = spoke.get(name) || (s.child ? spokeById.get(s.child) : undefined);
  const last = spokenAt || s.at;                         // never spoke => silent since birth
  const quietMin = Math.round((now - Date.parse(last)) / 60000);
  // Only worth the directory scan for candidates that would otherwise be flagged — an entry
  // already under QUIET_MIN was never going to be flagged, so its liveness is moot.
  const transcriptFreshMin = quietMin >= QUIET_MIN ? transcriptFreshnessMin(sessionId, name, now) : null;
  open.push({
    name,
    parent: s.parentName || s.parent,
    purpose: s.purpose,
    model: s.model,
    spawnedAt: s.at,
    lastOutbound: spokenAt || null,
    quietMin,
    transcriptFreshMin,
    waitingFor: waitingForOf(name, s.child),
  });
}

// A candidate is CONFIRMED ALIVE when its transcript grew more recently than
// STALE_TRANSCRIPT_MIN — a positive liveness signal that suppresses the false positive instead
// of a threshold bump, which would stay arbitrary and not fix the underlying model.
const isConfirmedAlive = (o) => o.transcriptFreshMin !== null && o.transcriptFreshMin < STALE_TRANSCRIPT_MIN;
const flagged = open.filter((o) => o.quietMin >= QUIET_MIN && !isConfirmedAlive(o)).sort((a, b) => b.quietMin - a.quietMin);
const confirmedAlive = open.filter((o) => o.quietMin >= QUIET_MIN && isConfirmedAlive(o));

// A count alone ("N spawn(s) cannot be followed") is a number with no set: the reader cannot
// judge whether the untracked loss matters without knowing what those spawns WERE. Every field
// used here (subagentType, model, purpose) is already on the spawn record written by
// wt-outbound-guard-hook.mjs — this is READ-ONLY, it changes no record and works retroactively on
// registries written before this change. It must NOT read as "these are tracked after all": the
// blind-spot warning above stays intact, this only names what was lost, not whether it survived.
function untrackableLine(s) {
  const label = s.subagentType || '(unknown type)';
  const modelPart = s.model ? ` (${s.model})` : '';
  const purposePart = s.purpose ? `"${s.purpose}"` : '(no purpose recorded)';
  return `    · ${label}${modelPart} — ${purposePart}  · launched ${s.at}`;
}

if (AS_JSON) {
  console.log(JSON.stringify({
    file, totalSpawns: spawns.length, open: open.length, flagged, confirmedAlive,
    untrackable: untrackable.length,
    untrackableDetail: untrackable.map((s) => ({
      subagentType: s.subagentType ?? null,
      model: s.model ?? null,
      purpose: s.purpose || null,
      spawnedAt: s.at,
    })),
  }, null, 2));
  process.exit(flagged.length ? 1 : 0);
}

console.log(`Registry: ${file}`);
console.log(`${spawns.length} spawn(s) recorded · ${open.length} with no recorded ending · threshold ${QUIET_MIN} min\n`);

if (untrackable.length) {
  console.log(`⚠ ${untrackable.length} spawn(s) cannot be followed individually — they were`);
  console.log('  launched without a name, so nothing identifies the agent they created and no');
  console.log('  stop record can ever be matched to them. They are NOT included in the counts');
  console.log('  above: this scan is blind to whether they ended. Name a spawn to track it.');
  for (const s of untrackable) console.log(untrackableLine(s));
  console.log('');
}

if (confirmedAlive.length) {
  console.log(`${confirmedAlive.length} agent(s) silent by message past ${QUIET_MIN} min but CONFIRMED ALIVE`);
  console.log('(their transcript is still growing) — not asked about:');
  for (const o of confirmedAlive) {
    console.log(`  ${o.name} — transcript touched ~${Math.round(o.transcriptFreshMin)} min ago`);
    if (o.waitingFor) console.log(`    waiting for: ${o.waitingFor.artifact} @ ${o.waitingFor.path}`);
  }
  console.log('');
}

if (!flagged.length) {
  console.log(open.length
    ? `Nothing to ask about: all ${open.length} open agent(s) have spoken within the last ${QUIET_MIN} min, or are confirmed alive by transcript.`
    : 'Nothing open.');
  process.exit(0);
}

console.log(`${flagged.length} agent(s) have no recorded ending, have been silent by message, AND`);
console.log(`show no transcript growth for >= ${STALE_TRANSCRIPT_MIN} min — worth asking about:\n`);
for (const o of flagged) {
  console.log(`  ${o.name}  (launched by ${o.parent})`);
  console.log(`    silent for ~${o.quietMin} min · ${o.lastOutbound ? `last spoke ${o.lastOutbound}` : 'NEVER spoke'}`);
  console.log(`    transcript: ${o.transcriptFreshMin === null ? 'not found (cannot confirm liveness)' : `last grew ~${Math.round(o.transcriptFreshMin)} min ago`}`);
  if (o.purpose) console.log(`    was doing: ${o.purpose}`);
  if (o.waitingFor) console.log(`    waiting for: ${o.waitingFor.artifact} @ ${o.waitingFor.path}`);
  console.log('');
}
console.log('This does NOT mean they are dead. A stale/missing transcript does not PROVE death —');
console.log('an agent awaiting a background exec writes nothing either — it only means this scan');
console.log('has no positive evidence of life, which is exactly why this scan exists to ask, not');
console.log('conclude. The way to tell them apart is to ASK: send each one a message. A substantive');
console.log('reply means it was working; "resumed from transcript" means it had died.');
process.exit(1);
