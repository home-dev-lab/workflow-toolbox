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
//   node wt-spawn-registry-scan.mjs [--session <id>] [--quiet-min <n>] [--json]
//     --session     which session's registry to read (default: the most recently written)
//     --quiet-min   minutes of silence before an open agent is worth asking about (default 20)
//     --json        machine-readable output
//     --ack <name>  mark one agent as dealt with, so later scans stop reporting it
//
// WHY --ack EXISTS. An entry nothing ever closed keeps surfacing, correctly, every single scan.
// That is right the first time and corrosive by the fifth: a signal that repeats what the reader
// has already handled stops being read, and the day it says something true nobody looks. So a
// human verdict is recordable — as one more append-only line, never by editing history. An ack
// says "I looked, this one is dealt with"; it does not say the agent finished, and it is scoped
// to the entry it names, so a LATER spawn of the same name is reported again.
//
// Exit codes:  0 = nothing to ask about   ·   1 = at least one open+silent agent   ·   2 = no registry

import { readFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = process.env.WT_OUTBOUND_GUARD_DIR
  || join(homedir(), '.local', 'state', 'wt-outbound-guard');

const argv = process.argv.slice(2);
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const QUIET_MIN = Number(arg('--quiet-min', '20'));
const AS_JSON = argv.includes('--json');

if (!existsSync(STATE_DIR)) {
  console.log(`No registry at ${STATE_DIR} — nothing has been recorded yet.`);
  process.exit(2);
}

let file = arg('--session', null);
if (file) {
  file = join(STATE_DIR, `${file}.jsonl`);
} else {
  const files = readdirSync(STATE_DIR).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f: join(STATE_DIR, f), m: statSync(join(STATE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) { console.log('Registry directory is empty.'); process.exit(2); }
  file = files[0].f;
}
if (!existsSync(file)) { console.log(`No registry file: ${file}`); process.exit(2); }

// --- acknowledge and exit: append a verdict, change nothing that was already written.
const ackName = arg('--ack', null);
if (ackName) {
  const rec = {
    t: 'ack', name: ackName, at: new Date().toISOString(),
    reason: arg('--reason', null) || undefined,
  };
  appendFileSync(file, JSON.stringify(rec) + '\n');
  console.log(`Acknowledged: ${ackName} — later scans will not report this entry.`);
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

const now = Date.now();
const open = [];
// Spawns made without a name return no child identity, so nothing can join them to the stop
// record their subordinate produces. They are NOT dropped: a scan that silently omits what it
// cannot follow reports a clean board while blind to part of it — the exact failure this exists
// to catch. They are counted and stated instead, so the reader knows the reach of the answer.
const untrackable = [];
for (const s of spawns) {
  const name = s.childName;
  if (!name) { untrackable.push(s); continue; }
  if (stopped.has(name)) continue;                       // accounted for: it ended
  // Acked AFTER this spawn: a human said they dealt with it. A later spawn of the same name has
  // a newer `at` than the ack and is therefore reported again — the ack settles one entry, not
  // a name forever.
  if (acked.has(name) && acked.get(name) > s.at) continue;
  const last = spoke.get(name) || s.at;                  // never spoke => silent since birth
  const quietMin = Math.round((now - Date.parse(last)) / 60000);
  open.push({
    name,
    parent: s.parentName || s.parent,
    purpose: s.purpose,
    model: s.model,
    spawnedAt: s.at,
    lastOutbound: spoke.get(name) || null,
    quietMin,
  });
}

const flagged = open.filter((o) => o.quietMin >= QUIET_MIN).sort((a, b) => b.quietMin - a.quietMin);

if (AS_JSON) {
  console.log(JSON.stringify({
    file, totalSpawns: spawns.length, open: open.length, flagged,
    untrackable: untrackable.length,
  }, null, 2));
  process.exit(flagged.length ? 1 : 0);
}

console.log(`Registry: ${file}`);
console.log(`${spawns.length} spawn(s) recorded · ${open.length} with no recorded ending · threshold ${QUIET_MIN} min\n`);

if (untrackable.length) {
  console.log(`⚠ ${untrackable.length} spawn(s) cannot be followed individually — they were`);
  console.log('  launched without a name, so nothing identifies the agent they created and no');
  console.log('  stop record can ever be matched to them. They are NOT included in the counts');
  console.log('  above: this scan is blind to whether they ended. Name a spawn to track it.\n');
}

if (!flagged.length) {
  console.log(open.length
    ? `Nothing to ask about: all ${open.length} open agent(s) have spoken within the last ${QUIET_MIN} min.`
    : 'Nothing open.');
  process.exit(0);
}

console.log(`${flagged.length} agent(s) have no recorded ending AND have been silent — worth asking about:\n`);
for (const o of flagged) {
  console.log(`  ${o.name}  (launched by ${o.parent})`);
  console.log(`    silent for ~${o.quietMin} min · ${o.lastOutbound ? `last spoke ${o.lastOutbound}` : 'NEVER spoke'}`);
  if (o.purpose) console.log(`    was doing: ${o.purpose}`);
  console.log('');
}
console.log('This does NOT mean they are dead. An agent reading a large file, waiting on a');
console.log('delegated run, and one that was killed all look identical from here — nothing');
console.log('fires when an agent is frozen or killed, which is exactly why this scan exists.');
console.log('The way to tell them apart is to ASK: send each one a message. A substantive');
console.log('reply means it was working; "resumed from transcript" means it had died.');
process.exit(1);
