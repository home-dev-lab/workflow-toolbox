// Last-responsible-moment policy: identify raw outbound values without rewriting destinations.
import { detections, optionalDetections } from './detector.js';
import { config } from './config.js';
import { knownTokens } from './token-vault.js';

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
    return start < 0 ? item : { ...item, value: value.slice(start, start + item.value.length) };
  });
  found.push(...direct, ...optionalDetections(candidate, { emails: options.maskEmails, ipAddresses: options.maskIpAddresses }));
  if (key) {
    for (const item of detections(`${key}: ${candidate}`)) {
      if (!direct.some(({ value: directValue }) => directValue === item.value)) found.push({ ...item, value, secret: value, path });
    }
  }
  // A known value is ignored only where an occurrence lies ENTIRELY inside a token's spelling: a token can
  // contain a vault value (`secret`, a kind name), and flagging it refused the token itself (Astra M7 at
  // f98cf712). An occurrence that straddles a token-shaped run is still raw text and stays flagged
  // (round 13's first version blanked the token and lost the straddling value). Only tokens are exempt -
  // a raw value wrapped in an `op://...`-looking string stays refused (V1).
  // Only a token this vault ISSUED is exempt; a token-shaped string never issued is raw text (Astra at
  // 2618aa81: a Write carrying a known value spelled like a token produced no finding).
  const issued = knownTokens();
  const tokenRanges = [...value.matchAll(/secret:[a-z-]+#[a-f0-9]{6}/g)].filter((match) => issued.has(match[0])).map((match) => [match.index, match.index + match[0].length]);
  const outsideTokens = (needle) => {
    for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + 1)) {
      if (!tokenRanges.some(([from, to]) => at >= from && at + needle.length <= to)) return true;
    }
    return false;
  };
  for (const [, entry] of knownTokens()) {
    const encoded = base64Utf8(entry.value);
    if (entry.value && outsideTokens(entry.value)) found.push({ kind: entry.kind, value: entry.value, secret: entry.value, path });
    if (encoded && outsideTokens(encoded)) found.push({ kind: entry.kind, value: encoded, secret: entry.value, path });
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

export async function classifyOutbound(_host, event) {
  // Own properties only: a tool named `toString` read the inherited method as its surface (Astra at 2618aa81).
  const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
  const surface = event.tool?.startsWith('mcp__') ? 'mcp' : own(SURFACE, event.tool);
  if (!surface) return { surface: null, findings: [] };
  const fields = own(OUTBOUND_FIELDS, event.tool);
  const input = Object.fromEntries(Object.entries(event).filter(([key]) => fields ? fields.has(key) : !['tool', 'tool_use_id', 'agentId'].includes(key)));
  return { surface, findings: findingsIn(input) };
}
