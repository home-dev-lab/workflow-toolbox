#!/usr/bin/env node
// This answers WHICH commits go out; the release-push evidence guard independently answers whether the release commit was gated.
// Push-time guard: nothing lands in a publishable tree beyond what was actually
// authorized. Computes the commits the push puts on its DESTINATION ref that were not
// there, and checks every one of them against an authorized scope:
//   - EXISTING destination ref (non-zero --remote-sha, or --branch found on the remote):
//     the commits of --ref not reachable from that ref's current tip. History the remote
//     already holds on ANOTHER ref still needs authorization to land here.
//   - NEW destination ref (all-zero --remote-sha, or --branch absent from the remote):
//     the commits of --ref not reachable from any branch or tag the remote advertises
//     (`git ls-remote --heads --tags <push url>`), since nothing else is transferred.
// Exits 1 and names the offending commit(s) if any commit is not covered, and exits 2
// whenever it cannot measure (remote unlisted, destination tip not in this clone, a
// non-commit --ref, a git failure) — fail-closed, never a pass.
// Every git call runs with --no-replace-objects: a replace ref could otherwise make a
// new commit look like a published one.
//
// Authorized-scope shapes (pick one):
//   {"commits": ["<sha-or-prefix>", ...]}  — precise per-commit coverage, but the
//     caller must know the SHAs ahead of time (works once commits already exist
//     locally, e.g. right before push). Every entry must be at least 7 hex digits:
//     a shorter prefix (the empty string included) would match many commits and
//     silently authorize them.
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
import { runPrePush } from './lib/host/push-guard-runtime.mjs';

const HELP = `wt-push-scope-check — push-time guard: nothing lands in a publishable tree beyond
what was actually authorized. Computes the commits the push puts on its destination ref and
checks every one against an authorized scope ({"commits":[...]} or {"maxCount":N}).

Usage:
  wt-push-scope-check.mjs --remote <name> --ref <refspec> --authorized <path.json>
                          (--remote-sha <sha> | --branch <branch> [--new-branch]) [--url <push url>]
  wt-push-scope-check.mjs --pre-push --remote <name> --url <push url>
                          --authorized <path.json> --install-dir <installed guard directory>
    --ref must be the EXACT ref about to be pushed (e.g. HEAD) — never omitted or assumed.
    --remote-sha is the destination ref's current tip as git hands it to a pre-push hook
      (all zeros for a new ref). Without it, --branch names the destination branch and its
      tip is read from the remote. Use --new-branch when that branch does not yet exist.
    --url is the URL git pushes to (a pre-push hook's $2); default: the remote's push URL.
  Existing destination: counts the commits not reachable from its current tip.
  New destination: counts the commits not reachable from any branch or tag the remote advertises.

Exit codes: 0 every commit is covered · 1 an uncovered commit was found · 2 usage error, or
the outgoing set could not be measured (fail-closed).
`;

const LS_REMOTE_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 256 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ZERO_SHA = /^0+$/;

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const out = { remote: null, branch: null, authorized: null, ref: null, remoteSha: null, url: null, newBranch: false, prePush: false, installDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--new-branch') out.newBranch = true;
    else if (a === '--pre-push') out.prePush = true;
    else if (['--remote', '--branch', '--authorized', '--ref', '--remote-sha', '--url', '--install-dir'].includes(a)) {
      const value = argv[++i];
      if (value === undefined) fail(`${a} requires a value`);
      out[{ '--remote': 'remote', '--branch': 'branch', '--authorized': 'authorized', '--ref': 'ref', '--remote-sha': 'remoteSha', '--url': 'url', '--install-dir': 'installDir' }[a]] = value;
    } else fail(`unknown argument: ${a}`);
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

/** Every git call: no replace refs, a large output buffer, stderr captured for the message. */
function git(args, { input, ...opts } = {}) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
    input: input ?? '',
    ...opts,
  });
}

const options = parseArgs(process.argv.slice(2));
if (options.prePush) {
  if (!options.remote || !options.url || !options.authorized || !options.installDir || options.ref || options.branch || options.remoteSha || options.newBranch) fail('usage: --pre-push --remote <name> --url <url> --authorized <path> --install-dir <dir>');
  runPrePush(options);
  process.exit(0);
}
const { remote, branch, authorized, ref, remoteSha, url, newBranch } = options;
if (options.installDir || (newBranch && !branch) || (remoteSha && branch)) fail('usage: --remote-sha and --branch are mutually exclusive; --new-branch requires --branch');
if (!remote || !authorized || !ref || (!remoteSha && !branch)) {
  fail(
    'usage: wt-push-scope-check.mjs --remote <name> --ref <refspec> --authorized <path.json> (--remote-sha <sha> | --branch <branch>) [--url <push url>]\n' +
      '  --ref must be the EXACT ref you are about to push (e.g. HEAD, or a branch/tag name) — never omitted or assumed.\n' +
      '  --remote-sha (the destination tip, zeros for a new ref) or --branch (the destination branch) is required.',
  );
}
if (ref.startsWith('-')) fail(`--ref must name a ref, not an option: ${ref}`);
if (remoteSha !== null && !SHA.test(remoteSha)) fail(`--remote-sha must be a full hex object id: ${remoteSha}`);

let scope;
try {
  scope = JSON.parse(readFileSync(authorized, 'utf8'));
} catch (err) {
  fail(`could not read/parse --authorized JSON at ${authorized}: ${err.message}`);
}

if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
  fail(`--authorized JSON must be an object with "commits" or "maxCount": ${authorized}`);
}

// Validate the scope BEFORE touching the remote, so a malformed scope is a usage error in every mode.
let authorizedShas = null;
let maxCount = null;
if (Object.prototype.hasOwnProperty.call(scope, 'commits')) {
  authorizedShas = scope.commits;
  if (!Array.isArray(authorizedShas)) {
    fail(`--authorized "commits" must be an array of strings: ${authorized}`);
  }
  const badEntry = authorizedShas.find((s) => typeof s !== 'string' || !/^[0-9a-f]{7,64}$/i.test(s.trim()));
  if (badEntry !== undefined) {
    fail(
      `--authorized "commits" entries must be at least 7 hex digits — a shorter prefix (the empty string ` +
        `included) matches many commits and would authorize them (rejected ${JSON.stringify(badEntry)}): ${authorized}`,
    );
  }
  authorizedShas = authorizedShas.map((s) => s.trim().toLowerCase());
} else if (Object.prototype.hasOwnProperty.call(scope, 'maxCount')) {
  maxCount = scope.maxCount;
  if (typeof maxCount !== 'number' || !Number.isFinite(maxCount) || !Number.isInteger(maxCount) || maxCount < 0) {
    fail(
      `--authorized "maxCount" must be a finite non-negative integer (got ${String(maxCount)} — ` +
        `values like 1e999 parse to Infinity and would authorize an unlimited push, rejected): ${authorized}`,
    );
  }
} else {
  fail(`--authorized JSON must have "commits" (array) or "maxCount" (number): ${authorized}`);
}

// What is pushed must be a commit: a tree or blob pushed to a ref carries no history to scope.
let localSha;
try {
  localSha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
} catch {
  fail(`--ref ${ref} is not a commit in this clone (refused: only commits can be scope-checked)`);
}

// The URL git actually pushes to: pushurl and pushInsteadOf can differ from the fetch URL.
let pushUrl = url;
if (!pushUrl) {
  try {
    pushUrl = git(['remote', 'get-url', '--push', remote]).trim();
  } catch {
    pushUrl = remote;
  }
}

function listRemote() {
  try {
    return git(['ls-remote', '--heads', '--tags', pushUrl], {
      timeout: LS_REMOTE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    return fail(
      `could not list the refs of remote "${remote}" at ${pushUrl} (fail-closed: without them the outgoing set is unknown): ${err.message}`,
    );
  }
}

let destinationTip = null;
let advertisedListing = null;
if (remoteSha !== null) {
  if (!ZERO_SHA.test(remoteSha)) destinationTip = remoteSha;
} else {
  advertisedListing = listRemote();
  const wanted = `refs/heads/${branch}`;
  const hit = advertisedListing.split('\n').find((l) => l.split('\t')[1]?.trim() === wanted);
  if (hit) destinationTip = hit.split('\t', 1)[0].trim();
  else if (!newBranch) fail(`destination branch not found: ${branch}; pass --new-branch if the push creates it`);
}

let outgoing;
let measuredAgainst;
if (destinationTip !== null) {
  // EXISTING destination: whatever the remote holds elsewhere, what is not on this ref's tip is new HERE.
  let tipCommit;
  try {
    tipCommit = git(['rev-parse', '--verify', '--quiet', `${destinationTip}^{commit}`]).trim();
  } catch {
    fail(
      `the destination tip ${destinationTip} is not in this clone (fail-closed: fetch "${remote}" first, ` +
        `so the commits it lacks can be told apart from the ones it holds)`,
    );
  }
  try {
    outgoing = git(['rev-list', localSha, `^${tipCommit}`]);
  } catch (err) {
    fail(`git rev-list failed: ${err.message}`);
  }
  measuredAgainst = `not on the destination's current tip ${tipCommit.slice(0, 12)}`;
} else {
  // NEW destination: the commits of --ref not reachable from any advertised branch or tag. Local
  // remote-tracking refs are no substitute: a branch deleted on the remote survives in them.
  const listing = advertisedListing ?? listRemote();
  const advertisedShas = [
    ...new Set(
      listing
        .split('\n')
        .map((l) => l.split('\t', 1)[0].trim())
        .filter((s) => SHA.test(s)),
    ),
  ];
  // A remote object this clone does not have cannot be an ancestor of anything local; skip it
  // rather than let rev-list abort on an unknown object.
  let known = [];
  if (advertisedShas.length > 0) {
    let check;
    try {
      check = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${advertisedShas.join('\n')}\n` });
    } catch (err) {
      fail(`could not check which advertised objects exist in this clone (fail-closed): ${err.message}`);
    }
    known = check
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter(([sha, type]) => sha && (type === 'commit' || type === 'tag'))
      .map(([sha]) => sha);
  }
  try {
    outgoing = git(['rev-list', '--stdin', localSha], { input: known.map((sha) => `^${sha}\n`).join('') });
  } catch (err) {
    fail(`git rev-list failed: ${err.message}`);
  }
  measuredAgainst = `new to ${remote}`;
}

const shas = outgoing.split('\n').map((l) => l.trim()).filter((l) => SHA.test(l));

if (shas.length === 0) {
  console.log('wt-push-scope-check: no commits to push — OK');
  process.exit(0);
}

let offending = [];
if (authorizedShas !== null) {
  offending = shas.filter((sha) => !authorizedShas.some((entry) => sha.startsWith(entry)));
} else if (shas.length > maxCount) {
  // maxCount mode cannot name WHICH commits are offending (it only bounds the count) —
  // report every commit beyond the authorized count, newest first, as the offending tail.
  offending = shas.slice(maxCount);
}

if (offending.length > 0) {
  // Subjects are for the human only; counting and matching above used bare object ids.
  const subjects = new Map();
  try {
    const described = git(['log', '--no-walk=unsorted', '--no-show-signature', '--format=%H%x09%s', '--stdin'], {
      input: `${offending.join('\n')}\n`,
    });
    for (const line of described.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab > 0) subjects.set(line.slice(0, tab), line.slice(tab + 1));
    }
  } catch {
    // Subjects are cosmetic; the refusal stands without them.
  }
  for (const sha of offending) {
    console.error(`UNAUTHORIZED COMMIT: ${sha.slice(0, 12)} ${subjects.get(sha) ?? ''}`.trimEnd());
  }
  console.error(
    `wt-push-scope-check: ${offending.length} unauthorized commit(s) out of ${shas.length} ${measuredAgainst} about to be pushed (ref=${ref})`,
  );
  process.exit(1);
}

console.log(`wt-push-scope-check: all ${shas.length} commit(s) covered by authorized scope — OK`);
process.exit(0);
