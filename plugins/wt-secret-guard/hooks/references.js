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
//             decode ($'...', $"...", backticks, NUL) and NO command name it cannot read literally.
//   out of scope  anything else that might run `op` - a computed or aliased name, eval, a wrapper's
//             argument list. Not refused, not prefetched: its output is protected only by the
//             detectors and the values already in the vault.
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
const NOT_WORDS = new Set(['comment', 'heredoc', 'heredoc-quoted', 'heredoc-unsupported']);
// Contexts where an `op` invocation written as raw text is refused rather than validated. A heredoc
// body is not among them: it is text the command writes, never a context this guard acts on.
const SHIELDED = new Set(['comment', 'unsupported']);
// A heredoc body - quoted or not - is NOT a context this guard expands (round 8 decision). A
// reference written there stays literal in what the command writes, is not prefetched, and does not
// refuse the command: the guard cannot tell "inject this secret into a file" from "write a document
// that mentions a reference", and the first is exactly the path that puts a secret on disk. Injection
// into files belongs to 1Password's own `op inject`.
const HEREDOC_BODY = new Set(['heredoc', 'heredoc-quoted', 'heredoc-unsupported']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', '{']);

const quoteForSingleQuotes = (value) => value.replace(/'/g, "'\"'\"'");

function consumeHeredoc(command, context, escapes, constructs, doc, start) {
  let lineStart = start;
  while (lineStart <= command.length) {
    const lineEnd = command.indexOf('\n', lineStart);
    const end = lineEnd < 0 ? command.length : lineEnd;
    const line = command.slice(lineStart, end);
    if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
      for (let at = lineStart; at < end; at += 1) context[at] = 'bare';
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
      if (character === '$' && command[index + 1] === '{') { context[index] = 'double'; stack.push({ type: 'param', depth: 0 }); index += 1; continue; }
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
    if (character === '$' && command[index + 1] === '{') { context[index] = 'bare'; stack.push({ type: 'param', depth: 0 }); index += 1; continue; }
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
  return { context, bounds, escapes, constructs, complete };
}

// Reads one shell word. `literal` is true only when the word's text is exactly what the shell will
// use: no expansion, no substitution, and no construct this guard does not decode. The guard never
// guesses what a non-literal word becomes; in a reference-bearing command it refuses it instead.
function readWord(command, context, from) {
  let text = ''; let literal = true; let index = from; let braceOpen = false;
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
      if (character === '*' || character === '?' || character === '[') literal = false;
      if (character === '~' && index === from) literal = false;
      if (character === '{') braceOpen = true;
      if (character === '}' && braceOpen) literal = false;
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
function shellWords(command, context) {
  const words = [];
  const nesting = [];
  let segment = 0; let next = 0; let atStart = true; let redirect = false;
  const boundary = () => { next += 1; segment = next; atStart = true; redirect = false; };
  let index = 0;
  while (index < command.length) {
    const kind = context[index];
    const character = command[index];
    if (NOT_WORDS.has(kind)) { index += 1; continue; }
    if (character === '\\' && command[index + 1] === '\n') { index += 2; continue; }
    if (character === '$' && command[index + 1] === '(') {
      if (atStart && !redirect) { words.push({ text: '$(', literal: false, start: index, end: index + 2, segment, command: true }); atStart = false; }
      nesting.push(segment); boundary(); index += 2; continue;
    }
    if (kind === 'bare' && character === '(') { nesting.push(segment); boundary(); index += 1; continue; }
    if (kind === 'bare' && character === ')') { segment = nesting.length ? nesting.pop() : segment; atStart = false; redirect = false; index += 1; continue; }
    if (kind === 'bare' && /[;|&\n]/.test(character)) { boundary(); index += 1; continue; }
    if (kind === 'bare' && (character === '<' || character === '>')) { redirect = true; index += 1; continue; }
    if (kind === 'bare' && SEPARATOR.test(character)) { index += 1; continue; }
    const word = readWord(command, context, index);
    if (word.end <= index) { index += 1; continue; }
    index = word.end;
    if (redirect) { redirect = false; words.push({ ...word, segment, command: false }); continue; }
    const assignment = atStart && context[word.start] === 'bare' && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(command.slice(word.start, word.end));
    const isCommand = atStart && !assignment;
    words.push({ ...word, segment, command: isCommand });
    if (isCommand) atStart = word.literal && KEYWORDS.has(word.text);
  }
  return words;
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
    found.push({ at: word.start, verb: verb.text, after: word.end, supported: true, command: word.command });
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
  for (let match; (match = REFERENCE.exec(command));) {
    const before = command[match.index - 1];
    if (before !== undefined && /[A-Za-z0-9_]/.test(before)) continue;
    if (HEREDOC_BODY.has(lexed.context[match.index])) continue;
    matches.push(match);
  }
  const words = shellWords(command, lexed.context);
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
    } else if (entry.command) {
      // Only the documented form written where the shell looks for a command name, and written wrong,
      // is ours to refuse. `echo op read x` is text; `exec op read "$REF"` is a wrapper - out of scope.
      invalid.push('`op read` without a single literal `op://` reference and documented flags');
    }
  }
  // A command that uses one of OUR forms may only be written in text this guard reads literally:
  // every construct it does not decode refuses it, by name, and so does every command name it cannot
  // read. A command with none of our forms is left alone, whatever it spells or mentions.
  const ours = matches.length > 0 || invocations.length > 0 || invalid.length > 0;
  if (ours) {
    for (const construct of lexed.constructs) refusals.push(`${construct}, which this guard does not decode`);
    if (words.some((word) => word.command && !word.literal)) refusals.push('a command name this guard cannot read literally');
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
