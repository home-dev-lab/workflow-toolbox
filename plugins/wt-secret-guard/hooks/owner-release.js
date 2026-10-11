// Authority is the engine's ingress stamp plus a guard-owned, UI-only confirmation.
// Residual: the host stamps scripted keystrokes into the session's own terminal as
// composer, so a session able to drive its own pane is not stopped by origin alone.
import { isIssuedToken, knownTokens, randomId, releaseRefusalReason, releaseToken, reserveTokenId } from './token-vault.js';
import { OWNER_CHANNEL_ADAPTERS } from './owner-channel.js';
import { base64Utf8 } from './outbound-tools.js';

const confirmations = new Map();
const privateCodes = new Set();
const RELEASE = /^wt-secret-guard release (secret:[a-z-]+#[a-f0-9]{6})(?: ([a-f0-9]{6}))?$/;
const EXPIRY_MS = 5 * 60_000;

export function redactConfirmationCodes(text) {
  expireConfirmations(Date.now());
  let value = text;
  for (const code of privateCodes) value = value.replace(new RegExp(code, 'gi'), '[guard confirmation withheld]');
  return value;
}

function deleteConfirmation(token) {
  const pending = confirmations.get(token);
  if (pending) privateCodes.delete(pending.code);
  confirmations.delete(token);
}

function expireConfirmations(now) {
  for (const [token, pending] of confirmations) if (now >= pending.expires) deleteConfirmation(token);
}

export function releaseGrammarRefusal(event) {
  if (confirmationKeyCollision(event)) return { deny: 'wt-secret-guard refused confirmation-code key collision.' };
  const strings = [...eventStrings(event)];
  const grammar = strings.filter(({ value }) => grammarCount(value));
  return grammar.length && !releaseLineAllowance(event, strings, grammar)
    ? { deny: 'wt-secret-guard refused tool input carrying owner-release grammar.' } : null;
}

// Inspect decoded values AND keys; JSON escaping must not hide control separators.
function* eventStrings(value, body = false, key = false, root = true) {
  if (['string', 'number', 'bigint', 'boolean'].includes(typeof value)) { yield { value: String(value), body, key }; return; }
  if (!value || typeof value !== 'object') return;
  for (const [name, child] of Object.entries(value)) {
    yield { value: name, body: false, key: true };
    yield* eventStrings(child, root && name === 'text', false, false);
  }
}

function grammarCount(text) {
  // Compatibility normalization broadens refusal only, never the literal allowance.
  return [...text.normalize('NFKC').replace(/\p{Cf}/gu, '').matchAll(/wt-secret-guard[\s\p{Z}\u0085]*release/giu)].length;
}

function privateMaterial(strings) {
  return strings.some(({ value }) => redactConfirmationCodes(value) !== value || heldMaterial(value));
}

function heldMaterial(value) {
  return [...knownTokens().values()].some((entry) => !entry.ephemeral && entry.value
    && (value.includes(entry.value) || value.includes(base64Utf8(entry.value))));
}

function releaseLineAllowance(event, strings, grammar) {
  if (!OWNER_CHANNEL_ADAPTERS.has(event.tool) || typeof event.text !== 'string') return false;
  if (grammar.length !== 1 || !grammar[0].body || grammarCount(event.text) !== 1) return false;
  if (privateMaterial(strings)) return false;
  const match = /(?:^|\n)(wt-secret-guard release (secret:[a-z-]+#[a-f0-9]{6}))(?=\r?\n|$)/.exec(event.text);
  if (!match || !isIssuedToken(match[2])) return false;
  // The owner supplies any confirmation separately, even when it is not active here.
  const idStart = match.index + match[0].length - 6;
  const outsideId = event.text.slice(0, idStart) + '[issued token id]' + event.text.slice(idStart + 6);
  return !/\b[a-f0-9]{6}\b/iu.test(outsideId.replace(/\p{Cf}/gu, ''));
}

export function confirmationKeyCollision(value) {
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value).map(redactConfirmationCodes);
  return new Set(keys).size !== keys.length || Object.values(value).some(confirmationKeyCollision);
}

function confirmationCode() {
  let code;
  do { code = randomId(); } while (privateCodes.has(code) || [...knownTokens()].some(([token, entry]) => token.includes(code) || (!entry.ephemeral && (entry.value.includes(code) || code.includes(entry.value)))));
  privateCodes.add(code);
  reserveTokenId(code);
  return code;
}

function showRelease(uiLog, token, now) {
  const reason = releaseRefusalReason(token);
  deleteConfirmation(token);
  if (reason) {
    // Unknown or ambiguous token-shaped text can itself be a held value: do not echo it.
    const entry = knownTokens().get(token);
    const label = entry && isIssuedToken(token) ? `${token} (kind ${entry.kind})` : 'requested entry';
    uiLog(`wt-secret-guard: ${label} is not releasable (${reason}); no protection changed.`);
    return;
  }
  const code = confirmationCode();
  const kind = knownTokens().get(token).kind;
  confirmations.set(token, { code, expires: now + EXPIRY_MS });
  uiLog(`wt-secret-guard: ${token} (kind ${kind}) is releasable. Confirmation stops masking and refusing this value for the rest of this session; it will not be re-held from ordinary text. Within 5 minutes submit wt-secret-guard release ${token} followed by confirmation code: ${code}`);
}

function confirmRelease(uiLog, token, code, now) {
  const pending = confirmations.get(token);
  deleteConfirmation(token);
  if (!pending || now >= pending.expires || code !== pending.code) {
    uiLog('wt-secret-guard: release confirmation is wrong or expired; no protection changed.');
    return null;
  }
  const released = releaseToken(token);
  try { uiLog(released ? 'wt-secret-guard: released one generic value for this session.' : 'wt-secret-guard: release unavailable; no protection changed.'); } catch { /* Publication still records a completed release. */ }
  return released;
}

export function handleOwnerRelease(event, uiLog, now = Date.now()) {
  expireConfirmations(now);
  if (!['composer', 'bridge'].includes(event.origin?.kind)) return { handled: false };
  const match = typeof event.text === 'string' ? event.text.trim().match(RELEASE) : null;
  if (!match) return { handled: false };
  const [, token, code] = match;
  try {
    if (!code) { showRelease(uiLog, token, now); return { handled: true }; }
    return { handled: true, released: confirmRelease(uiLog, token, code, now) };
  } catch {
    deleteConfirmation(token);
    return { handled: true };
  }
}
