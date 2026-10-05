// wt-secret-guard answers a call that RAN, and failed with a held value in its error, by refusing with the scrubbed
// error: the host checks a changed result against the tool's output schema, never a refusal. Every other refusal a
// rules-on-demand hook can meet from beneath means the call never ran. The guard's ran refusal always carries this
// note on a line of its own, and none of its refusals before execution does. A copy, because a hooks module cannot
// import across plugins; deny-after-run.test.mjs locks it to the guard's constants.js.
export const GUARD_REDACTION_NOTE = '[wt-secret-guard: text of the form secret:<kind>#<id> is a REDACTION TOKEN, not a secret. The real value was removed before it reached you and you have never seen it, so do not warn that a live credential was shared. To USE the value, put the token as-is in a Bash command of this session: the guard substitutes the real value when the command runs and scrubs it again from the output. Nothing else substitutes it: a token written into a file, passed to an MCP tool, or carried to another session stays the literal token, so for those ask the user for a secret:file:/absolute/path or op:// reference instead.]';

export const refusedAfterRun = (text) => typeof text === 'string' && text.split('\n').includes(GUARD_REDACTION_NOTE);

// What rules-on-demand appended to a ran refusal: the lines after the guard's last note line. The scrubbed error
// before it is the tool's own output and may quote anything, a rule block or the note itself included.
export const afterGuardNote = (text) => {
  const lines = text.split('\n');
  return lines.slice(lines.lastIndexOf(GUARD_REDACTION_NOTE) + 1).join('\n');
};
