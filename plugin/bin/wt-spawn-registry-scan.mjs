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
//
// Exit codes:  0 = nothing to ask about   ·   1 = at least one open+silent agent   ·   2 = no registry

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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
const spawns = dedupeSpawnsByChild(records.filter((r) => r.t === 'spawn'));
function dedupeSpawnsByChild(spawnRecords) {
  const seen = new Set();
  const out = [];
  for (const s of spawnRecords) {
    const key = s.childName || s.child;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
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
const spoke = lastByName('out');

const now = Date.now();
const open = [];
for (const s of spawns) {
  const name = s.childName;
  if (!name) continue;
  if (stopped.has(name)) continue;                       // accounted for: it ended
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
  console.log(JSON.stringify({ file, totalSpawns: spawns.length, open: open.length, flagged }, null, 2));
  process.exit(flagged.length ? 1 : 0);
}

console.log(`Registry: ${file}`);
console.log(`${spawns.length} spawn(s) recorded · ${open.length} with no recorded ending · threshold ${QUIET_MIN} min\n`);

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
