#!/usr/bin/env node
// wt-spawn-capability-guard-hook.mjs — a PreToolUse guard on the Agent tool: refuse a spawn whose
// BRIEF asks the agent to write a file when its agent TYPE has no Write tool.
//
// WHY IT EXISTS. An agent type declares its tools in frontmatter (`tools: Read, Grep, Glob`).
// Brief such a type with "write your report to <path>" and three things happen, in this order:
// it does the work; it cannot write; and it ends its turn saying REPORT WRITTEN. Every signal
// says success. The file is not there. The work survives only inside the agent's transcript,
// and recovering it costs another agent and another pass.
//
// The failure is SILENT and EXPENSIVE, and it is not a knowledge problem: it has been recorded
// in a rule and in a memory note, and it still recurred — twice, ~120k tokens each. A written
// instruction does not fire at the moment of the gesture. A hook does.
//
// WHAT IT CHECKS. Resolve the spawned type's definition, read its `tools:` allowlist, and deny
// only when BOTH hold:
//   1. the type declares an allowlist that does NOT include Write, and
//   2. the prompt asks for a file to be produced at a path.
// A type with no `tools:` line inherits everything — allowed, nothing to say.
//
// WHY DENY RATHER THAN WARN. The two costs are wildly asymmetric. A false deny costs one
// re-brief, immediately, with the reason printed. A false allow costs the whole delegated arc
// and looks like success while doing it. So this guard is biased toward refusing, and it says
// exactly how to fix the brief.
//
// WHY IT DOES NOT GUARD OTHER TOOLS. Bash, Edit and the rest have the same failure shape, but a
// brief mentions commands and files constantly for reasons other than "you must run/write this",
// so pattern-matching them would deny legitimate spawns. Write is the one measured repeatedly,
// and the file-report contract makes its intent unambiguous. One concern per guard.
//
// Any internal error → fail open with one stderr trace. A guard that breaks spawns because of its
// own bug is worse than the gap it closes.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Directories that can hold an agent definition, most specific first. A project copy wins over
 *  a user one, which is the same precedence the harness applies. */
function definitionDirs(cwd) {
  const dirs = []
  if (cwd) {
    let current = path.resolve(cwd)
    for (;;) {
      dirs.push(path.join(current, '.claude', 'agents'))
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  dirs.push(path.join(configDir, 'agents'))
  return dirs
}

/** A plugin-namespaced type (`plugin:name`) resolves on its bare name in these dirs; a plugin's
 *  own agent directory is not searched, because a plugin-registered type's frontmatter is not
 *  honored by the harness anyway — so we only ever act on definitions we can actually trust. */
function findDefinition(type, cwd) {
  const bare = type.includes(':') ? type.slice(type.lastIndexOf(':') + 1) : type
  for (const dir of definitionDirs(cwd)) {
    const file = path.join(dir, `${bare}.md`)
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    } catch {
      /* unreadable dir — keep looking */
    }
  }
  return null
}

/** Return the declared tool allowlist, or null when the definition declares none (= inherits
 *  every tool). Only the frontmatter block is considered. */
function declaredTools(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  const line = match[1].match(/^tools:\s*(.+)$/m)
  if (!line) return null
  const value = line[1].trim()
  if (!value || value === '*') return null
  // Supports `tools: A, B, C` and a YAML inline list `tools: [A, B]`.
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/** Does the brief ask the agent to PRODUCE a file? Deliberately narrow: an imperative write verb
 *  bound to a path or to the report contract. Mentioning a path is not enough — briefs name paths
 *  to READ all the time, and denying those would make the guard the nuisance it exists to prevent. */
const WRITE_INTENT = [
  /\bwrite\b[^.\n]{0,60}\b(?:to|into|at)\b[^.\n]{0,20}[/~][\w./-]+/i,
  /\bwrite\b[^.\n]{0,40}\b(?:report|findings|results?|output|proposal|file)\b[^.\n]{0,40}\bto\b/i,
  /\bREPORT WRITTEN\b/,
  /\b(?:save|persist|emit|output)\b[^.\n]{0,40}\bto\b[^.\n]{0,20}[/~][\w./-]+/i,
  // French — briefs on this machine are frequently written in French.
  // ⚠ No `\b` before an accented letter: JS word boundaries are built on ASCII \w, so `\bé`
  // does not mean what it looks like. And accents get dropped in practice, so match both forms.
  // A pattern that can never fire is worse than no pattern: it looks like coverage.
  /(?:^|[^\p{L}])[ée]cri[st][^.\n]{0,60}(?:dans|vers|à|a)\s[^.\n]{0,20}[/~][\w./-]+/iu,
  /(?:^|[^\p{L}])(?:enregistre|sauvegarde|d[ée]pose|r[ée]dige)[^.\n]{0,60}[/~][\w./-]+/iu,
]

function asksToWriteAFile(prompt) {
  return WRITE_INTENT.some((re) => re.test(prompt))
}

function main() {
  const input = readInput()
  if (input.tool_name !== 'Agent') return

  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  const type = typeof ti.subagent_type === 'string' ? ti.subagent_type.trim() : ''
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : ''
  if (!type || !prompt) return

  const source = findDefinition(type, typeof input.cwd === 'string' ? input.cwd : '')
  if (!source) return // unknown type: cannot judge, so say nothing

  const tools = declaredTools(source)
  if (!tools) return // inherits everything

  const hasWrite = tools.some((t) => t === 'Write' || t === '*')
  if (hasWrite) return
  if (!asksToWriteAFile(prompt)) return

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[workflow-toolbox spawn-capability] Refused: agent type "${type}" declares ` +
          `tools: ${tools.join(', ')} — it has NO Write tool, and this brief asks it to write a ` +
          `file. It would do the work, fail to write, and still end its turn reporting success; ` +
          `the output would survive only in its transcript. Fix the brief, not the agent: ` +
          `either spawn a type that has Write, or require the report to BE the agent's final ` +
          `message (and say "your last output IS the deliverable — do not summarise after it", ` +
          `because only the last message is routed back).`,
      },
    }),
  )
}

runFailOpenHook('wt-spawn-capability-guard-hook.mjs', main)
