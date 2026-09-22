const patterns = [
  ['github-classic', /\bghp_[A-Za-z0-9]{36}\b/g],
  ['github-fine-grained', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/g],
  ['openai-api-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g],
  ['brave-api-key', /(?<![A-Za-z0-9_-])BSA[A-Za-z0-9_-]{28}(?![A-Za-z0-9_-])/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['assignment', /\b(?:password|token|secret)\s*=\s*(?![=])(?:"[^"]+"|'[^']+'|[^\s;,)}"']+)/gi],
  ['op-output', /^\s*(?:password|token|secret|credential)\s*:\s*\S.+$/gim],
  // A QUOTED key with a quoted value: a JSON body or a Python dict - `{"password": "..."}`. No other
  // pattern matches it: `assignment` needs `=` and `op-output` needs an unquoted key at a line start.
  ['key-value', /(["'])(?:password|token|secret)\1\s*:\s*(?:"[^"\n]+"|'[^'\n]+')/gi],
  ['environment-dump', /^\s*(?:\+\s*)?(?:export\s+)?[A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET)\s*=\s*\S.+$/gm],
];

const sha = /\b[a-f0-9]{40}\b/gi;
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const secretToken = /\bsecret:[a-z-]+#[a-f0-9]{6}\b/gi;
const email = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g;
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
  if (/^(?:(?:export|default)\s+)*(?:const|let|var|type|interface|function|class|import)\b/.test(sourceLine)) return true;

  // Inside a call or a literal, the exemption covers a value that is a NAME (`connect(password=pwd)`
  // passes a variable). A QUOTED literal there is exactly what a Python repr or a keyword argument
  // carries - `Config(password='hunter2', user='x')` - and ordinary command output prints it.
  const value = match[0].slice(match[0].indexOf('=') + 1).trim();
  if (/^["']/.test(value)) return false;
  const after = text.slice(match.index + match[0].length, lineEnd < 0 ? text.length : lineEnd);
  return /[({][^({]*$/.test(before) && /^\s*[,)}]/.test(after);
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
    const fragment = text.slice(frame.start, end);
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
    if (text[next] !== '"') { cursor = next; continue; }

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

export function detections(text, command = '') {
  if (typeof text !== 'string') return [];
  const allowed = allowedRanges(text, command);
  const concealed = concealedJsonDetections(text);
  const found = [...concealed, ...credentialUuidDetections(text)];
  for (const [kind, expression] of patterns) {
    expression.lastIndex = 0;
    for (let match; (match = expression.exec(text));) {
      const duplicatesConcealed = concealed.some(({ value }) => value.includes(match[0]) || match[0].includes(value));
      const sourceSyntax = kind === 'assignment' && sourceAssignment(text, match);
      if (!sourceSyntax && !duplicatesConcealed && !overlaps(match.index, match.index + match[0].length, allowed)) found.push({ kind, value: match[0] });
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
    email.lastIndex = 0;
    for (let match; (match = email.exec(text));) found.push({ kind: 'email', value: match[0] });
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

export function entropyCandidates(text) {
  if (typeof text !== 'string') return 0;
  const candidates = text.match(/\b[A-Za-z0-9+/_-]{32,}\b/g) ?? [];
  return candidates.filter((value) => entropy(value) >= 4.2).length;
}

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => {
    const p = count / value.length;
    return sum - p * Math.log2(p);
  }, 0);
}
