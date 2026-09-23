// Functional core: recursively mask values without performing host I/O.
import { detections, entropyCandidates, optionalDetections } from './detector.js';
import { config } from './config.js';
import { isIssuedToken, knownTokens, tokenize } from './token-vault.js';

const GENERIC_KINDS = new Set(['assignment', 'op-output', 'key-value', 'environment-dump']);

function occurrences(text, value) {
  const spans = [];
  if (!value) return spans;
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) spans.push([at, at + value.length]);
  return spans;
}

// Every span to mask is collected from the ORIGINAL text first - known vault values, values this
// command was given by the guard, and every detection - and overlapping spans are MERGED before any
// replacement. Replacing one match at a time let an earlier replacement break a later, larger match:
// round 8's quoted key-value mask made a whole-line environment dump no longer occur verbatim, and the
// rest of that line leaked (reviewer at d1814348). A union can only mask more than any of its parts.
//
// `substituted` holds the tokens whose values the guard itself put into the command being scrubbed.
// Such a value is masked in that output whatever its kind: a credential UUID or an address is kept
// out of unconditional masking because it is ordinary elsewhere, never in the output of a command the
// guard handed it to.
function replaceKnown(text, command, includeOptional, substituted) {
  const options = config();
  const spans = [];
  for (const [token, entry] of knownTokens()) {
    const optionalEnabled = includeOptional && ((entry.kind === 'email' && options.maskEmails) || (entry.kind === 'ip-address' && options.maskIpAddresses));
    const contextSensitive = entry.kind === 'credential-uuid';
    const unconditional = !contextSensitive && ((entry.kind !== 'email' && entry.kind !== 'ip-address') || optionalEnabled);
    if (!unconditional && !substituted.has(token)) continue;
    for (const [from, to] of occurrences(text, entry.value)) spans.push({ from, to, token });
  }
  const found = [
    ...detections(text, command),
    ...(includeOptional ? optionalDetections(text, { emails: options.maskEmails, ipAddresses: options.maskIpAddresses }) : []),
  ];
  for (const detection of found) for (const [from, to] of occurrences(text, detection.value)) spans.push({ from, to, detection });
  // A token already in the text is never scrubbed again, whatever value lies inside its spelling:
  // re-tokenising it made it impossible to rehydrate (Astra M7 at f98cf712 - a vault value `secret`
  // turned `secret:environment#a64479` into `secret:environment#a64479:environment#a64479`).
  // Only the token itself is exempt: a span overlapping a token and extending past it is CLIPPED to
  // the text outside the token, never dropped whole - dropping it released that outside text (round 13's
  // first version leaked a complete known value that way through the c264f237 stream module, V6).
  // Only a token this vault ISSUED is exempt: a token-SHAPED string never issued is ordinary text, masked
  // when it is a known value (Astra at 2618aa81: an environment value spelled `secret:environment#abcdef`
  // reached the output unmasked because its shape alone exempted it).
  // isIssuedToken also refuses a spelling that a held value shares (verify13 finding 1).
  const tokenRanges = [...text.matchAll(/secret:[a-z-]+#[a-f0-9]{6}/g)].filter((match) => isIssuedToken(match[0])).map((match) => [match.index, match.index + match[0].length]);
  for (let at = spans.length - 1; at >= 0; at -= 1) {
    const span = spans[at];
    const inside = tokenRanges.filter(([from, to]) => span.from < to && span.to > from);
    if (!inside.length) continue;
    const pieces = [];
    let from = span.from;
    for (const [tokenFrom, tokenTo] of inside) { if (tokenFrom > from) pieces.push([from, tokenFrom]); from = Math.max(from, tokenTo); }
    if (from < span.to) pieces.push([from, span.to]);
    const kind = span.detection?.kind ?? knownTokens().get(span.token)?.kind ?? 'merged';
    spans.splice(at, 1, ...pieces.map(([pieceFrom, pieceTo]) => ({ from: pieceFrom, to: pieceTo, detection: { kind, value: text.slice(pieceFrom, pieceTo) } })));
  }
  if (!spans.length) return { value: text, changed: false, entropy: entropyCandidates(text) };
  spans.sort((left, right) => left.from - right.from || right.to - left.to);
  const groups = [];
  for (const span of spans) {
    const last = groups.at(-1);
    if (last && span.from < last.to) { last.to = Math.max(last.to, span.to); last.parts.push(span); } else groups.push({ from: span.from, to: span.to, parts: [span] });
  }
  const tokenFor = (part) => part.token ?? tokenize(part.detection.kind, part.detection.secret ?? part.detection.value);
  let scrubbed = '';
  let cursor = 0;
  for (const group of groups) {
    // A merged group is named after its most specific part: a vendor shape inside an environment dump
    // stays a `brave-api-key`, not a generic dump.
    const kindOf = (part) => part.detection?.kind ?? knownTokens().get(part.token)?.kind ?? 'merged';
    const named = group.parts.find((part) => part.detection && !GENERIC_KINDS.has(part.detection.kind)) ?? group.parts.find((part) => part.detection) ?? group.parts[0];
    const kind = kindOf(named);
    const reuse = group.parts.find((part) => part.from === group.from && part.to === group.to && kindOf(part) === kind);
    scrubbed += text.slice(cursor, group.from) + (reuse ? tokenFor(reuse) : tokenize(kind, text.slice(group.from, group.to)));
    cursor = group.to;
    // Every detection stays registered, as before: its value is masked wherever it appears next. After
    // the group's own token, so a part with the same value as the whole does not name the group.
    for (const part of group.parts) if (part.detection) tokenFor(part);
  }
  scrubbed += text.slice(cursor);
  return { value: scrubbed, changed: scrubbed !== text, entropy: entropyCandidates(scrubbed) };
}

export function scrub(value, command, includeOptional = true, substituted = new Set()) {
  if (typeof value === 'string') return replaceKnown(value, command, includeOptional, substituted);
  if (Array.isArray(value)) {
    let changed = false; let entropy = 0;
    const result = value.map((item) => { const next = scrub(item, command, includeOptional, substituted); changed ||= next.changed; entropy += next.entropy; return next.value; });
    return { value: result, changed, entropy };
  }
  if (value && typeof value === 'object') {
    let changed = false; let entropy = 0;
    const result = {};
    // defineProperty, not assignment: `result['__proto__'] = …` sets the prototype and drops the field.
    for (const [key, item] of Object.entries(value)) { const next = scrub(item, command, includeOptional, substituted); Object.defineProperty(result, key, { value: next.value, enumerable: true, writable: true, configurable: true }); changed ||= next.changed; entropy += next.entropy; }
    return { value: result, changed, entropy };
  }
  return { value, changed: false, entropy: 0 };
}
