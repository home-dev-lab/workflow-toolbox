#!/usr/bin/env node
// wt-isolated-spawn-report-path-hook.mjs — a PreToolUse guard on the Agent tool: warn when an
// ISOLATED spawn is briefed to write its report to an absolute path that cannot be inside its
// own worktree.
//
// WHY THIS EXISTS. An agent spawned with `isolation: "worktree"` gets its own git worktree, and
// that tree is REAPED the moment the agent stops. Twice, an agent spawned that way was told in
// its brief to write a report to an absolute path under the umbrella project root — not inside
// its own tree. Both times the file was simply not there afterwards, and both times the agent
// believed it had delivered: its Write call succeeded, inside its own tree, at a path that
// LOOKED like the one it was asked for. The failure this prevents is silent in both directions —
// nothing anywhere reports the missing delivery, because an absent file and a never-written file
// are the same observation from the spawner's side.
//
// ⚠ WARNS, NEVER DENIES. A new guard's precision is measured on material it did not choose
// before it is allowed to block, and this one reasons about prose in a prompt — the least
// reliable input there is. It also cannot know the worktree path the harness will pick after
// this hook runs, so it can only flag the SHAPE: isolation + an absolute write target that is
// not obviously already inside a worktrees directory.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - a relative report path (fine by construction, but also invisible here);
//   - a path handed to the agent later, by message rather than in the spawn prompt;
//   - an agent that decides on its own to write outside its tree.
// It covers the one shape that actually bit us, twice: the brief names the path at spawn time.

import { readFileSync } from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

// A write target named in a brief. Deliberately narrow: it wants an absolute path sitting next
// to a word about writing/reporting, not every absolute path in the prompt (briefs are full of
// repo paths to READ, and flagging those is how a guard earns its way into being switched off).
const WRITE_TARGET =
  /(?:write|writes|written|save|saved|report(?:\s+dir)?|REPORT_DIR|output)\b[^\n]{0,80}?(\/(?:home|Users|tmp|var|opt)\/[^\s"'`,)]+)/gi

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Agent') return

  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  const isolation = typeof ti.isolation === 'string' ? ti.isolation.trim() : ''
  if (!isolation) return // not isolated: its writes land wherever it is told

  const prompt = typeof ti.prompt === 'string' ? ti.prompt : ''
  if (!prompt) return

  const targets = []
  for (const m of prompt.matchAll(WRITE_TARGET)) {
    const p = m[1]
    // A path already inside a worktrees dir is the CORRECT shape — the spawner made the tree
    // itself. Don't nag about the thing we want people to do.
    if (/\/worktrees?\//.test(p)) continue
    if (!targets.includes(p)) targets.push(p)
  }
  if (targets.length === 0) return

  const name = typeof ti.name === 'string' && ti.name ? `"${ti.name}"` : 'an anonymous agent'
  const lines = [
    `⚠ ISOLATED SPAWN + AN OUT-OF-TREE WRITE TARGET — ${name} is spawned with isolation:`,
    `  "${isolation}", and its brief names ${targets.length} absolute write path(s):`,
    ...targets.slice(0, 4).map((p) => `    ${p}`),
    `  An isolated agent's write to a path outside its own worktree does not land, its tree is`,
    `  REAPED when it stops, and it will honestly report success. Fix, pick one:`,
    `    · drop isolation and create the worktree yourself, passing that path in the brief;`,
    `    · or keep isolation and have the report be the agent's FINAL MESSAGE, not a file.`,
    `  If it already happened: the work is not lost. The report is the largest Write tool-call`,
    `  payload in <projects-dir>/<session-id>/subagents/agent-<raw-id>.jsonl.`,
    `  (This warns only — it reads prose in a prompt and has not been measured. A relative path,`,
    `   or one sent by message after the spawn, is invisible to it.)`,
  ]
  recordGuardEvent({
    guard: 'wt-isolated-spawn-report-path-hook.mjs',
    decision: 'warned',
    class: 'isolated-spawn-out-of-tree-write',
    reason: `${name} isolation=${isolation} targets=${targets.length}`,
  })
  emitGuardNotice({ stdoutJson: { systemMessage: lines.join('\n') } })
}

runFailOpenHook('wt-isolated-spawn-report-path-hook.mjs', main)
