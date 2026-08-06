#!/usr/bin/env node
// wt-rule-edit-horizon-hook.mjs — surface the reload horizon at the moment an
// ambient rule is edited, when the otherwise-delayed effect is easiest to miss.
//
// Ambient rules are snapshotted when a session starts. A sub-agent spawn inherits
// that session's snapshot, so neither the current session nor a spawn can verify an
// edit; only a newly started session can. The hook is deliberately silent for every
// other edit so the useful signal does not become routine noise.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

/** Read the hook payload; malformed or empty input is a silent no-op. */
function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function editedFile(payload) {
  if (payload?.hook_event_name !== 'PostToolUse' || !EDIT_TOOLS.has(payload?.tool_name)) return null
  const input = payload?.tool_input
  if (typeof input?.file_path === 'string' && input.file_path) return input.file_path
  const firstEdit = Array.isArray(input?.edits) ? input.edits[0] : null
  return typeof firstEdit?.file_path === 'string' && firstEdit.file_path
    ? firstEdit.file_path
    : null
}

// Accept BOTH slash styles for the leading `~` regardless of host platform: a payload's
// file_path is produced by the tool call, not typed at a platform-native shell, so a
// forward-slash tilde path can legitimately reach us even on Windows.
function normalizeFile(file, cwd) {
  const expanded = file === '~'
    ? os.homedir()
    : file.startsWith('~/') || file.startsWith('~\\')
      ? path.join(os.homedir(), file.slice(2))
      : file
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : typeof cwd === 'string' && cwd
      ? path.resolve(cwd, expanded)
      : null
}

const CLAUDE_DIR_SEGMENT = /^\.claude(-.*)?$/

// Ambient rules live one level under a `.claude`-named (or `.claude-*`, e.g. `.claude-work`)
// directory: `<config-dir>/rules/*.md`. `rules` must be the DIRECT child of that segment —
// `.claude/agents/rules/x.md` or `.claude/rules-backup/rules/x.md` are NOT the ambient rules
// dir, just files that happen to sit under a nested "rules"-named folder. A CLAUDE_CONFIG_DIR
// pointed at an arbitrarily-named directory (documented as configurable, e.g.
// `/srv/claude-config`) is honored explicitly, since the `.claude*`-naming heuristic can't see it.
function isAmbientRule(file) {
  if (!file.endsWith('.md')) return false
  const segments = file.split(/[\\/]+/).filter(Boolean)
  const rulesIndex = segments.lastIndexOf('rules')
  if (rulesIndex < 1 || rulesIndex === segments.length - 1) return false
  if (CLAUDE_DIR_SEGMENT.test(segments[rulesIndex - 1])) return true

  const configDir = process.env.CLAUDE_CONFIG_DIR
  if (!configDir) return false
  try {
    const rel = path.relative(configDir, file)
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel) &&
      rel.split(/[\\/]+/)[0] === 'rules'
  } catch {
    return false
  }
}

function main() {
  const payload = readInput()
  if (!payload) return
  const sourceFile = editedFile(payload)
  if (!sourceFile) return
  const file = normalizeFile(sourceFile, payload.cwd)
  if (!file || !isAmbientRule(file)) return

  // ⚠ TWO things, and the second is why this hook is the right home for it.
  //
  // The reload horizon is the original job. The WRITING CONVENTIONS ride along because they
  // apply every single time a rule is written and nowhere else — and a convention that lives
  // only in a note is recall-on-demand, so it reaches whoever already suspects it and never
  // the person about to break it. This hook already fires on exactly that event, so carrying
  // the directive costs no new mechanism, no new rule file, and no noise on any other edit.
  //
  // ⚠ Keep it SHORT. This fires on EVERY ambient-rule edit; the moment it grows into a
  // paragraph it becomes the routine noise this file's header promises it is not, and the
  // reload horizon — the part that is genuinely easy to miss — drowns with it.
  const context =
    `Editing ${file} is verifiable ONLY FROM A NEW SESSION: an agent spawn inherits its ` +
    `session's rule snapshot, so neither this session nor a spawn can confirm the change. ` +
    `Writing conventions for a rule file: telegraphic register — strip GRAMMAR, never CONTENT. ` +
    `A clause you can only shorten by losing a nuance stays long: compressed into a one-liner it ` +
    `survives in the file and STOPS ACTING (measured 3/3 to 1/3). And a rule is a DIRECTIVE — ` +
    `dates, incident stories and field cases go to a note, not here.`

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    }),
  )
}

try {
  main()
} catch {
  // An observation hook must never disrupt the tool it follows: emit nothing, exit clean.
}
