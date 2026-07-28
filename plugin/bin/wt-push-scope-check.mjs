#!/usr/bin/env node
// Push-time guard: nothing lands in a publishable tree beyond what was actually
// authorized. Computes the commits about to be pushed (remote/branch..HEAD) and
// checks every one of them against an authorized scope. Exits non-zero and names
// the offending commit(s) if any commit is not covered.
//
// Authorized-scope shapes (pick one):
//   {"commits": ["<sha-or-prefix>", ...]}  — precise per-commit coverage, but the
//     caller must know the SHAs ahead of time (works once commits already exist
//     locally, e.g. right before push).
//   {"maxCount": N}                         — coarser: only bounds HOW MANY commits
//     may go out, not WHICH ones. Simpler to author in a brief, but does not catch
//     an authorized-count push that includes an unexpected commit.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = { remote: null, branch: null, authorized: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remote') out.remote = argv[++i];
    else if (a === '--branch') out.branch = argv[++i];
    else if (a === '--authorized') out.authorized = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

const { remote, branch, authorized } = parseArgs(process.argv.slice(2));
if (!remote || !branch || !authorized) {
  fail('usage: wt-push-scope-check.mjs --remote <name> --branch <branch> --authorized <path.json>');
}

let scope;
try {
  scope = JSON.parse(readFileSync(authorized, 'utf8'));
} catch (err) {
  fail(`could not read/parse --authorized JSON at ${authorized}: ${err.message}`);
}

let log;
try {
  log = execFileSync('git', ['log', `${remote}/${branch}..HEAD`, '--oneline'], {
    encoding: 'utf8',
  });
} catch (err) {
  fail(`git log failed (bad remote/branch, or remote ref not fetched?): ${err.message}`);
}

const lines = log.split('\n').map((l) => l.trim()).filter(Boolean);

if (lines.length === 0) {
  console.log('wt-push-scope-check: no commits to push — OK');
  process.exit(0);
}

function shaPrefixMatch(sha, entry) {
  return sha.startsWith(entry) || entry.startsWith(sha);
}

let offending = [];

if (Array.isArray(scope.commits)) {
  const authorizedShas = scope.commits;
  offending = lines.filter((line) => {
    const sha = line.split(/\s+/, 1)[0];
    return !authorizedShas.some((entry) => shaPrefixMatch(sha, entry));
  });
} else if (typeof scope.maxCount === 'number') {
  if (lines.length > scope.maxCount) {
    // maxCount mode cannot name WHICH commits are offending (it only bounds
    // the count) — report every commit beyond the authorized count, in push
    // order, as the offending tail.
    offending = lines.slice(scope.maxCount);
  }
} else {
  fail(`--authorized JSON must have "commits" (array) or "maxCount" (number): ${authorized}`);
}

if (offending.length > 0) {
  for (const line of offending) {
    console.error(`UNAUTHORIZED COMMIT: ${line}`);
  }
  console.error(
    `wt-push-scope-check: ${offending.length} unauthorized commit(s) out of ${lines.length} about to be pushed to ${remote}/${branch}`,
  );
  process.exit(1);
}

console.log(`wt-push-scope-check: all ${lines.length} commit(s) covered by authorized scope — OK`);
process.exit(0);
