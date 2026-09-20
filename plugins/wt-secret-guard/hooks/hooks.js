import { detections, entropyCandidates, optionalDetections } from './detector.js';
import { sha256 } from './sha256.js';
import { opReadArgv, opValueFrom } from './op-resolve.js';

// Learn every 1Password value a command will resolve BEFORE it runs (the hook's own process
// capability, value kept in the token map only), so the result scrub replaces it whatever its
// shape. Measured 2026-09-08 00:43: a 13-character password read through the shell rewrite
// matched no known pattern and reached the transcript twice — pattern scrubbing alone cannot
// protect a value the hook never saw.
export async function resolveReference($, ref, account = opAccount) {
  let result;
  try {
    // Positional signature per the generated declarations: run(argv, init?) — an object form is
    // refused with "takes argv" (measured 2026-09-08, run 8).
    result = await $.process.run(opReadArgv(ref, account, opBinary));
  } catch (error) {
    // Counts and kinds only: the failure reason is an errno/exit code, never a value.
    await $.ui.log(`wt-secret-guard: op resolve failed to start (${String(error?.code ?? error?.message ?? 'unknown').slice(0, 40)})`);
    return { token: null };
  }
  const value = opValueFrom(result);
  if (!value) {
    await $.ui.log(`wt-secret-guard: op resolve returned nothing (exit ${result?.exitCode ?? 'unknown'})`);
    return { token: null };
  }
  return { token: tokenFor('onepassword', value) };
}

const tokens = new Map();
let serial = 0;
let pending = [];
let storageFailureNoticed = false;

function tokenFor(kind, value) {
  for (const [token, entry] of tokens) if (entry.value === value) return token;
  serial += 1;
  const suffix = hash(`${serial}:${value}`);
  // Display convention agreed with Frederic (wt-suite #1374, 2026-09-08): `secret:<kind>#<6hex>`.
  const token = `secret:${kind}#${suffix}`;
  tokens.set(token, { kind, value });
  pending.push({ token, kind, value });
  return token;
}

export function tokenize(kind, value) { return tokenFor(kind, value); }

function hash(value) {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  return (state >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

function replaceKnown(text, command, includeOptional) {
  let scrubbed = text;
  for (const [token, entry] of tokens) {
    const optionalEnabled = includeOptional && ((entry.kind === 'email' && maskEmails) || (entry.kind === 'ip-address' && maskIpAddresses));
    if ((entry.kind !== 'email' && entry.kind !== 'ip-address') || optionalEnabled) scrubbed = scrubbed.split(entry.value).join(token);
  }
  const found = [
    ...detections(scrubbed, command),
    ...(includeOptional ? optionalDetections(scrubbed, { emails: maskEmails, ipAddresses: maskIpAddresses }) : []),
  ];
  for (const { kind, value, secret = value } of found) scrubbed = scrubbed.split(value).join(tokenFor(kind, secret));
  return { value: scrubbed, changed: scrubbed !== text, entropy: entropyCandidates(scrubbed) };
}

function scrub(value, command, includeOptional = true) {
  if (typeof value === 'string') return replaceKnown(value, command, includeOptional);
  if (Array.isArray(value)) {
    let changed = false; let entropy = 0;
    const result = value.map((item) => { const next = scrub(item, command, includeOptional); changed ||= next.changed; entropy += next.entropy; return next.value; });
    return { value: result, changed, entropy };
  }
  if (value && typeof value === 'object') {
    let changed = false; let entropy = 0;
    const result = {};
    for (const [key, item] of Object.entries(value)) { const next = scrub(item, command, includeOptional); result[key] = next.value; changed ||= next.changed; entropy += next.entropy; }
    return { value: result, changed, entropy };
  }
  return { value, changed: false, entropy: 0 };
}

function jsonStringRanges(text) {
  const ranges = [];
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '')) cursor += 1; };
  const string = () => {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === '\\') cursor += 2;
      else if (text[cursor++] === '"') return { start: start + 1, end: cursor - 1, value: JSON.parse(text.slice(start, cursor)) };
    }
    throw new Error('unterminated JSON string');
  };
  const value = (path) => {
    whitespace();
    if (text[cursor] === '"') { const range = string(); ranges.push({ ...range, path }); return; }
    if (text[cursor] === '{') {
      cursor += 1; whitespace();
      while (text[cursor] !== '}') {
        const key = string().value; whitespace();
        if (text[cursor++] !== ':') throw new Error('invalid JSON object');
        value([...path, key]); whitespace();
        if (text[cursor] !== ',') break;
        cursor += 1; whitespace();
      }
      if (text[cursor++] !== '}') throw new Error('invalid JSON object');
      return;
    }
    if (text[cursor] === '[') {
      cursor += 1; whitespace(); let index = 0;
      while (text[cursor] !== ']') {
        value([...path, index]); index += 1; whitespace();
        if (text[cursor] !== ',') break;
        cursor += 1; whitespace();
      }
      if (text[cursor++] !== ']') throw new Error('invalid JSON array');
      return;
    }
    const start = cursor;
    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor += 1;
    if (start === cursor) throw new Error('invalid JSON value');
  };
  value([]); whitespace();
  if (cursor !== text.length) throw new Error('trailing JSON content');
  return ranges;
}

function byteLength(value) { return new TextEncoder().encode(value).length; }

function locateReplacements(text, replacements, target) {
  const located = [];
  let lineStart = 0;
  for (const lineWithReturn of text.split('\n')) {
    const line = lineWithReturn.endsWith('\r') ? lineWithReturn.slice(0, -1) : lineWithReturn;
    if (!line) { lineStart += byteLength(lineWithReturn) + 1; continue; }
    const record = JSON.parse(line);
    const queueTarget = target === 'queue' && record.type === 'queue-operation';
    for (const range of jsonStringRanges(line)) {
      const eligible = target === 'history'
        ? range.path[0] === 'display' || range.path[0] === 'pastedContents'
        : queueTarget && range.path[0] === 'content';
      if (!eligible) continue;
      const source = line.slice(range.start, range.end);
      for (const { raw, token } of replacements) {
        const escaped = JSON.stringify(raw).slice(1, -1);
        for (let index = source.indexOf(escaped); index !== -1; index = source.indexOf(escaped, index + escaped.length)) {
          const length = byteLength(escaped);
          const replacement = byteLength(token) <= length ? token.padEnd(length, '*') : '*'.repeat(length);
          located.push({ offset: lineStart + byteLength(line.slice(0, range.start + index)), expected: escaped, replacement, length });
        }
      }
    }
    lineStart += byteLength(lineWithReturn) + 1;
  }
  return located;
}

async function overwriteInPlace($, path, change) {
  const read = await $.process.run(['dd', `if=${path}`, 'bs=1', `skip=${change.offset}`, `count=${change.length}`]);
  if (read?.exitCode !== 0 || read?.stdout !== change.expected) throw new Error('stored bytes changed');
  const write = await $.process.run(['dd', `of=${path}`, 'bs=1', `seek=${change.offset}`, 'conv=notrunc'], { stdin: change.replacement });
  if (write?.exitCode !== 0) throw new Error('in-place overwrite failed');
}

function joinPath(parent, ...parts) {
  return [parent.replace(/[\\/]+$/, ''), ...parts.map((part) => String(part).replace(/^[\\/]+|[\\/]+$/g, ''))].join('/');
}

async function configDir($) {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR');
  if (configured) return configured;
  const home = await $.env.get('HOME');
  if (!home) throw new Error('home unavailable');
  return joinPath(home, '.claude');
}

async function rewriteStoredPrompt($, path, replacements, target) {
  let text;
  try {
    text = await $.fs.read(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || String(error?.message).includes('ENOENT')) return false;
    throw error;
  }
  const changes = locateReplacements(text, replacements, target);
  if (!changes.length) return false;
  for (const change of changes) await overwriteInPlace($, path, change);
  return true;
}

async function scrubPromptStorage($, replacements, signal) {
  try {
    const root = await configDir($);
    const cwd = await $.session.cwd();
    const sessionId = await $.session.id();
    const targets = [
      { path: joinPath(root, 'history.jsonl'), target: 'history' },
      { path: joinPath(root, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${sessionId}.jsonl`), target: 'queue' },
    ];
    let scrubbed = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      for (const { path, target } of targets) scrubbed = await rewriteStoredPrompt($, path, replacements, target) || scrubbed;
      if (attempt < 4) await $.clock.sleep(40, signal ? { signal } : undefined);
    }
    if (!scrubbed) throw new Error('record not found');
  } catch {
    if (!storageFailureNoticed) {
      storageFailureNoticed = true;
      await $.ui.log('wt-secret-guard: could not scrub Claude Code prompt storage; a raw secret may remain in history.');
    }
  }
}

function substituteTokens(command) {
  let rewritten = command;
  for (const [token, entry] of tokens) rewritten = rewritten.split(token).join(entry.value);
  return rewritten;
}

function quoteForSingleQuotes(value) { return value.replace(/'/g, "'\"'\"'"); }

// `op --account` is passed explicitly when the plugin option `opAccount` is set: measured 2026-09-08,
// the OP_ACCOUNT environment variable does not reach op.exe through WSL interop (even with WSLENV),
// while `--account` does; a machine with two 1Password accounts otherwise resolves every reference
// against the CLI's default account and fails on the other one's vaults.
let opAccount = '';
let opBinary = 'op';
let maskEmails = false;
let maskIpAddresses = false;

export function configure(options) {
  opAccount = typeof options?.opAccount === 'string' ? options.opAccount.trim() : '';
  opBinary = typeof options?.opBinary === 'string' && options.opBinary.trim() ? options.opBinary.trim() : 'op';
  maskEmails = options?.maskEmails === true || options?.maskEmails === 'true';
  maskIpAddresses = options?.maskIpAddresses === true || options?.maskIpAddresses === 'true';
}

function opReadCommand(path) {
  const account = opAccount ? ` --account '${quoteForSingleQuotes(opAccount)}'` : '';
  return `"$(op read${account} 'op://${quoteForSingleQuotes(path)}')"`;
}

const OP_PATH = /^[\p{L}\p{N}._' -]+(?:\/[\p{L}\p{N}._' -]+){2,3}$/u;

function quoteContextAt(command, end) {
  let quote = null;
  let opener = -1;
  for (let index = 0; index < end; index += 1) {
    const character = command[index];
    if (character === '\\' && quote === '"') { index += 1; continue; }
    if (character !== "'" && character !== '"') continue;
    if (quote === character) { quote = null; opener = -1; }
    else if (!quote) { quote = character; opener = index; }
  }
  return { quote, opener };
}

function closingQuote(command, start, quote) {
  for (let index = start; index < command.length; index += 1) {
    if (command[index] === '\\' && quote === '"') { index += 1; continue; }
    if (command[index] === quote) return index;
  }
  return -1;
}

function heredocBodies(command) {
  const ranges = [];
  const expression = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  for (let match; (match = expression.exec(command));) {
    const bodyStart = command.indexOf('\n', expression.lastIndex);
    if (bodyStart < 0) continue;
    const delimiter = match[2];
    let lineStart = bodyStart + 1;
    while (lineStart <= command.length) {
      const lineEnd = command.indexOf('\n', lineStart);
      const end = lineEnd < 0 ? command.length : lineEnd;
      if (command.slice(lineStart, end).replace(/^\t+/, '') === delimiter) {
        ranges.push([bodyStart + 1, end]);
        expression.lastIndex = end;
        break;
      }
      if (lineEnd < 0) break;
      lineStart = lineEnd + 1;
    }
  }
  return ranges;
}

function hasTemplateDestination(command) {
  return /(?:>{1,2}|\btee(?:\s+-\w+)*)\s*(?:"[^"\n]*\.tpl"|'[^'\n]*\.tpl'|[^\s;|&]+\.tpl)(?=\s|$|[;|&])/m.test(command)
    || /\bop(?:\.exe)?\s+inject\b/.test(command);
}

function isOpConsumer(command, index) {
  const segment = command.slice(Math.max(command.lastIndexOf(';', index - 1), command.lastIndexOf('\n', index - 1)) + 1, index);
  return /\bop(?:\.exe)?\s+(?:read|inject|run)\b/.test(segment);
}

function rewriteOpReferences(command) {
  if (hasTemplateDestination(command)) return { command, count: 0, references: [] };
  const bodies = heredocBodies(command);
  const prefix = /secret:1p:|op:\/\//g;
  const replacements = [];
  const references = [];
  for (let match; (match = prefix.exec(command));) {
    if (bodies.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const context = quoteContextAt(command, match.index);
    const pathStart = prefix.lastIndex;
    let path;
    let end;
    let replacementStart = match.index;
    let replacementEnd;
    if (context.quote && context.opener + 1 === match.index) {
      end = closingQuote(command, pathStart, context.quote);
      if (end < 0) continue;
      path = command.slice(pathStart, end);
      replacementStart = context.opener;
      replacementEnd = end + 1;
    } else {
      const pathMatch = command.slice(pathStart).match(/^[\p{L}\p{N}._'-]+(?:\/[\p{L}\p{N}._'-]+){2,3}(?!\/)/u);
      if (!pathMatch) continue;
      path = pathMatch[0];
      replacementEnd = pathStart + path.length;
    }
    if (!OP_PATH.test(path)) continue;
    const reference = `op://${path}`;
    if (isOpConsumer(command, match.index)) { references.push(reference); continue; }
    if (context.quote && (context.opener + 1 !== match.index || replacementEnd !== end + 1)) continue;
    replacements.push({ start: replacementStart, end: replacementEnd, value: opReadCommand(path) });
    references.push(reference);
    prefix.lastIndex = replacementEnd;
  }
  let rewritten = command;
  for (const replacement of replacements.reverse()) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
  }
  return { command: rewritten, count: replacements.length, references: [...new Set(references)] };
}

async function rewriteFileReferences($, command) {
  const expression = /secret:file:(\/[^\s"'#]+)(?:#([1-9]\d*))?/g;
  let rewritten = '';
  let cursor = 0;
  let count = 0;
  for (let match; (match = expression.exec(command));) {
    const [reference, path, lineNumber] = match;
    let content;
    try {
      // The Function Hooks filesystem API takes the path positionally.
      const file = await $.fs.read(path);
      content = typeof file === 'string' ? file : file?.text;
      if (typeof content !== 'string') throw new Error('not text');
      if (lineNumber) {
        const line = content.split(/\r?\n/)[Number(lineNumber) - 1];
        if (line === undefined) throw new Error('line missing');
        content = line;
      }
    } catch {
      // A failed read must leave the shell reference intact; do not reveal a path in hook logs.
      await $.ui.log('wt-secret-guard: file reference unavailable (1 reference)');
      continue;
    }
    tokenFor('file', content);
    rewritten += command.slice(cursor, match.index);
    rewritten += `'${quoteForSingleQuotes(content)}'`;
    cursor = match.index + reference.length;
    count += 1;
  }
  return { command: count ? `${rewritten}${command.slice(cursor)}` : command, count };
}

async function rewriteReferences($, command) {
  const files = await rewriteFileReferences($, command);
  let rewritten = substituteTokens(files.command);
  let count = files.count + (rewritten === files.command ? 0 : 1);
  rewritten = rewritten.replace(/secret:env:([A-Z][A-Z0-9_]*)\b/g, (_, name) => { count += 1; return `"$${name}"`; });
  const onePassword = rewriteOpReferences(rewritten);
  return { command: onePassword.command, count: count + onePassword.count, references: onePassword.references };
}

// A model shown `secret:<kind>#<id>` with no explanation reads the token AS the secret and warns the
// person that they shared a live credential (reported by Frederic, wt-suite #2151). Every scrubbed
// result therefore says what the token is.
export const REDACTION_NOTE = '[wt-secret-guard: text of the form secret:<kind>#<id> is a REDACTION TOKEN, not a secret. The real value was removed before it reached you and you have never seen it, so do not warn that a live credential was shared. To USE the value, put the token as-is in a Bash command of this session: the guard substitutes the real value when the command runs and scrubs it again from the output. Nothing else substitutes it: a token written into a file, passed to an MCP tool, or carried to another session stays the literal token, so for those ask the user for a secret:env:NAME or op:// reference instead.]';

function withNotes(result, rewrites, entropy, tokenised = false) {
  if (!result || result.deny || (!rewrites && !entropy && !tokenised)) return result;
  const notes = [];
  if (tokenised) notes.push(REDACTION_NOTE);
  if (rewrites) notes.push(`[wt-secret-guard: rewrote ${rewrites} secret reference${rewrites === 1 ? '' : 's'}]`);
  if (entropy) notes.push(`[wt-secret-guard: ${entropy} candidate${entropy === 1 ? '' : 's'} not tokenised - entropy only]`);
  const text = typeof result.text === 'string' ? `${result.text}\n${notes.join('\n')}` : notes.join('\n');
  return { ...result, text };
}

// The detection table goes to the hook's PERSISTENT STORE, never to a file of our own: measured
// 2026-09-07, `$.fs.writeFile` refuses every `.claude`/`.git`-named directory and resolves `~`
// against the cwd, so no plugin-data path is reachable, while `$.store.set` lands (debug log
// `$.store.set (wt-secret-guard@inline): …`). The store holds tokens, kinds and SALTED SHA-256
// hashes — never a value. A consumer that already holds a value hashes it with the published salt
// and masks on a match; it can never recover a value from the table. Known limit, stated: a
// weak, guessable secret (a short password caught by the `assignment` pattern) is crackable
// offline from its hash by whoever can read the store file, which is the owner's user only.
let salt;

async function ensureSalt($) {
  if (salt) return salt;
  const stored = await $.store.get('salt');
  if (typeof stored === 'string' && stored.length >= 32) { salt = stored; return salt; }
  salt = sha256(`${Date.now()}:${Math.random()}:${Math.random()}`);
  await $.store.set('salt', salt);
  return salt;
}

async function publish($) {
  if (!pending.length) return;
  const added = pending;
  pending = [];
  try {
    const key = await ensureSalt($);
    const entries = [...tokens].map(([token, entry]) => ({ token, kind: entry.kind, sha256: sha256(`${key}:${entry.value}`) }));
    await $.store.set('detections', { version: 1, updatedAt: new Date().toISOString(), entries });
    const stats = await $.store.get('stats') ?? {};
    for (const entry of added) stats[entry.kind] = Number(stats[entry.kind] ?? 0) + 1;
    await $.store.set('stats', stats);
    await $.store.set('lastpublishedat', new Date().toISOString());
  } catch {}
}

async function scrubToolResult($, event, next) {
  const response = await next(event);
  const cleaned = scrub(response, '');
  await publish($);
  if (cleaned.changed) await $.ui.log(`wt-secret-guard: scrubbed ${tokens.size} tokenised value(s)`);
  return withNotes(cleaned.value, 0, cleaned.entropy, cleaned.changed);
}

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  configure(options);
  on('tool.call', { tool: 'Bash' }, async ($, event, next) => {
    const rewrite = await rewriteReferences($, typeof event.command === 'string' ? event.command : '');
    for (const ref of rewrite.references) {
      try { await resolveReference($, ref, opAccount); } catch {}
    }
    const response = await next(rewrite.command === event.command ? event : { ...event, command: rewrite.command });
    const cleaned = scrub(response, rewrite.command);
    await publish($);
    // Only counts and kinds may be logged: hook debug logs can otherwise expose the value.
    if (cleaned.changed) await $.ui.log(`wt-secret-guard: scrubbed ${tokens.size} tokenised value(s)`);
    return withNotes(cleaned.value, rewrite.count, cleaned.entropy, cleaned.changed);
  });
  on('tool.call', { tool: 'Read' }, scrubToolResult);
  on('tool.call', { tool: /^mcp__/ }, scrubToolResult);
  on('prompt.submit', async ($, event, next) => {
    const cleaned = scrub(event, '');
    const replacements = typeof event.text === 'string'
      ? [...tokens].filter(([, entry]) => event.text.includes(entry.value)).map(([token, entry]) => ({ raw: entry.value, token }))
      : [];
    await publish($);
    if (cleaned.changed) await $.ui.log(`wt-secret-guard: scrubbed ${tokens.size} tokenised value(s)`);
    const noted = withNotes(cleaned.value, 0, cleaned.entropy);
    // The explanation travels beside the scrubbed prompt as context the person never sees.
    const result = await next(cleaned.changed ? { ...noted, context: [...(noted.context ?? []), REDACTION_NOTE] } : noted);
    // Core has entered the prompt before next resolves, so a headless queue record can now exist.
    if (cleaned.changed && replacements.length && event.origin?.kind) await scrubPromptStorage($, replacements, next.signal);
    return result;
  });
};

export function testState() { return new Map(tokens); }
