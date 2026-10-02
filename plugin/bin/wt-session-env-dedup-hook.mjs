#!/usr/bin/env node
// SessionStart hook: keeps a session's env files from growing until Bash fails with E2BIG.
//
// Claude Code gives every SessionStart hook its own CLAUDE_ENV_FILE
// (`<config dir>/session-env/<id>/sessionstart-hook-<N>.sh`) and inlines all of them into every
// Bash command. A plugin that appends `export` lines at each start, without deduplicating, grows
// that text past the Linux single-argument limit (128 KiB). This hook removes repeated LITERAL
// export lines (last occurrence wins, so every variable keeps its final value) from the current
// session's directory and warns when the directory is still over 64 KiB.
//
// Advisory and best effort: every path exits 0; no CLAUDE_ENV_FILE (other harnesses) or one that is
// not a hook env file under a `session-env` directory is a silent no-op. On Windows nothing is
// rewritten (the rename-over-an-open-file the rewrite relies on is refused there); the size alarm
// still runs and says deduplication is unavailable on this platform.
// The file operations live in lib/host/session-env-dedup.mjs.

import { readStdinJson, runSessionEnvDedup } from './lib/host/session-env-dedup.mjs'

try {
  const text = runSessionEnvDedup(process.env.CLAUDE_ENV_FILE, readStdinJson().session_id)
  if (text) {
    // A closed output pipe must not turn a warning into a failing hook.
    process.stdout.on('error', () => {})
    process.stderr.on('error', () => {})
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`,
    )
    process.stderr.write(`${text}\n`)
  }
} catch {
  // A session-start cleanup must never delay or prevent a session from starting.
}
