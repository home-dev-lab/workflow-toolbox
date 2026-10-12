import { registrationRefusalReason } from './token-vault.js';

function jwtPrefixAt(text, at) {
  return text.startsWith('eyJ', at) && !/[A-Za-z0-9_]/.test(text[at - 1] ?? '')
    && /[A-Za-z0-9_-]/.test(text[at + 3] ?? '');
}

function jwtField(text, start) {
  let end = start; let prefix = -1; let wordEnd = start;
  while (/[A-Za-z0-9_-]/.test(text[end] ?? '')) {
    if (prefix < 0 && jwtPrefixAt(text, end)) prefix = end;
    if (/[A-Za-z0-9_]/.test(text[end])) wordEnd = end + 1;
    end += 1;
  }
  return { start, end, prefix, wordEnd };
}

function jwtMatchFrom(text, start) {
  // All eyJ starts in a field share its two following fields. Examine a field
  // once as a first field; lookahead scans overlap at most three fields. The
  // last word endpoint implements the greedy final run followed by \b.
  for (let at = start; at < text.length;) {
    const first = jwtField(text, at);
    at = first.end + 1;
    if (first.prefix < 0 || text[first.end] !== '.') continue;
    const second = jwtField(text, first.end + 1);
    if (second.start === second.end || text[second.end] !== '.') continue;
    const third = jwtField(text, second.end + 1);
    if (third.wordEnd === third.start) continue;
    const match = [text.slice(first.prefix, third.wordEnd)];
    match.index = first.prefix;
    return match;
  }
  return null;
}

function jwtMatcher() {
  return {
    lastIndex: 0,
    exec(text) {
      const match = jwtMatchFrom(text, this.lastIndex);
      this.lastIndex = match ? match.index + match[0].length : 0;
      return match;
    },
  };
}

function privateKeyMatcher() {
  return {
    lastIndex: 0,
    exec(text) {
      // The first BEGIN pairs with the first subsequent END. If there is no END,
      // later BEGINs cannot match either; never restart the whole suffix scan.
      const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
      const end = /-----END [A-Z ]*PRIVATE KEY-----/g;
      begin.lastIndex = this.lastIndex;
      const opening = begin.exec(text);
      if (!opening) { this.lastIndex = 0; return null; }
      end.lastIndex = begin.lastIndex;
      const closing = end.exec(text);
      if (!closing) { this.lastIndex = 0; return null; }
      this.lastIndex = end.lastIndex;
      const match = [text.slice(opening.index, this.lastIndex)];
      match.index = opening.index;
      return match;
    },
  };
}

const patterns = [
  ['github-classic', /\bghp_[A-Za-z0-9]{36}\b/g],
  ['github-fine-grained', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/g],
  ['openai-api-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g],
  ['brave-api-key', /(?<![A-Za-z0-9_-])BSA[A-Za-z0-9_-]{28}(?![A-Za-z0-9_-])/g],
  ['jwt', jwtMatcher()],
  ['private-key', privateKeyMatcher()],
  // The key-based kinds below match on ONE line ([ \t], never \s) and capture the value in a group: a
  // detection is the value itself, never the key, the indentation or a following line (card
  // the over-wide capture case - "token:\n    type" became a held value and refused every text sharing it).
  ['assignment', /\b(?:password|token|secret)[ \t]*=[ \t]*(?![=])(?:"([^"]+)"|'([^']+)'|([^\s;,)}"']+))/gi],
  ['op-output', /^[ \t]*(?:password|token|secret|credential)[ \t]*:[ \t]*(\S.*?)[ \t]*$/gim],
  // A QUOTED key with a quoted value: a JSON body or a Python dict - `{"password": "..."}`. No other
  // pattern matches it: `assignment` needs `=` and `op-output` needs an unquoted key at a line start.
  ['key-value', /(["'])(?:password|token|secret)\1[ \t]*:[ \t]*(?:"([^"\n]+)"|'([^'\n]+)')/gi],
  ['environment-dump', /^[ \t]*(?:\+[ \t]*)?(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET)[ \t]*=[ \t]*(\S.*?)[ \t]*$/gm],
];

// Below this length a captured value is not distinctive: masking it would mask every "true" or "0" in
// the output, and holding it would refuse ordinary text later. Such a value keeps its key, on its own line.
export const DISTINCT_VALUE_FLOOR = 6;

function capturedValue(match) {
  const groups = match.slice(1).filter((group) => group !== undefined);
  const value = groups.at(-1);
  if (value === undefined || value === match[0]) return match[0];
  if (value.length >= DISTINCT_VALUE_FLOOR) return value;
  return match[0].replace(/^[ \t]*(?:\+[ \t]*)?/, '');
}

const sha = /\b[a-f0-9]{40}\b/gi;
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const secretToken = /\bsecret:[a-z-]+#[a-f0-9]{6}\b/gi;
const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;
const EMAIL_LABEL = /[A-Za-z0-9-]/;
const ASCII_WORD = /[A-Za-z0-9_]/;

function emailTldEnd(text, start) {
  let end = start;
  while (end - start < 24 && /[A-Za-z]/.test(text[end] ?? '')) end += 1;
  return end - start >= 2 && !ASCII_WORD.test(text[end] ?? '') ? end : 0;
}

function emailDomainEnd(text, start) {
  if (!emailAlnumAt(text, start)) return 0;
  let at = start;
  while (EMAIL_LABEL.test(text[at] ?? '')) at += 1;
  if (!emailAlnumAt(text, at - 1)) return 0;
  let end = 0;
  while (text[at] === '.') {
    at += 1;
    end = emailTldEnd(text, at) || end;
    const labelStart = at;
    while (EMAIL_LABEL.test(text[at] ?? '')) at += 1;
    if (at === labelStart) break;
  }
  return end;
}

function emailAlnumAt(text, at) {
  return /[A-Za-z0-9]/.test(text[at] ?? '');
}

function emailLocalRun(text, start) {
  let at = start;
  let boundary = -1;
  while (EMAIL_LOCAL.test(text[at] ?? '')) {
    if (boundary < 0 && emailBoundaryAt(text, at)) boundary = at;
    at += 1;
  }
  return { at, boundary };
}

function emailBoundaryAt(text, at) {
  return ASCII_WORD.test(text[at]) !== ASCII_WORD.test(text[at - 1] ?? '');
}

function emailDetections(text) {
  // One maximal local run per @; all starts in it share the same domain result.
  // Domain labels have disjoint delimiters. The last valid TLD implements the
  // regex's greedy repetition, and the first ASCII word boundary its first start
  // (including word-to-punctuation after a preceding global match).
  // A domain ends before the next @, so these scans visit each unit O(1) times.
  const found = [];
  for (let at = 0; at < text.length;) {
    const run = emailLocalRun(text, at);
    const end = text[run.at] === '@' && run.boundary >= 0 ? emailDomainEnd(text, run.at + 1) : 0;
    if (end) found.push({ kind: 'email', value: text.slice(run.boundary, end) });
    at = end || run.at + 1;
  }
  return found;
}
const ipv4 = /(?<![0-9.])(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}(?![0-9.])/g;
const ipv6Candidate = /(?<![0-9A-Fa-f:])[0-9A-Fa-f]*:[0-9A-Fa-f:]+(?![0-9A-Fa-f:])/g;

function uuidHasCredentialContext(text, index) {
  const prefix = text.slice(Math.max(0, index - 96), index);
  return /new\s+Exa\s*\(\s*["']?$/i.test(prefix)
    || /\b(?:api[\s_-]*key|access[\s_-]*key|token|secret|credential)\b\s*(?:=|:)\s*["']?$/i.test(prefix);
}

function credentialUuidDetections(text) {
  const found = [];
  uuid.lastIndex = 0;
  for (let match; (match = uuid.exec(text));) {
    if (uuidHasCredentialContext(text, match.index)) found.push({ kind: 'credential-uuid', value: match[0] });
  }
  return found;
}

export function allowedRanges(text, command = '') {
  const ranges = [];
  for (const expression of [sha, secretToken]) {
    expression.lastIndex = 0;
    for (let match; (match = expression.exec(text));) ranges.push([match.index, match.index + match[0].length]);
  }
  uuid.lastIndex = 0;
  for (let match; (match = uuid.exec(text));) {
    if (!uuidHasCredentialContext(text, match.index)) ranges.push([match.index, match.index + match[0].length]);
  }
  // Base64 is only allow-listed when the command names a file, never as a blanket exemption.
  if (/\b(?:cat|base64|openssl)\s+[^\s]+/.test(command)) {
    const base64 = /\b[A-Za-z0-9+/]{32,}={0,2}\b/g;
    for (let match; (match = base64.exec(text));) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function overlaps(start, end, ranges) {
  return ranges.some(([from, to]) => start < to && end > from);
}

function sourceAssignment(text, match) {
  const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
  const lineEnd = text.indexOf('\n', match.index);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  // Judge the STATEMENT that holds the match, not the whole line: text after the last ";" before it.
  // A source-looking prefix earlier on the line must not exempt a later bare assignment
  // ("const harmless = true; secret=…", review finding A1), and a declaration that itself follows a
  // semicolon is still source code and stays exempt (a per-line rule rewrote such lines).
  const lineBefore = text.slice(lineStart, match.index);
  const statementStart = lineBefore.lastIndexOf(';') + 1;
  const before = lineBefore.slice(statementStart);
  const sourceLine = (statementStart > 0 ? line.slice(statementStart) : line).replace(/^\s*(?:[-+]\s*)?/, '');
  // Every exemption below covers a value that is a NAME, never a QUOTED literal: `const x = y` passes a
  // variable, while a quoted literal is the credential itself - in a Python repr or a keyword argument,
  // and equally in a declaration a `cat config.js` prints (reviewer at d1814348: the keyword rule ran
  // before this one and let `const <credential name> = '<literal>';` through).
  const value = match[0].slice(match[0].indexOf('=') + 1).trim();
  if (/^["']/.test(value)) return false;
  if (/^(?:(?:export|default)\s+)*(?:const|let|var|type|interface|function|class|import)\b/.test(sourceLine)) return true;

  // Inside a call or a literal, the exemption covers a value that is a NAME (`connect(password=pwd)`
  // passes a variable). A QUOTED literal there is exactly what a Python repr or a keyword argument
  // carries - `Config(password='hunter2', user='x')` - and ordinary command output prints it.
  const after = text.slice(match.index + match[0].length, lineEnd < 0 ? text.length : lineEnd);
  return /[({][^({]*$/.test(before) && /^\s*[,)}]/.test(after);
}

const FUNCTION_WORDS = new Set('a an the of from by to in on for with and or is are be if else when then this that which not into at as it its than via'.split(' '));
// A path prefix (`/usr/local/bin/op`, `C:\Tools\op.exe`) or a quoted command word still names op.
const OP_COMMAND = /(?:^|[\s;&|(`/\\"'])op(?:\.exe)?(?![A-Za-z0-9_.-])/i;
// Any `$` (an empty `$1`/`$@`, `$"…"`), brace expansion or a glob can splice or spell op
// (`o$@p`, `{op,}`, `/usr/bin/o?`), so each one refuses the exemption.
const SHELL_EXPANSION = /[$`{}*?[\]]/;

function normalizedShellWords(command) {
  return command.replace(/\\\r?\n/g, '')
    .replace(/\$'((?:\\.|[^'\\])*)'/g, (_match, word) => word.replace(/\\(?:([0-7]{1,3})|x([0-9a-f]{1,2}))/gi,
      (_escape, octal, hex) => String.fromCharCode(parseInt(octal ?? hex, octal ? 8 : 16))))
    .replace(/\\(.)/g, '$1').replace(/["']/g, '');
}

function uncertainOrOpCommand(command) {
  if (SHELL_EXPANSION.test(command)) return true;
  const normalized = normalizedShellWords(command);
  // Keep the raw check too: Windows path separators are not POSIX shell escapes.
  return OP_COMMAND.test(normalized) || OP_COMMAND.test(command);
}

function stripProsePunctuation(word) {
  // The global regex removes the anchored prefix first, then the suffix of the
  // original word. Separate scans preserve that order, including overlaps.
  let start = 0;
  while (start < word.length && '(["\'`'.includes(word[start])) start += 1;
  let end = word.length;
  while (end > start && ')"\'.,;:!?`'.includes(word[end - 1])) end -= 1;
  return word.slice(start, end);
}

function proseWords(value) {
  return value.trim().split(/\s+/).map(stripProsePunctuation);
}

function completeLine(text, match, options) {
  // Streaming callers cannot know that a final line is complete until a newline arrives.
  return options.complete === true || text.indexOf('\n', match.index + match[0].length) !== -1;
}

function proseOutput(text, match, command, options) {
  if (options.prose === false || !completeLine(text, match, options)) return false;
  if (uncertainOrOpCommand(command)) return false;
  const value = match[1].trim();
  const words = proseWords(value);
  if (words.length < 6) return false;
  if (!words.every((word) => /^\p{L}+(?:[_'-]\p{L}+)*$/u.test(word))) return false;
  const functionCount = words.filter((word) => FUNCTION_WORDS.has(word.toLowerCase())).length;
  if (functionCount < 2 || functionCount * 4 < words.length) return false;
  return words.every((word) => registrationRefusalReason(word, 'op-output'))
    && Boolean(registrationRefusalReason(value, 'op-output'));
}

function jsonString(text, start) {
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\') cursor += 2;
    else if (text[cursor++] === '"') {
      const serialized = text.slice(start + 1, cursor - 1);
      let decoded = serialized;
      try { decoded = JSON.parse(text.slice(start, cursor)); } catch { /* Malformed strings still need fail-safe scrubbing. */ }
      return { end: cursor, serialized, decoded };
    } else continue;
  }
  const serialized = text.slice(start + 1);
  let decoded = serialized;
  try { decoded = JSON.parse(`"${serialized}"`); } catch { /* Keep undecodable partial bytes fail-safe. */ }
  return { end: text.length, serialized, decoded };
}

function scannedConcealedDetections(text) {
  if (!/"type"\s*:\s*"CONCEALED"/.test(text)) return [];
  const found = [];
  const stack = [];
  const finish = (frame, end) => {
    if (frame.kind !== 'object' || !frame.concealed) return;
    if (frame.value?.serialized) {
      found.push({ kind: 'op-json-concealed', value: frame.value.serialized, secret: frame.value.decoded });
      return;
    }
    // Fail-safe for a value that is not a JSON string (truncated or malformed output): the run of
    // characters after "value": up to the next delimiter - never the whole object with its keys.
    if (frame.valueAt === undefined) return;
    const fragment = text.slice(frame.valueAt, end).match(/^[^,}\]\s]+/)?.[0];
    if (fragment) found.push({ kind: 'op-json-concealed', value: fragment, secret: fragment });
  };

  for (let cursor = 0; cursor < text.length;) {
    const character = text[cursor];
    if (character === '{') { stack.push({ kind: 'object', start: cursor }); cursor += 1; continue; }
    if (character === '[') { stack.push({ kind: 'array', start: cursor }); cursor += 1; continue; }
    if (character === '}' || character === ']') {
      const frame = stack.pop();
      if (frame) finish(frame, cursor + 1);
      cursor += 1;
      continue;
    }
    if (character !== '"') { cursor += 1; continue; }

    const key = jsonString(text, cursor);
    const frame = stack.at(-1);
    let next = key.end;
    while (/\s/.test(text[next] ?? '')) next += 1;
    if (frame?.kind !== 'object' || text[next] !== ':') { cursor = key.end; continue; }
    next += 1;
    while (/\s/.test(text[next] ?? '')) next += 1;
    if (text[next] !== '"') {
      if (key.decoded === 'value') frame.valueAt = next;
      cursor = next;
      continue;
    }

    const value = jsonString(text, next);
    if (key.decoded === 'type' && value.decoded === 'CONCEALED') frame.concealed = true;
    if (key.decoded === 'value') frame.value = value;
    cursor = value.end;
  }
  for (const frame of stack) finish(frame, text.length);
  return found;
}

function concealedJsonDetections(text) {
  const candidate = text.trimStart();
  if (!candidate.includes('"CONCEALED"')) return [];
  let root;
  if ('[{'.includes(candidate[0])) {
    try { root = JSON.parse(candidate); } catch { /* Shell output may surround or truncate the JSON. */ }
  }
  const found = [];
  const pending = root === undefined ? [] : [root];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value) && value.type === 'CONCEALED' && typeof value.value === 'string' && value.value) {
      found.push({ kind: 'op-json-concealed', value: JSON.stringify(value.value).slice(1, -1), secret: value.value });
    }
    pending.push(...(Array.isArray(value) ? value : Object.values(value)));
  }
  return found.length ? found : scannedConcealedDetections(text);
}

/** The pattern kinds, in order. The V34 union property enumerates every one of them. */
export const PATTERN_KINDS = patterns.map(([kind]) => kind);

function keepPatternMatch(kind, match, value, { text, concealed, command, options, allowed }) {
  const duplicatesConcealed = concealed.some((item) => item.value.includes(value) || value.includes(item.value));
  const sourceSyntax = kind === 'assignment' && sourceAssignment(text, match);
  if (kind === 'op-output' && proseOutput(text, match, command, options)) return false;
  return !sourceSyntax && !duplicatesConcealed && !overlaps(match.index, match.index + match[0].length, allowed);
}

// `only` (optional) restricts the scan to those kinds - what one pattern ALONE would mask, which is
// what the union property compares the full scrub against.
// Final lines stay credential-bearing by default; complete tool results opt in explicitly.
export function detections(text, command = '', only, options = {}) {
  if (typeof text !== 'string') return [];
  const selected = only ? new Set(only) : null;
  const allowed = allowedRanges(text, command);
  const concealed = !selected || selected.has('op-json-concealed') ? concealedJsonDetections(text) : [];
  const found = [...concealed, ...(!selected || selected.has('credential-uuid') ? credentialUuidDetections(text) : [])];
  const context = { text, concealed, command, options, allowed };
  for (const [kind, expression] of patterns) {
    if (selected && !selected.has(kind)) continue;
    expression.lastIndex = 0;
    for (let match; (match = expression.exec(text));) {
      const value = capturedValue(match);
      if (keepPatternMatch(kind, match, value, context)) found.push({ kind, value });
    }
  }
  return found;
}

function isIpv6(value) {
  if ((value.match(/::/g) ?? []).length > 1) return false;
  const compressed = value.includes('::');
  const parts = value.split(':').filter(Boolean);
  if (!parts.every((part) => /^[0-9A-Fa-f]{1,4}$/.test(part))) return false;
  return compressed ? parts.length < 8 : parts.length === 8;
}

export function optionalDetections(text, options = {}) {
  if (typeof text !== 'string') return [];
  const found = [];
  if (options.emails) {
    for (const item of emailDetections(text)) found.push(item);
  }
  if (options.ipAddresses) {
    ipv4.lastIndex = 0;
    for (let match; (match = ipv4.exec(text));) found.push({ kind: 'ip-address', value: match[0] });
    ipv6Candidate.lastIndex = 0;
    for (let match; (match = ipv6Candidate.exec(text));) {
      if (isIpv6(match[0])) found.push({ kind: 'ip-address', value: match[0] });
    }
  }
  return found;
}
