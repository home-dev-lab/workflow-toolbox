#!/usr/bin/env node
// wt-spawn-shape-guard-hook.mjs — a PreToolUse guard on the Agent tool: a `name` must travel
// with an `isolation`, or the spawned agent silently loses its observer.
//
// WHY IT EXISTS. A named spawn, in a session that already has addressable teammates, is
// rerouted to the in-process-teammate path. That path rebuilds the agent definition and never
// reads its `observer:`, so the watchdog is never attached. Passing `isolation` excludes the
// spawn from that path (the harness's own condition is `… && !isolation && !cwd && !fork`) and
// the pairing survives — measured: watchdog attached 4s after spawn, Bash present, the
// destructive-action guard firing.
//
// The failure this prevents is SILENT in both directions: the spawn succeeds, the agent works
// normally, and its report honestly says "no observer findings" — which is true, and reads
// exactly like a watchdog that looked and saw nothing. Nothing anywhere reports the missing
// pairing. That is why this refuses rather than warns: the fact was already written in the
// project's own auto-loaded memory index the day it was needed, and the spawn happened anyway.
// A text does not stop a gesture.
//
// WHY IT CHECKS cwd. `isolation: worktree` needs the SPAWNING session's working directory to be
// inside a git repository — not the repo being targeted. On an umbrella project holding several
// repos, the same spawn succeeds or fails depending on where the shell sits. Refusing a named
// spawn there would demand a fix that cannot be applied, and a guard that is red on legitimate
// work is a guard people route around. So: refuse only where the remedy exists; elsewhere say
// what will be lost and allow.
//
// Any internal error → fail open with one stderr trace. A guard that can break a spawn because of
// its own bug is worse than the gap it closes.

import fs from 'node:fs'
import path from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Walk up from `dir` looking for a `.git` entry — a file too, so worktrees and submodules
 *  count. Bounded by reaching the filesystem root. */
function insideGitRepo(dir) {
  try {
    let current = path.resolve(dir)
    for (;;) {
      if (fs.existsSync(path.join(current, '.git'))) return true
      const parent = path.dirname(current)
      if (parent === current) return false
      current = parent
    }
  } catch {
    return false
  }
}

function main() {
  const input = readInput()
  if (input.tool_name !== 'Agent') return

  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  const name = typeof ti.name === 'string' ? ti.name.trim() : ''
  if (!name) return // anonymous spawn: the observer attaches, nothing to say

  const isolation = typeof ti.isolation === 'string' ? ti.isolation.trim() : ''
  if (isolation) return // named AND isolated: the shape that keeps everything

  const type = typeof ti.subagent_type === 'string' ? ti.subagent_type : 'this agent'
  const cwd = typeof input.cwd === 'string' ? input.cwd : ''

  // No git repo under the session's cwd ⇒ `isolation` would itself fail, so there is no fix to
  // demand. Say what is being lost and get out of the way.
  if (!cwd || !insideGitRepo(cwd)) {
    process.stdout.write(
      JSON.stringify({
        systemMessage:
          `[workflow-toolbox spawn-shape] "${name}" (${type}) is named without isolation, so ` +
          `its observer will NOT be attached — and nothing will report that. isolation is ` +
          `unavailable here because the session's cwd is not inside a git repository, so this ` +
          `is allowed. cd into the target repo first if you want the pairing.`,
      }),
    )
    return
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[workflow-toolbox spawn-shape] Refused: "${name}" (${type}) is named but not ` +
          `isolated. A named spawn is rerouted to the in-process-teammate path, which rebuilds ` +
          `the definition and never reads its observer: — the watchdog is silently never ` +
          `attached, and the agent's own report will honestly say "no observer findings". ` +
          `Fix: add isolation: "worktree" to keep the name AND the pairing, or drop the name.`,
      },
    }),
  )
}

runFailOpenHook('wt-spawn-shape-guard-hook.mjs', main)
