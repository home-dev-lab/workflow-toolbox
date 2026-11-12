// This is the only diagnostic sensitivity policy; detection never runs on diagnostic prose.
import { knownTokens } from './token-vault.js';
import { base64Utf8, HELD_VALUE_FLOOR, standsAlone } from './diagnostic-values.js';

export const DIAGNOSTIC_FALLBACK = 'wt-secret-guard refused secret-bearing input.';
const MARKER = '<redacted>';
export const diagnosticWork = { steps: 0, reset() { this.steps = 0; } };

function withoutPadding(value) {
  let end = value.length;
  while (value[end - 1] === '=') end -= 1;
  return value.slice(0, end);
}

function addSpellings(set, value) {
  if (typeof value !== 'string' || !value) return;
  diagnosticWork.steps += value.length;
  const encoded = base64Utf8(value);
  set.add(value);
  set.add(JSON.stringify(value).slice(1, -1));
  set.add(encoded);
  set.add(withoutPadding(encoded));
  set.add(encoded.replace(/\+/g, '-').replace(/\//g, '_'));
  set.add(withoutPadding(encoded.replace(/\+/g, '-').replace(/\//g, '_')));
}

export function diagnosticSensitiveSet(findings) {
  const values = new Set(findings.sensitiveValues);
  for (const item of findings) { values.add(item.value); values.add(item.secret); }
  for (const entry of knownTokens().values()) if (!entry.ephemeral) values.add(entry.value);
  const set = new Set();
  for (const value of values) addSpellings(set, value);
  return set;
}

const eligible = (text, at, needle) => needle.length >= HELD_VALUE_FLOOR || standsAlone(text, at, needle.length);

function* occurrences(text, needle) {
  diagnosticWork.steps += text.length + 1;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    diagnosticWork.steps += 1;
    if (eligible(text, at, needle)) yield at;
  }
}

export function containsSensitive(text, set) {
  for (const needle of set) if (!occurrences(text, needle).next().done) return true;
  return false;
}

function maskSpans(text, set) {
  const edges = new Int32Array(text.length + 1);
  for (const needle of set) for (const at of occurrences(text, needle)) {
    edges[at] += 1; edges[at + needle.length] -= 1;
  }
  const parts = [];
  let active = 0;
  let start = 0;
  for (let at = 0; at <= text.length; at += 1) {
    const previous = active;
    active += edges[at]; diagnosticWork.steps += 1;
    if (!previous && active) { parts.push(text.slice(start, at), MARKER); }
    if (previous && !active) start = at;
  }
  parts.push(text.slice(start));
  return parts.join('');
}

export function redactDiagnostic(text, findings, set = diagnosticSensitiveSet(findings)) {
  const masked = maskSpans(text, set);
  if (!containsSensitive(masked, set)) return masked;
  return containsSensitive(DIAGNOSTIC_FALLBACK, set) ? '' : DIAGNOSTIC_FALLBACK;
}

export function plainDiagnosticKey(key, set) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) return '<key>';
  // Keys are <=64 code units: look up substrings rather than re-scan the vault for every key.
  for (let start = 0; start < key.length; start += 1) {
    for (let end = start + 1; end <= key.length; end += 1) if (set.has(key.slice(start, end))) return '<key>';
  }
  return key;
}
