#!/usr/bin/env node
// wt-live-config-tree-guard-hook.mjs — PreToolUse/Bash guard against a git command that
// SWITCHES THE WORKING TREE of a LIVE ambient rules directory (a `<config-dir>/rules`
// checkout that Claude Code reads at every session start and every compaction).
//
// GENERALIZED from a private, machine-specific hook that matched a hard-coded
// `<home>/.claude*/rules` glob. This version resolves the live rules directory the same
// way wt-rule-edit-horizon-hook.mjs's isAmbientRule does: an explicit CLAUDE_CONFIG_DIR
// wins; otherwise any ancestor segment literally named `.claude` or `.claude-*` whose
// direct child is `rules`. Two hooks defining "the live rules directory" independently
// would drift the day one of them changes — this mirrors that definition on purpose
// rather than reinventing a narrower one.
//
// WHY. `git checkout <branch>` / `git switch` / `git reset --hard` inside a versioned
// rules directory rewrites the standing instructions every session on the machine reads —
// including sessions mid-arc, and including the one issuing the command, at its next
// compaction. Measured 2026-08-05: a pilot-orchestrator was one command away from checking
// out a working branch directly inside its live rules directory. It caught itself and used
// a worktree instead — nothing mechanical would have caught it otherwise. This is that
// mechanism, generalized for adoption.
//
// ⚠ THE CORRECT PATTERN, and it is what makes a denial cheap: work on rules happens in a
// WORKTREE, never by switching the live tree.
//     git -C <rules-dir> worktree add <path-outside-the-config-dir> -b <branch>
// That command is NOT matched here, deliberately — it is the remedy this guard names.
//
// ⚠ POSTURE — this is a NEW, unmeasured guard; the convention for one is to WARN until its
// false-positive rate has been measured on material it did not choose. It DEFAULTS TO WARN.
// An adopter who has confirmed (as the originating machine has, by field incident) that
// checkout/switch/reset --hard have no legitimate use on their live rules tree can opt into
// DENY with an env var in their OWN settings.json `env` block — never hard-coded here:
//     WT_LIVE_CONFIG_TREE_GUARD_MODE=deny   (default: warn; also accepts: off)
//
// ⚠⚠ SCOPE, stated so its silence is never mistaken for coverage:
//   · Only GIT commands are seen. A direct Edit/Write/rm/mv inside the live rules directory
//     is INVISIBLE to this guard — that is the LARGER half of the hazard surface, and it is
//     not mechanised here.
//   · A target reached through a shell variable, a glob, a symlink, or a script that `cd`s
//     inside itself is unresolvable and is never guessed at — no verdict follows.
//   · INERT (no denial, no warning, ever) when the resolved rules directory is not itself a
//     git working tree (no `.git`) — nothing to switch means nothing to protect. Run this
//     file directly with `--diagnose` to see, for the CURRENT environment, whether the
//     guard is active — so inertness is a legible, checkable fact rather than a silent
//     no-op that looks identical to "installed and protecting".

import { existsSync, readFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { recordGuardEvent } from './lib/guard-journal.mjs'

const CLAUDE_DIR_SEGMENT = /^\.claude(-.*)?$/

/** Is `dirPath` (already absolute) the live ambient rules directory for this environment?
 *  Mirrors wt-rule-edit-horizon-hook.mjs's isAmbientRule, applied to a directory rather
 *  than a file path. */
function isLiveRulesDir(dirPath) {
  if (!dirPath) return false
  const segments = dirPath.split(sep).filter(Boolean)
  if (segments[segments.length - 1] !== 'rules') return false
  const parent = segments[segments.length - 2]
  if (parent && CLAUDE_DIR_SEGMENT.test(parent)) return true
  const configDir = process.env.CLAUDE_CONFIG_DIR
  if (!configDir) return false
  try {
    return resolve(configDir, 'rules') === dirPath
  } catch {
    return false
  }
}

/** Only a directory that both (a) matches the live-rules definition above AND (b) is
 *  itself a git working tree is a guard target — a non-git match is INERT by design. */
function isGuardedDir(dirPath) {
  if (!isLiveRulesDir(dirPath)) return false
  try {
    return existsSync(resolve(dirPath, '.git'))
  } catch {
    return false
  }
}

function resolveMode() {
  const raw = (process.env.WT_LIVE_CONFIG_TREE_GUARD_MODE || '').trim().toLowerCase()
  return raw === 'deny' || raw === 'off' ? raw : 'warn'
}

function readInput() {
  try {
    const raw = readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** The directory a git invocation acts on: an explicit `-C <path>`, else a leading `cd <path>`,
 *  else the shell's cwd. Returns an absolute path, or null when it cannot be resolved — an
 *  unresolvable target is NOT treated as a hit, because guessing produces false denials. */
function targetDir(cmd, cwd) {
  const dashC = cmd.match(/\bgit\s+(?:[^\s|;&]*\s+)*?-C\s+("([^"]+)"|'([^']+)'|(\S+))/)
  const cd = cmd.match(/(?:^|[;&|]\s*)cd\s+("([^"]+)"|'([^']+)'|(\S+))/)
  const raw = dashC ? (dashC[2] ?? dashC[3] ?? dashC[4]) : cd ? (cd[2] ?? cd[3] ?? cd[4]) : cwd
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (/[$*?`]/.test(raw)) return null // a variable or a glob: unresolvable, do not guess
  const expanded = raw.startsWith('~') ? homedir() + raw.slice(1) : raw
  try {
    return resolve(cwd && !expanded.startsWith('/') ? cwd : '/', expanded)
  } catch {
    return null
  }
}

/** Split on shell separators so one dangerous segment is not hidden behind a harmless one. */
function segments(cmd) {
  return cmd.split(/(?:\|\||&&|[;|&\n])/g).map((s) => s.trim()).filter(Boolean)
}

/** Returns 'deny' | 'warn' | null for ONE segment, ignoring which directory it targets. */
function verdictFor(seg) {
  if (!/^git\b|[;&|]\s*git\b|\bgit\s/.test(seg)) return null

  // `git checkout -- <path>` / `git checkout <path>` restores files; it does not move HEAD.
  // Only a branch-shaped checkout does. `--` marks the pathspec form explicitly.
  if (/\bgit\s+(?:-C\s+\S+\s+)*checkout\b/.test(seg) && !/\s--\s/.test(seg)) {
    // `-b`/`-B` creates AND switches; a bare `checkout <ref>` switches.
    if (/\bcheckout\s+(-b|-B)\b/.test(seg)) return 'deny'
    if (/\bcheckout\s+(?!-)\S/.test(seg)) return 'deny'
  }
  if (/\bgit\s+(?:-C\s+\S+\s+)*switch\b/.test(seg)) return 'deny'
  if (/\bgit\s+(?:-C\s+\S+\s+)*reset\b[^|;&]*--hard\b/.test(seg)) return 'deny'

  // Ambiguous: these can be legitimate maintenance on the live tree. Never escalated past warn.
  if (/\bgit\s+(?:-C\s+\S+\s+)*(merge|rebase|stash|cherry-pick)\b/.test(seg)) return 'warn'
  return null
}

function diagnose() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || null
  const rulesDir = configDir ? resolve(configDir, 'rules') : resolve(homedir(), '.claude', 'rules')
  const mode = resolveMode()
  const active = isGuardedDir(rulesDir)
  writeSync(
    1,
    JSON.stringify(
      {
        configDir: configDir ?? `${homedir()} (via .claude*-named ancestor heuristic, no CLAUDE_CONFIG_DIR set)`,
        rulesDir,
        isGitRepo: existsSync(resolve(rulesDir, '.git')),
        mode,
        active,
        note: active
          ? 'guard is ACTIVE for this environment: matched git commands targeting this directory will be warned or denied per mode'
          : 'guard is INERT for this environment: the resolved rules directory is not a git working tree, so nothing is protected',
      },
      null,
      2,
    ) + '\n',
  )
}

function main() {
  if (process.argv.includes('--diagnose')) return diagnose()

  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (!cmd) return
  const cwd = typeof input.cwd === 'string' ? input.cwd : ''

  const mode = resolveMode()
  if (mode === 'off') return

  let worst = null
  let hitSeg = ''
  let hitDir = ''
  // The shell's cwd CARRIES ACROSS segments: `cd <dir> && git switch x` splits into two
  // segments, and the git one alone looks harmless. Tracking the cd is what makes the split
  // safe — measured on the originating machine: without it, `cd <live-dir> && git reset
  // --hard` passed silently.
  let effectiveCwd = cwd
  for (const seg of segments(cmd)) {
    const cdOnly = seg.match(/^cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*$/)
    if (cdOnly) {
      const d = targetDir(seg, effectiveCwd)
      if (d) effectiveCwd = d
      continue
    }
    const v = verdictFor(seg)
    if (!v) continue
    const dir = targetDir(seg, effectiveCwd)
    if (!dir || !isGuardedDir(dir)) continue
    const effective = mode === 'warn' && v === 'deny' ? 'warn' : v
    if (effective === 'deny') {
      worst = 'deny'
      hitSeg = seg
      hitDir = dir
      break
    }
    if (!worst) {
      worst = 'warn'
      hitSeg = seg
      hitDir = dir
    }
  }
  if (!worst) return

  const why = [
    `This targets a LIVE ambient rules directory (${hitDir}) — read by every session on this`,
    `machine at session start AND at every compaction. Switching it changes the standing`,
    `instructions of sessions that are mid-arc, silently, including this one at its next`,
    `compaction.`,
    ``,
    `The correct pattern, and it is NOT matched by this guard:`,
    `    git -C ${hitDir} worktree add <path-outside-the-config-dir> -b <branch>`,
    `then edit inside that worktree and merge back to main when the work is done.`,
    ``,
    `⚠ This guard only sees GIT commands. A direct Edit/Write/rm inside the live rules dir is`,
    `  invisible to it — that half is not mechanised. Run this hook with --diagnose to check`,
    `  whether it is active for your environment.`,
  ].join('\n')

  if (worst === 'deny') {
    recordGuardEvent({
      guard: 'wt-live-config-tree-guard-hook.mjs',
      decision: 'blocked',
      class: 'live-config-tree',
      reason: hitSeg,
      cwd: hitDir,
    })
    writeSync(
      1,
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `LIVE CONFIG TREE — refused: ${hitSeg}\n\n${why}`,
        },
      }),
    )
    return
  }
  recordGuardEvent({
    guard: 'wt-live-config-tree-guard-hook.mjs',
    decision: 'warned',
    class: 'live-config-tree',
    reason: hitSeg,
    cwd: hitDir,
  })
  writeSync(
    1,
    JSON.stringify({
      systemMessage: `⚠ LIVE CONFIG TREE — this changes the running rules for every session:\n    ${hitSeg}\n\n${why}`,
    }),
  )
}

try {
  main()
} catch {
  /* a hook that throws is a hook that gets disabled */
}
process.exit(0)
