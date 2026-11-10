#!/usr/bin/env node
// WHY: real written files have ended with a </content> line then an </invoke> line,
// sometimes a <parameter name="file_path"> line: leaked tool-call markup, not prose.
// WHAT IT DOES NOT COVER: indented lines; lines inside closed fences; other parameter
// close tags such as </new_string>; NotebookEdit; Bash-redirection file writes;
// cd <dir> && git commit (reads input.cwd); --git-dir= / --work-tree= on the git command;
// commits older than 120 seconds at inspection. A command that never committed
// (false && git commit) cannot be told from the stored HEAD alone, so a notice says
// "the HEAD commit ... (committed within the last 120 s)", never "the commit just made".
// Edit and MultiEdit see only new_string: a fence or line context around the replacement in
// the file is invisible, so a replacement inside an existing fence warns and a replacement
// that completes a tag mid-file does not.
// JOURNAL: tool, distinct kinds, hit count, tail proximity, toolUseId, and the session cwd
// every guard of this family records; never the target file path, the content or the commit text.
// WARN-ONLY: absent from SDK role writer lists because their crash handling denies.
// PROBATION EXIT: read 20 distinct real-origin warned Write/Edit/MultiEdit journal
// entries, each located in its transcript by toolUseId, with zero false positives.
// A false positive resets the count and its fix lands first. Then promote those three
// tools via emitGuardNotice(..., subagentDeny: true), refusing with instructions to
// drop the listed lines and call again. PostToolUse commits always remain warn-only.

import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'
import { readStdinJson } from './lib/host/read-stdin-json.mjs'
import { recentCommitMessage } from './lib/host/stray-tool-markup-git.mjs'
import { commitDirectories } from './lib/stray-tool-markup-command.mjs'
import { findStrayToolMarkup } from './lib/stray-tool-markup-core.mjs'

function scanned(text, edit) {
  const hits = findStrayToolMarkup(text)
  // Count the lines once, and only when something was hit.
  const total = hits.length ? text.split('\n').length : 0
  return { hits, edit, tail: hits.some(({ line }) => line > total - 3) }
}

function fileTarget(input) {
  const args = input.tool_input || {}
  let parts
  if (input.tool_name === 'Write') parts = [scanned(args.content)]
  else if (input.tool_name === 'Edit') parts = [scanned(args.new_string, 1)]
  else if (input.tool_name === 'MultiEdit' && Array.isArray(args.edits)) {
    parts = args.edits.map((edit, index) => scanned(edit?.new_string, index + 1))
  } else return []
  return [{ target: String(args.file_path || 'the target file'), parts, write: input.tool_name === 'Write' }]
}

function commitTargets(input) {
  if (input.tool_name !== 'Bash') return []
  const targets = []
  for (const dir of commitDirectories(input.tool_input?.command, input.cwd)) {
    const text = recentCommitMessage(dir)
    if (text === null) continue
    targets.push({ target: `the HEAD commit in ${dir} (committed within the last 120 s)`, parts: [scanned(text)], commit: true })
  }
  return targets
}

const COMMIT_REMEDY = 'Amend the message (`git commit --amend -F <corrected file>` or `git commit --amend -m`).'
const FILE_REMEDY = 'Use an Edit whose old_string is the newline before the flagged line plus the line itself and whose new_string is empty (repeat for each line), or re-run the Write without those lines.'
const LINE_ONE_REMEDY = ' For a hit on line 1 of the file the old_string is the line plus the newline AFTER it.'

function remedyText(target) {
  if (target.commit) return COMMIT_REMEDY
  const first = target.write && target.parts.some(({ hits }) => hits.some(({ line }) => line === 1))
  return FILE_REMEDY + (first ? LINE_ONE_REMEDY : '')
}

function locationText(target, { line, kind }, edit) {
  if (edit) return `line ${line} of new_string (edit ${edit}) (${kind})`
  return target.write && line === 1 ? `line 1 of the file (${kind})` : `line ${line} (${kind})`
}

function noticeText(target) {
  const locations = target.parts.flatMap(({ hits, edit }) => hits.map((hit) => locationText(target, hit, edit)))
  return `⚠ [workflow-toolbox stray tool-call markup] ${target.target}: ${locations.join(', ')}. This call is NOT blocked. ${remedyText(target)}`
}

function journal(input, targets, hits) {
  recordGuardEvent({
    guard: 'wt-stray-tool-markup-guard-hook.mjs', decision: 'warned',
    session: input.session_id, agent: input.agent_id, cwd: input.cwd,
    class: 'stray-tool-markup', evidence: {
      tool: input.tool_name, kinds: [...new Set(hits.map(({ kind }) => kind))].join(','),
      lines: hits.length, tail: targets.some((target) => target.parts.some(({ tail }) => tail)) ? 'yes' : 'no',
      ...(input.tool_use_id ? { toolUseId: input.tool_use_id } : {}),
    },
  })
}

function targetsFor(input) {
  if (input.hook_event_name === 'PreToolUse') return fileTarget(input)
  if (input.hook_event_name === 'PostToolUse') return commitTargets(input)
  return []
}

function main() {
  const input = readStdinJson()
  const targets = targetsFor(input).filter((target) => target.parts.some(({ hits }) => hits.length))
  if (!targets.length) return
  journal(input, targets, targets.flatMap((target) => target.parts.flatMap(({ hits }) => hits)))
  const additionalContext = targets.map(noticeText).join(' ')
  const stdoutJson = input.hook_event_name === 'PreToolUse'
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }
    : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }
  emitGuardNotice({ payload: input, stdoutJson })
}

runFailOpenHook('wt-stray-tool-markup-guard-hook.mjs', main)
