#!/usr/bin/env node
// wt-unquoted-tool-glob-guard-hook.mjs — a PreToolUse guard, plugin-level: DENIES a Bash
// command that passes a glob pattern to a TOOL OPTION unquoted — `grep --include=*.ts`,
// `find -name *.mjs`, `--exclude=*.log`, `-path */node_modules/*`.
//
// WHY. In zsh, a glob with NO match is a hard ERROR, not an empty expansion: the command
// aborts BEFORE any redirection, so `grep -rn X --include=*.ts .` dies with `no matches
// found` and produces nothing on stdout. In a compound command (`A; B` / `A && B`) the whole
// line can die, so EVERY branch's output is empty too.
//
// That is what makes this worth a BLOCKING guard rather than an advisory one: the failure
// does not look like a failure. It looks like a clean, empty, believable result — "no hits",
// "the registration isn't there", "the feature is absent". The reliable tell is a ROUND ZERO
// on a check you expected to pass.
//
// The two outcomes are BOTH wrong, which is what makes unquoted always a mistake here:
//   - no match  -> the command never runs, and the silence reads as a finding;
//   - a match   -> the shell expands the pattern against the CURRENT DIRECTORY and hands the
//                  tool concrete filenames, so `--include=*.ts` silently becomes
//                  `--include=app.ts` and the search quietly covers one file instead of a tree.
// There is no case where passing these flags an unquoted glob is what the author meant.
//
// Safe forms, all deliberately silent: `--include='*.ts'`, `--include="*.ts"`, `-name '*.mjs'`.
//
// ⚠ WHY THIS ONE SHIPS BLOCKING, NOT WARN-ONLY. Every other new guard here ships warn-only
// until its precision is measured on material it did not choose (a false-positive rate at
// unknown quality is worse than no guard). This one was measured before shipping: 5,193
// session transcripts scanned, 82,015 Bash commands; 206 distinct commands matched the
// option-value glob shape after dedup by exact text; each of the 206 fed to this guard's own
// executable as a real PreToolUse payload; result 197 true positives, 0 false positives, 9
// correct silences (its own heredoc/prose exclusions firing correctly). The material was
// entirely unchosen — written before the guard existed, by many sessions, across projects.
//
// ⚠⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - a bare unquoted glob as an ORDINARY argument (`ls path/prefix*`) — the same shell abort
//     applies, but there the glob is usually meant for the shell to expand, so flagging it
//     would refuse correct work; the narrow flag set below is where unquoted is unambiguously
//     wrong, never where it might be intended;
//   - `--include` / `-name` written with a variable (`--include=$PAT`) — a different hazard;
//   - the sibling zsh traps this guard says nothing about: unquoted word-splitting
//     (`for x in $LIST`), or `$var:path` being read as a parameter modifier rather than
//     concatenation;
//   - any tool other than a Bash tool_use, and any shell other than the one actually running
//     the command (the hazard is zsh-specific; a bash-only session would not hit the abort
//     half of it, though the silent-expansion half still applies in bash too).

import { readFileSync } from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

// A glob character that the shell would try to expand, in a token that is NOT quoted.
// Two shapes, matching how these flags are written in practice:
//   --include=*.ts / --exclude=*.log        (flag=value)
//   -name *.mjs / -path */node_modules/*    (flag<space>value)
const FLAG_EQ_GLOB = /(--(?:include|exclude|include-dir|exclude-dir)=)(?!['"])([^\s'"]*[*?[][^\s'"]*)/
const FLAG_SP_GLOB = /(^|\s)(-(?:name|iname|path|ipath|wholename)\s+)(?!['"])([^\s'"]*[*?[][^\s'"]*)/

// A command line carries CODE and DATA in the same string. A heredoc body (a commit message, a
// file being written) and a markdown span in backticks are DATA: the shell never expands them,
// so a glob there is prose, not a command. Strip data spans before matching, or the guard nags
// on — or here, REFUSES — text that merely describes the shape it guards, and a guard that
// refuses correct work gets switched off, taking its real cases with it.
function stripDataSpans(cmd) {
  let out = cmd
  // Heredoc bodies: <<'TAG' ... TAG   /  <<TAG ... TAG  (quoted or bare, optional -)
  out = out.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\2$/gm, '<<HEREDOC')
  // Unterminated heredoc (the tag never closes inside this command): drop the tail.
  out = out.replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1[\s\S]*$/, '<<HEREDOC')
  // Markdown/backtick spans — prose quoting a command rather than running it.
  out = out.replace(/`[^`]*`/g, '`CODESPAN`')
  // QUOTED spans, single and double. The hazard REQUIRES the glob to be unquoted in the
  // shell's own parse: anything inside quotes is never expanded, so it can neither abort the
  // command nor silently become a filename — whether it is a real argument or an example
  // string being passed to something else. Removing quoted spans first leaves exactly the
  // dangerous population behind, and is why this guard can stay quiet on text ABOUT the trap.
  out = out.replace(/'[^']*'/g, "'Q'").replace(/"[^"]*"/g, '"Q"')
  return out
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const raw = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!raw) return
  const cmd = stripDataSpans(raw)

  const eq = cmd.match(FLAG_EQ_GLOB)
  const sp = cmd.match(FLAG_SP_GLOB)
  if (!eq && !sp) return

  const shown = eq ? `${eq[1]}${eq[2]}` : `${sp[2].trim()} ${sp[3]}`
  const fixed = eq ? `${eq[1]}'${eq[2]}'` : `${sp[2].trim()} '${sp[3]}'`

  recordGuardEvent({
    guard: 'wt-unquoted-tool-glob-guard-hook.mjs',
    decision: 'blocked',
    class: 'unquoted-glob',
    reason: shown,
  })
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[workflow-toolbox glob guard] Refused: Unquoted glob passed to a tool flag: ` +
          `\`${shown}\`. In zsh a glob with NO match is a hard ERROR that aborts the command ` +
          'before any redirection — so the command produces nothing and the emptiness reads ' +
          'as a real finding ("no hits", "not registered", "absent"). And if it DOES match, ' +
          'the shell expands it against the current directory, so the tool silently receives ' +
          'concrete filenames instead of the pattern. Both outcomes are wrong. There is no ' +
          `case where this flag is meant to take an unquoted glob. Quote it: \`${fixed}\`.`,
      },
    }),
  )
}

runFailOpenHook('wt-unquoted-tool-glob-guard-hook.mjs', main)
