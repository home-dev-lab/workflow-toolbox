// Least privilege boundary: resolve explicit references through host capabilities without returning
// values. The allow-list and the refusal decision live in references.js; this module only turns an
// approved plan into shell-safe data bindings.
import { config } from './config.js';
import { opReadArgv, opValueFrom } from './op-resolve.js';
import { planReferences, renderReplacement } from './references.js';
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

// secret:env is DISABLED. Claude Code (measured on 2.1.280) refuses a whole hooks module whose `$.env.get`
// takes a non-literal name, so that the variables a module reads can be listed; an arbitrary
// `secret:env:NAME` cannot honour that, and the guard loaded nothing in any real session while it tried.
// The reference is refused with its reason until a design that declares its names literally exists; the
// host rule is not routed around (no printenv, no other process reading the environment for it).
export const ENV_DISABLED = 'secret:env is disabled: Claude Code only lets a plugin read environment variables it names literally; use secret:file or a 1Password reference';

const refused = (command, reason, extra = {}) => ({ command, count: 0, references: [], substituted: [], invalidReference: true, reason, ...extra });

// A value bash cannot carry unchanged: a NUL byte (a command substitution drops it - Astra at
// ca950a58: `short-13-pass` + NUL reached the output as `short-13-pass`, unmasked) or an unpaired
// UTF-16 surrogate (the encoder replaces it). Binding either would put into the command a value the
// vault does not hold, so the command is refused instead.
const unrepresentable = (value) => value.includes('\0') || !value.isWellFormed();

// The variants bash can produce from a bound value in a substitution: `"$(printf ...)"` and every
// `$( )` remove ALL trailing newlines. Each variant is registered and masked with the value itself
// (Astra H5 at f98cf712: a prefetch of `value\n\n` reached the output as `value`, unmasked).
function substitutionVariants(kind, value) {
  const stripped = value.replace(/\n+$/, '');
  return stripped && stripped !== value ? [tokenize(kind, stripped)] : [];
}

export async function rewriteReferences($, command) {
  const plan = planReferences(command, { tokens: knownTokens() });
  if (!plan.ok) return refused(command, plan.reason);
  const account = config().opAccount;
  const bindings = [];
  const replacements = [];
  // The tokens whose values this rewrite puts into the command: masked in its output whatever their kind.
  const substituted = [];
  let names = 0;
  const bind = (value) => { const bound = binding(names, value); names += 1; bindings.push(bound.source); return bound.name; };
  // Every 1Password value is prefetched ONCE, registered in the vault, and bound into the command as
  // data - the command never reads 1Password itself. Astra H6 at ca950a58: a second read at run time
  // returned a rotated value that no mask knew.
  const prefetched = new Map();
  const opValue = async (ref, refAccount) => {
    const key = `${refAccount}:${ref}`;
    if (!prefetched.has(key)) {
      const resolved = await resolveReference($, ref, refAccount);
      prefetched.set(key, resolved.token ? { token: resolved.token, value: knownTokens().get(resolved.token)?.value } : null);
    }
    return prefetched.get(key);
  };
  const prefetchFailed = () => refused(command, 'a 1Password reference that could not be prefetched', { prefetchFailed: true });
  // Before any prefetch: a disabled form refuses the whole command, and nothing is read for it.
  if (plan.occurrences.some((occurrence) => occurrence.form === 'env')) return refused(command, ENV_DISABLED);
  for (const occurrence of plan.occurrences) {
    let value;
    if (occurrence.form === 'op') {
      const resolved = await opValue(`op://${occurrence.path}`, account);
      if (!resolved) return prefetchFailed();
      value = resolved.value;
      substituted.push(resolved.token);
    } else {
      // Every value WE substitute is bound as data and registered in the vault BEFORE the command
      // runs: a value no detector recognises can only be masked in the output because the vault knows it.
      value = occurrence.form === 'file' ? await fileContent($, occurrence) : knownTokens().get(occurrence.label)?.value;
      if (typeof value !== 'string') return refused(command, 'a reference whose value could not be read');
      if (occurrence.form === 'token') substituted.push(occurrence.label);
      else if (value) substituted.push(tokenize('file', value));
    }
    if (unrepresentable(value)) return refused(command, 'a value holding a NUL byte or an unpaired surrogate, which bash cannot carry unchanged');
    const kind = occurrence.form === 'op' ? 'onepassword' : occurrence.form === 'file' ? 'file' : knownTokens().get(occurrence.label)?.kind ?? 'token';
    if (value) substituted.push(...substitutionVariants(kind, value));
    replacements.push({ start: occurrence.replaceStart, end: occurrence.replaceEnd, value: renderReplacement(occurrence, `\${${bind(value)}}`) });
  }
  // The literal `op read <ref>` form: its `op` word becomes a function that prints the bound value with
  // op read's own output contract - a trailing newline unless -n / --no-newline. Its flags, its
  // redirections and its place in a pipeline or a "$( )" stay exactly as written.
  for (const [index, invocation] of plan.invocations.entries()) {
    // The configured account applies exactly as to a bare reference when the command names none
    // (Astra at 2618aa81: `op read <ref>` prefetched without the configured --account).
    const resolved = await opValue(invocation.ref, invocation.account || account);
    if (!resolved) return prefetchFailed();
    if (unrepresentable(resolved.value)) return refused(command, 'a value holding a NUL byte or an unpaired surrogate, which bash cannot carry unchanged');
    substituted.push(resolved.token, ...substitutionVariants('onepassword', resolved.value));
    const name = bind(resolved.value);
    const printer = `__wt_op_${index}`;
    bindings.push(`${printer}() { printf '${invocation.noNewline ? '%s' : '%s\\n'}' "\${${name}}"; }; `);
    replacements.push({ start: invocation.at, end: invocation.wordEnd, value: printer });
  }
  replacements.sort((left, right) => left.start - right.start);
  let rewritten = command;
  for (const replacement of [...replacements].reverse()) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
  }
  return {
    command: `${bindings.join('')}${rewritten}`,
    count: replacements.length,
    references: [...prefetched.keys()],
    substituted,
    invalidReference: false,
    reason: '',
  };
}
