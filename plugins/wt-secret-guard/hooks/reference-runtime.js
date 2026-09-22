// Least privilege boundary: resolve explicit references through host capabilities without returning values.
import { config } from './config.js';
import { opReadArgv, opValueFrom } from './op-resolve.js';
import { rewriteOpReferences } from './references.js';
import { knownTokens, tokenize } from './token-vault.js';

export async function resolveReference($, ref, account = config().opAccount) {
  let result;
  // Measured 2026-09-08 00:43: a 13-character password matched no pattern, so every
  // explicit reference is prefetched. process.run takes positional argv (run 8).
  try { result = await $.processRun(opReadArgv(ref, account, config().opBinary)); } catch {
    await $.uiLog('wt-secret-guard: op resolve failed to start (1 reference)');
    return { token: null };
  }
  const value = opValueFrom(result);
  if (!value) { await $.uiLog(`wt-secret-guard: op resolve returned nothing (exit ${result?.exitCode ?? 'unknown'})`); return { token: null }; }
  return { token: tokenize('onepassword', value) };
}

function expansionAt(command, index, expression) {
  if (inHeredocBody(command, index)) return expression;
  const quote = quoteAt(command, index);
  const expanded = `"${expression}"`;
  return quote ? `${quote}${expanded}${quote}` : expanded;
}

function inHeredocBody(command, index) {
  const expression = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  for (let match; (match = expression.exec(command));) {
    const bodyStart = command.indexOf('\n', expression.lastIndex);
    if (bodyStart < 0) continue;
    let lineStart = bodyStart + 1;
    while (lineStart <= command.length) {
      const lineEnd = command.indexOf('\n', lineStart);
      const end = lineEnd < 0 ? command.length : lineEnd;
      if (command.slice(lineStart, end).replace(/^\t+/, '') === match[2]) return index >= bodyStart + 1 && index < lineStart;
      if (lineEnd < 0) break;
      lineStart = lineEnd + 1;
    }
  }
  return false;
}

function binding(index, value) {
  const name = `__wt_secret_${index}`;
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return { name, source: `${name}="$(printf '%s' '${encoded}' | base64 --decode; printf .)"; ${name}="${'${'}${name}%.}"; readonly ${name}; ` };
}

async function rewriteFileReferences($, command, bindings) {
  const expression = /secret:file:(\/[^\s"'#)<>&;|]+)(?:#([1-9]\d*))?/g;
  let rewritten = ''; let cursor = 0; let count = 0;
  for (let match; (match = expression.exec(command));) {
    const [reference, path, lineNumber] = match;
    let content;
    try {
      // The Function Hooks filesystem API takes the path positionally.
      const file = await $.fsRead(path);
      content = typeof file === 'string' ? file : file?.text;
      if (typeof content !== 'string') throw new Error('not text');
      if (lineNumber) { const line = content.split(/\r?\n/)[Number(lineNumber) - 1]; if (line === undefined) throw new Error('line missing'); content = line; }
    } catch { await $.uiLog('wt-secret-guard: file reference unavailable (1 reference)'); continue; }
    tokenize('file', content);
    const bound = binding(bindings.length, content); bindings.push(bound.source);
    rewritten += command.slice(cursor, match.index);
    rewritten += expansionAt(command, match.index, `\${${bound.name}}`);
    cursor = match.index + reference.length; count += 1;
  }
  return { command: count ? `${rewritten}${command.slice(cursor)}` : command, count };
}

function quoteAt(command, end) {
  let quote = ''; const substitutions = [];
  for (let index = 0; index < end; index += 1) {
    if (command[index] === '\\' && quote === '"') index += 1;
    else if (command[index] === '$' && command[index + 1] === '(' && quote !== "'") { substitutions.push(quote); quote = ''; index += 1; }
    else if (command[index] === ')' && !quote && substitutions.length) quote = substitutions.pop();
    else if (command[index] === quote) quote = '';
    else if (!quote && (command[index] === "'" || command[index] === '"')) quote = command[index];
  }
  return quote;
}

function bindKnownValues(command, bindings) {
  const occurrences = [];
  for (const [token, entry] of knownTokens()) {
    for (let index = command.indexOf(token); index !== -1; index = command.indexOf(token, index + token.length)) occurrences.push({ index, token, value: entry.value });
  }
  occurrences.sort((left, right) => left.index - right.index);
  let rewritten = ''; let cursor = 0; let count = 0;
  for (const occurrence of occurrences) {
    if (occurrence.index < cursor) continue;
    const bound = binding(bindings.length, occurrence.value); bindings.push(bound.source);
    rewritten += command.slice(cursor, occurrence.index) + expansionAt(command, occurrence.index, `\${${bound.name}}`);
    cursor = occurrence.index + occurrence.token.length; count += 1;
  }
  return { command: count ? rewritten + command.slice(cursor) : command, count };
}

export async function rewriteReferences($, command) {
  const bindings = [];
  const files = await rewriteFileReferences($, command, bindings);
  const bound = bindKnownValues(files.command, bindings);
  let rewritten = bound.command;
  let count = files.count + bound.count;
  rewritten = rewritten.replace(/secret:env:([A-Z][A-Z0-9_]*)\b/g, (reference, name, index) => { count += 1; return expansionAt(rewritten, index, `\${${name}}`); });
  const onePassword = rewriteOpReferences(rewritten, config().opAccount);
  const unresolved = /secret:(?:file|env|1p):|secret:[a-z-]+#[a-f0-9]{6}\b/i.test(onePassword.command);
  return {
    command: `${bindings.join('')}${onePassword.command}`, count: count + onePassword.count, references: onePassword.references,
    invalidReference: onePassword.invalidOpRead || onePassword.unhandled || unresolved,
  };
}
