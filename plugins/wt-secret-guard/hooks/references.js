// Parse, then transform: ONE shell lexer classifies every reference-shaped span by its quoting
// context, and only the documented allow-list below is ever expanded. Anything else - an unknown
// form, an unsupported context, an `op read` whose reference is not a literal - is refused, so no
// path through this module can execute a command whose references it did not fully understand.
//
// ALLOW-LIST (kept in step with README "Supported secret references")
//   forms     op://vault/item[/section]/field
//             op read <literal op:// reference> with documented flags
//             secret:env:NAME
//             secret:file:/absolute/path[#line]
//             a redaction token this session issued
//   contexts  bare shell word
//             the complete contents of a single-quoted word
//             the complete contents of a double-quoted word
//   not ours  a heredoc body, quoted or not: a reference there stays literal text, is not prefetched
//             and does not refuse the command (injection into files is `op inject`'s job)
//   grammar   a command using one of THESE forms must fit the ALLOW-LIST (see allowList): simple
//             commands with literal command names (listed wrappers followed by a literal name), joined
//             by ; && || | & or a newline, words that are literal, our forms, or double-quoted
//             "$NAME"/"${NAME}" text, literal redirection targets, one plain heredoc. Everything else
//             is refused with what to rewrite. A command with none of our forms is never examined.
//   out of scope  anything else that might run `op` without our forms - a computed or aliased name,
//             eval, the argument list of a program not on the wrapper list. Not refused, not
//             prefetched: its output is protected only by the detectors and the values in the vault.
//
// Measured over six review rounds: a deny-list of "places a command name hides" lost to each new bash
// spelling (case bodies, function bodies, `time -p`, nested heredocs, `${Y:-$(...)}`, field splitting).
// Beside our forms the guard therefore accepts a small grammar and refuses the rest.
//
// Measured 2026-09-08: OP_ACCOUNT does not cross WSL interop, while the explicit --account
// positional argv does, so account identity stays part of each invocation.

const OP_PATH = /^[\p{L}\p{N}._' -]+(?:\/[\p{L}\p{N}._' -]+){2,3}$/u;
const BARE_PATH = /^[\p{L}\p{N}._-]+(?:\/[\p{L}\p{N}._-]+){2,3}(?!\/)/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]*/;
// Every word/blank decision uses bash's OWN blank set - space, tab and newline - never JavaScript's `\s`,
// which also holds the vertical tab, the form feed, NBSP and every Unicode space: bash reads those as
// ordinary word characters (Astra at 2618aa81: `x\v# "$(printf MARK)"` is one word to bash, not a word
// and a comment, and bash ran the substitution).
const FILE_PATH = /^\/[^ \t\n"'#)<>&;|`$\\]+/;
const FILE_LINE = /^#([1-9]\d*)/;
const VAULT_TOKEN = /^secret:[a-z-]+#[a-f0-9]{6}/i;
const REFERENCE = /op:\/\/|secret:[A-Za-z0-9_-]+[:#]/g;
const SEPARATOR = /[ \t\n;|&()<>]/;
const OP_COMMAND = /^(?:[^ \t\n/]*\/)*op(?:\.exe)?$/;
// Beside our forms a command holds only printable ASCII, space, tab and newline (see allowList).
const OUTSIDE_ALLOWED_BYTES = /[^\x20-\x7e\t\n]/u;
const OP_VERBS = new Set(['read', 'inject', 'run']);
const VALUE_FLAGS = new Set(['--account', '-o', '--out-file', '--encoding', '--file-mode', '--format', '--session', '--config']);
const BOOLEAN_FLAGS = new Set(['-n', '--no-newline', '-f', '--force', '--no-color', '--cache']);

// Constructs whose decoding this guard does not own. A reference-bearing command that carries one
// anywhere is refused, by name; a command that carries no reference is left alone.
const ANSI_C = "ANSI-C quoting ($'...')";
const LOCALE = 'locale quoting ($"...")';
const BACKTICKS = 'backtick command substitution';
const NUL = 'a NUL byte';
// Contexts whose text is never a shell word: skipped when reading words, never expanded into.
const NOT_WORDS = new Set(['comment', 'heredoc', 'heredoc-quoted', 'heredoc-unsupported', 'heredoc-end']);
// A heredoc body - quoted or not - is NOT a context this guard expands (round 8 decision). A
// reference written there stays literal in what the command writes, is not prefetched, and does not
// refuse the command: the guard cannot tell "inject this secret into a file" from "write a document
// that mentions a reference", and the first is exactly the path that puts a secret on disk. Injection
// into files belongs to 1Password's own `op inject`.
const HEREDOC_BODY = new Set(['heredoc', 'heredoc-quoted', 'heredoc-unsupported', 'heredoc-end']);
// `op read` flags whose output the guard cannot reproduce from a bound value.
const OUTPUT_FLAGS = new Set(['-o', '--out-file', '--encoding', '--file-mode', '--format']);
// `op read` options that change how 1Password RESOLVES the reference. The prefetch carries --account
// exactly; these it does not carry, so the command is refused rather than resolved differently from what
// it asked (Astra at f98cf712: --config and --session were silently dropped).
const RESOLUTION_FLAGS = new Set(['--config', '--session', '--cache']);
// A FIXED list of external wrappers whose argument list names the command they run, each with the
// option grammar read on this machine (2026-09-23): GNU coreutils 9.4 env, timeout, nice, nohup,
// stdbuf, chroot; util-linux 2.39.3 setsid, ionice, taskset; sudo 1.9.15p5 (find is handled apart:
// its -exec actions; xargs is refused outright, see commandHead). doas is not installed here: its grammar is doas(1)'s
// synopsis, `doas [-Lns] [-a style] [-C config] [-u user] command`, not read locally.
// Every one of them stops at its first non-option (measured: `timeout 5 printf %s -k 1` passes -k to
// printf) and accepts a unique abbreviation of a long option (`env --uns=HOME`, `timeout --sig=KILL`).
// Option kinds: 0 a flag; 1 takes a value (glued `-uroot`, or the next word; `--name=v` or `--name v`);
// 'opt' a long option whose value is only ever `=v`; 'glued' a short option whose value is only ever
// glued (`-l5`); 'none' no command runs (the rest are plain arguments); 'refuse' a grammar the guard
// does not place (env -S splits a string into the command). `operands`: positional words before the
// command (timeout's DURATION, chroot's NEWROOT, taskset's mask). Anything unknown refuses.
// Not on this list - any other program that runs its arguments - is out of scope (README).
const WRAPPERS = {
  // The bash builtins that run their argument (bash 5.2 `help exec` / `help command`): short options
  // only, no long ones, clusters allowed (`exec -ca label cmd`).
  exec: { short: { c: 0, l: 0, a: 1 }, long: {} },
  command: { short: { p: 0, v: 'none', V: 'none' }, long: {} },
  builtin: { short: {}, long: {} },
  env: {
    short: { i: 0, 0: 0, v: 0, u: 1, C: 1, S: 'refuse' },
    long: { 'ignore-environment': 0, null: 0, unset: 1, chdir: 1, 'split-string': 'refuse', 'block-signal': 'opt', 'default-signal': 'opt', 'ignore-signal': 'opt', 'list-signal-handling': 0, debug: 0 },
    dash: true, assignments: true,
  },
  timeout: { short: { k: 1, s: 1, v: 0 }, long: { 'kill-after': 1, signal: 1, verbose: 0, 'preserve-status': 0, foreground: 0 }, operands: 1 },
  nice: { short: { n: 1 }, long: { adjustment: 1 }, numeric: true },
  nohup: { short: {}, long: {} },
  stdbuf: { short: { i: 1, o: 1, e: 1 }, long: { input: 1, output: 1, error: 1 } },
  setsid: { short: { c: 0, f: 0, w: 0 }, long: { ctty: 0, fork: 0, wait: 0 } },
  sudo: {
    short: { A: 0, b: 0, B: 0, E: 0, H: 0, i: 0, k: 0, n: 0, P: 0, s: 0, S: 0, C: 1, D: 1, g: 1, p: 1, R: 1, r: 1, t: 1, T: 1, U: 1, u: 1, e: 'none', l: 'none', v: 'none', K: 'none', V: 'none', h: 'refuse' },
    long: {
      askpass: 0, background: 0, bell: 0, 'close-from': 1, chdir: 1, 'preserve-env': 'opt', edit: 'none', group: 1, 'set-home': 0, host: 1, login: 0,
      'remove-timestamp': 'none', 'reset-timestamp': 0, list: 'none', 'non-interactive': 0, 'preserve-groups': 0, prompt: 1, chroot: 1, role: 1,
      stdin: 0, shell: 0, type: 1, 'command-timeout': 1, 'other-user': 1, user: 1, validate: 'none',
    },
  },
  doas: { short: { L: 'none', n: 0, s: 0, a: 1, C: 1, u: 1 }, long: {} },
  chroot: { short: {}, long: { groups: 1, userspec: 1, 'skip-chdir': 0 }, operands: 1 },
  ionice: { short: { c: 1, n: 1, t: 0, p: 'none', P: 'none', u: 'none' }, long: { class: 1, classdata: 1, ignore: 0, pid: 'none', pgid: 'none', uid: 'none' } },
  taskset: { short: { a: 0, c: 0, p: 'none' }, long: { 'all-tasks': 0, 'cpu-list': 0, pid: 'none' }, operands: 1 },
};
// Own properties only: a command named `toString` or `constructor` read the inherited method as a
// wrapper spec and threw on the reference-free path (Astra at 2618aa81).
const wrapperSpec = (name) => (Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

const quoteForSingleQuotes = (value) => value.replace(/'/g, "'\"'\"'");

// Reads one heredoc body the way bash does, measured on bash 5.2.21:
// - in an UNQUOTED heredoc bash removes every backslash-newline BEFORE it compares a line with the
//   delimiter: `text\` then `EOF` reads as `textEOF`, which does not end the body, and `EO\` then `F`
//   reads as `EOF`, which does. An odd run of trailing backslashes continues the line; an even one is
//   escaped backslashes and does not;
// - a quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) joins nothing;
// - `<<-` strips leading tabs from the LOGICAL line: `\tEO\` then `\tF` reads `EO\tF`, no end.
function consumeHeredoc(command, context, escapes, constructs, doc, start) {
  let lineStart = start;
  while (lineStart <= command.length) {
    let logical = ''; let cursor = lineStart; let lineEnd;
    for (;;) {
      lineEnd = command.indexOf('\n', cursor);
      const physical = command.slice(cursor, lineEnd < 0 ? command.length : lineEnd);
      const trailing = physical.length - physical.replace(/\\+$/, '').length;
      if (!doc.quoted && lineEnd >= 0 && trailing % 2 === 1) { logical += physical.slice(0, -1); cursor = lineEnd + 1; continue; }
      logical += physical;
      break;
    }
    const end = lineEnd < 0 ? command.length : lineEnd;
    if ((doc.strip ? logical.replace(/^\t+/, '') : logical) === doc.delimiter) {
      for (let at = lineStart; at < end; at += 1) context[at] = 'heredoc-end';
      if (lineEnd >= 0) context[lineEnd] = 'bare';
      return lineEnd < 0 ? command.length : lineEnd + 1;
    }
    let depth = 0;
    for (let at = lineStart; at < end; at += 1) {
      const character = command[at];
      if (doc.quoted) { context[at] = 'heredoc-quoted'; continue; }
      if (character === '\\') { context[at] = 'heredoc'; escapes.add(at); if (at + 1 < end) context[at + 1] = 'heredoc'; at += 1; continue; }
      // An unquoted heredoc body runs backticks as command substitutions.
      if (character === '`') { constructs.add(BACKTICKS); context[at] = 'heredoc-unsupported'; continue; }
      if (character === '$' && (command[at + 1] === '(' || command[at + 1] === '{')) { depth += 1; context[at] = 'heredoc-unsupported'; context[at + 1] = 'heredoc-unsupported'; at += 1; continue; }
      if (depth > 0 && (character === ')' || character === '}')) { depth -= 1; context[at] = 'heredoc-unsupported'; continue; }
      context[at] = depth > 0 ? 'heredoc-unsupported' : 'heredoc';
    }
    if (lineEnd < 0) return -1;
    context[lineEnd] = doc.quoted ? 'heredoc-quoted' : 'heredoc';
    lineStart = lineEnd + 1;
  }
  return -1;
}

// Returns, for every byte of the command, the quoting context it sits in, plus the bounds of the
// quoted word that encloses it. 'unsupported' covers parameter expansion, backticks and $'...';
// 'comment' and the heredoc-* contexts cover text that is never a shell word. None of them is ever
// expanded into.
// `escapes` carries the position of every backslash the shell consumes as an escape, so a caller
// replacing a span can tell an escaped reference from one that starts its own word.
// `constructs` names every construct present whose decoding this guard does not own. It does not
// decode them: a reference-bearing command that contains one is refused (see planReferences).
export function lex(command) {
  const size = command.length;
  const context = new Array(size).fill('bare');
  const bounds = new Array(size).fill(null);
  const escapes = new Set();
  const constructs = new Set();
  const stack = [{ type: 'top' }];
  const pending = [];
  let complete = true;
  // A heredoc whose end the guard cannot place with certainty: a command using our forms refuses.
  let uncertain = false;
  let index = 0;
  const close = (frame, at, kind) => {
    for (let k = frame.start + 1; k < at; k += 1) if (context[k] === kind && bounds[k] === null) bounds[k] = [frame.start, at];
  };
  while (index < size) {
    const frame = stack.at(-1);
    const character = command[index];
    const base = frame.type === 'top' || frame.type === 'subst' || frame.type === 'paren';
    if (frame.type === 'single') {
      if (character === "'") { close(frame, index, 'single'); context[index] = 'quote'; stack.pop(); index += 1; continue; }
      context[index] = 'single'; index += 1; continue;
    }
    if (frame.type === 'ansi' || frame.type === 'backtick') {
      const closer = frame.type === 'ansi' ? "'" : '`';
      context[index] = 'unsupported';
      if (character === '\\') { if (index + 1 < size) context[index + 1] = 'unsupported'; index += 2; continue; }
      if (character === closer) { stack.pop(); index += 1; continue; }
      index += 1; continue;
    }
    if (frame.type === 'param') {
      context[index] = 'unsupported';
      if (character === '`') constructs.add(BACKTICKS);
      if (character === '$' && command[index + 1] === "'") constructs.add(ANSI_C);
      if (character === '{') frame.depth += 1;
      if (character === '}') { if (frame.depth === 0) stack.pop(); else frame.depth -= 1; }
      index += 1; continue;
    }
    if (frame.type === 'comment') {
      if (character === '\n') { stack.pop(); continue; }
      context[index] = 'comment'; index += 1; continue;
    }
    if (frame.type === 'double') {
      if (character === '\\') { context[index] = 'double'; escapes.add(index); if (index + 1 < size) context[index + 1] = 'double'; index += 2; continue; }
      if (character === '"') { close(frame, index, 'double'); context[index] = 'quote'; stack.pop(); index += 1; continue; }
      if (character === '$' && command[index + 1] === '(') { context[index] = 'double'; context[index + 1] = 'double'; stack.push({ type: 'subst' }); index += 2; continue; }
      // The frame opens AFTER `${`: counting its own brace left every `${NAME}` open to the end of the
      // command, so anything written after it read as unsupported and the command as unfinished.
      if (character === '$' && command[index + 1] === '{') { context[index] = 'double'; context[index + 1] = 'unsupported'; stack.push({ type: 'param', depth: 0 }); index += 2; continue; }
      if (character === '`') { constructs.add(BACKTICKS); stack.push({ type: 'backtick' }); context[index] = 'unsupported'; index += 1; continue; }
      context[index] = 'double'; index += 1; continue;
    }
    if (!base) { context[index] = 'unsupported'; index += 1; continue; }
    if (character === '\\') { context[index] = 'bare'; escapes.add(index); if (index + 1 < size) context[index + 1] = 'bare'; index += 2; continue; }
    if (character === "'") { context[index] = 'quote'; stack.push({ type: 'single', start: index }); index += 1; continue; }
    if (character === '"') { context[index] = 'quote'; stack.push({ type: 'double', start: index }); index += 1; continue; }
    if (character === '$' && command[index + 1] === "'") { constructs.add(ANSI_C); context[index] = 'unsupported'; context[index + 1] = 'unsupported'; stack.push({ type: 'ansi' }); index += 2; continue; }
    if (character === '$' && command[index + 1] === '"') { constructs.add(LOCALE); context[index] = 'bare'; context[index + 1] = 'quote'; stack.push({ type: 'double', start: index + 1 }); index += 2; continue; }
    if (character === '$' && command[index + 1] === '(') { context[index] = 'bare'; context[index + 1] = 'bare'; stack.push({ type: 'subst' }); index += 2; continue; }
    if (character === '$' && command[index + 1] === '{') { context[index] = 'bare'; context[index + 1] = 'unsupported'; stack.push({ type: 'param', depth: 0 }); index += 2; continue; }
    if (character === '`') { constructs.add(BACKTICKS); context[index] = 'unsupported'; stack.push({ type: 'backtick' }); index += 1; continue; }
    if (character === '(') { context[index] = 'bare'; stack.push({ type: 'paren' }); index += 1; continue; }
    if (character === ')') { context[index] = 'bare'; if (frame.type === 'subst' || frame.type === 'paren') stack.pop(); index += 1; continue; }
    if (character === '#' && (index === 0 || SEPARATOR.test(command[index - 1]))) { stack.push({ type: 'comment' }); continue; }
    if (character === '<' && command[index + 1] === '<') {
      if (command[index + 2] === '<') { context[index] = context[index + 1] = context[index + 2] = 'bare'; index += 3; continue; }
      let at = index + 2;
      const strip = command[at] === '-';
      if (strip) at += 1;
      while (at < size && /[ \t]/.test(command[at])) at += 1;
      let delimiter = ''; let quoted = false;
      while (at < size && !SEPARATOR.test(command[at])) {
        const mark = command[at];
        // bash decodes `$'...'` and `$"..."` in a delimiter word (measured: `<<$'EOF'` ends at `EOF`)
        // and never expands `$X`. The guard does not own that decoding, so it cannot place the end.
        if (mark === '$' || mark === '`') uncertain = true;
        if (mark === "'" || mark === '"') {
          quoted = true;
          const closer = command.indexOf(mark, at + 1);
          if (closer < 0) { at = size; complete = false; break; }
          delimiter += command.slice(at + 1, closer); at = closer + 1; continue;
        }
        if (mark === '\\') { quoted = true; delimiter += command[at + 1] ?? ''; at += 2; continue; }
        delimiter += mark; at += 1;
      }
      for (let k = index; k < at && k < size; k += 1) context[k] = 'bare';
      if (delimiter) pending.push({ delimiter, quoted, strip });
      index = at; continue;
    }
    if (character === '\n') {
      context[index] = 'bare';
      index += 1;
      while (pending.length) {
        const next = consumeHeredoc(command, context, escapes, constructs, pending.shift(), index);
        if (next < 0) { complete = false; index = size; break; }
        index = next;
      }
      continue;
    }
    context[index] = frame.type === 'heredoc' ? 'heredoc' : 'bare';
    index += 1;
  }
  // A comment is closed by the end of the line OR by the end of the input - it is never unfinished
  // syntax, so a supported reference followed by `# note` stays supported.
  while (stack.length > 1 && stack.at(-1).type === 'comment') stack.pop();
  if (stack.length > 1 || pending.length) complete = false;
  if (command.includes('\0')) constructs.add(NUL);
  return { context, bounds, escapes, constructs, complete, uncertain };
}

// Reads one shell word. `literal` is true only when the word's text is exactly what the shell will
// use: no expansion, no substitution, and no construct this guard does not decode. The guard never
// guesses what a non-literal word becomes; in a reference-bearing command it refuses it instead.
function readWord(command, context, from) {
  let text = ''; let literal = true; let index = from; let braceOpen = false; let bracketOpen = false;
  while (index < command.length) {
    const kind = context[index];
    const character = command[index];
    if (kind === 'bare') {
      if (SEPARATOR.test(character)) break;
      if (character === '$' || character === '`' || character === '\0') { literal = false; text += character; index += 1; continue; }
      // A backslash-newline is a line continuation: the shell removes BOTH characters, so the word
      // continues with nothing added. Keeping the newline makes `r\<newline>ead` decode as something
      // no command is ever named.
      if (character === '\\') { if (command[index + 1] !== '\n') text += command[index + 1] ?? ''; index += 2; continue; }
      // Globs, brace expansion and a leading tilde are expansions bash performs on unquoted text:
      // `/usr/bin/o?` and `{op,}` both become `op`.
      // A `[` is a bracket glob only when a `]` closes it: `[` and `[[` alone are literal words.
      if (character === '*' || character === '?') literal = false;
      if (character === '~' && index === from) literal = false;
      if (character === '{') braceOpen = true;
      if (character === '}' && braceOpen) literal = false;
      if (character === '[') bracketOpen = true;
      if (character === ']' && bracketOpen) literal = false;
      text += character; index += 1; continue;
    }
    if (kind === 'quote') { index += 1; continue; }
    if (kind === 'single') { if (character === '\0') literal = false; text += character; index += 1; continue; }
    if (kind === 'double') {
      // Inside double quotes a backslash escapes only $ ` " \ and a newline; before anything else it
      // is an ordinary character the shell keeps.
      if (character === '\\') {
        const escaped = command[index + 1];
        if (escaped === '\n') { index += 2; continue; }
        if (escaped === '$' || escaped === '`' || escaped === '"' || escaped === '\\') { text += escaped; index += 2; continue; }
        text += character; index += 1; continue;
      }
      // A command substitution opens a new command list: it ends the enclosing word for the purpose
      // of reading command words, so `"$(op read ...)"` still shows `op` as a word of its own. The
      // enclosing word is not literal - its value is that command's output.
      if (character === '$' && command[index + 1] === '(') { literal = false; break; }
      if (character === '$' || character === '`' || character === '\0') literal = false;
      text += character; index += 1; continue;
    }
    literal = false; text += character; index += 1;
  }
  return { text, literal, start: from, end: index };
}

function invocationTokens(command, context, from) {
  const words = [];
  let index = from;
  while (index < command.length) {
    const kind = context[index];
    const character = command[index];
    if (kind !== 'bare') { const word = readWord(command, context, index); if (word.end <= index) { index += 1; continue; } words.push({ ...word, operator: false }); index = word.end; continue; }
    if (character === '\\' && command[index + 1] === '\n') { index += 2; continue; }
    if (/[ \t]/.test(character)) { index += 1; continue; }
    if (/[;|&\n)]/.test(character)) break;
    if (character === '<' || character === '>') {
      let operator = character;
      if (command[index + 1] === character) { operator += character; index += 1; }
      if (command[index + 1] === '&') { operator += '&'; index += 1; }
      words.push({ text: operator, literal: true, operator: true, start: index, end: index + 1 });
      index += 1; continue;
    }
    if (/\d/.test(character) && (command[index + 1] === '<' || command[index + 1] === '>')) { index += 1; continue; }
    const word = readWord(command, context, index);
    if (word.end === index) { index += 1; continue; }
    words.push({ ...word, operator: false });
    index = word.end;
  }
  return { words, end: index };
}

// Words from just after `op`: documented global flags, the `read` verb once, then documented flags
// and exactly one literal op:// reference, in any order after the verb.
// `reproducible`: whether the guard can print the prefetched value exactly as this `op read` would.
// It binds that value instead of letting the command read 1Password a second time (a rotated value no
// mask knows), so a flag that changes the OUTPUT - a file, an encoding, a format - cannot be honoured.
function validateOpRead(words) {
  let account = '';
  let ref = '';
  let verb = false;
  let noNewline = false;
  let reproducible = true;
  let carried = true;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!verb && !word.operator && word.literal && word.text === 'read') { verb = true; continue; }
    if (word.operator) {
      const target = words[index + 1];
      if (!target || target.operator || !target.literal || /^(?:op:\/\/|secret:)/i.test(target.text)) return { valid: false };
      index += 1; continue;
    }
    if (!word.literal) return { valid: false };
    const assigned = word.text.indexOf('=');
    if (word.text.startsWith('--') && assigned > 2) {
      const name = word.text.slice(0, assigned);
      const value = word.text.slice(assigned + 1);
      // The glued value is checked exactly like a spaced one: no reference form, issued token or not
      // (Astra at d9b197c7: `op --account=secret:fixture#abcdef read …` reached the prefetch, because the
      // invocation's consumed range is exempt from the reference scan that refuses unissued tokens).
      if (!VALUE_FLAGS.has(name) || !value || value.startsWith('-') || /^(?:op:\/\/|secret:)/i.test(value)) return { valid: false };
      if (name === '--account') account = value;
      if (OUTPUT_FLAGS.has(name)) reproducible = false;
      if (RESOLUTION_FLAGS.has(name)) carried = false;
      continue;
    }
    if (VALUE_FLAGS.has(word.text)) {
      const value = words[index + 1];
      if (!value || value.operator || !value.literal || !value.text || value.text.startsWith('-') || /^(?:op:\/\/|secret:)/i.test(value.text)) return { valid: false };
      if (word.text === '--account') account = value.text;
      if (OUTPUT_FLAGS.has(word.text)) reproducible = false;
      if (RESOLUTION_FLAGS.has(word.text)) carried = false;
      index += 1; continue;
    }
    if (BOOLEAN_FLAGS.has(word.text)) { if (word.text === '-n' || word.text === '--no-newline') noNewline = true; if (RESOLUTION_FLAGS.has(word.text)) carried = false; continue; }
    if (word.text.startsWith('-')) return { valid: false };
    if (word.text.startsWith('op://')) {
      if (ref || !OP_PATH.test(word.text.slice('op://'.length))) return { valid: false };
      ref = word.text; continue;
    }
    return { valid: false };
  }
  return { valid: verb && Boolean(ref), account, ref, noNewline, reproducible, carried };
}

function templateDestination(command) {
  return /(?:>{1,2}|\btee(?:[ \t]+-\w+)*)[ \t]*(?:"[^"\n]*\.tpl"|'[^'\n]*\.tpl'|[^ \t\n;|&]+\.tpl)(?=[ \t\n]|$|[;|&])/m.test(command);
}

function shellTokens(command, context, escapes) {
  const tokens = [];
  let index = 0;
  const push = (type, end, extra = {}) => { tokens.push({ type, start: index, end, ...extra }); index = end; };
  while (index < command.length) {
    const kind = context[index];
    const character = command[index];
    if (NOT_WORDS.has(kind)) { index += 1; continue; }
    if (character === '\\' && command[index + 1] === '\n') { index += 2; continue; }
    // `$(` opens a nested list, at the start of a word or glued to one (`x=$(...)`: readWord keeps the
    // `$` in the word it was reading and stops at the `(`).
    const opens = (kind === 'bare' || kind === 'double') && character === '$' && command[index + 1] === '(';
    const glued = kind === 'bare' && character === '(' && command[index - 1] === '$' && context[index - 1] === 'bare' && !escapes.has(index - 2);
    if (opens || glued) {
      const after = opens ? index + 2 : index + 1;
      push('open', after, { arith: command[after] === '(' });
      continue;
    }
    if (kind === 'bare') {
      if (character === ' ' || character === '\t') { index += 1; continue; }
      if (character === '\n') { push('op', index + 1, { op: '\n' }); continue; }
      if (character === ';') { const op = /^;;&|^;;|^;&|^;/.exec(command.slice(index, index + 3))[0]; push('op', index + op.length, { op }); continue; }
      if (character === '|') { const op = /^\|\||^\|&|^\|/.exec(command.slice(index, index + 2))[0]; push('op', index + op.length, { op }); continue; }
      if (character === '&' && command[index + 1] !== '>') { const op = command[index + 1] === '&' ? '&&' : '&'; push('op', index + op.length, { op }); continue; }
      if ((character === '<' || character === '>') && command[index + 1] === '(') { push('open', index + 2, { arith: false }); continue; }
      if (character === '<' || character === '>' || character === '&') {
        const op = /^(?:&>>?|<<<|<<-?|<>|<&|>&|>>|>\||<|>)/.exec(command.slice(index, index + 3))[0];
        push('redirect', index + op.length, { op }); continue;
      }
      if (character === '(' || character === ')') { push(character, index + 1); continue; }
    }
    const word = readWord(command, context, index);
    if (word.end <= index) { index += 1; continue; }
    const raw = command.slice(word.start, word.end);
    // A file-descriptor number or `{name}` written against a redirection belongs to that redirection.
    if (context[word.end] === 'bare' && /[<>]/.test(command[word.end] ?? '') && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(raw)) { index = word.end; continue; }
    tokens.push({ type: 'word', ...word, raw });
    index = word.end;
  }
  return tokens;
}


// A global flag the 1Password CLI accepts BEFORE its subcommand (`op --account=team read ...`).
function globalFlag(word) {
  if (!word?.literal) return 0;
  if (BOOLEAN_FLAGS.has(word.text)) return 1;
  if (VALUE_FLAGS.has(word.text)) return 2;
  const assigned = word.text.indexOf('=');
  return word.text.startsWith('--') && assigned > 2 && VALUE_FLAGS.has(word.text.slice(0, assigned)) ? 1 : 0;
}

// Every `op [documented global flags] <verb>` word sequence in the command, as the words the shell
// sees (quoting removed), inside one simple command. This is how the guard notices its literal
// `op read` form; it does not decide where a command name stands - `allowList` does.
function opSequences(tokens) {
  const found = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const word = tokens[at];
    if (word.type !== 'word' || !word.literal || !OP_COMMAND.test(word.text)) continue;
    let cursor = at + 1;
    // Global flags AND redirections may stand between `op` and its verb, as bash allows: a redirection
    // with its target is skipped (Astra at 7323b6d2: `op 2>/dev/null read …` hid the literal form, so the
    // value was never bound and `op` itself ran).
    const skip = (token, next) => (token?.type === 'redirect' ? (next?.type === 'word' ? 2 : 1) : globalFlag(token?.type === 'word' ? token : null));
    for (let width = skip(tokens[cursor], tokens[cursor + 1]); width > 0; width = skip(tokens[cursor], tokens[cursor + 1])) cursor += width;
    const verb = tokens[cursor];
    if (verb?.type !== 'word' || !verb.literal || !OP_VERBS.has(verb.text)) continue;
    found.push({ at: word.start, verb: verb.text, after: word.end });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// THE ALLOW-LIST (round 11). Rounds 7 to 10 each closed spellings of "a command name the guard cannot
// read" and each review found the next one in the same code: bash has more grammar than a deny-list
// can enumerate. So a command that uses one of our forms must now FIT this grammar, and anything
// outside it is refused with what to rewrite:
//   - simple commands joined by `;` `&&` `||` `|` `&` or a newline;
//   - each command name a literal word, or a listed wrapper (WRAPPERS, exec/command/builtin, find's
//     -exec) followed, recursively, by a literal command name;
//   - every word literal (quoted or not), one of our forms, or a double-quoted string holding only
//     literal text and `$NAME` / `${NAME}` - one field, whatever the value; an unquoted `$NAME` is
//     refused (field splitting moves positions), and so is every other expansion: `${...}` with an
//     operator, `$( )` and backticks, `<( )`, `$(( ))`, globs, brace expansion;
//   - the one exception: the documented literal `op read` form in a `$( )`, double-quoted or as an
//     assignment value (`X=$(op read 'op://...')`, `"Bearer $(op read 'op://...')"`);
//   - redirections with a literal target; at most one heredoc, with a plain delimiter;
//   - no compound command, keyword, subshell, function, array, `[[ ]]` or `(( ))`.
// A command WITHOUT our forms is never examined here: it passes exactly as it did before.
// ---------------------------------------------------------------------------------------------
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'function', 'coproc', 'time', '{', '}', '!', '[[', ']]', 'in']);
// Builtins that run a string as shell code: their "command name" is inside an argument.
const STRING_RUNNERS = new Set(['eval', 'source', '.', 'alias', 'trap']);
const ALLOWED_OPERATORS = new Set([';', '&&', '||', '|', '&', '\n']);
const PLAIN_DELIMITER = /^(?:[A-Za-z0-9_.-]+|'[A-Za-z0-9_.-]+'|"[A-Za-z0-9_.-]+"|\\[A-Za-z0-9_.-]+)$/;

// The kind of one word: 'literal' (its text is exact), 'field' (one field whose text the guard does
// not know: a double-quoted `$NAME`, an accepted `op read` substitution), or a refusal.
function wordKind(command, context, from, to) {
  let kind = 'literal';
  let bracket = false; let brace = false;
  for (let at = from; at < to; at += 1) {
    const where = context[at];
    const character = command[at];
    if (where === 'quote' || where === 'single') continue;
    if (where === 'bare') {
      if (character === '\\') { at += 1; continue; }
      if (character === '$') return { refuse: /[A-Za-z_{]/.test(command[at + 1] ?? '') ? 'an unquoted parameter (write "$NAME")' : 'an unquoted special parameter or expansion' };
      if (character === '*' || character === '?') return { refuse: 'an unquoted glob' };
      if (character === '[') bracket = true;
      if (character === ']' && bracket) return { refuse: 'an unquoted glob' };
      if (character === '{') brace = true;
      if (brace && (character === ',' || (character === '.' && command[at + 1] === '.'))) return { refuse: 'a brace expansion' };
      // Bash expands a tilde at a word's start and after `=` or `:` - positions that differ between an
      // argument and an assignment. Beside our forms no unquoted tilde is accepted: write the path out.
      if (character === '~') return { refuse: 'an unquoted tilde (write the path out)' };
      continue;
    }
    if (where === 'double') {
      if (character === '\\') { at += 1; continue; }
      if (character !== '$') continue;
      const rest = command.slice(at, to);
      const name = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}|^\$[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      if (name) { kind = 'field'; at += name[0].length - 1; continue; }
      // Strict: a `$` is accepted only as `$NAME`, `${NAME}`, or a literal `$` before a blank or the
      // closing quote. Anything else is an expansion - `$[...]` arithmetic among them (Astra at
      // f98cf712: `"$[A]"` with A holding `a[$(cmd)]` ran cmd).
      if (!/^\$(?:[ \t\n"]|$)/.test(rest)) return { refuse: rest[1] === '{' ? 'a ${...} expansion with an operator' : rest[1] === '(' ? 'a command substitution' : rest[1] === '[' ? 'a $[...] arithmetic expansion' : 'a special parameter or expansion ($1, $@, $?, $[...])' };
      continue;
    }
    return { refuse: 'an expansion this guard does not accept ($(...), ${...} with an operator, backticks)' };
  }
  return { kind };
}

// One option word of a listed wrapper: 'arg', or 'none' (no command runs) or 'refuse' (a grammar the
// guard does not place). Updates `entry` (phase, pending value).
function wrapperOption(entry, text) {
  const { spec } = entry;
  if (text === '--') { entry.phase = entry.left > 0 ? 'operands' : spec.assignments ? 'assign' : 'command'; return 'arg'; }
  if (spec.numeric && /^--?\d+$/.test(text)) return 'arg';
  if (text.startsWith('--')) {
    const equals = text.indexOf('=');
    const given = text.slice(2, equals < 0 ? undefined : equals);
    if (given === 'help' || given === 'version') return 'none';
    const names = Object.keys(spec.long);
    const matching = names.includes(given) ? [given] : names.filter((name) => name.startsWith(given));
    if (!given || matching.length !== 1) return 'refuse';
    const [name] = matching;
    const kind = spec.long[name];
    if (kind === 'none' || kind === 'refuse') return kind;
    if (kind === 1 && equals < 0) entry.pending = 'value';
    return 'arg';
  }
  for (let at = 1; at < text.length; at += 1) {
    const letter = text[at];
    const kind = Object.hasOwn(spec.short, letter) ? spec.short[letter] : 'refuse';
    if (kind === 'none' || kind === 'refuse') return kind;
    if (kind === 0) continue;
    const rest = text.slice(at + 1);
    if (kind === 'glued') return 'arg';
    if (!rest) entry.pending = 'value';
    return 'arg';
  }
  return 'arg';
}

// Where a listed wrapper's command starts: { index }, { none } (no command), or { refuse }.
// Every word from the wrapper up to its command must be a plain literal: an option, a value, an
// operand or an assignment whose text is expanded (`"$T"` holding `--kill-after=1`, measured by Astra
// at ca950a58) moves the command position where the guard cannot see it.
function wrapperCommand(words, from, name, filled) {
  const spec = wrapperSpec(name);
  const entry = { name, spec, phase: 'options', left: spec.operands ?? 0, pending: false, replace: null };
  // Each branch that consumes a word as something OTHER than the command checks it is plain - and,
  // under find -exec, not built from `{}`, which find fills from a file name.
  const plain = (word) => (word.kind === 'literal' && !word.reference && !(filled && word.text.includes(filled)) ? null : { refuse: `a word of ${name} that is not a plain literal (${word.raw})` });
  for (let at = from; at < words.length; at += 1) {
    const word = words[at];
    if (entry.pending) {
      const refusal = plain(word);
      if (refusal) return refusal;
      entry.pending = false;
      continue;
    }
    if (entry.phase === 'options') {
      if (word.kind !== 'literal') {
        // An expanded word where an option may stand: it could be an option, an operand or the
        // command - the guard cannot tell which.
        if (entry.left > 0 || spec.assignments) return plain(word);
      } else if (word.text.startsWith('-') && word.text !== '-') {
        const refusal = plain(word);
        if (refusal) return refusal;
        const outcome = wrapperOption(entry, word.text);
        if (outcome === 'refuse') return { refuse: `an option of ${name} this guard does not place (${word.text})` };
        if (outcome === 'none') return { none: true };
        continue;
      } else if (word.text === '-' && spec.dash) continue;
      entry.phase = entry.left > 0 ? 'operands' : spec.assignments ? 'assign' : 'command';
    }
    if (entry.phase === 'operands') {
      const refusal = plain(word);
      if (refusal) return refusal;
      entry.left -= 1;
      if (entry.left <= 0) entry.phase = spec.assignments ? 'assign' : 'command';
      continue;
    }
    if (entry.phase === 'assign' && word.raw.split(/[$`]/)[0].includes('=')) {
      const refusal = plain(word);
      if (refusal) return refusal;
      continue;
    }
    return { index: at, replace: entry.replace };
  }
  return { none: true };
}

// Checks the command name at `from` (after leading assignments) and, through wrappers, the command it
// runs. Records every command-name position in `positions` as 'command' or 'wrapped'.
function commandHead(words, from, positions, role, filled) {
  let at = from;
  if (role === 'command') while (at < words.length && words[at].assignment) at += 1;
  if (at >= words.length) return null;
  const name = words[at];
  if (name.kind !== 'literal') return 'a command name this guard cannot read literally';
  if (name.reference) return 'a secret reference as a command name (references are accepted as arguments only)';
  if (filled && name.text.includes(filled)) return `a command built from ${filled}, which its wrapper fills from input`;
  // Keywords on the DECODED text: a quoted or escaped `"time"` is a command bash runs, `/usr/bin/time`,
  // and it runs its argument. Strict: any spelling of a reserved word is refused as a command name.
  if (RESERVED.has(name.text)) return `the shell keyword \`${name.text}\` (in any spelling)`;
  if (STRING_RUNNERS.has(name.text)) return `\`${name.text}\`, which runs a string as shell code`;
  // xargs turns its INPUT into words of the command it runs - options, operands, even the command
  // itself once a wrapper is left open (Astra at f98cf712: `-I R timeout R 1 "$CMD"`). Not bounded.
  if (name.text.replace(/^.*\//, '') === 'xargs') return '`xargs`, whose input becomes words of the command it runs';
  positions.set(name.start, role);
  const base = name.text.replace(/^.*\//, '');
  if (wrapperSpec(base)) {
    const found = wrapperCommand(words, at + 1, base, filled);
    if (found.refuse) return found.refuse;
    if (found.none) return null;
    return commandHead(words, found.index, positions, 'wrapped', found.replace ?? filled);
  }
  if (base === 'find') {
    // Every word of a find invocation is plain: an expanded word can be an action (`"$ACTION"` holding
    // -exec, measured by Astra at ca950a58) or a command the guard cannot see.
    const expanded = words.slice(at + 1).find((word) => word.kind !== 'literal' || word.reference);
    if (expanded) return `a word of find that is not a plain literal (${expanded.raw})`;
    for (let next = at + 1; next < words.length; next += 1) {
      if (words[next].kind !== 'literal' || !FIND_EXEC.has(words[next].text)) continue;
      let end = next + 1;
      while (end < words.length && !(words[end].kind === 'literal' && (words[end].text === ';' || (words[end].text === '+' && words[end - 1]?.text === '{}')))) end += 1;
      const executed = words.slice(next + 1, end);
      if (!executed.length) return 'find -exec without a command';
      const refusal = commandHead(executed, 0, positions, 'wrapped', '{}');
      if (refusal) return refusal;
      next = end;
    }
  }
  return null;
}

// Validates a command that uses one of our forms against the allow-list. Returns { refuse } or
// { positions } (every command-name position, for the op read rule).
function allowList(command, lexed, tokens, referenceStarts) {
  const { context } = lexed;
  // An UNQUOTED heredoc body expands like a double-quoted string, AFTER bash joins its backslash-
  // newlines: `$\` + newline + `(printf x)` is a substitution (Astra at ca950a58) that no scan of
  // physical characters sees. Beside our forms an unquoted body therefore holds no `$` and no backtick
  // at all; a quoted body (<<'EOF') is plain text and holds anything.
  for (let at = 0; at < command.length; at += 1) {
    if ((context[at] === 'heredoc' || context[at] === 'heredoc-unsupported') && (command[at] === '$' || command[at] === '`')) {
      return { refuse: 'a `$` or backtick inside an unquoted heredoc body (quote the delimiter: <<\'EOF\')' };
    }
  }
  // Bash's line continuation and a carriage return change what a word is AFTER the guard has read it:
  // `ti\\` + newline + `me` is the keyword `time`, and `EOF\r` is a different heredoc delimiter
  // (Astra at f98cf712). Strict: neither is accepted, except inside a quoted heredoc body, which is text.
  // Beside our forms only printable ASCII, space, tab and newline, ANYWHERE - words, quotes, heredoc
  // delimiters and bodies: a vertical tab, a form feed, NBSP or any other Unicode space or control is a
  // word character to bash and a blank to JavaScript (Astra at 2618aa81), and a CR changes a heredoc
  // delimiter (Astra at f98cf712). Strict: none is accepted, rather than each being modelled.
  const outside = OUTSIDE_ALLOWED_BYTES.exec(command);
  if (outside) {
    const point = outside[0].codePointAt(0);
    return { refuse: `a character outside printable ASCII, space, tab and newline (U+${point.toString(16).toUpperCase().padStart(4, '0')})` };
  }
  for (let at = 0; at < command.length; at += 1) {
    if (command[at] === '\\' && command[at + 1] === '\n' && context[at] !== 'heredoc-quoted') return { refuse: 'a backslash-newline line continuation' };
  }
  const carriesReference = (from, to) => referenceStarts.some((at) => at >= from && at < to);
  const positions = new Map();
  const simple = [[]];
  let heredocs = 0;
  let target = null;
  // Whether the current command has a word or a redirection yet, and the last operator that ended one.
  let content = false;
  let lastOperator = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'op') {
      if (target) return { refuse: 'a redirection without a target' };
      if (!ALLOWED_OPERATORS.has(token.op)) return { refuse: `the operator \`${token.op === '\n' ? 'newline' : token.op}\`` };
      // A command list bash would reject is refused, not left to bash (Astra at d9b197c7: `… &&` at the end,
      // `; ;`). Every operator but a newline needs a command before it; a newline ends a command when
      // there is one, and is only a line break after `&&`, `||` or `|`, where bash reads on.
      if (token.op === '\n') { if (content) lastOperator = '\n'; } else {
        if (!content) return { refuse: `an incomplete or malformed command list (\`${token.op}\` with no command before it)` };
        lastOperator = token.op;
      }
      content = false;
      simple.push([]);
      continue;
    }
    content = true;
    if (token.type === 'redirect') {
      if (target) return { refuse: 'a redirection without a target' };
      if (token.op === '<<' || token.op === '<<-') { heredocs += 1; if (heredocs > 1) return { refuse: 'more than one heredoc' }; target = 'heredoc'; } else target = 'file';
      continue;
    }
    if (token.type === '(' || token.type === ')') {
      // Named by its keyword when one opens the command (`case x in x)`, `function f()`): the real-host
      // matrix showed `case` refused as "a subshell", which does not say what to rewrite.
      const head = simple.at(-1).find((word) => !word.assignment);
      if (head?.kind === 'literal' && RESERVED.has(head.text)) return { refuse: `the shell keyword \`${head.text}\` (in any spelling)` };
      return { refuse: 'a subshell, function definition, array or arithmetic command' };
    }
    // One shell word: a word token, possibly glued to a `$( )` and to the rest of the word after it.
    const opener = token.type === 'open' ? index : tokens[index + 1]?.type === 'open' && tokens[index + 1].start === token.end ? index + 1 : -1;
    const from = token.start;
    let to = token.end;
    let checked;
    if (opener < 0) {
      checked = wordKind(command, context, from, to);
    } else {
      // The only substitution accepted: the documented literal `op read` form, double-quoted or as an
      // assignment value - where its output is one field.
      const open = tokens[opener];
      const dollar = command[open.start] === '$' ? open.start : open.start - 1;
      const close = tokens.findIndex((other, at) => at > opener && other.type !== 'word');
      const inner = tokens.slice(opener + 1, close);
      if (command[dollar] !== '$' || open.arith || close < 0 || tokens[close].type !== ')' || !inner.length || !inner[0].literal || !OP_COMMAND.test(inner[0].text)) return { refuse: 'a command, process or arithmetic substitution' };
      if (!validateOpRead(inner.slice(1).map((word) => ({ ...word, operator: false }))).valid) return { refuse: 'a command substitution other than the literal `op read` form' };
      // The `op` inside stands where the substitution runs a command.
      positions.set(inner[0].start, 'command');
      const prefix = command.slice(from, dollar);
      // `NAME=` is an assignment only in the assignment-prefix position of a simple command. As an
      // argument (`printf %s A=$(op read ...)`, Astra at ca950a58) it is an ordinary word, and bash
      // splits the unquoted substitution into fields no mask knows.
      const inPrefix = simple.at(-1).every((word) => word.assignment);
      if (context[dollar] !== 'double' && !(inPrefix && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(prefix))) return { refuse: 'an unquoted command substitution (double-quote it, or assign it before the command)' };
      to = tokens[close].end;
      index = close;
      const rest = tokens[index + 1];
      if (rest?.type === 'word' && rest.start === to) { to = rest.end; index += 1; }
      // The text around the substitution follows the ordinary word rules.
      for (const [start, end] of [[from, dollar], [tokens[close].end, to]]) {
        if (end > start) { const piece = wordKind(command, context, start, end); if (piece.refuse) return { refuse: piece.refuse }; }
      }
      checked = { kind: 'field' };
    }
    const raw = command.slice(from, to);
    if (checked.refuse) return { refuse: checked.refuse };
    if (target === 'heredoc') { if (!PLAIN_DELIMITER.test(raw)) return { refuse: 'a heredoc delimiter that is not a plain word' }; target = null; continue; }
    const reference = carriesReference(from, to);
    if (target === 'file') {
      if (checked.kind !== 'literal') return { refuse: 'a redirection target that is not a literal word' };
      if (reference) return { refuse: 'a secret reference as a redirection target (references are accepted as arguments only)' };
      target = null;
      continue;
    }
    // An assignment only in the assignment-prefix position; anywhere else `NAME=value` is an argument.
    const assignment = simple.at(-1).every((word) => word.assignment) && context[from] === 'bare' && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(raw);
    simple.at(-1).push({ start: from, end: to, raw, text: opener < 0 ? token.text : raw, kind: checked.kind, assignment, reference });
  }
  if (target) return { refuse: 'a redirection without a target' };
  if (!content && (lastOperator === '&&' || lastOperator === '||' || lastOperator === '|')) return { refuse: `an incomplete command list (it ends with \`${lastOperator}\`)` };
  for (const words of simple) {
    const refusal = commandHead(words, 0, positions, 'command', null);
    if (refusal) return { refuse: refusal };
  }
  return { positions };
}

function extent(command, lexed, match) {
  const { context, bounds, escapes } = lexed;
  const start = match.index;
  // An escape belongs to the shell word the reference sits in. Replacing the reference alone would
  // leave it behind and emit `\"${NAME}"` - accepted here, an unmatched quote at run time.
  if (escapes.has(start - 1)) return { refuse: 'a reference preceded by a backslash escape' };
  const where = context[start];
  if (where !== 'bare' && where !== 'single' && where !== 'double') return { refuse: 'an unsupported quoting context' };
  const quoted = where === 'single' || where === 'double';
  const wrapper = quoted ? bounds[start] : null;
  if (quoted && (!wrapper || wrapper[0] + 1 !== start)) return { refuse: 'a reference that is not the whole quoted word' };
  const limit = quoted ? wrapper[1] : command.length;
  const body = command.slice(start, limit);
  const same = (end) => {
    for (let at = start; at < end; at += 1) {
      if (context[at] !== where) return false;
      if (quoted && (bounds[at] === null || bounds[at][0] !== wrapper[0])) return false;
    }
    return true;
  };
  const finish = (end, value) => {
    if (!same(end)) return { refuse: 'a reference broken by quoting' };
    if (quoted && end !== limit) return { refuse: 'a reference that is not the whole quoted word' };
    if (!quoted && !(end >= command.length || SEPARATOR.test(command[end]))) return { refuse: 'a reference that does not end the shell word' };
    return { ...value, start, end, context: where, replaceStart: quoted ? wrapper[0] : start, replaceEnd: quoted ? wrapper[1] + 1 : end };
  };

  if (body.startsWith('op://')) {
    const from = start + 'op://'.length;
    if (quoted) {
      const path = command.slice(from, limit);
      if (!OP_PATH.test(path) || /[$`\\"]/.test(path)) return { refuse: 'a 1Password reference with unsupported characters' };
      return finish(limit, { form: 'op', path });
    }
    const matched = BARE_PATH.exec(command.slice(from));
    if (!matched) return { refuse: 'a 1Password reference that is not a literal vault/item/field path' };
    return finish(from + matched[0].length, { form: 'op', path: matched[0] });
  }
  const token = VAULT_TOKEN.exec(body);
  if (token) return finish(start + token[0].length, { form: 'token', label: token[0] });
  if (body.startsWith('secret:env:')) {
    const from = start + 'secret:env:'.length;
    const name = ENV_NAME.exec(command.slice(from, limit));
    if (!name) return { refuse: 'an environment reference whose name is not UPPER_SNAKE_CASE' };
    return finish(from + name[0].length, { form: 'env', name: name[0] });
  }
  if (body.startsWith('secret:file:')) {
    const from = start + 'secret:file:'.length;
    const path = FILE_PATH.exec(command.slice(from, limit));
    if (!path) return { refuse: 'a file reference without an absolute path' };
    const line = FILE_LINE.exec(command.slice(from + path[0].length, limit));
    return finish(from + path[0].length + (line ? line[0].length : 0), { form: 'file', path: path[0], line: line ? Number(line[1]) : 0 });
  }
  return { refuse: 'an unsupported reference form' };
}

/**
 * Classify every reference-shaped span in a command. Never returns a partial plan: either every
 * span is on the allow-list in a supported context (`ok: true`), or the whole command is refused.
 */
export function planReferences(command, options = {}) {
  const known = options.tokens ?? new Map();
  const lexed = lex(command);
  const occurrences = [];
  const invocations = [];
  const refusals = [];
  REFERENCE.lastIndex = 0;
  const matches = [];
  let inBodies = 0;
  for (let match; (match = REFERENCE.exec(command));) {
    const before = command[match.index - 1];
    if (before !== undefined && /[A-Za-z0-9_]/.test(before)) continue;
    if (HEREDOC_BODY.has(lexed.context[match.index])) { inBodies += 1; continue; }
    matches.push(match);
  }
  // A heredoc body is text only when the guard knows where it ends. When it cannot place that end - an
  // unterminated body, a delimiter it does not decode - a reference it would call "body" may be a
  // command line to bash, so such a command counts as using our forms and is refused.
  // A byte outside printable ASCII, space, tab and newline makes the placement uncertain too: the guard
  // models bash's reading of those bytes nowhere (a vertical tab or a CR in a delimiter, a NUL that ends
  // the string a process receives), so a form it would call "body" beside one counts as ours - and the
  // allow-list then refuses the byte (Astra at 2618aa81; "heredoc delimiters and bodies included").
  const uncertainBody = inBodies > 0 && (!lexed.complete || lexed.uncertain || OUTSIDE_ALLOWED_BYTES.test(command));
  const tokens = shellTokens(command, lexed.context, lexed.escapes);
  const sequences = opSequences(tokens);
  // OUR FORMS ONLY. The guard acts on its reference forms and on its literal `op read` words, nothing
  // else: a command carrying none of them is never examined, and passes exactly as written.
  // Only `op read` is our form: `op inject` / `op run` without a reference are not ours (Astra M7).
  const byReference = matches.length > 0 || uncertainBody;
  const ours = byReference || sequences.some((entry) => entry.verb === 'read');
  if (!ours) return { ok: true, reason: '', occurrences, invocations };
  for (const construct of lexed.constructs) refusals.push(`${construct}, which this guard does not decode`);
  if (!lexed.complete) refusals.push('an incomplete quote, heredoc or substitution');
  if (lexed.uncertain) refusals.push('a heredoc whose end this guard cannot place');
  const allowed = refusals.length ? { positions: new Map() } : allowList(command, lexed, tokens, matches.map((match) => match.index));
  // With no reference at all, the literal `op read` words are ours only where the allow-list can place
  // them. Inside shell it does not read - a loop, a case body - they are text, and the command passes
  // untouched (Astra M6 at f98cf712: `for x in a; do echo op read foo; done` was refused).
  if (!byReference && (refusals.length || allowed.refuse)) return { ok: true, reason: '', occurrences, invocations };
  if (allowed.refuse) refusals.push(`${allowed.refuse} - beside a secret reference this guard accepts only simple commands with literal command names, joined by ; && || | & or a newline`);
  const consumed = [];
  for (const entry of sequences) {
    const role = allowed.positions?.get(entry.at);
    if (entry.verb !== 'read') {
      if (matches.length) refusals.push(`\`op ${entry.verb}\` beside a secret reference`);
      continue;
    }
    const parsed = invocationTokens(command, lexed.context, entry.after);
    const validated = validateOpRead(parsed.words);
    if (validated.valid) {
      // Only the invocation's own `op://` reference word is consumed; every other reference-shaped text
      // inside the invocation is scanned like anywhere else (Astra at d9b197c7).
      const refWord = parsed.words.find((word) => !word.operator && word.text === validated.ref);
      if (refWord) consumed.push([refWord.start, refWord.end]);
      // The guard binds the value it prefetched and masks, and the invocation prints exactly that value
      // (Astra H6 at ca950a58: a second `op read` returned a rotated value no mask knew). So the form
      // must stand where the guard can replace `op` - a command position - and ask only for output
      // the guard can reproduce.
      if (!validated.carried) refusals.push('an `op read` option that changes how 1Password resolves the reference (--config, --session, --cache), which the prefetch does not carry');
      else if (role === 'command' && validated.reproducible) invocations.push({ ref: validated.ref, account: validated.account, at: entry.at, wordEnd: entry.after, noNewline: validated.noNewline });
      else if (role === 'command') refusals.push('an `op read` flag whose output this guard cannot reproduce from the prefetched value (-o, --out-file, --encoding, --file-mode, --format)');
      else refusals.push(`the literal \`op read\` form ${role === 'wrapped' ? 'behind a wrapper' : 'as an argument'}, where the guard cannot bind the value it prefetched (write it as a command of its own)`);
    } else if (role === 'command' || (role === 'wrapped' && matches.length)) {
      // The documented form written where the shell runs it, and written wrong. As an argument
      // (`echo op read x`) it is text. Behind a wrapper with no reference of ours it is out of scope
      // (`exec op read "$REF"`); beside one, it would run op on a value the guard bound and never
      // prefetched, so there it is refused.
      refusals.push('`op read` without a single literal `op://` reference and documented flags');
    }
  }
  // Beside a reference, an `op` the shell runs as a command must be one the guard recognised (its verb
  // placed through flags and redirections). One it cannot place would run `op` itself, on values the guard
  // bound and never prefetched - it refuses instead (Astra at 7323b6d2).
  if (byReference && allowed.positions) {
    const recognised = new Set(sequences.map((entry) => entry.at));
    for (const token of tokens) {
      if (token.type === 'word' && token.literal && OP_COMMAND.test(token.text) && allowed.positions.has(token.start) && !recognised.has(token.start)) {
        refusals.push('an `op` invocation whose verb this guard cannot place (write it as `op [flags] read \'op://vault/item/field\'`)');
      }
    }
  }
  for (const match of matches) {
    if (consumed.some(([from, to]) => match.index >= from && match.index < to)) continue;
    const resolved = extent(command, lexed, match);
    if (resolved.refuse) { refusals.push(resolved.refuse); continue; }
    occurrences.push(resolved);
    if (resolved.form === 'token' && !known.has(resolved.label)) refusals.push('a redaction token this session does not know');
  }
  if (occurrences.length && templateDestination(command)) refusals.push('a secret reference written to a 1Password template destination');
  occurrences.sort((left, right) => left.replaceStart - right.replaceStart);
  for (let index = 1; index < occurrences.length; index += 1) {
    if (occurrences[index].replaceStart < occurrences[index - 1].replaceEnd) refusals.push('overlapping references');
  }
  return { ok: refusals.length === 0, reason: refusals[0] ?? '', occurrences, invocations };
}

/** Every supported context is a shell word, so an expansion is always double-quoted. */
export function renderReplacement(occurrence, expression) {
  return `"${expression}"`;
}

export function opExpression(path, account) {
  const selector = account ? ` --account '${quoteForSingleQuotes(account)}'` : '';
  return `$(op read${selector} 'op://${quoteForSingleQuotes(path)}')`;
}

export { quoteForSingleQuotes };
