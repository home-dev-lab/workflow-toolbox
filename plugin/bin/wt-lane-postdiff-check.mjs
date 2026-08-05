#!/usr/bin/env node
// Post-lane diff-scope check: after an external executor-lane call, flag any file it
// touched OUTSIDE the set of paths its own brief named — WITHOUT reverting or refusing
// anything. Mechanizes the lesson `lane-edits-files-outside-its-brief`.
//
// Why this exists: the natural review gesture after a delegated increment is to read the
// diff of the files the BRIEF named — those are the ones the reviewer has a hypothesis
// about. An edit outside that set is invisible to that gesture BY CONSTRUCTION, and it
// arrives together with the lane's own "done" report, which reads as cover. A search
// pointed at a set only ever proves things about that set — this tool widens the set back
// to the WHOLE working tree, mechanically, every time.
//
// ⚠ THIS TOOL FLAGS, IT NEVER REFUSES. An unexpected file is not automatically wrong — it
// can be a legitimate consequence the brief did not anticipate. What matters is that it
// becomes a DECISION the caller makes, never a discovery made later by someone else. A
// guard that blocked here would be disabled within the week (see the rule this ships
// under, wt-durable-fix-at-the-right-level.md — "a guard that refuses correct work is
// worse than no guard").
//
// ⚠ "TOUCHED" MEANS CONTENT CHANGED, NOT JUST STATUS CODE CHANGED. A file already dirty
// (e.g. " M") at snapshot time that the lane edits AGAIN stays " M" — the status code alone
// cannot see it. So the snapshot records a content HASH (`git hash-object`) alongside each
// status line, and `check` compares (status, hash) pairs, not status codes alone. A
// status-only comparison was this tool's own first cut and it silently missed exactly this
// case — caught by cross-family review before shipping (see REVIEW below).
//
// ⚠ WHAT THIS DOES NOT COVER, both stated rather than silently missed:
//   - a lane that writes OUTSIDE the working tree (a temp file, a cache, a user config)
//     stays invisible to any `git status`-based check.
//   - a file inside the tree that matches `.gitignore` (build output, `node_modules/`,
//     generated caches) is ALSO invisible. `git status --ignored` would surface it, but
//     that flag recursively scans every ignored path on disk — on an ordinary JS
//     monorepo that means walking `node_modules/`, turning a sub-second advisory check
//     into a multi-second-or-worse one on every single lane call. That cost was judged
//     not worth it for this tool's purpose; name it explicitly if a brief's scope
//     legitimately includes an ignored path.
//   - a lane that COMMITS its out-of-brief edit is ALSO invisible. The comparison is
//     `git status`-based: a file clean at snapshot time, edited by the lane, then
//     committed by the lane, is clean again at check time — it appears in neither
//     snapshot as touched, so this exits 0 on precisely the case where the edit is
//     hardest to undo. Bounded in practice (briefs tell lanes not to commit, and this
//     check is advisory anyway), but "the brief says not to" is the same class of
//     assurance this tool exists to stop relying on. Found in the integrating review
//     of card 1835017482180494996; not yet closed. Cheapest fix: record
//     `git rev-parse HEAD` in the snapshot and compare it at check time — a moved HEAD
//     is a one-line detection, and the range can then widen to `before..HEAD`.
//
// ⚠ SELF-ARTIFACT EXCLUSION: `check` excludes its own --before/--after/@brief-paths files
// from the comparison whenever they were written INSIDE the worktree — otherwise running
// this tool would flag its own snapshot file as a lane edit. This is an accepted,
// documented trade-off, not a fully-closed gap: if the lane happens to ALSO edit one of
// those exact paths in the same window, that edit is invisible too. Prefer writing
// snapshot/brief-paths files OUTSIDE the worktree (e.g. REPORT_DIR) to make the trade-off
// moot rather than relying on it.
//
// Usage — two steps, because a git status snapshot has no memory of its own:
//
//   wt-lane-postdiff-check.mjs snapshot --worktree <dir> --out <file>
//       Capture status+content-hash BEFORE the lane call. Run this first, or every file
//       already modified by the pilot's own work-in-progress gets flagged as if the lane
//       had touched it — noise from the very first use.
//
//   wt-lane-postdiff-check.mjs check --worktree <dir> --before <snapshot-file> \
//       --brief-paths <comma-list|@file> [--after <snapshot-file>]
//       Compare the BEFORE snapshot against the current tree state (or an --after
//       snapshot, for offline/test use) and print every touched path outside the brief.
//
// The --out/--before/--after files are this tool's OWN format: one JSON object per line
// (`{"status","path","origPath","hash","origHash"}`), never hand-authored.
//
// Exit codes (deliberately distinct from "refused" — this tool never refuses):
//   0  ran cleanly, nothing touched outside the brief
//   3  ran cleanly, at least one file touched outside the brief (ADVISORY — read the list)
//   2  usage error, or git/fs itself could not be run (see CROSS-PLATFORM below)
//
// CROSS-PLATFORM verdict:
//   - Shells out to `git`. If `git` is not on PATH, or `--worktree` is not inside a git
//     repository, the underlying call THROWS (ENOENT / non-zero exit) and this tool exits
//     2 with the git error attached — it never silently reports "nothing touched".
//   - Snapshot/read/write I/O failures (permission denied, a directory passed where a file
//     is expected, etc.) are caught and reported the same way — exit 2 with the underlying
//     error, never an uncaught-exception non-2 exit.
//   - `git status --porcelain=v1 -z` paths are RAW BYTES, exactly as they exist on disk,
//     with NO quoting/escaping and NO separator translation of any kind — a documented git
//     guarantee independent of host OS. This tool therefore NEVER normalizes a path git
//     handed back (an earlier revision did, incorrectly turning a literal backslash inside
//     a POSIX filename into a fake directory separator — caught by cross-family review;
//     see the RED-then-GREEN lock in the test suite).
//   - `--brief-paths` entries come from the CALLER and may use OS-native separators (a
//     brief authored on Windows could contain `foo\bar.ts`). This tool NORMALIZES every
//     brief-path entry by converting backslashes to forward slashes before comparing —
//     explicit, not silent-plausible: an un-normalized entry would otherwise never match
//     and every one of its files would be (wrongly) flagged as out-of-brief.
//
// REVIEW: implemented directly by the pilot (small, self-contained — see the card report
// for why the executor lane was not used for implementation); cross-family-reviewed via
// the opencode `openai/gpt-5.6-terra` lane, which found 3 real false-negative classes
// (content-blind status comparison, backslash mis-normalization, ambiguous " -> " parsing
// in human-readable porcelain) — all fixed here, each with a RED-then-GREEN test lock. Two
// lower-severity findings (ignored files, self-artifact exclusion) are documented above as
// deliberate scope decisions rather than fixed in code.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

function usage() {
  return [
    'wt-lane-postdiff-check — flag files an executor lane touched outside its brief',
    '',
    'Usage:',
    '  wt-lane-postdiff-check.mjs snapshot --worktree <dir> --out <file>',
    '  wt-lane-postdiff-check.mjs check --worktree <dir> --before <file> \\',
    '      --brief-paths <comma-list|@file> [--after <file>]',
    '',
    'Exit codes: 0 = nothing out-of-brief · 3 = out-of-brief files found (advisory) · 2 = usage/git/fs error.',
    'This tool never refuses or reverts anything — see the header comment for why.',
  ].join('\n');
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--worktree') out.worktree = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--before') out.before = argv[++i];
    else if (a === '--after') out.after = argv[++i];
    else if (a === '--brief-paths') out.briefPaths = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

// Brief-path entries come from the CALLER (a brief author, possibly on Windows) and are
// the ONLY thing this tool ever normalizes — never a path git itself produced. See the
// CROSS-PLATFORM header comment for why the two are not the same operation.
function normalizeBriefPathSlashes(p) {
  return p.replace(/\\/g, '/');
}

// Parse `git status --porcelain=v1 -z` output (NUL-terminated records, paths raw and
// UNQUOTED — no ambiguity from spaces, newlines, or a literal " -> " inside a filename,
// which the human-readable format cannot safely disambiguate). For a rename/copy record
// (X or Y is 'R' or 'C'), git emits ONE extra NUL-terminated field immediately after:
// the ORIGINAL path.
function parsePorcelainZ(raw) {
  const fields = raw.split('\0');
  if (fields.length && fields[fields.length - 1] === '') fields.pop(); // trailing NUL
  const records = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    const isRenameOrCopy = status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C';
    let origPath = null;
    if (isRenameOrCopy && i + 1 < fields.length) {
      origPath = fields[++i];
    }
    records.push({ status, path, origPath });
  }
  return records;
}

function runGitStatusZ(worktree) {
  try {
    return execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: worktree,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    fail(
      `wt-lane-postdiff-check: could not run "git status" in ${worktree} — is git installed and is this a git worktree?\n${err.message}`,
    );
  }
}

// Batch-hash every path that currently exists on disk via `git hash-object --stdin-paths`
// (one process for the whole batch, not one per file). A path with no on-disk file (a
// deleted-only entry, or a rename's vacated original) gets no hash — content identity is
// undefined for something that is not there.
function hashExistingPaths(worktree, paths) {
  const unique = [...new Set(paths)].filter((p) => existsSync(join(worktree, p)));
  const map = new Map();
  if (unique.length === 0) return map;
  let out;
  try {
    out = execFileSync('git', ['hash-object', '--stdin-paths'], {
      cwd: worktree,
      input: `${unique.join('\n')}\n`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    fail(`wt-lane-postdiff-check: "git hash-object" failed in ${worktree}: ${err.message}`);
  }
  const hashes = out.split('\n').filter(Boolean);
  for (let i = 0; i < unique.length; i++) map.set(unique[i], hashes[i]);
  return map;
}

// Capture the LIVE, enriched status of a worktree: every porcelain record plus a content
// hash for whichever side of it (new path / original path) currently exists on disk.
function captureEnrichedStatus(worktree) {
  const records = parsePorcelainZ(runGitStatusZ(worktree));
  const toHash = [];
  for (const r of records) {
    toHash.push(r.path);
    if (r.origPath) toHash.push(r.origPath);
  }
  const hashes = hashExistingPaths(worktree, toHash);
  return records.map((r) => ({
    status: r.status,
    path: r.path,
    origPath: r.origPath,
    hash: hashes.get(r.path) ?? null,
    origHash: r.origPath ? (hashes.get(r.origPath) ?? null) : null,
  }));
}

function writeSnapshot(filePath, records) {
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  try {
    writeFileSync(filePath, lines ? `${lines}\n` : '', 'utf8');
  } catch (err) {
    fail(`wt-lane-postdiff-check: could not write snapshot to ${filePath}: ${err.message}`);
  }
}

function readSnapshot(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(`wt-lane-postdiff-check: could not read snapshot ${filePath}: ${err.message}`);
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  try {
    return lines.map((l) => JSON.parse(l));
  } catch (err) {
    fail(
      `wt-lane-postdiff-check: ${filePath} is not a valid snapshot (this tool's own ` +
        `JSON-lines format, written by "snapshot" — never hand-authored, and not the raw ` +
        `\`git status --porcelain\` text an earlier revision wrote): ${err.message}`,
    );
  }
}

// A rename's ORIGINAL path is represented as a separate synthetic "removed" entry (hash
// null — content no longer lives there) so it participates in the diff like any other
// vacated path, rather than silently disappearing because it only ever appeared as a
// side-field of the new path's record.
function toPathMap(records) {
  const map = new Map();
  for (const r of records) {
    map.set(r.path, { status: r.status, hash: r.hash });
    if (r.origPath) {
      map.set(r.origPath, { status: `${r.status}(renamed-from)`, hash: null });
    }
  }
  return map;
}

function readBriefPaths(spec) {
  let raw;
  if (spec.startsWith('@')) {
    const filePath = spec.slice(1);
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      fail(`wt-lane-postdiff-check: could not read --brief-paths file ${filePath}: ${err.message}`);
    }
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map(normalizeBriefPathSlashes);
  }
  return spec
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(normalizeBriefPathSlashes);
}

function isCoveredByBrief(filePath, briefPaths) {
  const norm = filePath.replace(/^\.\//, '');
  return briefPaths.some((entry) => {
    const e = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    return norm === e || norm.startsWith(`${e}/`);
  });
}

// If a snapshot/brief-paths FILE was itself written inside the worktree (a natural place
// to put it), it shows up as a brand-new untracked file in the "after" status — a
// self-inflicted false positive. Resolve it to the git-status-style relative path so it
// can be excluded from the comparison; returns null when the path is outside the
// worktree (nothing to exclude). This is the ONLY place a computed path is normalized —
// it comes from OUR OWN filesystem call (node:path.relative), never from git, and on
// Windows that call itself returns backslashes.
function relativeIfInsideWorktree(worktree, filePath) {
  if (!filePath) return null;
  const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const worktreeAbs = resolve(worktree);
  const rel = relative(worktreeAbs, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function diffTouchedPaths(before, after) {
  const touched = new Set();
  for (const [p, a] of after) {
    const b = before.get(p);
    if (!b || b.status !== a.status || b.hash !== a.hash) touched.add(p);
  }
  for (const p of before.keys()) {
    if (!after.has(p)) touched.add(p);
  }
  return [...touched].sort();
}

function cmdSnapshot(args) {
  if (!args.worktree || !args.out) {
    fail('usage: wt-lane-postdiff-check.mjs snapshot --worktree <dir> --out <file>');
  }
  const records = captureEnrichedStatus(args.worktree);
  writeSnapshot(args.out, records);
  console.log(`wt-lane-postdiff-check: snapshot written to ${args.out} (${records.length} record(s))`);
  process.exit(0);
}

function cmdCheck(args) {
  if (!args.worktree || !args.before || !args.briefPaths) {
    fail(
      'usage: wt-lane-postdiff-check.mjs check --worktree <dir> --before <file> --brief-paths <comma-list|@file> [--after <file>]',
    );
  }
  if (!existsSync(args.before)) {
    fail(`wt-lane-postdiff-check: --before snapshot not found: ${args.before}`);
  }
  const beforeRecords = readSnapshot(args.before);
  let afterRecords;
  if (args.after) {
    if (!existsSync(args.after)) {
      fail(`wt-lane-postdiff-check: --after snapshot not found: ${args.after}`);
    }
    afterRecords = readSnapshot(args.after);
  } else {
    afterRecords = captureEnrichedStatus(args.worktree);
  }

  const before = toPathMap(beforeRecords);
  const after = toPathMap(afterRecords);
  const briefPaths = readBriefPaths(args.briefPaths);

  // Exclude this tool's OWN artifacts (the before/after snapshot files, and a @-file
  // brief-paths list) when they happen to live inside the worktree — otherwise the act of
  // running this check creates a false positive against itself.
  const briefPathsFile = args.briefPaths.startsWith('@') ? args.briefPaths.slice(1) : null;
  const selfPaths = [args.before, args.after, briefPathsFile]
    .map((p) => relativeIfInsideWorktree(args.worktree, p))
    .filter(Boolean);
  for (const p of selfPaths) {
    before.delete(p);
    after.delete(p);
  }

  const touched = diffTouchedPaths(before, after);
  const outOfBrief = touched.filter((p) => !isCoveredByBrief(p, briefPaths));

  if (touched.length === 0) {
    console.log('wt-lane-postdiff-check: no changes since the before-snapshot — OK');
    process.exit(0);
  }

  console.log(`wt-lane-postdiff-check: ${touched.length} file(s) touched since the before-snapshot`);
  for (const p of touched) {
    console.log(`  ${outOfBrief.includes(p) ? 'OUT-OF-BRIEF' : 'in-brief     '}  ${p}`);
  }

  if (outOfBrief.length === 0) {
    console.log('wt-lane-postdiff-check: all touched files are covered by the brief — OK');
    process.exit(0);
  }

  console.error(
    `wt-lane-postdiff-check: ${outOfBrief.length} file(s) touched OUTSIDE the brief — this is ADVISORY, nothing was reverted. Review and decide.`,
  );
  process.exit(3);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (args.help || !command) {
  console.log(usage());
  process.exit(args.help ? 0 : 2);
}

if (command === 'snapshot') cmdSnapshot(args);
else if (command === 'check') cmdCheck(args);
else fail(`wt-lane-postdiff-check: unknown command "${command}"\n\n${usage()}`);
