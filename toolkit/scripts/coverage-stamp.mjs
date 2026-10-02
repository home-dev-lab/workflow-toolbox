// Provenance of the coverage summary that `quality.mjs` reads.
//
// `coverage-summary.json` says nothing about the tree it measured, so a summary left over from an
// older run read exactly like a fresh one. The coverage provider writes a stamp beside it naming the
// git tree it measured, and `quality.mjs` refuses a summary whose stamp does not name HEAD's tree.
// The TREE id is compared, not the commit id: a merge or a message-only amend that keeps the tree
// keeps the coverage valid.

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const COVERAGE_STAMP_NAME = 'coverage-stamp.json'
export const COVERAGE_REFRESH_COMMAND = 'pnpm quality:coverage'

function git(cwd, args) {
  // --no-optional-locks: a read must never take the index lock another git process may need.
  const result = spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8' })
  return result.error || result.status !== 0 ? null : result.stdout
}

// The commit, tree and dirtiness of the checkout at `cwd`. Every field is null when git cannot
// answer (git absent, not a repository): an unknown tree is never reported as a known one.
export function readTreeIdentity(cwd) {
  const ids = git(cwd, ['rev-parse', 'HEAD', 'HEAD^{tree}'])?.trim().split('\n')
  const status = git(cwd, ['status', '--porcelain'])
  const known = ids?.length === 2
  return {
    commit: known ? ids[0] : null,
    tree: known ? ids[1] : null,
    dirty: status === null ? null : status.trim().length > 0,
  }
}

// `start` and `end` are the identities read when the coverage run began and when it reported. A
// commit or checkout during the run means the numbers describe neither tree, so the stamp then
// records no tree at all. Writing never throws: a coverage run must not fail because of its stamp.
export function writeCoverageStamp(directory, { start, end, filtered }) {
  const sameTree = start.tree !== null && start.tree === end.tree
  const stamp = {
    commit: sameTree ? end.commit : null,
    tree: sameTree ? end.tree : null,
    dirty: start.dirty === null || end.dirty === null ? null : start.dirty || end.dirty,
    filtered,
    generatedAt: new Date().toISOString(),
  }
  const path = join(directory, COVERAGE_STAMP_NAME)
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`)
  } catch {
    // An older stamp must not stay beside the new summary: removed, the summary reads as
    // unstamped, which quality.mjs refuses.
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Nothing more can be done without failing the coverage run.
    }
  }
  return stamp
}

const short = (id) => String(id).slice(0, 12)

// Whether a coverage stamp describes the checkout whose identity is `current`: { ok: true }, or
// { ok: false, reason }. Edits made AFTER a clean run are not detected: the stamp names a committed
// tree, and the working tree is not hashed.
export function coverageFreshness(stamp, current) {
  const refuse = (why) => ({ ok: false, reason: `${why}. Run \`${COVERAGE_REFRESH_COMMAND}\` at this commit, then re-run this command.` })
  if (!current?.tree) {
    return { ok: false, reason: 'cannot read the HEAD tree with git, so the coverage artifact cannot be matched to it. Run this command inside the git checkout, with git on PATH.' }
  }
  if (!stamp || typeof stamp !== 'object') return refuse('the coverage artifact has no readable provenance stamp, so the tree it measured is unknown')
  if (!stamp.tree) return refuse('the coverage run recorded no tree: git was unreadable, or the HEAD tree changed while the suite ran')
  if (stamp.tree !== current.tree) {
    return refuse(`the coverage artifact was measured at commit ${short(stamp.commit)}, not at HEAD ${short(current.commit)}` +
      `${stamp.generatedAt ? ` (generated ${stamp.generatedAt})` : ''}`)
  }
  if (stamp.filtered !== false) {
    return refuse(stamp.filtered === true
      ? 'the coverage run did not run the whole suite (selected files or projects, a shard, a test-name pattern, a test mode, or test files that never ran), so its totals cover part of it'
      : 'the coverage run did not record whether it ran the whole suite (merged reports, or a Vitest context this check cannot read)')
  }
  if (stamp.dirty !== false) {
    return refuse(stamp.dirty === true
      ? 'the coverage run measured uncommitted changes, so its numbers describe that working tree rather than HEAD; commit them first'
      : 'the coverage run could not read whether the tree had uncommitted changes')
  }
  return { ok: true }
}
