#!/usr/bin/env node
// wt-tmp-glob-rm-guard-hook.mjs — PreToolUse Bash, WARN ONLY; never denies in any mode.
// WHY. Concurrent agents reuse short scratch prefixes. rm /tmp/b8-* removes other agents'
// files too, including mutation backups. Own scratch belongs in a mktemp -d directory.
// Uses rm-critical-path-core's quote/heredoc-aware command traversal, including nested scripts.
// Only an active glob in the FIRST segment under a known temp root warns; deeper globs,
// literal files, quoted/escaped globs and unknown scratch variables deliberately stay silent.
// Probation exit: consider refusal only after 20 live journal firings, read with
// wt-guard-journal-scan.mjs, are all correct and none matched a mktemp or literal path.
// CROSS-PLATFORM VERDICT. Reads command text only: no /proc or filesystem probes beyond
// shared journal bookkeeping (and stdin input). Windows Bash is Git Bash: /tmp maps to user
// temp; /c/Users/<u>/AppData/Local/Temp and $TMP/$TEMP are recognised, case-insensitive for
// the Windows path. macOS $TMPDIR is /var/folders/.../T; /tmp symlinks to /private/tmp.
// WHAT IT DOES NOT COVER: PowerShell Remove-Item; find /tmp -name 'b8-*' -delete; xargs rm;
// F=/tmp/b8-*; rm $F; a glob below the first segment of a shared temp subdirectory; rmdir;
// arbitrary wrappers, script files, or runtime variable values not visible in command text.

import { readStdinJson } from './lib/host/read-stdin-json.mjs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'
import { listRmTargets } from './lib/rm-critical-path-core.mjs'

const GUARD = 'wt-tmp-glob-rm-guard-hook.mjs'
const TEMP_REF = /^\$(?:\{(TMPDIR|TMP|TEMP)(?::?-(?:\/tmp|'\/tmp'|"\/tmp")|:\?[^}]*|%\/)?\}|(TMPDIR|TMP|TEMP)(?!\w))/
const TEMP_ASSIGNMENT = /(?:^|[\s;&|()])(TMPDIR|TMP|TEMP)=/g
const POSIX_ROOT = /^\/(?:private\/)?(?:tmp|var\/tmp|var\/folders\/[^/*?[$`]+\/[^/*?[$`]+\/T)\/+/
const WINDOWS_ROOT = /^\/[a-z]\/Users\/[^/*?[$`]+\/AppData\/Local\/Temp\/+/i

// This is a single raw WORD from the shared parser, not a second command parser. Preserve an
// active-glob mask while removing quotes, and substitute only recognised temp-root references.
function targetShape(word, assigned) {
  let quote = null
  let text = ''
  const active = []
  const append = (s, glob = false) => {
    for (const c of s) {
      if (c === '/' && text.endsWith('/')) continue
      text += c
      active.push(glob)
    }
  }
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i]
    if (c === quote) { quote = null; continue }
    if (!quote && (c === '"' || c === "'")) { quote = c; continue }
    if (c === '\\' && quote !== "'" && i + 1 < word.length) {
      const next = word[++i]
      append(quote === '"' && !/[$`"\\\n]/.test(next) ? `\\${next}` : next)
      continue
    }
    const ref = text === '' && quote !== "'" && c === '$' ? TEMP_REF.exec(word.slice(i)) : null
    if (ref && !assigned.has(ref[1] ?? ref[2])) { append('/tmp'); i += ref[0].length - 1; continue }
    append(c, quote === null && /[*?[\]]/.test(c))
  }
  return { text, active }
}

function hasActiveGlob(segment, active) {
  let bracket = false
  for (let i = 0; i < segment.length; i += 1) {
    if (!active[i]) continue
    if (/[*?]/.test(segment[i])) return true
    if (segment[i] === '[') bracket = true
    if (segment[i] === ']' && bracket) return true
  }
  return false
}

function isTempRootGlob(target, assigned) {
  const { text, active } = targetShape(target, assigned)
  const root = POSIX_ROOT.exec(text) ?? WINDOWS_ROOT.exec(text)
  if (!root) return false
  const start = root[0].length
  const first = text.slice(start).split('/')[0]
  return !/[$`]/.test(first) && hasActiveGlob(first, active.slice(start, start + first.length))
}

function main() {
  const input = readStdinJson()
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return
  const command = input.tool_input?.command
  if (typeof command !== 'string' || !command) return
  // Any command-local assignment makes that name scratch-owned for this text-only warning.
  const assigned = new Set([...command.matchAll(TEMP_ASSIGNMENT)].map((match) => match[1]))
  const targets = [...new Set(listRmTargets(command).filter((target) => isTempRootGlob(target, assigned)))]
  if (targets.length === 0) return
  const namedTargets = targets.map((t) => `\`${t}\``).join(', ')
  const additionalContext =
    `⚠ [workflow-toolbox tmp-glob-rm guard] Temp-root glob target(s): ${namedTargets}. ` +
    'Other agents running at the same time use the same short prefixes, so this glob deletes their files too, ' +
    'including mutation backups. Keep scratch in `T=$(mktemp -d)` and clean it with `rm -rf "${T:?}"`. ' +
    'Warn-only: promotion to refusal requires 20 live firings read from the guard journal ' +
    '(`wt-guard-journal-scan.mjs`), all correct and none on a mktemp or literal path.'
  recordGuardEvent({
    guard: GUARD, decision: 'warned', session: input.session_id, agent: input.agent_id,
    class: 'temp-root-glob', evidence: { shape: 'first-segment-glob', targets: targets.length },
  })
  emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } } })
}

runFailOpenHook(GUARD, main)
