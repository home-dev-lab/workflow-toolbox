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

async function rewriteFileReferences($, command) {
  const expression = /secret:file:(\/[^\s"'#]+)(?:#([1-9]\d*))?/g;
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
    rewritten += command.slice(cursor, match.index);
    rewritten += dataExpression(content);
    cursor = match.index + reference.length; count += 1;
  }
  return { command: count ? `${rewritten}${command.slice(cursor)}` : command, count };
}

function dataExpression(value) {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return `"$(printf '%s' '${encoded}' | base64 --decode)"`;
}

function bindKnownValues(command) {
  let rewritten = command; let count = 0;
  for (const [token, entry] of knownTokens()) {
    if (!rewritten.includes(token)) continue;
    rewritten = rewritten.split(token).join(dataExpression(entry.value)); count += 1;
  }
  return { command: rewritten, count };
}

export async function rewriteReferences($, command) {
  const files = await rewriteFileReferences($, command);
  const bound = bindKnownValues(files.command);
  let rewritten = bound.command;
  let count = files.count + bound.count;
  rewritten = rewritten.replace(/secret:env:([A-Z][A-Z0-9_]*)\b/g, (_, name) => { count += 1; return `"$${name}"`; });
  const onePassword = rewriteOpReferences(rewritten, config().opAccount);
  return { command: onePassword.command, count: count + onePassword.count, references: onePassword.references };
}
