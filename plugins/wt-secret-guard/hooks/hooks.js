import { detections, entropyCandidates } from './detector.js';
import { sha256 } from './sha256.js';
import { opReadArgv, opReferencesIn, opValueFrom } from './op-resolve.js';

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

function replaceKnown(text, command) {
  let scrubbed = text;
  for (const [token, entry] of tokens) scrubbed = scrubbed.split(entry.value).join(token);
  const found = detections(scrubbed, command);
  for (const { kind, value } of found) scrubbed = scrubbed.split(value).join(tokenFor(kind, value));
  return { value: scrubbed, changed: scrubbed !== text, entropy: entropyCandidates(scrubbed) };
}

function scrub(value, command) {
  if (typeof value === 'string') return replaceKnown(value, command);
  if (Array.isArray(value)) {
    let changed = false; let entropy = 0;
    const result = value.map((item) => { const next = scrub(item, command); changed ||= next.changed; entropy += next.entropy; return next.value; });
    return { value: result, changed, entropy };
  }
  if (value && typeof value === 'object') {
    let changed = false; let entropy = 0;
    const result = {};
    for (const [key, item] of Object.entries(value)) { const next = scrub(item, command); result[key] = next.value; changed ||= next.changed; entropy += next.entropy; }
    return { value: result, changed, entropy };
  }
  return { value, changed: false, entropy: 0 };
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

export function configure(options) {
  opAccount = typeof options?.opAccount === 'string' ? options.opAccount.trim() : '';
  opBinary = typeof options?.opBinary === 'string' && options.opBinary.trim() ? options.opBinary.trim() : 'op';
}

function opReadCommand(path) {
  const account = opAccount ? ` --account '${quoteForSingleQuotes(opAccount)}'` : '';
  return `"$(op read${account} 'op://${quoteForSingleQuotes(path)}')"`;
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
      // POSITIONAL, like $.process.run: the binary's capability shim reads `readFile:(t)=>e("fs.readFile",{path:t})`
      // (run.log of the 2026-09-08 lane), so an object argument would be sent as {path:{path}} and fail.
      const file = await $.fs.readFile(path);
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
  rewritten = rewritten.replace(/(?:secret:1p:|op:\/\/)([^\s"]+)/g, (reference, path) => {
    count += 1;
    return opReadCommand(path);
  });
  return { command: rewritten, count };
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
    for (const ref of opReferencesIn(event.command)) {
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
    await publish($);
    if (cleaned.changed) await $.ui.log(`wt-secret-guard: scrubbed ${tokens.size} tokenised value(s)`);
    const noted = withNotes(cleaned.value, 0, cleaned.entropy);
    // The prompt text stays as typed; the explanation travels beside it as context the person never sees.
    return next(cleaned.changed ? { ...noted, context: [...(noted.context ?? []), REDACTION_NOTE] } : noted);
  });
};

export function testState() { return new Map(tokens); }
