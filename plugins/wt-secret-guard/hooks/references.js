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
//             an UNQUOTED heredoc body line
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

const quoteForSingleQuotes = (value) => value.replace(/'/g, "'\"'\"'");

function consumeHeredoc(command, context, escapes, doc, start) {
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
      if (doc.quoted) { context[at] = 'unsupported'; continue; }
      if (character === '\\') { context[at] = 'heredoc'; escapes.add(at); if (at + 1 < end) context[at + 1] = 'heredoc'; at += 1; continue; }
      if (character === '$' && (command[at + 1] === '(' || command[at + 1] === '{')) { depth += 1; context[at] = 'unsupported'; context[at + 1] = 'unsupported'; at += 1; continue; }
      if (depth > 0 && (character === ')' || character === '}')) { depth -= 1; context[at] = 'unsupported'; continue; }
      context[at] = depth > 0 ? 'unsupported' : 'heredoc';
    }
    if (lineEnd < 0) return -1;
    context[lineEnd] = doc.quoted ? 'unsupported' : 'heredoc';
    lineStart = lineEnd + 1;
  }
  return -1;
}

// Returns, for every byte of the command, the quoting context it sits in, plus the bounds of the
// quoted word that encloses it. 'unsupported' covers parameter expansion, backticks, $'...',
// comments and quoted heredoc bodies - contexts this guard deliberately never expands into.
// `escapes` carries the position of every backslash the shell consumes as an escape, so a caller
// replacing a span can tell an escaped reference from one that starts its own word.
export function lex(command) {
  const size = command.length;
  const context = new Array(size).fill('bare');
  const bounds = new Array(size).fill(null);
  const escapes = new Set();
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
      // An ANSI-C span gets its own context rather than 'unsupported'. It is still never expanded
      // into - `extent` accepts only bare, single, double and heredoc - but its body IS a literal
      // the shell decodes, so a command word spelled $'op' has to be readable as the word `op`.
      const ansi = frame.type === 'ansi';
      const closer = ansi ? "'" : '`';
      const inside = ansi ? 'ansi' : 'unsupported';
      context[index] = inside;
      if (character === '\\') { if (index + 1 < size) context[index + 1] = inside; index += 2; continue; }
      if (character === closer) { context[index] = ansi ? 'quote' : 'unsupported'; stack.pop(); index += 1; continue; }
      index += 1; continue;
    }
    if (frame.type === 'param') {
      context[index] = 'unsupported';
      if (character === '{') frame.depth += 1;
      if (character === '}') { if (frame.depth === 0) stack.pop(); else frame.depth -= 1; }
      index += 1; continue;
    }
    if (frame.type === 'comment') {
      if (character === '\n') { stack.pop(); continue; }
      context[index] = 'unsupported'; index += 1; continue;
    }
    if (frame.type === 'double') {
      if (character === '\\') { context[index] = 'double'; escapes.add(index); if (index + 1 < size) context[index + 1] = 'double'; index += 2; continue; }
      if (character === '"') { close(frame, index, 'double'); context[index] = 'quote'; stack.pop(); index += 1; continue; }
      if (character === '$' && command[index + 1] === '(') { context[index] = 'double'; context[index + 1] = 'double'; stack.push({ type: 'subst' }); index += 2; continue; }
      if (character === '$' && command[index + 1] === '{') { context[index] = 'double'; stack.push({ type: 'param', depth: 0 }); index += 1; continue; }
      if (character === '`') { stack.push({ type: 'backtick' }); context[index] = 'unsupported'; index += 1; continue; }
      context[index] = 'double'; index += 1; continue;
    }
    if (!base) { context[index] = 'unsupported'; index += 1; continue; }
    if (character === '\\') { context[index] = 'bare'; escapes.add(index); if (index + 1 < size) context[index + 1] = 'bare'; index += 2; continue; }
    if (character === "'") { context[index] = 'quote'; stack.push({ type: 'single', start: index }); index += 1; continue; }
    if (character === '"') { context[index] = 'quote'; stack.push({ type: 'double', start: index }); index += 1; continue; }
    if (character === '$' && command[index + 1] === "'") { context[index] = 'quote'; context[index + 1] = 'quote'; stack.push({ type: 'ansi' }); index += 2; continue; }
    if (character === '$' && command[index + 1] === '"') { context[index] = 'bare'; context[index + 1] = 'quote'; stack.push({ type: 'double', start: index + 1 }); index += 2; continue; }
    if (character === '$' && command[index + 1] === '(') { context[index] = 'bare'; context[index + 1] = 'bare'; stack.push({ type: 'subst' }); index += 2; continue; }
    if (character === '$' && command[index + 1] === '{') { context[index] = 'bare'; stack.push({ type: 'param', depth: 0 }); index += 1; continue; }
    if (character === '`') { context[index] = 'unsupported'; stack.push({ type: 'backtick' }); index += 1; continue; }
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
        const next = consumeHeredoc(command, context, escapes, pending.shift(), index);
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
  return { context, bounds, escapes, complete };
}

// One ANSI-C escape, decoded the way the shell decodes it. Unknown escapes keep their backslash,
// which is what bash does; a code point outside Unicode keeps its raw spelling rather than throwing.
const ANSI_SIMPLE = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
function ansiEscape(command, at) {
  const character = command[at];
  if (character === undefined) return { text: '\\', end: at };
  if (Object.hasOwn(ANSI_SIMPLE, character)) return { text: ANSI_SIMPLE[character], end: at + 1 };
  if (character === 'x' || character === 'u' || character === 'U') {
    const width = character === 'x' ? 2 : character === 'u' ? 4 : 8;
    const digits = /^[0-9a-fA-F]+/.exec(command.slice(at + 1, at + 1 + width));
    const code = digits ? Number.parseInt(digits[0], 16) : Number.NaN;
    if (!digits || !(code >= 0 && code <= 0x10ffff)) return { text: `\\${character}`, end: at + 1 };
    return { text: String.fromCodePoint(code), end: at + 1 + digits[0].length };
  }
  if (character === 'c') {
    const next = command[at + 1];
    return next === undefined ? { text: '\\c', end: at + 1 } : { text: String.fromCharCode(next.toUpperCase().charCodeAt(0) ^ 64), end: at + 2 };
  }
  const octal = /^[0-7]{1,3}/.exec(command.slice(at));
  if (octal) return { text: String.fromCharCode(Number.parseInt(octal[0], 8)), end: at + octal[0].length };
  return { text: `\\${character}`, end: at + 1 };
}

function readWord(command, context, from) {
  let text = ''; let literal = true; let index = from;
  while (index < command.length) {
    const kind = context[index];
    const character = command[index];
    if (kind === 'bare') {
      if (SEPARATOR.test(character)) break;
      if (character === '$' || character === '`') { literal = false; text += character; index += 1; continue; }
      // A backslash-newline is a line continuation: the shell removes BOTH characters, so the word
      // continues with nothing added. Keeping the newline makes `r\<newline>ead` decode as something
      // no command is ever named.
      if (character === '\\') { if (command[index + 1] !== '\n') text += command[index + 1] ?? ''; index += 2; continue; }
      text += character; index += 1; continue;
    }
    if (kind === 'quote') { index += 1; continue; }
    if (kind === 'single') { text += character; index += 1; continue; }
    if (kind === 'ansi') {
      if (character === '\\') { const decoded = ansiEscape(command, index + 1); text += decoded.text; index = decoded.end; continue; }
      text += character; index += 1; continue;
    }
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
      // of reading command words, so `"$(op read ...)"` still shows `op` as a word of its own.
      if (character === '$' && command[index + 1] === '(') break;
      if (character === '$' || character === '`') literal = false;
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

function validateOpRead(words) {
  let account = '';
  let ref = '';
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
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
  return { valid: Boolean(ref), account, ref };
}

function templateDestination(command) {
  return /(?:>{1,2}|\btee(?:\s+-\w+)*)\s*(?:"[^"\n]*\.tpl"|'[^'\n]*\.tpl'|[^\s;|&]+\.tpl)(?=\s|$|[;|&])/m.test(command);
}

// Every shell word of the command, decoded exactly as the shell would decode it: quoting changes a
// word's spelling, never its meaning, so `"op"`, `o"p"` and `op` are all the word `op`. Heredoc
// bodies and unsupported contexts carry no shell words at all and are skipped here.
function shellWords(command, context) {
  const words = [];
  let index = 0;
  while (index < command.length) {
    const kind = context[index];
    if (kind === 'heredoc' || kind === 'unsupported') { index += 1; continue; }
    if (command[index] === '\\' && command[index + 1] === '\n') { index += 2; continue; }
    if (command[index] === '$' && command[index + 1] === '(') { index += 2; continue; }
    if (kind === 'bare' && SEPARATOR.test(command[index])) { index += 1; continue; }
    const word = readWord(command, context, index);
    if (word.end <= index) { index += 1; continue; }
    words.push(word);
    index = word.end;
  }
  return words;
}

function opWords(command, context) {
  const found = [];
  const words = shellWords(command, context);
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at];
    const verb = words[at + 1];
    if (!word.literal || !OP_COMMAND.test(word.text)) continue;
    if (!verb || !verb.literal || !OP_VERBS.has(verb.text)) continue;
    found.push({ at: word.start, verb: verb.text, after: verb.end, supported: true });
  }
  // In a heredoc body or an unsupported context there are no shell words to decode - the text is
  // literal data - so its raw spelling IS its decoded spelling. An `op read` written there is
  // refused rather than validated, because this guard never expands anything in those contexts.
  const spelling = /\bop(?:\.exe)?\b/g;
  const verbAt = /(?:read|inject|run)\b/y;
  for (let match; (match = spelling.exec(command));) {
    const at = match.index;
    const kind = context[at];
    if (kind !== 'heredoc' && kind !== 'unsupported') continue;
    if (at > 0 && !SEPARATOR.test(command[at - 1]) && command[at - 1] !== '/') continue;
    let after = at + match[0].length;
    while (/[ \t]/.test(command[after] ?? '')) after += 1;
    verbAt.lastIndex = after;
    const verb = verbAt.exec(command);
    if (!verb) continue;
    found.push({ at, verb: verb[0], after: after + verb[0].length, supported: false });
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
  if (where !== 'bare' && where !== 'single' && where !== 'double' && where !== 'heredoc') return { refuse: 'an unsupported quoting context' };
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
    matches.push(match);
  }
  const consumed = [];
  for (const entry of opWords(command, lexed.context)) {
    if (entry.verb !== 'read') { if (matches.length) refusals.push(`\`op ${entry.verb}\` beside a secret reference`); continue; }
    if (!entry.supported) { refusals.push('`op read` inside a quoted string, a comment or a heredoc body'); continue; }
    const parsed = invocationTokens(command, lexed.context, entry.after);
    const validated = validateOpRead(parsed.words);
    if (!validated.valid) { refusals.push('`op read` without a single literal `op://` reference and documented flags'); continue; }
    invocations.push({ ref: validated.ref, account: validated.account });
    consumed.push([entry.at, parsed.end]);
  }
  // An unbalanced quote in a command that carries no reference at all is the caller's business.
  if (!lexed.complete && matches.length) refusals.push('an incomplete quote, heredoc or substitution');
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

/** A supported context decides how an expansion is quoted; every other context was already refused. */
export function renderReplacement(occurrence, expression) {
  return occurrence.context === 'heredoc' ? expression : `"${expression}"`;
}

export function opExpression(path, account) {
  const selector = account ? ` --account '${quoteForSingleQuotes(account)}'` : '';
  return `$(op read${selector} 'op://${quoteForSingleQuotes(path)}')`;
}

export { quoteForSingleQuotes };
