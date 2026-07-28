#!/usr/bin/env node
// Push-time guard: nothing lands in a publishable tree beyond what was actually
// authorized. Computes the commits about to be pushed (remote/branch..ref) and
// checks every one of them against an authorized scope. Exits non-zero and names
// the offending commit(s) if any commit is not covered.
//
// Authorized-scope shapes (pick one):
//   {"commits": ["<sha-or-prefix>", ...]}  — precise per-commit coverage, but the
//     caller must know the SHAs ahead of time (works once commits already exist
//     locally, e.g. right before push). Every entry must be a non-empty string —
//     an empty string is REJECTED at parse time (a bare "" would otherwise match
//     every SHA via startsWith and silently authorize the whole push).
//   {"maxCount": N}                         — coarser: only bounds HOW MANY commits
//     may go out, not WHICH ones. Simpler to author in a brief, but does not catch
//     an authorized-count push that includes an unexpected commit. N must be a
//     finite non-negative integer — non-finite values (e.g. from `1e999`, which
//     JSON/JS silently parses to Infinity) are REJECTED at parse time.
//
// --ref is MANDATORY and must name the EXACT ref about to be pushed (the same
// value the caller is about to pass to `git push <remote> <ref>:...`), never a
// bare assumption of HEAD — a caller that checks against HEAD and then pushes a
// different ref, or that commits more after the check, would otherwise bypass
// this guard entirely. Pass `--ref HEAD` explicitly if HEAD genuinely is what
// is being pushed; the script will not infer it for you.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = { remote: null, branch: null, authorized: null, ref: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remote') out.remote = argv[++i];
    else if (a === '--branch') out.branch = argv[++i];
    else if (a === '--authorized') out.authorized = argv[++i];
    else if (a === '--ref') out.ref = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

const { remote, branch, authorized, ref } = parseArgs(process.argv.slice(2));
if (!remote || !branch || !authorized || !ref) {
  fail(
    'usage: wt-push-scope-check.mjs --remote <name> --branch <branch> --ref <refspec> --authorized <path.json>\n' +
      '  --ref must be the EXACT ref you are about to push (e.g. HEAD, or a branch/tag name) — never omitted or assumed.',
  );
}

let scope;
try {
  scope = JSON.parse(readFileSync(authorized, 'utf8'));
} catch (err) {
  fail(`could not read/parse --authorized JSON at ${authorized}: ${err.message}`);
}

if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
  fail(`--authorized JSON must be an object with "commits" or "maxCount": ${authorized}`);
}

let log;
try {
  log = execFileSync('git', ['log', `${remote}/${branch}..${ref}`, '--oneline'], {
    encoding: 'utf8',
  });
} catch (err) {
  fail(`git log failed (bad remote/branch/ref, or remote ref not fetched?): ${err.message}`);
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

if (Object.prototype.hasOwnProperty.call(scope, 'commits')) {
  const authorizedShas = scope.commits;
  if (!Array.isArray(authorizedShas)) {
    fail(`--authorized "commits" must be an array of strings: ${authorized}`);
  }
  const badEntry = authorizedShas.find((s) => typeof s !== 'string' || s.trim() === '');
  if (badEntry !== undefined) {
    fail(
      `--authorized "commits" entries must be non-empty strings — an empty string ` +
        `matches every SHA via prefix and would authorize the entire push (rejected): ${authorized}`,
    );
  }
  offending = lines.filter((line) => {
    const sha = line.split(/\s+/, 1)[0];
    return !authorizedShas.some((entry) => shaPrefixMatch(sha, entry));
  });
} else if (Object.prototype.hasOwnProperty.call(scope, 'maxCount')) {
  const maxCount = scope.maxCount;
  if (typeof maxCount !== 'number' || !Number.isFinite(maxCount) || !Number.isInteger(maxCount) || maxCount < 0) {
    fail(
      `--authorized "maxCount" must be a finite non-negative integer (got ${String(maxCount)} — ` +
        `values like 1e999 parse to Infinity and would authorize an unlimited push, rejected): ${authorized}`,
    );
  }
  if (lines.length > maxCount) {
    // maxCount mode cannot name WHICH commits are offending (it only bounds
    // the count) — report every commit beyond the authorized count, in push
    // order, as the offending tail.
    offending = lines.slice(maxCount);
  }
} else {
  fail(`--authorized JSON must have "commits" (array) or "maxCount" (number): ${authorized}`);
}

if (offending.length > 0) {
  for (const line of offending) {
    console.error(`UNAUTHORIZED COMMIT: ${line}`);
  }
  console.error(
    `wt-push-scope-check: ${offending.length} unauthorized commit(s) out of ${lines.length} about to be pushed to ${remote}/${branch} (ref=${ref})`,
  );
  process.exit(1);
}

console.log(`wt-push-scope-check: all ${lines.length} commit(s) covered by authorized scope — OK`);
process.exit(0);
