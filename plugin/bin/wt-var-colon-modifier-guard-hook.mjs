#!/usr/bin/env node
// wt-var-colon-modifier-guard-hook.mjs — a PreToolUse guard, plugin-level: WARNS when a Bash
// command's double-quoted string contains a BARE `$var:letter` — zsh parses `:` right after an
// unbraced parameter name as the start of a history/modifier expansion (`:s`, `:h`, `:t`, `:r`,
// ...), not as literal text.
//
// WHY. Measured 2026-08-04: `git show "$s:src/db-base.ts"`, written to mean "revision `$s`,
// colon, path `src/db-base.ts`" (the ordinary git `rev:path` syntax), instead hit zsh's `:s`
// substitute modifier — malformed without the `/pat/repl/` that modifier expects — and failed
// with `bad substitution`. The command substitution then returned an EMPTY string, so a
// `grep -c` built on it returned `0`: a silent, plausible, INVERTED verdict ("the fix is absent
// from the commit") rather than a visible error. The tell was `bad substitution` on stderr
// sitting next to a result that looked usable.
//
// The failure is intermittent by construction: it only fires when the character right after the
// colon happens to be a modifier letter — a path starting with `src/`, `home/`, `test/` and
// similar all collide; one starting with, say, `docs/` does not. That is exactly why nobody
// notices the pattern is unsafe: it "usually" works.
//
// Safe forms, all deliberately silent: `${var}:path` (braces stop zsh from reading past the
// name), single-quoted strings (no expansion at all), or a form that doesn't concatenate a bare
// var with a literal colon inside double quotes.
//
// ⚠ WARNS, NEVER DENIES — a new guard's precision is measured on material it did not choose
// before it is allowed to block (mechanise-on-sight.md). Measured on real command history:
// - an over-broad 34-letter candidate set produced 22 warnings on 125 matching commands, of
//   which only 6 were genuine — 27% precision;
// - narrowed to the 13 letters `man zshexpn` documents as standalone parameter-expansion
//   modifiers (`a A c e h l P q Q r s t u`), warnings fell to 6, all 6 genuine — 100% precision
//   on that sample.
// That is still one measured sample, not the blocking bar this repo requires (the sibling
// unquoted-glob guard's 197 true positives / 0 false positives over 82,015 commands before it
// shipped denying) — so this guard stays warn-only despite the clean precision figure.
//
// ⚠⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - single-quoted strings (no expansion risk — deliberately silent);
//   - `${var}:...` (braced — the documented safe form — deliberately silent);
//   - a bare `$var:` followed by a non-modifier-letter or non-alphabetic char (digit, `/`, `$`,
//     end of string) — those don't trigger zsh's modifier grammar and are left silent, even
//     though this is a coarse approximation, not a full zsh parser;
//   - an UNRECOGNIZED letter right after `:` does not reliably fall back to literal text — zsh's
//     parser can SKIP it and try the NEXT character as a modifier instead (`$v:frestofpath/more`
//     mutates via the `r` one character past the non-modifier `f`). Narrowing the trigger letters
//     reduces false POSITIVES; it does not reduce false NEGATIVES from this chaining behavior —
//     both are true at once, and this guard was never a full zsh parser;
//   - anything inside a `$(...)` command substitution;
//   - any command other than a Bash tool_use, and any shell other than the one actually running
//     the command (the hazard is zsh-specific).
//
// It strips, before matching, exactly what the sibling unquoted-glob guard strips for the same
// reason: a heredoc body under a QUOTED delimiter (`<<'TAG'`) performs no expansion at all, same
// as single quotes, and text merely DESCRIBING the trap (a commit message, this very header)
// would otherwise match the regex on its own quoting. An UNQUOTED heredoc delimiter (`<<TAG`)
// DOES still expand its body — that shape is deliberately left in place for the match to see.

import { readFileSync } from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

// Strip spans where the shell performs NO expansion, so text merely describing the trap (a
// commit message, a doc comment) doesn't trip the same regex the trap itself would. Order
// matters: heredocs first (their own delimiter uses quote characters that single-quote
// stripping would otherwise mangle), THEN single-quoted spans, THEN backticks.
function stripDataSpans(cmd) {
  let out = cmd
  // Heredoc with a QUOTED delimiter (<<'TAG', <<"TAG", <<-'TAG') — the whole body is literal,
  // no expansion at all, same as single quotes. Strip it wholesale.
  out = out.replace(/<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\2$/gm, '<<HEREDOC')
  // Unterminated quoted-delimiter heredoc (tag never closes inside this command): drop the tail
  // too, rather than let a bare fragment of the body match past the end.
  out = out.replace(/<<-?\s*(['"])[A-Za-z_][A-Za-z0-9_]*\1[\s\S]*$/, '<<HEREDOC')
  // Single-quoted spans — no expansion at all, whatever characters sit inside them.
  out = out.replace(/'[^']*'/g, "'Q'")
  // Backtick/markdown code spans — prose quoting the shape, never executed.
  out = out.replace(/`[^`]*`/g, '`CODESPAN`')
  return out
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

// A bare (unbraced) parameter reference — $NAME — immediately followed by `:` and a letter that
// is a real zsh history/parameter modifier, while inside a DOUBLE-quoted string. We approximate
// "inside a double-quoted string" by requiring the match to start right after an opening `"` —
// cheap and sufficient for a warn-only guard: it fires on the documented shape
// (`"$var:letter...`) and stays silent on `${var}:...` and on single quotes.
//
// The full list of standalone parameter-expansion modifiers documented by `man zshexpn`'s
// "Modifiers" section is exactly: a A c e h l P q Q r s t u (`x` and `p` are excluded — the
// manual states they work only with history expansion, `!!:p`/`!!:x`, never with `$var:...`
// parameter expansion, confirmed empirically: both come back byte-identical to the literal
// input in this shape). Every other letter is not a documented zsh modifier at all, and a
// clean, isolated `$v:LETTER` test leaves it completely literal.
const MODIFIER_LETTERS = 'aAcehlPqQrstu'
const BARE_VAR_COLON_MODIFIER = new RegExp(
  `"[^"]*\\$([A-Za-z_][A-Za-z0-9_]*):([${MODIFIER_LETTERS}])`,
)

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const raw = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!raw) return
  const cmd = stripDataSpans(raw)

  const m = cmd.match(BARE_VAR_COLON_MODIFIER)
  if (!m) return

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `⚠ [workflow-toolbox var-colon guard] Found a bare "$${m[1]}:${m[2]}..." ` +
        'inside a double-quoted string — in zsh, `:` right after an unbraced parameter name ' +
        'starts a history/modifier expansion (`:s`, `:h`, `:t`, `:r`, ...), not literal text. ' +
        'Measured 2026-08-04: `git show "$s:src/db-base.ts"` failed with `bad substitution` and ' +
        'the empty result silently read as "not found" instead of erroring loudly. Safe form: ' +
        '`"${var}:path"` (braces), or single quotes if no expansion is needed.',
    },
  }
  process.stdout.write(JSON.stringify(payload))
}

runFailOpenHook('wt-var-colon-modifier-guard-hook.mjs', main)
