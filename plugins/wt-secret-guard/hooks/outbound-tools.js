// Last-responsible-moment policy: identify raw outbound values without rewriting destinations.
import { detections, optionalDetections } from './detector.js';
import { config } from './config.js';
import { isIssuedToken, knownTokens, replacementFor } from './token-vault.js';

const REFERENCE = /(?:op:\/\/[^\s"']+|secret:(?:env|file|1p):[^\s"']+|\$\{[A-Za-z_][A-Za-z0-9_]*\}|secret:[a-z-]+#[a-f0-9]{6})/gi;
const SURFACE = {
  Bash: 'bash', Write: 'write', Edit: 'edit', NotebookEdit: 'notebook-edit',
  WebFetch: 'web-fetch', WebSearch: 'web-search', Agent: 'agent', Task: 'task',
};
const OUTBOUND_FIELDS = {
  Edit: new Set(['new_string']),
  Write: new Set(['content']),
  NotebookEdit: new Set(['new_source']),
  WebFetch: new Set(['url', 'prompt']),
  WebSearch: new Set(['query']),
  Agent: new Set(['prompt']),
  Task: new Set(['prompt']),
};

// A held value shorter than this also occurs by chance INSIDE ordinary identifiers: measured on fixtures (5,000
// random values per length against card ids, issue keys, channel ids and prose), 4 digits matched 6% of the
// time and 5 digits 0.7%, 6 characters of any class never. So a short held value counts only where it stands
// alone - no letter or digit touching either side: `pin=7342` is refused, card `1876734226877283108` is not.
// Skipping short values altogether let a whole PIN and its base64 leave (critic-xhigh and Astra at 578fd20e).
export const HELD_VALUE_FLOOR = 6;
const ALNUM = /[A-Za-z0-9]/;
const standsAlone = (text, at, length) => !ALNUM.test(text[at - 1] ?? '') && !ALNUM.test(text[at + length] ?? '');

function withoutReferences(value) { return value.replace(REFERENCE, (reference) => ' '.repeat(reference.length)); }
function base64Utf8(value) {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pushStringFindings(found, value, key, path, options) {
  const candidate = withoutReferences(value);
  const direct = detections(candidate).map((item) => {
    const start = candidate.indexOf(item.value);
    return start < 0 ? { ...item, path } : { ...item, value: value.slice(start, start + item.value.length), path, index: start };
  });
  found.push(...direct, ...optionalDetections(candidate, { emails: options.maskEmails, ipAddresses: options.maskIpAddresses }));
  if (key) {
    for (const item of detections(`${key}: ${candidate}`)) {
      if (!direct.some(({ value: directValue }) => directValue === item.value)) found.push({ ...item, value, secret: value, path, index: 0 });
    }
  }
  // A known value is ignored only where an occurrence lies ENTIRELY inside a token's spelling: a token can
  // contain a vault value (`secret`, a kind name), and flagging it refused the token itself (Astra M7 at
  // f98cf712). An occurrence that straddles a token-shaped run is still raw text and stays flagged
  // (round 13's first version blanked the token and lost the straddling value). Only tokens are exempt -
  // a raw value wrapped in an `op://...`-looking string stays refused (V1).
  // Only a token this vault ISSUED is exempt; a token-shaped string never issued is raw text (Astra at
  // 2618aa81: a Write carrying a known value spelled like a token produced no finding).
  // isIssuedToken also refuses a spelling that a held value shares (verify13 finding 1).
  const tokenRanges = [...value.matchAll(/secret:[a-z-]+#[a-f0-9]{6}/g)].filter((match) => isIssuedToken(match[0])).map((match) => [match.index, match.index + match[0].length]);
  // The first raw occurrence: outside every issued token and, for a short value, standing alone.
  const rawOccurrence = (needle, alone) => {
    for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + 1)) {
      if (tokenRanges.some(([from, to]) => at >= from && at + needle.length <= to)) continue;
      if (!alone || standsAlone(value, at, needle.length)) return at;
    }
    return -1;
  };
  for (const [, entry] of knownTokens()) {
    if (typeof entry.value !== 'string' || !entry.value) continue;
    const encoded = base64Utf8(entry.value);
    const short = entry.value.length < HELD_VALUE_FLOOR;
    const at = rawOccurrence(entry.value, short);
    if (at >= 0) found.push({ kind: entry.kind, value: entry.value, secret: entry.value, path, index: at });
    const encodedAt = rawOccurrence(encoded, encoded.length < HELD_VALUE_FLOOR);
    if (encodedAt >= 0) found.push({ kind: entry.kind, value: encoded, secret: entry.value, path, index: encodedAt });
  }
}

function findingsIn(value) {
  const options = config();
  const found = [];
  if (typeof value === 'string') pushStringFindings(found, value, '', [], options);
  const pending = value && typeof value === 'object' ? [{ value, path: [] }] : [];
  while (pending.length) {
    const item = pending.pop();
    for (const [key, child] of Object.entries(item.value)) {
      const path = [...item.path, key];
      if (child && typeof child === 'object') pending.push({ value: child, path });
      else if (typeof child === 'string') pushStringFindings(found, child, key, path, options);
    }
  }
  const unique = new Map(found.filter(({ value: detected }) => detected).map((item) => [`${item.kind}:${item.value}`, item]));
  return [...unique.values()];
}

function outboundInput(event) {
  const fields = typeof event.tool === 'string' && Object.hasOwn(OUTBOUND_FIELDS, event.tool) ? OUTBOUND_FIELDS[event.tool] : undefined;
  return Object.fromEntries(Object.entries(event).filter(([key]) => fields ? fields.has(key) : !['tool', 'tool_use_id', 'agentId'].includes(key)));
}

// A field name is the caller's text too: an MCP input can use a credential, or a held value, as a KEY. A
// name is printed only when nothing in it would itself be refused; otherwise the refusal says <key>.
function fieldName(path) {
  if (!path?.length) return 'input';
  return path.map((key) => {
    const found = [];
    pushStringFindings(found, String(key), '', [], config());
    return found.length ? '<key>' : String(key);
  }).join('.');
}

function heldSource(finding) {
  for (const [token, entry] of knownTokens()) {
    // replacementFor, never the map key: a token can be spelled like another held value (V52).
    if (finding.value === entry.value) { const safe = replacementFor(token); return { label: `held value ${safe}`, token: safe }; }
    if (finding.value === base64Utf8(entry.value)) { const safe = replacementFor(token); return { label: `base64 of held value ${safe}`, token: safe }; }
  }
  return null;
}

// What matched, where, and how to satisfy it in the same turn - never the value itself. The position is the
// occurrence the classification found, not the first spelling anywhere (which can sit inside an issued token).
export function describeFindings(_event, findings) {
  return findings.map((finding) => {
    const where = Number.isInteger(finding.index)
      ? `${fieldName(finding.path)} at ${finding.index}, ${finding.value.length} chars`
      : `${fieldName(finding.path)}, ${finding.value.length} chars`;
    const held = heldSource(finding);
    return held ? `${held.label}: ${where} - replace it with ${held.token}` : `${finding.kind} detector: ${where}`;
  });
}

export async function classifyOutbound(_host, event) {
  // Own properties only: a tool named `toString` read the inherited method as its surface (Astra at 2618aa81).
  const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
  const surface = event.tool?.startsWith('mcp__') ? 'mcp' : own(SURFACE, event.tool);
  if (!surface) return { surface: null, findings: [] };
  return { surface, findings: findingsIn(outboundInput(event)) };
}
