// Fixed literal-message adapter. Atrium treats secret:<kind>#<id> as literal text;
// only this guard's Bash hook rehydrates tokens. Routing fields are never rewritten.
// Scrubbing every occurrence and re-classifying the forwarded event preserves the
// refusal classifier's local guarantee, including held-value base64 forms.
import { config } from './config.js';
import { base64Utf8, classifyOutbound } from './outbound-tools.js';
import { isIssuedToken, knownTokens, knownValueOccurrences } from './token-vault.js';
import { scrubWithVaultOccurrences } from './scrub.js';

const ADAPTERS = new Set(['mcp__plugin_atrium_atrium__speak', 'mcp__atrium__speak']);

function encodedOccurrences(text) {
  const matches = knownValueOccurrences(text);
  for (const [token, entry] of knownTokens()) {
    if (entry.ephemeral || !entry.value) continue;
    const encoded = base64Utf8(entry.value);
    for (let at = text.indexOf(encoded); at >= 0; at = text.indexOf(encoded, at + 1)) {
      matches.push({ from: at, to: at + encoded.length, token, kind: entry.kind });
    }
  }
  return matches;
}

function bodyPass(text) {
  // The substitution set also enables context-sensitive held kinds in this outbound body.
  const substituted = new Set([...knownTokens()].filter(([, entry]) => !entry.ephemeral).map(([token]) => token));
  const first = scrubWithVaultOccurrences(text, '', true, encodedOccurrences, substituted);
  return first;
}

function redactBody(text) {
  let current = text;
  const replacements = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const next = bodyPass(current);
    if (next.value === current) break;
    replacements.push(...(next.replacements ?? []));
    current = next.value;
  }
  return { value: current, replacements };
}

export async function planOwnerChannel(event, classify = classifyOutbound) {
  if (!config().ownerChannelRedaction || !ADAPTERS.has(event.tool)) return null;
  const { text, ...routing } = event;
  const outside = await classify({}, routing);
  if (outside.findings.length) return null;
  const original = await classify({}, event);
  if (!original.findings.length) return null;
  const redacted = typeof text === 'string' ? redactBody(text) : { value: text, replacements: [] };
  const rewritten = redacted.value;
  const forwarded = { ...event, text: rewritten };
  const remaining = await classify({}, forwarded);
  if (remaining.findings.length) return null;
  if (rewritten === text) return null;
  const replacements = redacted.replacements;
  // Issued tokens only: a held value can itself be spelled like a token, and replacing it adds no token-shaped text.
  const issued = (body) => [...body.matchAll(/secret:[a-z-]+#[a-f0-9]{6}/g)].filter((match) => isIssuedToken(match[0])).length;
  const count = issued(rewritten) - issued(text);
  return { forwarded, replacements, count };
}
