#!/usr/bin/env node
// wt-stale-date-guard.mjs — scan markdown files for absolute dates and flag
// any OPERATIONAL DEADLINE that has already passed, without flagging the far
// more common PROVENANCE date ("measured on 31/07") that never expires.
// See plugin/bin/lib/stale-date-guard-core.mjs for the classification
// heuristic and why the two must never be conflated.
//
// This tool takes no project-specific paths by default — the targets (a
// user's ~/.claude/rules, a project's own rule dir, a memory-fiche dir) are
// this machine's calibration, passed as arguments, never hard-coded here.
//
// Usage:
//   wt-stale-date-guard.mjs --path <dir-or-file> [--path <dir-or-file> ...]
//                            [--today YYYY-MM-DD] [--json] [--out <file>]
//                            [--fail-on-unknown]
//
// Exit codes:
//   0 — no stale deadline found (unknowns may still exist; see stderr/JSON)
//   1 — at least one stale deadline found
//   2 — usage error (no --path given, bad --today, unreadable path)
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { scanText } from './lib/stale-date-guard-core.mjs';
import { handleHelpFlag } from './lib/cli-help.mjs';

const HELP = `wt-stale-date-guard — scan markdown files for absolute dates and flag any
OPERATIONAL DEADLINE that has already passed, without flagging a PROVENANCE date
("measured on 31/07") that never expires. Targets are always passed as arguments, never
hard-coded, so this tool works on any user's rules/memory dir.

Usage:
  wt-stale-date-guard.mjs --path <dir-or-file> [--path <dir-or-file> ...]
                           [--today YYYY-MM-DD] [--json] [--out <file>] [--fail-on-unknown]

Exit codes: 0 no stale deadline found (unknowns may still exist) · 1 at least one stale
deadline found · 2 usage error.
`;

function parseArgs(argv) {
  handleHelpFlag(argv, HELP);
  const out = { paths: [], today: null, json: false, out: null, failOnUnknown: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') out.paths.push(argv[++i]);
    else if (a === '--today') out.today = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--fail-on-unknown') out.failOnUnknown = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function parseTodayArg(s) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s);
  if (!m) fail(`--today must be YYYY-MM-DD, got: ${s}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function collectMarkdownFiles(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    fail(`cannot stat path: ${path}`);
  }
  if (st.isFile()) return extname(path) === '.md' ? [path] : [];
  const out = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdownFiles(full));
    else if (extname(entry.name) === '.md') out.push(full);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.paths.length === 0) {
  fail(
    'usage: wt-stale-date-guard.mjs --path <dir-or-file> [--path ...] [--today YYYY-MM-DD] [--json] [--out <file>] [--fail-on-unknown]',
  );
}
const today = args.today ? parseTodayArg(args.today) : undefined;

const files = args.paths.flatMap(collectMarkdownFiles);
const results = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    fail(`cannot read file: ${file} (${e.message})`);
  }
  const findings = scanText(text, today ? { today } : {});
  for (const f of findings) results.push({ file, ...f });
}

const staleDeadlines = results.filter((r) => r.kind === 'deadline' && r.stale);
const liveDeadlines = results.filter((r) => r.kind === 'deadline' && !r.stale);
const unknowns = results.filter((r) => r.kind === 'unknown');
const provenanceCount = results.filter((r) => r.kind === 'provenance').length;

const report = {
  scannedFiles: files.length,
  totalDates: results.length,
  provenance: provenanceCount,
  liveDeadlines: liveDeadlines.length,
  staleDeadlines: staleDeadlines.map(({ file, line, column, raw, window }) => ({
    file,
    line,
    column,
    raw,
    window,
  })),
  unknowns: unknowns.map(({ file, line, column, raw, window }) => ({ file, line, column, raw, window })),
};

if (args.json) {
  const json = JSON.stringify(report, null, 2);
  if (args.out) writeFileSync(args.out, json);
  else console.log(json);
} else {
  console.log(
    `scanned ${report.scannedFiles} file(s), ${report.totalDates} date(s): ` +
      `${report.provenance} provenance, ${report.liveDeadlines} live deadline(s), ` +
      `${report.staleDeadlines.length} STALE deadline(s), ${report.unknowns.length} unknown (needs triage)`,
  );
  for (const s of report.staleDeadlines) {
    console.log(`STALE DEADLINE: ${s.file}:${s.line}:${s.column} "${s.raw}" — ${s.window}`);
  }
  for (const u of report.unknowns) {
    console.log(`UNKNOWN (triage): ${u.file}:${u.line}:${u.column} "${u.raw}" — ${u.window}`);
  }
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
}

if (staleDeadlines.length > 0) process.exit(1);
if (args.failOnUnknown && unknowns.length > 0) process.exit(1);
process.exit(0);
