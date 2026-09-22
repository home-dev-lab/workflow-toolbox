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
// The bound is per reference AND absolute:
// - CONCURRENCY: a request arriving while a resolution for the same key is in flight joins it rather
//   than spawning its own - forty simultaneous requests are one `op` call. At most IN_FLIGHT_MAX
//   distinct resolutions run at once; a request past that is refused without spawning.
// - SIZE: at most FAILURE_MEMORY_MAX failures are remembered. A key inside its window is never
//   evicted to make room - that would let it spawn early - so while the memory is full a NEW key is
//   refused without spawning instead. Neither path records anything, so neither can grow the map.
// - EXPIRY: entries are recorded in time order (Map insertion order, stamped at recording), so every
//   access drops the expired ones from the FRONT and stops at the first live one - amortised O(1),
//   and nothing expired stays resident past the next access.
const FAILURE_MEMORY_MS = 60_000;
const FAILURE_MEMORY_MAX = 1024;
const IN_FLIGHT_MAX = 16;
const failures = new Map();
const inFlight = new Map();

function expire(now) {
  for (const [key, at] of failures) {
    if (now - at < FAILURE_MEMORY_MS) break;
    failures.delete(key);
  }
}

function rememberFailure(key) {
  failures.delete(key);
  failures.set(key, Date.now());
}

/** Resident sizes, for the bound's own locks. */
export function referenceMemoryStats() {
  return { failures: failures.size, inFlight: inFlight.size };
}

async function resolveOnce($, key, ref, account) {
  let result;
  // Measured 2026-09-08 00:43: a 13-character password matched no pattern, so every
  // explicit reference is prefetched. process.run takes positional argv (run 8).
  try { result = await $.processRun(opReadArgv(ref, account, config().opBinary)); } catch {
    rememberFailure(key);
    await $.uiLog('wt-secret-guard: op resolve failed to start (1 reference)');
    return { token: null };
  }
  const value = opValueFrom(result);
  if (!value) { rememberFailure(key); await $.uiLog(`wt-secret-guard: op resolve returned nothing (exit ${result?.exitCode ?? 'unknown'})`); return { token: null }; }
  return { token: tokenize('onepassword', value) };
}

export async function resolveReference($, ref, account = config().opAccount) {
  const key = `${account}:${ref}`;
  expire(Date.now());
  // Answering from memory stays silent: a log line per attempt would storm exactly like the spawns.
  if (failures.has(key)) return { token: null };
  const pending = inFlight.get(key);
  if (pending) return pending;
  // Every resolution in flight may record one failure, so it counts against the memory NOW: checking
  // the remembered size alone admitted 16 concurrent failures onto 1,023 and reached 1,039 (reviewer
  // at d1814348).
  if (inFlight.size >= IN_FLIGHT_MAX || failures.size + inFlight.size >= FAILURE_MEMORY_MAX) return { token: null };
  const resolution = resolveOnce($, key, ref, account);
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

async function envValue($, name) {
  try {
    const value = await $.envGet?.(name);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

const refused = (command, reason) => ({ command, count: 0, references: [], substituted: [], invalidReference: true, reason });

export async function rewriteReferences($, command) {
  const plan = planReferences(command, { tokens: knownTokens() });
  if (!plan.ok) return refused(command, plan.reason);
  const account = config().opAccount;
  const bindings = [];
  const replacements = [];
  const references = [...plan.invocations];
  // The tokens whose values this rewrite puts into the command: masked in its output whatever their
  // kind (op values join them once the caller has resolved them).
  const substituted = [];
  for (const occurrence of plan.occurrences) {
    let expression;
    if (occurrence.form === 'op') {
      expression = opExpression(occurrence.path, account);
      references.push({ ref: `op://${occurrence.path}`, account });
    } else {
      // Every value WE substitute is bound as data and registered in the vault BEFORE the command
      // runs: a value no detector recognises can only be masked in the output because the vault knows
      // it. An env reference therefore binds the value the guard read from Claude Code's environment
      // (measured 2026-09-22: $.env.get returns an arbitrary variable of the claude process) instead
      // of letting the shell expand a variable the guard never saw.
      const value = occurrence.form === 'file' ? await fileContent($, occurrence)
        : occurrence.form === 'env' ? await envValue($, occurrence.name)
          : knownTokens().get(occurrence.label)?.value;
      if (typeof value !== 'string') return refused(command, occurrence.form === 'env' ? 'an environment reference whose value this guard cannot read' : 'a reference whose value could not be read');
      if (occurrence.form === 'token') substituted.push(occurrence.label);
      else if (value) substituted.push(tokenize(occurrence.form === 'file' ? 'file' : 'environment', value));
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
    substituted,
    invalidReference: false,
    reason: '',
  };
}
