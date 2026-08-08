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

  const logArgs = args.range
    ? ['log', '--format=%H%x09%G?%x09%s', args.range]
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
