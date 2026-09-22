// Least privilege boundary: resolve explicit references through host capabilities without returning
// values. The allow-list and the refusal decision live in references.js; this module only turns an
// approved plan into shell-safe data bindings.
import { config } from './config.js';
import { opReadArgv, opValueFrom } from './op-resolve.js';
import { opExpression, planReferences, renderReplacement } from './references.js';
import { knownTokens, tokenize } from './token-vault.js';

// A FAILED prefetch is remembered for a short window, keyed by account and reference.
// Measured 2026-09-22 in a real session: ONE Bash command carrying ONE reference produced 42,716
// `op read` spawns in about 100 seconds. This module resolves each reference exactly once per call,
// so whatever re-entered that call sits above it - which is why the bound lives here, where it holds
// whatever the caller does. Only failures are remembered: a value that resolved once may have
// rotated since, and binding a stale secret into a command is worse than spawning `op` again.
//
// The bound is per reference and unconditional within the window:
// - CONCURRENCY: a request arriving while a resolution for the same key is in flight joins it rather
//   than spawning its own - forty simultaneous requests are one `op` call;
// - EVICTION: only EXPIRED entries are ever removed. A key inside its window is never dropped to make
//   room, so no amount of other failures lets it spawn early. The map is swept of expired entries
//   once it passes FAILURE_SWEEP_AT, which bounds memory by the failure RATE times the window.
const FAILURE_MEMORY_MS = 60_000;
const FAILURE_SWEEP_AT = 256;
const failures = new Map();
const inFlight = new Map();

function rememberedFailure(key, now) {
  const at = failures.get(key);
  if (at === undefined) return false;
  if (now - at < FAILURE_MEMORY_MS) return true;
  failures.delete(key);
  return false;
}

function rememberFailure(key, now) {
  if (failures.size >= FAILURE_SWEEP_AT) {
    for (const [other, at] of failures) if (now - at >= FAILURE_MEMORY_MS) failures.delete(other);
  }
  failures.set(key, now);
}

async function resolveOnce($, key, ref, account, now) {
  let result;
  // Measured 2026-09-08 00:43: a 13-character password matched no pattern, so every
  // explicit reference is prefetched. process.run takes positional argv (run 8).
  try { result = await $.processRun(opReadArgv(ref, account, config().opBinary)); } catch {
    rememberFailure(key, now);
    await $.uiLog('wt-secret-guard: op resolve failed to start (1 reference)');
    return { token: null };
  }
  const value = opValueFrom(result);
  if (!value) { rememberFailure(key, now); await $.uiLog(`wt-secret-guard: op resolve returned nothing (exit ${result?.exitCode ?? 'unknown'})`); return { token: null }; }
  return { token: tokenize('onepassword', value) };
}

export async function resolveReference($, ref, account = config().opAccount) {
  const key = `${account}:${ref}`;
  const now = Date.now();
  // Answering from memory stays silent: a log line per attempt would storm exactly like the spawns.
  if (rememberedFailure(key, now)) return { token: null };
  const pending = inFlight.get(key);
  if (pending) return pending;
  const resolution = resolveOnce($, key, ref, account, now);
  inFlight.set(key, resolution);
  try { return await resolution; } finally { inFlight.delete(key); }
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
