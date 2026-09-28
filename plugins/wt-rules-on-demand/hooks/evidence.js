// Shared with transcript tooling; the Function Hooks host cannot import Node builtins.
import { linearRegex } from './linear-regex.js';

export const SUBJECT_CAP = 16 * 1024;
export const RULE_CAP = 256 * 1024;
export const bounded = (value) => String(value ?? '').slice(0, SUBJECT_CAP);
export function argumentEvidence(input) {
  if (typeof input === 'string') return bounded(input);
  if (!input || typeof input !== 'object') return null;
  // Reserve space for every key and non-string value before allocating the
  // remaining budget to strings (including strings nested in arrays/objects).
  const trim = (value, max) => {
    if (typeof value === 'string') return value.slice(0, max);
    if (Array.isArray(value)) return value.map((item) => trim(item, max));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trim(item, max)]));
    return value;
  };
  let low = 0, high = SUBJECT_CAP;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(trim(input, mid)).length <= SUBJECT_CAP) low = mid;
    else high = mid - 1;
  }
  return bounded(JSON.stringify(trim(input, low)));
}

export function safeRegex(rule, source, flags = '', options = {}) {
  try { return linearRegex(source, flags, options); }
  catch (error) { throw new Error(`${rule}: ${error.message} in ${String(source)}`, { cause: error }); }
}
