#!/usr/bin/env node
// registry-heartbeat — the periodic invocation the spawn registry needed, without anyone arming
// anything.
//
// THE GAP THIS CLOSES. wt-session-start-registry-hook.mjs answers "what happened while this
// session was dead" — it fires once, at birth, and says so plainly: it does NOT cover an agent
// going quiet WHILE the session is alive. Closing that gap has always meant a human remembering
// to arm a periodic loop (a /loop, a cron) — discipline wearing a mechanism's clothes, the exact
// pattern this hook exists to remove.
//
// WHY THIS EVENT, AND NO EXTERNAL TIMER. `Stop` fires every single time this session's own turn
// ends, for the entire life of the session — no cron, no systemd timer, nothing to arm, nothing
// to remember. That is also the honest boundary: when Claude Code itself is not running, there is
// no session to wake and no agent in flight for this hook to report on — the gap is empty by
// construction, not silently uncovered. wt-session-start-registry-hook.mjs already covers the one
// moment this hook cannot see (what happened before this session existed); together the two cover
// "dead in the past" and "silent right now", leaving no gap while Claude Code is running at all.
//
// WHAT IT DOES ON A HIT. An agent that is open and has gone silent past the threshold is exactly
// the failure this whole registry exists to surface (measured incident: 6h54 of empty pings,
// nobody looked, because a signal existed but never reached an actor). So a hit BLOCKS the stop —
// the one mechanism available here that hands the finding to something that can ACT, instead of a
// log file nobody opens. The session is forced to read it and can `SendMessage` the flagged
// agent, or run `wt-spawn-registry-scan.mjs --ack <name>` once it has looked — the same contract
// the scan script itself documents ("an ack records that you looked, not that the agent finished").
//
// LOOP SAFETY. A blocked Stop re-enters this same hook with `stop_hook_active: true` (the harness's
// own re-processing pass). On that pass the finding is surfaced as an informational systemMessage
// but never blocks again — one block per stop ATTEMPT, mirroring the same stopHookActive guard
// stop-hook.ts already uses for workflow-audit trouble. The NEXT real stop attempt (a fresh turn)
// can block again if the entry is still open and unacked — the finding stays visible until dealt
// with, it does not get one free pass and then silence.
//
// DEGRADES TO SILENT. Any failure anywhere below — malformed stdin, missing scan script, scan
// timeout/crash — emits `{}` and allows the stop. A guard that can hang a session shut is a worse
// defect than the silence it watches for.
//
// SHIPPED (plugin/bin/): registered on Stop in plugin/.claude-plugin/plugin.json. Reads the
// registry via its sibling wt-spawn-registry-scan.mjs (resolved relative to THIS file, never a
// hardcoded project path).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, 'wt-spawn-registry-scan.mjs');
const QUIET_MIN = process.env.WT_REGISTRY_HEARTBEAT_QUIET_MIN || '20';

function emit(json) {
  process.stdout.write(JSON.stringify(json));
  process.exit(0);
}

let payload = null;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  emit({});
}

try {
  const sessionId = payload?.session_id;
  const stopHookActive = payload?.stop_hook_active === true;
  if (!sessionId || typeof sessionId !== 'string' || !existsSync(SCAN)) emit({});

  const res = spawnSync(
    process.execPath,
    [SCAN, '--session', sessionId, '--quiet-min', QUIET_MIN, '--json'],
    { encoding: 'utf8', timeout: 10_000 }
  );

  // 1 = flagged open+silent agents found. 0 (clean), 2 (no registry yet), or null (timeout/crash)
  // all mean: nothing worth spending this stop over.
  if (res.status !== 1 || !res.stdout) emit({});

  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    emit({});
  }
  const flagged = Array.isArray(data?.flagged) ? data.flagged : [];
  if (flagged.length === 0) emit({});

  const lines = flagged.map(
    (o) =>
      `  - ${o.name} (launched by ${o.parent}) — silent ~${o.quietMin} min` +
      (o.purpose ? `, was doing: ${o.purpose}` : '')
  );
  const reason =
    `${flagged.length} spawned agent(s) have no recorded ending AND have gone silent mid-session ` +
    `(>= ${QUIET_MIN} min). Nothing else fires for a frozen or killed agent — this scan is the ` +
    `only thing that sees it:\n\n${lines.join('\n')}\n\n` +
    'This does NOT mean they are dead: reading a large file, waiting on a delegated run, and a ' +
    'kill all look identical from here. ASK each one (SendMessage) before assuming anything — a ' +
    'substantive reply means it was working, "resumed from transcript" means it had died. Once ' +
    `you have looked, run \`node ${SCAN} --ack <name>\` so this stops repeating for that entry.`;

  if (stopHookActive) emit({ systemMessage: reason }); // already forced through once this attempt
  emit({ decision: 'block', reason });
} catch {
  emit({});
}
