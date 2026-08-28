// shell-text.mjs — the one implementation of "remove the parts of a shell command that are DATA,
// not code", shared by every guard that pattern-matches a command string.
//
// WHY THIS EXISTS AS A MODULE. A command line carries code and data in one string, and nothing
// textual separates them: a heredoc body, a quoted message and a JSON payload all carry the very
// shapes a guard refuses. Mentioning a footgun is not committing one, and a regex over a command
// string cannot see the difference — so a guard that skips this step fires on correct work, and
// the cheapest escape for whoever is blocked is to disable it, which takes its real case with it.
//
// Measured three times on this machine, on three DIFFERENT guards, before this module existed:
//   - a guard refused its own commit message, which quoted the shape it forbids, in a heredoc;
//   - the same guard refused its own test harness, where the shape sat in a quoted JSON payload;
//   - the lane-consent gate refused the command WRITING a test fixture, because the fixture's
//     heredoc body contained an external-CLI invocation string. That gate REFUSES rather than
//     warns, so it blocked correct work outright.
//
// The first two were fixed in place; the third was not, because the fix lived as two hand-written
// copies rather than as one importable function. That is what this module corrects.
//
// ⚠ SCOPE, so nobody expects more than it gives: this is a TEXTUAL approximation, not a shell
// parser. It handles the shapes that actually cause false positives here. It does not understand
// nesting, `$(…)` substitution, or backslash-continued quotes.

/** Strip heredoc BODIES — never real shell in the segment they sit in, always pure data.
 *
 *  A heredoc body line can otherwise become its own pseudo-segment (splitting on bare newlines
 *  treats it as a standalone command) and look like an invocation starting with the matched word.
 *  Handles `<<WORD`, `<<-WORD`, `<<'WORD'` and `<<"WORD"`. */
export function stripHeredocs(cmd) {
  return cmd.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    '<<HEREDOC-BODY-STRIPPED',
  )
}

/** Strip quoted SPANS to empty quotes, so text merely mentioned, echoed, or destined for a commit
 *  message stops looking like an instruction.
 *
 *  ⚠ RESIDUAL, stated rather than hidden: an invocation written with a quoted flag — `git push
 *  "--force"` — reads as `git push ""` afterwards and is no longer caught. That is deliberate. It
 *  is an obfuscation shape, not a reflex mistake, and these guards are defence-in-depth against
 *  reflexes. The ordinary forms are unaffected. Apply this only where the anchor word is never
 *  itself legitimately quoted in a real invocation. */
export function stripQuotedSpans(cmd) {
  return cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

/** Both, in the order that matters: heredocs FIRST, because a heredoc body can contain quotes that
 *  would otherwise pair with quotes outside it and swallow real code. */
export function stripNonCode(cmd) {
  return stripQuotedSpans(stripHeredocs(cmd))
}
