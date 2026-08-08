#!/usr/bin/env node
// pilot-card-reconcile — compare CARDS reputedly taken against PILOTS actually in flight, and
// name the mismatch. The gap this closes is a pilot that dies between
// spawn and its own intake (its first act, moving the card to In Progress) — the card then sits
// claimed while nobody works it, and nothing detects it.
//
// WHY A COMPARISON, NOT A PREVENTIVE MOVE. Having the orchestrator move the card to In Progress
// at spawn time (instead of leaving that to the pilot's own intake) would HIDE this exact case:
// the card would read In Progress with a dead pilot behind it — a board that actively lies is
// worse than one that is merely a few minutes stale. The remedy compares two sets that SHOULD
// agree and names the gap; it never "decides better" on either side.
//
// TWO SETS COMPARED
//   - CARDS  : supplied via --cards <path>, a JSON array of
//              { cardId, title?, list: "InProgress"|"Next", claimedAt: <ISO> }.
//              This script does not talk to the task tracker itself — it is fed a snapshot, so it
//              stays tracker-agnostic (Planka today, anything else tomorrow) and testable without
//              a live board.
//   - PILOTS : derived from the SAME spawn registry wt-outbound-guard-hook.mjs already writes
//              (~/.local/state/wt-outbound-guard/<sessionId>.jsonl). A pilot is "alive" when its
//              spawn record has no matching 'stop' record — using the SAME raw-id fallback
//              correlation as wt-spawn-registry-scan.mjs's own raw-agent-id fix, since
//              a pilot's own spawn shape can hit the identical name-vs-agent_type mismatch.
//
// MATCHING A CARD TO A PILOT. The registry has no first-class "this pilot works this card" link,
// so the match is by SUBSTRING: a spawn's `purpose` (its description, truncated to 160 chars —
// see wt-outbound-guard-hook.mjs) containing the cardId. This is the SAME convention this pilot
// suite's own briefs already follow (a card id named in the spawn description) — no new field.
// A card id absent from every live purpose is exactly the case this script exists to catch.
//
// INTAKE TOLERANCE. A card can be legitimately claimed (list moved, or a pilot just spawned for
// it) for a few minutes before its pilot's own intake act reaches the board — that window is
// bening and MUST NOT be flagged, per the card's own closure criterion ("stay silent during a
// normal intake window"). --tolerance-min (default 5) is that window, applied to claimedAt.
//
// OUTPUT NAMES BOTH SETS COMPARED — a count with no set proves nothing (numbers-carry-their-
// set-and-unit). Exit codes: 0 = no mismatch, 1 = at least one, 2 = no registry found.
//
// SHIPPED (plugin/bin/): standalone, not wired into a hook. INVOCATION POINT (this card's ask
// #3, "who runs it and when") is a deliberate ARBITER CALL, stated here rather than left silent:
// run it from the pilot-orchestrator / main session at board-reconciliation points (wave start,
// wave end, and on any "is this card actually being worked" doubt) — the same moment this very
// wave's orchestrator already did this check BY HAND (a board-reconciliation comment,
// 2026-08-02). A Stop-hook wiring was considered and rejected: unlike the
// registry heartbeat (which the SESSION that spawned an agent can act on directly), reconciling
// cards against pilots is an ORCHESTRATOR-level judgment (which card, which wave) that a generic
// per-session hook has no scope to make correctly — wiring it in would fire on sessions with no
// wave in flight and no cards to compare against.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { handleHelpFlag } from './lib/cli-help.mjs';

const HELP = `wt-pilot-card-reconcile — compare cards reputedly taken against pilots actually
in flight (via the spawn registry), and name the mismatch: a pilot that died between spawn
and its own intake leaves a card claimed while nobody works it.

Usage:
  node wt-pilot-card-reconcile.mjs --cards <path> [--session <id>] [--tolerance-min 5] [--json]
    --cards <path>         JSON array of {cardId, title?, list, claimedAt}
    --session <id>         which session's registry to read (default: most recently modified)
    --tolerance-min <n>    grace window before a claimed card with no live pilot is flagged
    --json                 machine-readable output
`;

const STATE_DIR = process.env.WT_OUTBOUND_GUARD_DIR
  || join(homedir(), '.local', 'state', 'wt-outbound-guard');

const argv = process.argv.slice(2);
handleHelpFlag(argv, HELP);

const KNOWN_FLAGS = new Set(['--cards', '--tolerance-min', '--session', '--json']);
for (const token of argv) {
  if (token.startsWith('--') && !KNOWN_FLAGS.has(token)) {
    console.error(`wt-pilot-card-reconcile: unknown flag '${token}'`);
    process.exit(2);
  }
}

const arg = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const CARDS_PATH = arg('--cards', null);
const TOLERANCE_MIN = Number(arg('--tolerance-min', '5'));
const requestedSession = arg('--session', null);
const AS_JSON = argv.includes('--json');

if (!CARDS_PATH) {
  console.error('Missing --cards <path> (a JSON array of {cardId, title, list, claimedAt}).');
  process.exit(2);
}

let cards;
try {
  cards = JSON.parse(readFileSync(CARDS_PATH, 'utf8'));
  if (!Array.isArray(cards)) throw new Error('not an array');
} catch (e) {
  console.error(`Could not read/parse --cards ${CARDS_PATH}: ${e?.message ?? e}`);
  process.exit(2);
}

if (!existsSync(STATE_DIR)) {
  console.log(`No registry at ${STATE_DIR} — nothing has been recorded yet.`);
  process.exit(2);
}

let file = requestedSession ? join(STATE_DIR, `${requestedSession}.jsonl`) : null;
if (!file) {
  const journals = readdirSync(STATE_DIR).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f: join(STATE_DIR, f), m: statSync(join(STATE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!journals.length) { console.log('Registry directory is empty.'); process.exit(2); }
  file = journals[0].f;
  console.error(`No --session given; using most recent journal: ${file}`);
}
if (!existsSync(file)) { console.log(`No registry file: ${file}`); process.exit(2); }

const records = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const spawns = records.filter((r) => r.t === 'spawn');

// Same raw-id fallback as wt-spawn-registry-scan.mjs's own fix: a stop
// record's `name` field can carry the underlying subagent_type instead of the explicit spawn
// name for a plain non-teammate Agent-tool spawn, so correlate on raw agentId too.
const lastByName = (t) => {
  const m = new Map();
  for (const r of records) {
    if (r.t !== t || !r.name) continue;
    const prev = m.get(r.name);
    if (!prev || r.at > prev) m.set(r.name, r.at);
  }
  return m;
};
const lastByAgentId = (t) => {
  const m = new Map();
  for (const r of records) {
    if (r.t !== t || !r.agentId) continue;
    const prev = m.get(r.agentId);
    if (!prev || r.at > prev) m.set(r.agentId, r.at);
  }
  return m;
};
const stoppedByName = lastByName('stop');
const stoppedById = lastByAgentId('stop');

function isAlive(s) {
  const name = s.name ? s.childName : null;
  if (name && stoppedByName.has(name)) return false;
  if (s.child && stoppedById.has(s.child)) return false;
  return true;
}

const alivePilots = spawns.filter(isAlive);

const now = Date.now();
const mismatches = [];

// Cards claimed with no live pilot found, past the intake tolerance.
for (const c of cards) {
  if (!c.cardId || !c.claimedAt) continue;
  const claimedMinAgo = (now - Date.parse(c.claimedAt)) / 60000;
  if (claimedMinAgo < TOLERANCE_MIN) continue; // still inside the benign intake window
  const matchingPilot = alivePilots.find((s) => typeof s.purpose === 'string' && s.purpose.includes(c.cardId));
  if (!matchingPilot) {
    mismatches.push({
      kind: 'card-claimed-no-live-pilot',
      cardId: c.cardId,
      title: c.title || null,
      list: c.list,
      claimedAt: c.claimedAt,
      claimedMinAgo: Math.round(claimedMinAgo),
    });
  }
}

// Live pilots whose purpose names no card in the supplied set at all.
const cardIds = new Set(cards.map((c) => c.cardId).filter(Boolean));
for (const s of alivePilots) {
  const name = s.name ? s.childName : null;
  if (!name) continue; // untrackable spawns are out of scope here, same reach limit as the scan
  const purpose = typeof s.purpose === 'string' ? s.purpose : '';
  const referencesAnyCard = [...cardIds].some((id) => purpose.includes(id));
  if (!referencesAnyCard) {
    const spawnedMinAgo = (now - Date.parse(s.at)) / 60000;
    if (spawnedMinAgo < TOLERANCE_MIN) continue; // symmetric tolerance: pilot just spawned
    mismatches.push({
      kind: 'live-pilot-no-claimed-card',
      pilotName: name,
      purpose: s.purpose || null,
      spawnedAt: s.at,
      spawnedMinAgo: Math.round(spawnedMinAgo),
    });
  }
}

const result = {
  file,
  toleranceMin: TOLERANCE_MIN,
  cardsChecked: cards.map((c) => c.cardId),
  pilotsAlive: alivePilots.map((s) => (s.name ? s.childName : `(untrackable:${s.child})`)),
  mismatches,
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(mismatches.length ? 1 : 0);
}

console.log(`Registry: ${file}`);
console.log(`Cards checked (${result.cardsChecked.length}): ${result.cardsChecked.join(', ') || '(none)'}`);
console.log(`Pilots alive (${result.pilotsAlive.length}): ${result.pilotsAlive.join(', ') || '(none)'}`);
console.log('');

if (!mismatches.length) {
  console.log('No mismatch: every claimed card past the intake window has a live pilot, and every live pilot references a claimed card.');
  process.exit(0);
}

console.log(`${mismatches.length} mismatch(es):\n`);
for (const m of mismatches) {
  if (m.kind === 'card-claimed-no-live-pilot') {
    console.log(`  CARD ${m.cardId}${m.title ? ` (${m.title})` : ''} — claimed in ${m.list} ~${m.claimedMinAgo} min ago, NO live pilot references it.`);
  } else {
    console.log(`  PILOT ${m.pilotName} — spawned ~${m.spawnedMinAgo} min ago, purpose does not reference any of the checked cards${m.purpose ? ` (purpose: "${m.purpose}")` : ''}.`);
  }
}
process.exit(1);
