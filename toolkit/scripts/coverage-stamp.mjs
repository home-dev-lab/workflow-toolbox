// Provenance of the coverage summary that `quality.mjs` reads.
//
// `coverage-summary.json` says nothing about the tree it measured, so a summary left over from an
// older run read exactly like a fresh one. The coverage provider writes a stamp beside it naming the
// git tree it measured, and `quality.mjs` refuses a summary whose stamp does not name HEAD's tree.
// The TREE id is compared, not the commit id: a merge or a message-only amend that keeps the tree
// keeps the coverage valid.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
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
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, COVERAGE_STAMP_NAME), `${JSON.stringify(stamp, null, 2)}\n`)
  } catch {
    // An unwritable stamp leaves the summary unstamped, which quality.mjs refuses.
  }
  return stamp
}

const short = (id) => String(id).slice(0, 12)

// Whether a coverage stamp describes the checkout whose identity is `current`. Returns
// { ok: false, reason } for a refusal, { ok: true, warning } otherwise; `warning` is null or a line.
export function coverageFreshness(stamp, current) {
  const refuse = (why) => ({ ok: false, reason: `${why}. Run \`${COVERAGE_REFRESH_COMMAND}\` at this commit, then re-run this command.` })
  if (!current?.tree) return refuse('cannot read the HEAD tree with git, so the coverage artifact cannot be matched to it')
  if (!stamp || typeof stamp !== 'object') return refuse('the coverage artifact has no readable provenance stamp, so the tree it measured is unknown')
  if (!stamp.tree) return refuse('the coverage run recorded no tree: git was unreadable, or HEAD moved while the suite ran')
  if (stamp.tree !== current.tree) {
    return refuse(`the coverage artifact was measured at commit ${short(stamp.commit)}, not at HEAD ${short(current.commit)}` +
      `${stamp.generatedAt ? ` (generated ${stamp.generatedAt})` : ''}`)
  }
  if (stamp.filtered !== false) {
    return refuse(stamp.filtered === true
      ? 'the coverage run was filtered (selected files, projects, a test-name pattern or a test mode), so its totals cover part of the suite'
      : 'the coverage run did not record whether it was filtered')
  }
  return { ok: true, warning: stamp.dirty === false ? null : 'coverage was measured on a tree with uncommitted changes (or one whose status git could not read); its numbers describe that working tree, not HEAD alone' }
}
