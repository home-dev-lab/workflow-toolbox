#!/usr/bin/env node
// wt-plugin-release-record-guard-hook.mjs — a PreToolUse guard, plugin-level: WARNS when a commit
// stages a change under `plugin/` while staging NEITHER the plugin's version NOR its changelog.
//
// WHY. This repository already enforces the same invariant for its published PACKAGES: touch a
// package source without a changeset and `changeset-gate.test.ts` goes red. The PLUGIN has no
// such gate — its `CHANGELOG.md` is hand-written and its version is bumped by hand, so a plugin
// change can be merged and pushed with neither, and nothing anywhere says so.
//
// Measured 2026-08-27: exactly that happened. `plugin/bin/wt-queue-not-empty-gate-hook.mjs` was
// merged to main and pushed with no version bump and no changelog entry. The version gates what
// adopters receive, so the fix reached main and reached no one. It was found only because the
// owner asked an unrelated question about the changelog hours later.
//
// The asymmetry is the whole defect: the SAME omission on a package would have gone red at commit
// time. This guard is the plugin's half of that pair.
//
// ⚠ WARNS, NEVER DENIES — a new guard's precision is measured on material it did not choose before
// it is allowed to block (mechanise-on-sight.md). Two legitimate shapes fire it and must be
// measured before this can be promoted:
//   - a work-in-progress commit on a feature branch, where the version bump legitimately lands
//     once at the end of the branch rather than on every commit;
//   - a plugin change with genuinely no release surface (a comment, a test fixture), where a
//     changelog entry would be noise.
// Neither loses work; both are a nag. Promotion to blocking is a separate decision, taken from
// the guard journal's record, not from this file.
//
// ⚠ BRANCH-AWARE REMEDY. `no-publish-from-branches.md`: a branch never bumps the version — it
// inherits `main`'s number and the bump happens on `main`, at push time; a branch's changelog
// entry carries no version heading, only `## [Unreleased]`. On any branch other than
// `main`/`master`, the warning's remedy asks ONLY for a changelog entry — never the version bump,
// which would ask the committer to do the one thing that rule forbids.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is never read as coverage:
//   - whether the changelog entry is CORRECT, or whether the bump is the right size. It reads
//     that the files were staged, nothing about their content;
//   - a plugin change committed from outside a repository carrying `plugin/.claude-plugin/
//     plugin.json` — the guard scopes itself to that manifest so it stays silent in every other
//     project on the machine;
//   - `git commit --amend` onto a commit that already carried the bump. It still warns; the
//     committer knows better and this is one of the false-positive shapes named above;
//   - anything that is not a `git commit` — a merge that carries plugin changes in from a branch
//     is deliberately out of scope, because the bump belongs to the branch, not to the merge.

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

const PLUGIN_MANIFEST = 'plugin/.claude-plugin/plugin.json'
const PLUGIN_CHANGELOG = 'plugin/CHANGELOG.md'

// `git commit`, not `git commit-tree`, and not a word merely containing "commit".
const GIT_COMMIT = /\bgit\b[^\n;&|]*\bcommit\b(?!-)/

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

/** Repo root for `cwd`, or null when cwd is not inside a work tree. */
function repoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null
  } catch {
    return null
  }
}

/** Staged paths, repo-relative. Empty array on any failure — fail open. */
function stagedPaths(cwd) {
  try {
    return execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Current branch name, or null when it can't be determined (detached HEAD, git failure). Fail
 * open toward the MAIN-branch remedy: an unknown branch gets the same wording main gets today,
 * never the branch-only wording — `no-publish-from-branches.md` only relaxes the requirement on a
 * branch it can actually name.
 */
function currentBranch(cwd) {
  try {
    const name = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return name || null
  } catch {
    return null
  }
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const cmd =
    input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : ''
  if (!cmd || !GIT_COMMIT.test(cmd)) return

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
  const root = repoRoot(cwd)
  if (root === null) return

  // Scope: only the repository that OWNS a plugin manifest. Without this the guard would fire in
  // every unrelated project that happens to have a `plugin/` directory.
  if (!existsSync(join(root, PLUGIN_MANIFEST))) return

  const staged = stagedPaths(cwd)
  if (staged.length === 0) return

  const touchesPlugin = staged.some((p) => p.startsWith('plugin/'))
  if (!touchesPlugin) return

  const hasVersion = staged.includes(PLUGIN_MANIFEST)
  const hasChangelog = staged.includes(PLUGIN_CHANGELOG)
  if (hasVersion || hasChangelog) return

  const missing = 'neither the version nor the changelog'
  const branch = currentBranch(cwd)
  const onFeatureBranch = branch !== null && branch !== 'main' && branch !== 'master'

  recordGuardEvent({
    guard: 'wt-plugin-release-record-guard-hook.mjs',
    decision: 'warned',
    class: 'plugin-change-without-release-record',
    reason: `${staged.filter((p) => p.startsWith('plugin/')).length} plugin path(s) staged, ${missing}${
      onFeatureBranch ? ` (branch ${branch})` : ''
    }`,
  })

  const preamble =
    '⚠ [workflow-toolbox plugin release-record guard] This commit stages a change under ' +
    '`plugin/` but stages ' + missing + '. The plugin version is what gates whether ' +
    'ADOPTERS receive the change: a plugin fix merged and pushed without a bump reaches ' +
    '`main` and reaches nobody, silently. Measured 2026-08-27, exactly that. Published ' +
    'PACKAGES already fail red on the same omission (changeset-gate); the plugin had no ' +
    'equivalent, which is the asymmetry this closes.\n'

  // `no-publish-from-branches.md`: a branch never bumps the version — it inherits main's number
  // and leaves it alone; the bump happens on `main`, at push time. Telling a branch commit to
  // stage the version bump would ask for the one thing that rule forbids.
  const remedy = onFeatureBranch
    ? 'Stage a changelog entry in this commit:\n' +
      '  plugin/CHANGELOG.md   (an entry under `## [Unreleased]`, no version heading)\n' +
      `The version bump happens on \`main\`, at push time — not on branch \`${branch}\`.\n` +
      'Deliberately WARN-ONLY: a plugin change with no release surface (a comment, a test ' +
      'fixture) fires this legitimately too.'
    : 'Stage the bump and the entry in this commit:\n' +
      '  plugin/.claude-plugin/plugin.json   (version)\n' +
      '  plugin/CHANGELOG.md                 (one entry naming what adopters get)\n' +
      'Deliberately WARN-ONLY: a work-in-progress commit on a branch that bumps once at the ' +
      'end, and a plugin change with no release surface, both fire this legitimately.'

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: preamble + remedy,
      },
    }),
  )
}

runFailOpenHook('wt-plugin-release-record-guard-hook.mjs', main)
