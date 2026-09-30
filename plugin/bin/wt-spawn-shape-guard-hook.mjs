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
// Outside a repository worktree isolation is unavailable, but dropping the name is always
// possible. Named non-isolated teammates also miss wakeups from their own background work.
//
// Any internal error → fail open with one stderr trace. A guard that can break a spawn because of
// its own bug is worse than the gap it closes.

import fs from 'node:fs'
import path from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

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
  let current = path.resolve(dir)
  for (;;) {
    try {
      fs.statSync(path.join(current, '.git'))
      return true
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
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

  const inRepo = cwd && insideGitRepo(cwd)

  recordGuardEvent({
    guard: 'wt-spawn-shape-guard-hook.mjs',
    decision: 'blocked',
    session: input.session_id,
    agent: input.agent_id,
    class: inRepo ? 'named-without-isolation' : 'named-without-isolation-no-repo',
    reason: `"${name}" (${type}) named but not isolated`,
    cwd,
  })
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[workflow-toolbox spawn-shape] Refused: "${name}" (${type}) is named but not ` +
          `isolated. The in-process teammate loses its observer and is not woken by its own ` +
          `background tasks. Drop name (spawn anonymously; address it by the returned raw id) — ` +
          `prefer this when the agent will hand work to an external lane and then wait, because ` +
          `an isolated worktree left unchanged while the lane writes in it can be reaped` +
          (inRepo ? `; otherwise add isolation: "worktree" to keep the name and observer.` :
            `. isolation: "worktree" is unavailable because cwd is not in a git repository.`),
      },
    }),
  )
}

runFailOpenHook('wt-spawn-shape-guard-hook.mjs', main)
