#!/usr/bin/env node
// wt-memory-index-check.mjs — make a silent memory-index ceiling LOUD before
// it swallows the tail of the queue.
//
// An auto-loaded knowledge-base index (e.g. an auto-memory MEMORY.md) is
// truncated by the harness past a line count with no error — entries past
// the cut simply stop existing for every session that loads the index, and
// neither the file nor the session can tell. This probe reports:
//   1. the index's entry-line count against a threshold (a parameter with a
//      default, never a hard-coded harness constant — the exact ceiling is
//      one observation, not a read of the loader's source);
//   2. how many fiches exist on disk vs how many are REACHABLE from the
//      index, following direct links AND, transitively, any `[[slug]]`
//      hub-member references inside a linked fiche's own body;
//   3. the gap, named: "N fiches on disk, M reachable, K invisible".
//
// Point 3 is the actual deliverable. Line-counting alone cannot distinguish
// a COMPRESSED index (fiches still reachable through a hub) from an
// AMPUTATED one (fiches genuinely lost) — a probe that only counts lines
// can be satisfied by deleting entries, which is the defect itself.
//
// The store path is always an argument, never guessed — a tool that knows
// one location only works on one machine.
//
// Usage:
//   wt-memory-index-check.mjs --store <dir> [--threshold 200]
//                              [--index-file MEMORY.md] [--json] [--out <file>]
//
// Exit codes:
//   0 — no index (nothing to check), or index present and clean
//   1 — flagged: index over threshold, and/or fiches on disk unreachable
//   2 — usage error (no --store, bad path, bad --threshold)
import { writeFileSync } from 'node:fs';
import { checkStore } from './lib/memory-index-check-core.mjs';

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { store: null, threshold: 200, indexFile: 'MEMORY.md', json: false, out: null };
  // A flag that takes a value must actually find one — `--index-file` at
  // the end of argv with nothing after it must fail loudly (usage error),
  // never silently fall back to a default because `undefined` happened to
  // coalesce into one downstream.
  const nextValue = (i, flag) => {
    if (i + 1 >= argv.length) fail(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') out.store = nextValue(i++, a);
    else if (a === '--threshold') out.threshold = Number(nextValue(i++, a));
    else if (a === '--index-file') out.indexFile = nextValue(i++, a);
    else if (a === '--json') out.json = true;
    else if (a === '--out') out.out = nextValue(i++, a);
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.store) {
  fail(
    'usage: wt-memory-index-check.mjs --store <dir> [--threshold 200] [--index-file MEMORY.md] [--json] [--out <file>]',
  );
}
if (!Number.isFinite(args.threshold) || args.threshold <= 0) {
  fail(`--threshold must be a positive number, got: ${args.threshold}`);
}

let report;
try {
  report = checkStore(args.store, { threshold: args.threshold, indexFile: args.indexFile });
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

// A bad --out path (a parent dir that doesn't exist, no write permission)
// is a usage problem the caller can fix, not a computed verdict — it must
// exit 2 with a clean message, never crash uncaught with a raw stack trace
// (found by cross-model review: `--out <missing-dir>/out.json` previously
// threw ENOENT past this script's own exit-code contract).
function writeReport(path, text) {
  try {
    writeFileSync(path, text);
  } catch (e) {
    fail(`cannot write --out file: ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
}

if (args.json) {
  const json = JSON.stringify(report, null, 2);
  if (args.out) writeReport(args.out, json);
  else console.log(json);
} else {
  if (!report.hasIndex) {
    console.log(`no index found at ${args.store}/${report.indexFile} — nothing to check (no index convention in use)`);
  } else {
    console.log(
      `index: ${report.entryLines} entry line(s) (threshold applied: ${report.threshold}) — ` +
        `${report.diskFiches} fiche(s) on disk, ${report.reachableFiches} reachable, ` +
        `${report.unreachableFiches.length} invisible`,
    );
    for (const r of report.reasons) console.log(`FLAG: ${r}`);
    for (const f of report.unreachableFiches) console.log(`  unreachable: ${f}`);
  }
  if (args.out) writeReport(args.out, JSON.stringify(report, null, 2));
}

process.exit(report.flagged ? 1 : 0);
