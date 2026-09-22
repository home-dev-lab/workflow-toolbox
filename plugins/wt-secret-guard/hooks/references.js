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
//   contexts  bare shell word (including inside $( ))
//             the complete contents of a single-quoted word
//             the complete contents of a double-quoted word
//   not ours  a heredoc body, quoted or not: a reference there stays literal text, is not prefetched
//             and does not refuse the command (injection into files is `op inject`'s job)
//   restriction  a command using one of THESE forms may contain NO construct this module does not
//             decode ($'...', $"...", backticks, NUL), NO command name it cannot read literally in any
//             position where bash reads one (see shellWords), NO syntax in which it cannot place
//             those positions, and NO heredoc whose end it cannot place.
//             Listed external wrappers (WRAPPERS, find -exec) are parsed with their option grammar,
//             chained, and their command position is one of those positions.
//   out of scope  anything else that might run `op` - a computed or aliased name, eval, the argument
//             list of a program not on the wrapper list. Not refused, not prefetched: its output is
//             protected only by the detectors and the values already in the vault.
//
// Measured over four review rounds: a decoder here lost to each new bash spelling of `op read`, and
// a search for hidden invocations both missed some and refused ordinary work. This module therefore
// acts on its own forms and nothing else.
//
// Measured 2026-09-08: OP_ACCOUNT does not cross WSL interop, while the explicit --account
// positional argv does, so account identity stays part of each invocation.

const OP_PATH = /^[\p{L}\p{N}._' -]+(?:\/[\p{L}\p{N}._' -]+){2,3}$/u;
const BARE_PATH = /^[\p{L}\p{N}._-]+(?:\/[\p{L}\p{N}._-]+){2,3}(?!\/)/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]*/;
const FILE_PATH = /^\/[^\s"'#)<>&;|`$\\]+/;
const FILE_LINE = /^#([1-9]\d*)/;
const VAULT_TOKEN = /^secret:[a-z-]+#[a-f0-9]{6}/i;
const REFERENCE = /op:\/\/|secret:[A-Za-z0-9_-]+[:#]/g;
const SEPARATOR = /[\s;|&()<>]/;
const OP_COMMAND = /^(?:[^\s/]*\/)*op(?:\.exe)?$/;
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
// Contexts where an `op` invocation written as raw text is refused rather than validated. A heredoc
// body is not among them: it is text the command writes, never a context this guard acts on.
const SHIELDED = new Set(['comment', 'unsupported']);
// A heredoc body - quoted or not - is NOT a context this guard expands (round 8 decision). A
// reference written there stays literal in what the command writes, is not prefetched, and does not
// refuse the command: the guard cannot tell "inject this secret into a file" from "write a document
// that mentions a reference", and the first is exactly the path that puts a secret on disk. Injection
// into files belongs to 1Password's own `op inject`.
const HEREDOC_BODY = new Set(['heredoc', 'heredoc-quoted', 'heredoc-unsupported', 'heredoc-end']);
// Reserved words after which bash reads the next word as a command name. Only an UNQUOTED spelling
// is reserved (measured: `time "-p" x` runs a command named -p).
const LEADS_TO_COMMAND = new Set(['!', '{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
const ENDS_COMPOUND = new Set(['fi', 'done', '}']);
const COMPOUND_START = new Set(['{', 'if', 'while', 'until', 'for', 'select', 'case', '[[']);
// Bash builtins whose argument is the command they run. External wrappers (sudo, env, timeout,
// xargs...) are an open-ended list the guard does not chase - the README states it.
const BUILTIN_WRAPPERS = new Set(['exec', 'command', 'builtin']);
// A FIXED list of external wrappers whose argument list names the command they run, each with the
// option grammar read on this machine (2026-09-23): GNU coreutils 9.4 env, timeout, nice, nohup,
// stdbuf, chroot; util-linux 2.39.3 setsid, ionice, taskset; sudo 1.9.15p5; GNU findutils 4.9.0 xargs
// (find is handled apart: its -exec actions). doas is not installed here: its grammar is doas(1)'s
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
  xargs: {
    short: { 0: 0, o: 0, p: 0, r: 0, t: 0, x: 0, a: 1, d: 1, E: 1, I: 1, L: 1, n: 1, P: 1, s: 1, e: 'glued', i: 'glued', l: 'glued' },
    long: {
      null: 0, 'arg-file': 1, delimiter: 1, eof: 'opt', replace: 'opt', 'max-lines': 1, 'max-args': 1, 'open-tty': 0, 'max-procs': 1,
      interactive: 0, 'process-slot-var': 1, 'no-run-if-empty': 0, 'max-chars': 1, 'show-limits': 0, verbose: 0, exit: 0,
    },
  },
};
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
    // A case pattern's `)` closes the PATTERN, not the enclosing `$(`: without this, the rest of
    // `"$(case x in x) ...;; esac)"` read as the outer double-quoted string and every quoting context
    // after it was wrong. Tracked per nesting frame: `case` ... `in` opens pattern mode, a pattern's
    // `)` opens the body, `;;` `;&` `;;&` reopen pattern mode, `esac` closes the case.
    if (/[a-z]/.test(character) && (index === 0 || SEPARATOR.test(command[index - 1]))) {
      const word = /^[a-z]+(?=[\s;&|()<>]|$)/.exec(command.slice(index, index + 8))?.[0];
      let back = index - 1;
      while (back >= 0 && (command[back] === ' ' || command[back] === '\t')) back -= 1;
      frame.cases ??= [];
      const leads = back < 0 || /[;&|()\n{!]/.test(command[back]) || /(?:^|[\s;&|(])(?:then|do|else|elif|time)$/.test(command.slice(Math.max(0, back - 5), back + 1));
      if (word === 'case' && leads) frame.caseWait = (frame.caseWait ?? 0) + 1;
      else if (word === 'in' && frame.caseWait > 0) { frame.caseWait -= 1; frame.cases.push('pattern'); }
      else if (word === 'esac' && frame.cases.length) frame.cases.pop();
    }
    if (character === ';' && frame.cases?.at(-1) === 'body' && (command[index + 1] === ';' || command[index + 1] === '&')) frame.cases[frame.cases.length - 1] = 'pattern';
    if (character === ')' && frame.cases?.at(-1) === 'pattern') { frame.cases[frame.cases.length - 1] = 'body'; context[index] = 'bare'; index += 1; continue; }
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
function validateOpRead(words) {
  let account = '';
  let ref = '';
  let verb = false;
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
      if (!VALUE_FLAGS.has(name) || !value) return { valid: false };
      if (name === '--account') account = value;
      continue;
    }
    if (VALUE_FLAGS.has(word.text)) {
      const value = words[index + 1];
      if (!value || value.operator || !value.literal || !value.text || value.text.startsWith('-') || /^(?:op:\/\/|secret:)/i.test(value.text)) return { valid: false };
      if (word.text === '--account') account = value.text;
      index += 1; continue;
    }
    if (BOOLEAN_FLAGS.has(word.text)) continue;
    if (word.text.startsWith('-')) return { valid: false };
    if (word.text.startsWith('op://')) {
      if (ref || !OP_PATH.test(word.text.slice('op://'.length))) return { valid: false };
      ref = word.text; continue;
    }
    return { valid: false };
  }
  return { valid: verb && Boolean(ref), account, ref };
}

function templateDestination(command) {
  return /(?:>{1,2}|\btee(?:\s+-\w+)*)\s*(?:"[^"\n]*\.tpl"|'[^'\n]*\.tpl'|[^\s;|&]+\.tpl)(?=\s|$|[;|&])/m.test(command);
}

// Every shell word of the command, with the simple command it belongs to (`segment`) and whether it
// sits where the shell looks for a command name (`command`). Quoting changes a word's spelling,
// never its meaning, so `"op"`, `o"p"` and `op` are all the word `op`; anything whose value the shell
// computes is marked non-literal by `readWord` and never decoded here. A command substitution is its
// own segment, and when it stands where a command name goes, a non-literal placeholder takes that
// position - `$(printf op) read` runs whatever the substitution prints.
//
// Two passes. `shellTokens` cuts the command into words, operators, redirections and the openings of
// nested command lists; `shellWords` walks them with the grammar positions where bash reads a command
// name: the start of every list (after `;` `&` `&&` `||` `|` `|&`, a newline, `(`, `{`, `$(`, `<(`),
// after `!` `time [-p] [--]` `coproc` `if` `then` `else` `elif` `while` `until` `do`, after leading
// assignments and redirections (`2>/dev/null`, `{fd}>`, `&>`), a case body (after a pattern's `)`
// and after `;;` `;&` `;;&`), a function body (`f() {`, `function f {`), and the argument of the
// builtins exec/command/builtin. Syntax it cannot place makes the result `unsure`, and a command that
// uses our forms is then refused rather than guessed at.
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

function shellWords(command, lexed) {
  const tokens = shellTokens(command, lexed.context, lexed.escapes);
  const words = [];
  let unsure = false;
  let segments = 0;
  const fresh = (state) => ({ state, segment: (segments += 1), cases: 0, target: false, lastEnd: -1, lastRole: null, wrapper: '', skipValue: false, ext: [] });
  const stack = [];
  let frame = fresh('command');
  const boundary = (state) => { frame.state = state; frame.segment = (segments += 1); frame.target = false; frame.lastRole = null; frame.ext = []; };
  const record = (token, role) => {
    // 'computed': a wrapped command whose name comes from somewhere the guard cannot read (find's `{}`,
    // xargs's replace string) - recorded as a non-literal wrapped name.
    const computed = role === 'computed';
    words.push({ text: token.text, literal: computed ? false : token.literal, start: token.start, end: token.end, segment: frame.segment, command: role === 'command', wrapped: role === 'wrapped' || computed });
    frame.lastEnd = token.end; frame.lastRole = computed ? 'wrapped' : role;
  };
  // External wrappers (WRAPPERS, and find's -exec actions), as a stack: a wrapper's command may be
  // another wrapper (`env A=1 timeout 5 nice cmd`), and find's -exec command may be one too.
  const externalName = (token) => {
    if (!token.literal) return null;
    const base = token.text.replace(/^.*\//, '');
    return WRAPPERS[base] || base === 'find' ? base : null;
  };
  const startExternal = (name) => (name === 'find' ? { name, phase: 'expr', last: null } : { name, spec: WRAPPERS[name], phase: 'options', left: WRAPPERS[name].operands ?? 0, pending: false, replace: null });
  // The word a wrapper runs. A non-literal one, or one spelled like the placeholder the wrapper fills
  // from its input, is a name the guard cannot read.
  const wrappedCommand = (token, placeholder) => {
    if (!token.literal || (placeholder && token.text === placeholder)) { if (!frame.ext.length) frame.state = 'args'; return 'computed'; }
    const name = externalName(token);
    if (name) frame.ext.push(startExternal(name));
    else if (!frame.ext.length) frame.state = 'args';
    return 'wrapped';
  };
  // One option word of a wrapper: 'arg', or 'none' (no command runs) or 'refuse' (grammar not placed).
  const wrapperOption = (entry, text) => {
    const { spec } = entry;
    const after = () => (entry.left > 0 ? 'operands' : spec.assignments ? 'assign' : 'command');
    if (text === '--') { entry.phase = after(); return 'arg'; }
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
      if (entry.name === 'xargs' && name === 'replace') entry.replace = equals < 0 ? '{}' : text.slice(equals + 1) || '{}';
      if (kind === 1 && equals < 0) entry.pending = 'value';
      return 'arg';
    }
    for (let at = 1; at < text.length; at += 1) {
      const letter = text[at];
      const kind = Object.hasOwn(spec.short, letter) ? spec.short[letter] : 'refuse';
      if (kind === 'none' || kind === 'refuse') return kind;
      if (kind === 0) continue;
      const rest = text.slice(at + 1);
      if (kind === 'glued') { if (entry.name === 'xargs' && letter === 'i') entry.replace = rest || '{}'; return 'arg'; }
      if (!rest) entry.pending = entry.name === 'xargs' && letter === 'I' ? 'replace' : 'value';
      else if (entry.name === 'xargs' && letter === 'I') entry.replace = rest;
      return 'arg';
    }
    return 'arg';
  };
  const externalStep = (token) => {
    const entry = frame.ext.at(-1);
    if (entry.name === 'find') {
      if (entry.phase === 'exec-args') {
        if (token.literal && (token.text === ';' || (token.text === '+' && entry.last === '{}'))) entry.phase = 'expr';
        else entry.last = token.literal ? token.text : null;
        return 'arg';
      }
      if (entry.phase === 'exec-command') { entry.phase = 'exec-args'; entry.last = null; return wrappedCommand(token, '{}'); }
      if (token.literal && FIND_EXEC.has(token.text)) entry.phase = 'exec-command';
      return 'arg';
    }
    if (entry.phase === 'none') return 'arg';
    if (entry.pending) {
      if (entry.pending === 'replace') { if (token.literal) entry.replace = token.text; else unsure = true; }
      entry.pending = false;
      return 'arg';
    }
    if (entry.phase === 'options') {
      if (token.literal && token.text.startsWith('-') && token.text !== '-') {
        const outcome = wrapperOption(entry, token.text);
        if (outcome === 'refuse') unsure = true;
        if (outcome !== 'arg') entry.phase = 'none';
        return 'arg';
      }
      if (token.literal && token.text === '-' && entry.spec.dash) return 'arg';
      entry.phase = entry.left > 0 ? 'operands' : entry.spec.assignments ? 'assign' : 'command';
    }
    if (entry.phase === 'operands') {
      entry.left -= 1;
      if (entry.left <= 0) entry.phase = entry.spec.assignments ? 'assign' : 'command';
      return 'arg';
    }
    // env: a word whose literal prefix holds `=` is an assignment, the first one without is the command.
    if (entry.phase === 'assign' && token.raw.split(/[$`]/)[0].includes('=')) return 'arg';
    frame.ext.pop();
    return wrappedCommand(token, entry.replace);
  };
  // The role of a word in the current frame, and the state it leaves behind.
  const place = (token, next) => {
    if (frame.target) { frame.target = false; return 'target'; }
    const bare = token.literal && token.raw === token.text ? token.text : null;
    switch (frame.state) {
      case 'args': case 'arith': return 'arg';
      case 'dbracket': if (bare === ']]') frame.state = 'args'; return 'arg';
      case 'for': frame.state = 'for-args'; return 'arg';
      case 'for-args': if (bare === 'do') frame.state = 'command'; return 'arg';
      case 'case-subject': frame.state = 'case-in'; return 'arg';
      case 'case-in': if (bare !== 'in') unsure = true; frame.state = 'case-pattern-start'; return 'arg';
      case 'case-pattern-start':
        if (bare === 'esac') { frame.cases -= 1; frame.state = 'args'; } else frame.state = 'case-pattern';
        return 'arg';
      case 'case-pattern': unsure = true; return 'arg';
      case 'time':
        if (bare === '-p' || bare === '--') return 'arg';
        frame.state = 'command'; break;
      case 'wrapper':
        if (frame.skipValue) { frame.skipValue = false; return 'arg'; }
        if (token.literal && /^-./.test(token.text)) {
          // `command -v NAME` / `-V` only print how NAME resolves; they run nothing.
          if (frame.wrapper === 'command' && /^-[a-zA-Z]*[vV]/.test(token.text)) { frame.state = 'args'; return 'arg'; }
          if (frame.wrapper === 'exec' && token.text === '-a') frame.skipValue = true;
          return 'arg';
        }
        if (token.literal && BUILTIN_WRAPPERS.has(token.text)) { frame.wrapper = token.text; return 'wrapped'; }
        frame.state = 'ext'; frame.ext = [];
        return wrappedCommand(token, null);
      case 'ext': return externalStep(token);
      case 'coproc': {
        const compound = next && (next.type === '(' || (next.type === 'word' && next.literal && next.raw === next.text && COMPOUND_START.has(next.text)));
        frame.state = 'command';
        if (compound && token.literal) return 'arg';
        break;
      }
      default: break;
    }
    // Where bash reads a command name. Leading assignments keep that position.
    if (lexed.context[token.start] === 'bare' && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(token.raw)) return 'assignment';
    if (bare !== null && LEADS_TO_COMMAND.has(bare)) frame.state = 'command';
    else if (token.literal && token.text === 'time') frame.state = 'time';
    else if (bare === 'coproc') frame.state = 'coproc';
    else if (bare === 'case') { frame.state = 'case-subject'; frame.cases += 1; }
    else if (bare === 'for' || bare === 'select') frame.state = 'for';
    else if (bare === 'function') frame.state = 'func-name';
    else if (bare === '[[') frame.state = 'dbracket';
    else if (bare === 'esac') { if (frame.cases > 0) frame.cases -= 1; else unsure = true; frame.state = 'args'; }
    else if (bare !== null && ENDS_COMPOUND.has(bare)) frame.state = 'args';
    else if (token.literal && BUILTIN_WRAPPERS.has(token.text)) { frame.state = 'wrapper'; frame.wrapper = token.text; frame.skipValue = false; }
    else if (externalName(token)) { frame.state = 'ext'; frame.ext = [startExternal(externalName(token))]; }
    else frame.state = 'args';
    return 'command';
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const following = tokens[index + 1];
    if (token.type === 'redirect') {
      if (frame.state !== 'dbracket' && frame.state !== 'arith') frame.target = true;
      continue;
    }
    if (token.type === 'op') {
      const { op } = token;
      if (frame.state === 'arith') continue;
      if (frame.state === 'dbracket') { if (op !== '&&' && op !== '||') unsure = true; continue; }
      if (op === '|' && frame.state === 'case-pattern') { frame.state = 'case-pattern-start'; continue; }
      if (op === '\n' && ['case-subject', 'case-in', 'case-pattern-start'].includes(frame.state)) continue;
      if (op === ';;' || op === ';&' || op === ';;&') { if (!frame.cases) unsure = true; boundary('case-pattern-start'); continue; }
      if (frame.state.startsWith('case') || frame.state === 'func-name') unsure = true;
      boundary('command');
      continue;
    }
    if (token.type === '(') {
      if (frame.state === 'arith') { stack.push(frame); frame = { ...fresh('arith'), segment: frame.segment }; continue; }
      if (frame.state === 'dbracket' || frame.state === 'case-pattern-start') continue;
      // NAME ( ) : a function definition - its body is a command position.
      if (following?.type === ')' && frame.lastRole === 'command' && tokens[index - 1]?.type === 'word' && tokens[index - 1].end === frame.lastEnd && (frame.state === 'args' || frame.state === 'wrapper')) {
        index += 1; boundary('command'); continue;
      }
      const arithmetic = following?.type === '(' && following.start === token.end;
      // `name=( ... )` is an array literal: its words are values, never commands.
      if (frame.lastRole === 'assignment' && token.start === frame.lastEnd) { stack.push(frame); frame = fresh('args'); continue; }
      const subshellHere = frame.state === 'command' || frame.state === 'time' || frame.state === 'coproc';
      if (!arithmetic && !subshellHere) unsure = true;
      if (frame.state === 'for') frame.state = 'for-args';
      else if (subshellHere) frame.state = 'args';
      stack.push(frame);
      frame = fresh(arithmetic ? 'arith' : 'command');
      continue;
    }
    if (token.type === ')') {
      if (frame.state === 'dbracket') continue;
      if (frame.state === 'case-pattern') { boundary('command'); continue; }
      if (frame.state.startsWith('case') || !stack.length) { unsure = true; continue; }
      if (frame.cases) unsure = true;
      frame = stack.pop();
      frame.lastEnd = token.end;
      continue;
    }
    if (token.type === 'open') {
      // Glued to the word before it (`op$(x)`, `x=$(...)`): the rest of THAT word, in its role.
      if (frame.lastRole && token.start === frame.lastEnd) {
        if (frame.lastRole === 'command' || frame.lastRole === 'wrapped') {
          words.push({ text: '$(', literal: false, start: token.start, end: token.end, segment: frame.segment, command: frame.lastRole === 'command', wrapped: frame.lastRole === 'wrapped' });
        }
      } else if (frame.state === 'func-name') {
        unsure = true;
      } else {
        // The substitution stands where a word goes: a command name there runs whatever it prints.
        const placeholder = { text: '$(', raw: '$(', literal: false, start: token.start, end: token.end };
        record(placeholder, place(placeholder, following));
      }
      stack.push(frame);
      frame = fresh(token.arith ? 'arith' : 'command');
      continue;
    }
    // A word.
    if (frame.lastRole && token.start === frame.lastEnd) {
      // The rest of a word a substitution interrupted (`"$(x)y"`): same word, same role.
      const role = frame.lastRole;
      words.push({ text: token.text, literal: token.literal, start: token.start, end: token.end, segment: frame.segment, command: role === 'command' && !token.literal, wrapped: role === 'wrapped' && !token.literal });
      frame.lastEnd = token.end;
      continue;
    }
    if (frame.state === 'func-name' && !frame.target) {
      record(token, 'arg');
      if (following?.type === '(' && tokens[index + 2]?.type === ')') index += 2;
      frame.state = 'command';
      continue;
    }
    record(token, place(token, following));
  }
  if (stack.length || frame.cases || frame.state.startsWith('case') || frame.state === 'func-name' || frame.state === 'dbracket') unsure = true;
  return { words, unsure };
}

// The next word after `at` in the same simple command, or undefined.
function nextInSegment(words, at) {
  for (let index = at + 1; index < words.length; index += 1) if (words[index].segment === words[at].segment) return words[index];
  return undefined;
}

// A global flag the 1Password CLI accepts BEFORE its subcommand (`op --account=team read ...`).
function globalFlag(word) {
  if (!word?.literal) return 0;
  if (BOOLEAN_FLAGS.has(word.text)) return 1;
  if (VALUE_FLAGS.has(word.text)) return 2;
  const assigned = word.text.indexOf('=');
  return word.text.startsWith('--') && assigned > 2 && VALUE_FLAGS.has(word.text.slice(0, assigned)) ? 1 : 0;
}

// The ONE literal form this guard owns besides its reference forms: a literal `op` word, documented
// global flags, then a literal verb. Anything else that might run `op` - a computed name, an alias,
// eval, a wrapper's argument list - is out of scope by design and is never looked for.
// `command` records whether `op` stands where the shell looks for a command name: only there does an
// INVALID use of the form refuse the command, so `echo op read foo` stays ordinary text.
function opWords(command, context, words) {
  const found = [];
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at];
    if (!word.literal || !OP_COMMAND.test(word.text)) continue;
    let cursor = at;
    let verb = nextInSegment(words, cursor);
    for (let width = globalFlag(verb); width > 0; width = globalFlag(verb)) {
      for (let step = 0; step < width; step += 1) { const following = nextInSegment(words, cursor); if (!following) break; cursor = words.indexOf(following); }
      verb = nextInSegment(words, cursor);
    }
    if (!verb || !verb.literal || !OP_VERBS.has(verb.text)) continue;
    found.push({ at: word.start, verb: verb.text, after: word.end, supported: true, command: word.command, wrapped: word.wrapped });
  }
  // In a comment or an unsupported context there are no shell words to decode, so an `op read`
  // written there as raw text is refused rather than validated (only when the command is ours). A
  // heredoc body is not checked at all: it is text the command writes.
  const spelling = /\bop(?:\.exe)?\b/g;
  const verbAt = /(?:read|inject|run)\b/y;
  for (let match; (match = spelling.exec(command));) {
    const at = match.index;
    const kind = context[at];
    if (!SHIELDED.has(kind)) continue;
    if (at > 0 && !SEPARATOR.test(command[at - 1]) && command[at - 1] !== '/') continue;
    let after = at + match[0].length;
    while (/[ \t]/.test(command[after] ?? '')) after += 1;
    verbAt.lastIndex = after;
    const verb = verbAt.exec(command);
    if (!verb) continue;
    found.push({ at, verb: verb[0], after: after + verb[0].length, supported: false, command: false });
  }
  return found.sort((left, right) => left.at - right.at);
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
  const uncertainBody = inBodies > 0 && (!lexed.complete || lexed.uncertain);
  const { words, unsure } = shellWords(command, lexed);
  const entries = opWords(command, lexed.context, words);
  // OUR FORMS ONLY. The guard acts on its reference forms and on the one literal documented
  // `op read <literal op:// reference>` form - nothing else. It does not look for other ways a shell
  // might reach `op` (a computed name, an alias, eval, a wrapper): that search cannot be won from the
  // text, and trying refused ordinary work. Those invocations are out of scope by design (README).
  const invalid = [];
  const consumed = [];
  for (const entry of entries) {
    if (entry.verb !== 'read' || !entry.supported) continue;
    const parsed = invocationTokens(command, lexed.context, entry.after);
    const validated = validateOpRead(parsed.words);
    if (validated.valid) {
      invocations.push({ ref: validated.ref, account: validated.account });
      consumed.push([entry.at, parsed.end]);
    } else if (entry.command || (entry.wrapped && matches.length)) {
      // Only the documented form written where the shell looks for a command name, and written wrong,
      // is ours to refuse. `echo op read x` is text. Behind a wrapper (`exec op read "$REF"`) it is out of
      // scope on its own - but beside one of our reference forms it would run op on a value the guard
      // bound and never prefetched (`timeout 5 op read secret:env:R`), so there it is ours too.
      invalid.push('`op read` without a single literal `op://` reference and documented flags');
    }
  }
  // A command that uses one of OUR forms may only be written in text this guard reads literally:
  // every construct it does not decode refuses it, by name, and so does every command name it cannot
  // read. A command with none of our forms is left alone, whatever it spells or mentions.
  const ours = matches.length > 0 || invocations.length > 0 || invalid.length > 0 || uncertainBody;
  if (ours) {
    for (const construct of lexed.constructs) refusals.push(`${construct}, which this guard does not decode`);
    if (words.some((word) => (word.command || word.wrapped) && !word.literal)) refusals.push('a command name this guard cannot read literally');
    if (unsure) refusals.push('shell syntax in which this guard cannot place every command name');
    if (lexed.uncertain) refusals.push('a heredoc whose end this guard cannot place');
    refusals.push(...invalid);
    for (const entry of entries) {
      if (entry.verb !== 'read' && matches.length) refusals.push(`\`op ${entry.verb}\` beside a secret reference`);
      if (entry.verb === 'read' && !entry.supported) refusals.push('`op read` inside a comment or an unsupported context');
    }
  }
  // An unbalanced quote in a command that is not ours is the caller's business.
  if (!lexed.complete && ours) refusals.push('an incomplete quote, heredoc or substitution');
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
