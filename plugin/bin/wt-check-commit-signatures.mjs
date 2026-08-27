#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { checkSignatures, statusMeaning } from './lib/commit-signature-core.mjs';
import { handleHelpFlag } from './lib/cli-help.mjs';

const HELP = `wt-check-commit-signatures — verify that the commits a signature policy expects
signed (per git's own commit.gpgsign / user.signingkey config) actually carry a valid signature,
and print the offending commits plus a ready-to-run fix.

Usage:
  node wt-check-commit-signatures.mjs [--repo <path>] [--range <git-range>]
    --repo <path>    git repo to check (default: cwd)
    --range <range>  a git revision range (e.g. origin/main..HEAD); default: just HEAD

Exit codes: 0 nothing to report · 1 unsigned commit(s) found (printed to stdout) · 2 usage/git error.
`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  handleHelpFlag(argv, HELP);
  const out = { repo: process.cwd(), range: null };
  const nextValue = (i, flag) => {
    if (i + 1 >= argv.length) fail(`${flag} requires a value`);
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') out.repo = nextValue(i++, arg);
    else if (arg === '--range') out.range = nextValue(i++, arg);
    else fail(`unknown argument: ${arg}`);
  }

  return out;
}

function runGit(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function usageError(repo, args, res, fallback) {
  const detail = String(res?.stderr || res?.stdout || fallback || '').trim();
  fail(detail || `git ${args.join(' ')} failed`);
}

function getOptionalConfig(repo, ...args) {
  const res = runGit(repo, ['config', ...args]);
  if (res.status === 0) return String(res.stdout || '').trim();
  if (res.status === 1) return null;
  usageError(repo, ['config', ...args], res, 'git config failed');
}

function shortSha(sha) {
  return sha.slice(0, 7);
}

function rebaseBase(range) {
  if (!range) return 'HEAD~1';
  if (range.includes('...')) return range.split('...')[0] || '--root';
  if (range.includes('..')) return range.split('..')[0] || '--root';
  return range;
}

function printFindings({ offenders, headSha, range }) {
  console.log('Commit signature check failed:');
  for (const offender of offenders) {
    console.log(
      `- ${shortSha(offender.sha)}: ${offender.status} (${statusMeaning(offender.status)}) — ${offender.subject}`,
    );
  }
  console.log(
    'Common cause: signing likely failed at commit time because the signing key or signing agent was unavailable, locked, or otherwise unusable.',
  );

  const onlyHeadOffender = offenders.length === 1 && offenders[0].sha === headSha;
  if (onlyHeadOffender) {
    console.log('Fix: git commit --amend --no-edit -S');
    return;
  }

  const namedRange = range || 'HEAD';
  console.log(
    `Fix: rebase the commits in ${namedRange}, for example: git rebase --exec 'git commit --amend --no-edit -S' ${rebaseBase(range)}`,
  );
  console.log(
    'Warning: rewriting published history is not the same operation as amending an unpushed commit.',
  );
}

/** Name the remote a range is pushing TO, or null when it cannot be established.
 *
 * The left side of `refs/remotes/<remote>/<branch>..HEAD` (or `<remote>/<branch>..HEAD`) names it.
 * The candidate is validated against `git remote` rather than trusted from the string, so a branch
 * that merely LOOKS like `<something>/<something>` cannot silently widen the exclusion.
 *
 * Returning null is the SAFE outcome: the caller then excludes nothing and reports every commit in
 * range. Over-reporting wastes a reader's time; under-reporting ships unsigned commits.
 */
function remoteFromRange(repo, range) {
  if (!range) return null;
  const left = range.split(/\.\.\.?/)[0];
  if (!left) return null;
  const withoutPrefix = left.startsWith('refs/remotes/') ? left.slice('refs/remotes/'.length) : left;
  const candidate = withoutPrefix.split('/')[0];
  if (!candidate || candidate === 'refs' || candidate === 'HEAD') return null;
  const res = runGit(repo, ['remote']);
  if (res.status !== 0) return null;
  const known = String(res.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return known.includes(candidate) ? candidate : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const repoCheck = runGit(args.repo, ['rev-parse', '--git-dir']);
  if (repoCheck.status !== 0) {
    usageError(args.repo, ['rev-parse', '--git-dir'], repoCheck, 'not a git repository');
  }

  const configLines = [];
  const commitGpgsign = getOptionalConfig(args.repo, '--get', '--bool', 'commit.gpgsign');
  if (commitGpgsign !== null) configLines.push(`commit.gpgsign=${commitGpgsign}`);
  const signingKey = getOptionalConfig(args.repo, '--get', 'user.signingkey');
  if (signingKey !== null) configLines.push(`user.signingkey=${signingKey}`);

  // ⚠ EXCLUDE WHAT THE TARGET REMOTE ALREADY HAS — and ONLY that remote.
  //
  // A range like <remote>/<branch>..HEAD answers "what would this push add" only while the branch
  // is a straight line. Merge the default branch in — the most routine update there is — and the
  // range legitimately contains that branch's whole history: other people's commits, unsigned, and
  // ALREADY PUBLISHED. Measured 2026-08-20 on a repository whose main is not signed: 121 commits in
  // range, 120 reachable from origin/main, one actually added. The check refused that push and its
  // remedy proposed rebasing 120 published commits by a dozen authors.
  //
  // ⚠⚠ But a BARE `--not --remotes` over-corrects, and it fails in the dangerous direction: it
  // excludes whatever ANY tracking ref reaches. Measured the same day on this repository: 43
  // tracking refs, 31 of them leftovers from a DELETED remote and 11 belonging to an archive that
  // is never pushed — exactly ONE is a push target. On a range that would genuinely add 62 commits
  // to the public remote, the bare form reported ZERO. A guard that goes mute on precisely the
  // commits it exists to inspect does not degrade, it INVERTS: it grants confidence at the one
  // moment it should refuse.
  //
  // So scope the exclusion to the remote the range is pushing TO. When that remote cannot be
  // established we exclude NOTHING and over-report — a noisy guard is recoverable, a mute one is
  // not.
  const targetRemote = remoteFromRange(args.repo, args.range);
  const excludeArgs = targetRemote === null ? [] : ['--not', `--remotes=${targetRemote}`];
  const logArgs = args.range
    ? ['log', '--format=%H%x09%G?%x09%s', args.range, ...excludeArgs]
    : ['log', '-1', '--format=%H%x09%G?%x09%s', 'HEAD'];
  const logRes = runGit(args.repo, logArgs);
  if (logRes.status !== 0) {
    usageError(args.repo, logArgs, logRes, 'git log failed');
  }

  const report = checkSignatures({
    configLines,
    logLines: String(logRes.stdout || '')
      .split('\n')
      .filter(Boolean),
  });

  if (!report.signingExpected || report.offenders.length === 0) process.exit(0);

  const headRes = runGit(args.repo, ['rev-parse', 'HEAD']);
  if (headRes.status !== 0) {
    usageError(args.repo, ['rev-parse', 'HEAD'], headRes, 'cannot resolve HEAD');
  }

  printFindings({
    offenders: report.offenders,
    headSha: String(headRes.stdout || '').trim(),
    range: args.range,
  });
  process.exit(1);
}

main();
