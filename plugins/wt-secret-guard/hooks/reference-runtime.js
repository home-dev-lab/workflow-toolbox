// Least privilege boundary: resolve explicit references through host capabilities without returning values.
import { config } from './config.js';
import { opReadArgv, opValueFrom } from './op-resolve.js';
import { rewriteOpReferences, quoteForSingleQuotes } from './references.js';
import { substituteTokens, tokenize } from './token-vault.js';

export async function resolveReference($, ref, account = config().opAccount) {
  let result;
  try { result = await $.processRun(opReadArgv(ref, account, config().opBinary)); } catch (error) {
    await $.uiLog(`wt-secret-guard: op resolve failed to start (${String(error?.code ?? error?.message ?? 'unknown').slice(0, 40)})`);
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
      const file = await $.fsRead(path);
      content = typeof file === 'string' ? file : file?.text;
      if (typeof content !== 'string') throw new Error('not text');
      if (lineNumber) { const line = content.split(/\r?\n/)[Number(lineNumber) - 1]; if (line === undefined) throw new Error('line missing'); content = line; }
    } catch { await $.uiLog('wt-secret-guard: file reference unavailable (1 reference)'); continue; }
    tokenize('file', content);
    rewritten += command.slice(cursor, match.index);
    rewritten += `'${quoteForSingleQuotes(content)}'`;
    cursor = match.index + reference.length; count += 1;
  }
  return { command: count ? `${rewritten}${command.slice(cursor)}` : command, count };
}

export async function rewriteReferences($, command) {
  const files = await rewriteFileReferences($, command);
  let rewritten = substituteTokens(files.command);
  let count = files.count + (rewritten === files.command ? 0 : 1);
  rewritten = rewritten.replace(/secret:env:([A-Z][A-Z0-9_]*)\b/g, (_, name) => { count += 1; return `"$${name}"`; });
  const onePassword = rewriteOpReferences(rewritten, config().opAccount);
  return { command: onePassword.command, count: count + onePassword.count, references: onePassword.references };
}
