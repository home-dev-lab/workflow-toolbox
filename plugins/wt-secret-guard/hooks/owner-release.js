// Authority is the engine's ingress stamp plus a guard-owned, UI-only confirmation.
// Residual: the host stamps scripted keystrokes into the session's own terminal as
// composer, so a session able to drive its own pane is not stopped by origin alone.
import { isIssuedToken, knownTokens, randomId, releaseRefusalReason, releaseToken, reserveTokenId } from './token-vault.js';
import { OWNER_CHANNEL_ADAPTERS } from './owner-channel.js';
import { base64Utf8 } from './outbound-tools.js';
import { INSPECTION_NODES, INSPECTION_TEXT } from './outbound-traversal.js';

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
  if (strings.some((item) => item.budget)) return { deny: 'wt-secret-guard refused input that is too large to inspect.' };
  if (strings.some(({ value }) => redactConfirmationCodes(value) !== value)) {
    return { deny: 'wt-secret-guard refused tool input carrying an active confirmation code.' };
  }
  const grammar = strings.filter(({ value }) => grammarCount(value));
  return grammar.length && !releaseLineAllowance(event, strings, grammar)
    ? { deny: 'wt-secret-guard refused tool input carrying owner-release grammar.' } : null;
}

// Inspect decoded values AND keys; JSON escaping must not hide control separators.
const SCALAR_TYPES = new Set(['string', 'number', 'bigint', 'boolean']);

function* eventStrings(event) {
  yield* placedStrings(event, { body: false, hostTool: false }, true);
}

// A root `text` value is the body; a root `tool` value is the host's tool name.
function rootPlace(root, name) {
  return { body: root && name === 'text', hostTool: root && name === 'tool' };
}

const hasObjectValue = (item) => item.value && typeof item.value === 'object';

function* placedStrings(value, place, root) {
  const stack = [{ value, place, root }];
  let nodes = 0;
  let text = 0;
  while (stack.length) {
    const item = stack.pop();
    if (item.entries) {
      if (item.cursor < item.entries.length) placeChild(stack, item);
      continue;
    }
    if (!item.place.key) nodes += 1;
    if (SCALAR_TYPES.has(typeof item.value)) {
      const scalar = String(item.value); text += scalar.length;
      if (text <= INSPECTION_TEXT) yield { value: scalar, key: false, ...item.place };
    } else if (hasObjectValue(item)) {
      stack.push({ entries: Object.entries(item.value), cursor: 0, root: item.root });
    }
    if (nodes > INSPECTION_NODES || text > INSPECTION_TEXT) { yield { value: '', budget: true }; return; }
  }
}

function placeChild(stack, item) {
  const [name, child] = item.entries[item.cursor++];
  const childPlace = rootPlace(item.root, name);
  stack.push(item, { value: child, place: childPlace, root: false });
  // Count key text through the same scalar budget without changing its placement.
  stack.push({ value: name, place: { body: false, key: true, hostTool: childPlace.hostTool }, root: false });
}

function grammarCount(text) {
  // Compatibility normalization broadens refusal only, never the literal allowance.
  return [...stripIgnorables(text.normalize('NFKC')).matchAll(/wt-secret-guard(?:\s|\u0085)*release/giu)].length;
}

function privateMaterial(strings) {
  return strings.some(({ value, hostTool }) => redactConfirmationCodes(value) !== value || (!hostTool && heldMaterial(value)));
}

function heldMaterial(value) {
  const ranges = [...value.matchAll(/secret:[a-z-]+#[a-f0-9]{6}/g)]
    .filter((match) => isIssuedToken(match[0])).map((match) => [match.index, match.index + match[0].length]);
  return [...knownTokens().values()].some((entry) => !entry.ephemeral && entry.value
    && [entry.value, base64Utf8(entry.value)].some((needle) => rawHeldOccurrence(value, needle, ranges)));
}

function rawHeldOccurrence(value, needle, ranges) {
  for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + 1)) {
    if (!ranges.some(([from, to]) => at >= from && at + needle.length <= to)) return true;
  }
  return false;
}

function stripIgnorables(value) {
  return value.replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, '');
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
  return !/\b[a-f0-9]{6}\b/iu.test(stripIgnorables(outsideId));
}

export function confirmationKeyCollision(value) {
  const pending = [value];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > INSPECTION_NODES) return false; // The grammar walk returns the budget denial.
    if (!current || typeof current !== 'object') continue;
    const keys = Object.keys(current).map(redactConfirmationCodes);
    if (new Set(keys).size !== keys.length) return true;
    const children = Object.values(current);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  return false;
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
