// Last-responsible-moment policy: identify raw outbound values without rewriting destinations.
import { detections, optionalDetections } from './detector.js';
import { config } from './config.js';
import { isIssuedToken, knownTokens, replacementFor } from './token-vault.js';
import { boundaryFindings, isContextual, referenceProof } from './value-boundary.js';
import { walkOutbound, inspectionBudget, materializePath, TRUNCATED_PATH } from './outbound-traversal.js';
import { numericEquals } from './decimal-equality.js';
import { base64Utf8, HELD_VALUE_FLOOR, standsAlone } from './diagnostic-values.js';
import { diagnosticSensitiveSet, plainDiagnosticKey, redactDiagnostic } from './diagnostic-redaction.js';
export { base64Utf8, HELD_VALUE_FLOOR } from './diagnostic-values.js';

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
// alone - no letter or digit touching either side: `pin=7342` is refused, a long numeric id such as `187673422687728310` is not.
// Skipping short values altogether let a whole PIN and its base64 leave (critic-xhigh and Astra at 578fd20e).
function withoutReferences(value) { return value.replace(REFERENCE, (reference) => ' '.repeat(reference.length)); }

function pushDetectedFindings(found, value, key, path, options) {
  const candidate = withoutReferences(value);
  const baseDirect = detections(candidate, '', undefined, options);
  if (options.inspectionBudget.exhausted) {
    for (const item of baseDirect) found.push({ ...item, path });
    return;
  }
  // Only exact Route S spellings cancel frozen contextual findings.
  // Independent detector evidence survives; raw-only matches never add findings.
  const direct = baseDirect.filter((item) => !isContextual(item.kind)).map((item) => {
    const start = candidate.indexOf(item.value);
    return start < 0 ? { ...item, path } : { ...item, value: value.slice(start, start + item.value.length), path, index: start };
  });
  for (const item of boundaryFindings(value, options)) direct.push({ ...item, path });
  for (const item of direct) found.push(item);
  for (const item of optionalDetections(candidate, { emails: options.maskEmails, ipAddresses: options.maskIpAddresses })) found.push(item);
  if (key) pushKeyFindings(found, { value, key, path, candidate, baseDirect }, options);
}

function pushKeyFindings(found, { value, key, path, candidate, baseDirect }, options) {
  const detectorOptions = { ...options, prose: false };
  const keyEvidence = detections(key, '', undefined, detectorOptions);
  for (const item of detections(`${key}: ${candidate}`, '', undefined, detectorOptions)) {
    if (baseDirect.some(({ value: directValue }) => directValue === item.value)) continue;
    // A match in the object key is evidence independent of the decoded child.
    const inKey = detections(`${key}: `, '', undefined, detectorOptions).some((entry) => entry.kind === item.kind && entry.value === item.value);
    if (inKey) {
      const origins = keyEvidence.filter((entry) => entry.kind === item.kind);
      if (!origins.length) origins.push({ kind: item.kind, value: key });
      for (const evidence of origins) {
        found.push({ ...evidence, secret: evidence.secret ?? evidence.value, path, index: key.indexOf(evidence.value) });
      }
    } else if (!referenceProof(value, 'decoded')) found.push({ ...item, value, secret: value, path, index: 0 });
  }
}

function pushStringFindings(found, value, key, path, options) {
  pushDetectedFindings(found, value, key, path, options);
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
    if (entry.ephemeral || typeof entry.value !== 'string' || !entry.value) continue;
    const encoded = base64Utf8(entry.value);
    const short = entry.value.length < HELD_VALUE_FLOOR;
    const at = rawOccurrence(entry.value, short);
    if (at >= 0) found.push({ kind: entry.kind, value: entry.value, secret: entry.value, path, index: at });
    const encodedAt = rawOccurrence(encoded, encoded.length < HELD_VALUE_FLOOR);
    if (encodedAt >= 0) found.push({ kind: entry.kind, value: encoded, secret: entry.value, path, index: encodedAt });
  }
}

function findingsIn(value) {
  const budget = inspectionBudget();
  const options = { ...config(), inspectionBudget: budget };
  const found = [];
  for (const unit of walkOutbound(value, budget)) {
    if (unit.kind === 'inspection-budget') {
      found.push({ kind: 'inspection-budget', value: '', secret: '' });
      break;
    }
    consumeUnit(found, unit, options);
    if (budget.exhausted) { found.push({ kind: 'inspection-budget', value: '', secret: '' }); break; }
  }
  return reduceFindings(found);
}

// Presentation deduplication keeps one finding per kind:value, but every raw spelling
// (including a discarded finding's secret) stays in sensitiveValues for redaction.
export function reduceFindings(found) {
  const sensitiveValues = new Set();
  const unique = new Map();
  for (const item of found) {
    sensitiveValues.add(item.value); sensitiveValues.add(item.secret);
    if (item.value || item.kind === 'inspection-budget') unique.set(`${item.kind}:${item.value}`, finishFinding(item));
  }
  return Object.defineProperty([...unique.values()], 'sensitiveValues', { value: sensitiveValues });
}

function consumeUnit(found, unit, options) {
  const { text, key, pathRef } = unit;
  if (unit.kind === 'number') return pushNumericFindings(found, unit);
  if (unit.kind === 'concealed') {
    for (const item of detections(JSON.stringify({ type: 'CONCEALED', value: text }), '', undefined, options)) found.push({ ...item, path: pathRef });
  } else if (unit.kind === 'key') {
    pushStringFindings(found, text, '', pathRef, options);
    // Reference blanking is for values; raw key-alone evidence remains independent.
    for (const item of detections(text, '', undefined, { ...options, prose: false })) found.push({ ...item, path: pathRef, index: text.indexOf(item.value) });
  } else pushStringFindings(found, text, key, pathRef, options);
}

function pushNumericFindings(found, unit) {
  for (const entry of knownTokens().values()) {
    if (entry.ephemeral || !numericEquals(entry.value, unit.number)) continue;
    found.push({ kind: entry.kind, value: entry.value, secret: entry.value, path: unit.pathRef, index: 0 });
  }
}

function finishFinding(item) {
  const ref = item.path;
  const held = heldSource(item);
  delete item.path;
  if (ref !== undefined) Object.defineProperty(item, 'path', { enumerable: true, get: () => materializePath(ref) });
  Object.defineProperties(item, { pathRef: { value: ref }, heldSource: { value: held } });
  return item;
}

function outboundInput(event) {
  const fields = typeof event.tool === 'string' && Object.hasOwn(OUTBOUND_FIELDS, event.tool) ? OUTBOUND_FIELDS[event.tool] : undefined;
  return Object.fromEntries(Object.entries(event).filter(([key]) => fields ? fields.has(key) : !['tool', 'tool_use_id', 'agentId'].includes(key)));
}

// A field name is the caller's text too: an MCP input can use a credential, or a held value, as a KEY. A
// name is printed only when nothing in it would itself be refused; otherwise the refusal says <key>.
function fieldName(path, sensitive) {
  if (!path?.length) return 'input';
  return path.map((key) => key === TRUNCATED_PATH ? '...' : plainDiagnosticKey(String(key), sensitive)).join('.');
}

function heldSource(finding) {
  for (const [token, entry] of knownTokens()) {
    if (entry.ephemeral) continue;
    // replacementFor, never the map key: a token can be spelled like another held value (V52).
    if (finding.value === entry.value) { const safe = replacementFor(token); return { label: `held value ${safe}`, token: safe }; }
    if (finding.value === base64Utf8(entry.value)) { const safe = replacementFor(token); return { label: `base64 of held value ${safe}`, token: safe }; }
  }
  return null;
}

// What matched, where, and how to satisfy it in the same turn - never the value itself. The position is the
// occurrence the classification found, not the first spelling anywhere (which can sit inside an issued token).
export function describeFindings(_event, findings) {
  const sensitive = diagnosticSensitiveSet(findings);
  const descriptions = findings.slice(0, 20).map((finding) => describeFinding(finding, sensitive));
  if (findings.length > 20) descriptions.push(`and ${findings.length - 20} more`);
  return redactDiagnostic(descriptions.join('\n'), findings, sensitive).split('\n');
}

function describeFinding(finding, sensitive) {
  if (finding.kind === 'inspection-budget') return 'input is too large to inspect';
  const path = Object.hasOwn(finding, 'pathRef') ? materializePath(finding.pathRef, 8) : boundedPath(finding.path);
  const field = fieldName(path, sensitive);
  const where = Number.isInteger(finding.index)
    ? `${field} at ${finding.index}, ${finding.value.length} chars` : `${field}, ${finding.value.length} chars`;
  const held = finding.heldSource;
  return held ? `${held.label}: ${where} - replace it with ${held.token}` : `${finding.kind} detector: ${where}`;
}

function boundedPath(path) {
  if (!path || path.length <= 8) return path;
  return [TRUNCATED_PATH, ...path.slice(-8)];
}

export async function classifyOutbound(_host, event) {
  // Own properties only: a tool named `toString` read the inherited method as its surface (Astra at 2618aa81).
  const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
  const surface = event.tool?.startsWith('mcp__') ? 'mcp' : own(SURFACE, event.tool);
  if (!surface) return { surface: null, findings: [] };
  return { surface, findings: findingsIn(outboundInput(event)) };
}
