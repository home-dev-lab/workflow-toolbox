// wt-secret-guard answers a call that RAN, and failed with a held value in its error, by refusing with the scrubbed
// error: the host checks a changed result against the tool's output schema, never a refusal. Every other refusal a
// rules-on-demand hook can meet from beneath means the call never ran. The guard's ran refusal always carries this
// note on a line of its own, and none of its refusals before execution does. A copy, because a hooks module cannot
// import across plugins; deny-after-run.test.mjs locks it to the guard's constants.js.
export const GUARD_REDACTION_NOTE = '[wt-secret-guard: text of the form secret:<kind>#<id> is a REDACTION TOKEN, not a secret. The real value was removed before it reached you and you have never seen it, so do not warn that a live credential was shared. To USE the value, put the token as-is in a Bash command of this session: the guard substitutes the real value when the command runs and scrubs it again from the output. Nothing else substitutes it: a token written into a file, passed to an MCP tool, or carried to another session stays the literal token, so for those ask the user for a secret:file:/absolute/path or op:// reference instead.]';

export const refusedAfterRun = (text) => typeof text === 'string' && text.split('\n').includes(GUARD_REDACTION_NOTE);

// The transcript stores a refusal inside this wrapper; the live hook chain sees it bare, so only the offline readers
// unwrap. Without it, a note that ends the refusal reads `<note></tool_use_error>` and is no longer a line of its own.
const WRAP_OPEN = '<tool_use_error>';
const WRAP_CLOSE = '</tool_use_error>';
const unwrapped = (text) => {
  const trimmed = text.trimEnd();
  const wrapped = trimmed.startsWith(WRAP_OPEN) && trimmed.endsWith(WRAP_CLOSE);
  return wrapped ? trimmed.slice(WRAP_OPEN.length, -WRAP_CLOSE.length) : text;
};

// An errored tool result from a transcript, as the text of the guard's ran refusal; null when it is not one.
export const storedRanRefusal = (text) => {
  if (typeof text !== 'string') return null;
  const bare = unwrapped(text);
  return refusedAfterRun(bare) ? bare : null;
};

const RULE_CLOSE = '\n</rule>';
const RULE_OPEN = '\n\n<rule name="';
const OPENING_LINE = /^<rule name="[^"\n]+">\n/;

// rules-on-demand BELOW the guard returns its rules as context; the guard joins the scrubbed error and every context
// item with blank lines, then puts its note under them. So the rules it carried are a trailing run of whole blocks:
// each opens on its own line after a blank line, ends at its first line starting `</rule>`, and the last ends on the
// line right above the note. A block the error quoted elsewhere is not in that run. Residuals, no layout tells them
// apart: an error that itself ends in such a block reads as carried; a rule whose content holds an opening line after
// a blank line reads under the inner name; a rule with a line starting `</rule>` in its content is not read.
function foldedRun(before) {
  let start = before.length;
  for (;;) {
    const head = before.slice(0, start);
    const open = head.lastIndexOf(RULE_OPEN);
    if (open < 0) break;
    const block = head.slice(open + 2);
    if (!OPENING_LINE.test(block) || block.indexOf(RULE_CLOSE) !== block.length - RULE_CLOSE.length) break;
    start = open;
  }
  return before.slice(start);
}

// What rules-on-demand put on a ran refusal, given the text storedRanRefusal returns. Above the guard, it appends its
// rules after the guard's last note line; below it, the guard folds them in just above that line. The scrubbed error
// before them is the tool's own output and may quote anything, a rule block or the note itself included: when a rule
// block follows the note, that is the carried part and nothing above the note is read.
export const guardCarried = (text) => {
  const lines = text.split('\n');
  const note = lines.lastIndexOf(GUARD_REDACTION_NOTE);
  const after = lines.slice(note + 1).join('\n');
  if (after.includes('<rule name="')) return after;
  return foldedRun(lines.slice(0, note).join('\n'));
};
