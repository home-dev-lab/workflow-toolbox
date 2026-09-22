// Least privilege boundary: resolve explicit references through host capabilities without returning
// values. The allow-list and the refusal decision live in references.js; this module only turns an
// approved plan into shell-safe data bindings.
import { config } from './config.js';
import { opReadArgv, opValueFrom } from './op-resolve.js';
import { opExpression, planReferences, renderReplacement } from './references.js';
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

function binding(index, value) {
  const name = `__wt_secret_${index}`;
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return { name, source: `${name}="$(printf '%s' '${encoded}' | base64 --decode; printf .)"; ${name}="${'${'}${name}%.}"; readonly ${name}; ` };
}

async function fileContent($, occurrence) {
  try {
    // The Function Hooks filesystem API takes the path positionally.
    const file = await $.fsRead(occurrence.path);
    const content = typeof file === 'string' ? file : file?.text;
    if (typeof content !== 'string') throw new Error('not text');
    if (!occurrence.line) return content;
    const line = content.split(/\r?\n/)[occurrence.line - 1];
    if (line === undefined) throw new Error('line missing');
    return line;
  } catch {
    await $.uiLog('wt-secret-guard: file reference unavailable (1 reference)');
    return null;
  }
}

const refused = (command, reason) => ({ command, count: 0, references: [], invalidReference: true, reason });

export async function rewriteReferences($, command) {
  const plan = planReferences(command, { tokens: knownTokens() });
  if (!plan.ok) return refused(command, plan.reason);
  const account = config().opAccount;
  const bindings = [];
  const replacements = [];
  const references = [...plan.invocations];
  for (const occurrence of plan.occurrences) {
    let expression;
    if (occurrence.form === 'op') {
      expression = opExpression(occurrence.path, account);
      references.push({ ref: `op://${occurrence.path}`, account });
    } else if (occurrence.form === 'env') {
      expression = `\${${occurrence.name}}`;
    } else {
      const value = occurrence.form === 'file' ? await fileContent($, occurrence) : knownTokens().get(occurrence.label)?.value;
      if (typeof value !== 'string') return refused(command, 'a reference whose value could not be read');
      if (occurrence.form === 'file') tokenize('file', value);
      const bound = binding(bindings.length, value);
      bindings.push(bound.source);
      expression = `\${${bound.name}}`;
    }
    replacements.push({ start: occurrence.replaceStart, end: occurrence.replaceEnd, value: renderReplacement(occurrence, expression) });
  }
  let rewritten = command;
  for (const replacement of [...replacements].reverse()) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
  }
  const unique = new Map(references.map((item) => [`${item.account}:${item.ref}`, item]));
  return {
    command: `${bindings.join('')}${rewritten}`,
    count: replacements.length,
    references: [...unique.values()],
    invalidReference: false,
    reason: '',
  };
}
