// Information hiding: raw values stay in this registry and callers operate on stable tokens.
const tokens = new Map();
// Every value the vault holds, so a token is never minted equal to one (verify13 finding 1).
const values = new Set();
const tokenByValue = new Map();
const PREFIX_LENGTH = 8;
const MAX_INDEXED_VALUE_LENGTH = 4096;
let serial = 0;
let entryOrder = 0;
let pending = [];
const work = { valueLookupSteps: 0, scrubEntryScans: 0, shortValueScans: 0, prefixLookups: 0, prefixCandidateChecks: 0, prefixCandidateSearches: 0, prefixLengthRejections: 0 };
const prefixIndex = new Map();
const shortEntries = [];
const categoryCounts = new Map();
const longCategoryMinLengths = new Map();
const indexStats = { oversizedValues: 0, prefixEntries: 0, prefixKeyCharacters: 0 };

function categoryFor(kind) {
  if (kind === 'credential-uuid') return 'credential';
  if (kind === 'email') return 'email';
  if (kind === 'ip-address') return 'ipAddress';
  return 'unconditional';
}

function indexEntry(token, kind, value) {
  if (!value) return;
  const category = categoryFor(kind);
  const entry = { value, token, kind, category, order: entryOrder };
  entryOrder += 1;
  categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  if (value.length < PREFIX_LENGTH) shortEntries.push(entry);
  else {
    const prefix = value.slice(0, PREFIX_LENGTH);
    const existing = prefixIndex.get(prefix);
    const bucket = existing ?? { entries: [], categories: new Set() };
    bucket.entries.push(entry);
    bucket.categories.add(category);
    prefixIndex.set(prefix, bucket);
    if (!existing) indexStats.prefixKeyCharacters += prefix.length;
    longCategoryMinLengths.set(category, Math.min(longCategoryMinLengths.get(category) ?? Infinity, value.length));
    indexStats.prefixEntries += 1;
  }
  if (value.length > MAX_INDEXED_VALUE_LENGTH) indexStats.oversizedValues += 1;
}

function addByValue(grouped, entry) {
  const entries = grouped.get(entry.value) ?? [];
  entries.push(entry);
  grouped.set(entry.value, entries);
}

function inactiveEligibleEntries(eligible, activeCategories) {
  const hasInactive = [...categoryCounts].some(([category, count]) => count && !activeCategories.has(category));
  const result = new Set();
  if (!hasInactive) return result;
  for (const entry of shortEntries) if (!activeCategories.has(entry.category) && eligible(entry)) result.add(entry);
  for (const bucket of prefixIndex.values()) {
    if ([...bucket.categories].every((category) => activeCategories.has(category))) continue;
    for (const entry of bucket.entries) if (!activeCategories.has(entry.category) && eligible(entry)) result.add(entry);
  }
  return result;
}

function eligibleGroups(entries, activeCategories, inactiveEligible) {
  const grouped = new Map();
  for (const entry of entries) if (activeCategories.has(entry.category) || inactiveEligible.has(entry)) addByValue(grouped, entry);
  return grouped;
}

function collectShortOccurrences(text, grouped, matches) {
  for (const [value, entries] of grouped) {
    work.shortValueScans += 1;
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
      for (const entry of entries) matches.push({ from: at, to: at + value.length, token: entry.token, kind: entry.kind, order: entry.order });
    }
  }
}

function hasPossibleLongEntries(activeCategories, inactiveEligible, textLength) {
  if ([...activeCategories].some((category) => (longCategoryMinLengths.get(category) ?? Infinity) <= textLength)) return true;
  return [...inactiveEligible].some((entry) => entry.value.length >= PREFIX_LENGTH && entry.value.length <= textLength);
}

function eligiblePrefixGroups(entries, activeCategories, inactiveEligible, maxLength) {
  const grouped = new Map();
  for (const entry of entries) {
    if (entry.value.length > maxLength) {
      work.prefixLengthRejections += 1;
      continue;
    }
    if (activeCategories.has(entry.category) || inactiveEligible.has(entry)) addByValue(grouped, entry);
  }
  return grouped;
}

function collectPrefixOccurrences(text, activeCategories, inactiveEligible, matches) {
  if (!hasPossibleLongEntries(activeCategories, inactiveEligible, text.length)) return;
  const visitedPrefixes = new Set();
  for (let at = 0; at + PREFIX_LENGTH <= text.length; at += 1) {
    const prefix = text.slice(at, at + PREFIX_LENGTH);
    work.prefixLookups += 1;
    const bucket = prefixIndex.get(prefix);
    if (!bucket || visitedPrefixes.has(prefix)) continue;
    visitedPrefixes.add(prefix);
    const grouped = eligiblePrefixGroups(bucket.entries, activeCategories, inactiveEligible, text.length - at);
    for (const [value, entries] of grouped) {
      work.prefixCandidateChecks += 1;
      let found = at;
      do {
        work.prefixCandidateSearches += 1;
        found = text.indexOf(value, found);
        if (found < 0) break;
        for (const entry of entries) matches.push({ from: found, to: found + value.length, token: entry.token, kind: entry.kind, order: entry.order });
        found += 1;
      } while (found <= text.length - value.length);
    }
  }
}

function shortHash(value) {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  return (state >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

export function tokenize(kind, value) {
  // The token for a value is one no held value is spelled like: a value registered AFTER its token was
  // issued can share that spelling, and emitting it then prints that other value verbatim (Astra at
  // 7323b6d2: A's token reused as A's replacement printed B, whose value was that spelling). Such a
  // token keeps rehydrating to its value, but a fresh one is issued to REPLACE the value from then on.
  work.valueLookupSteps += 1;
  const existing = tokenByValue.get(value);
  if (existing) return existing;
  // A token names exactly one value. Six hex digits collide (measured by Astra at 5a2134a5: 3,408
  // values gave two of them the same token, the second overwrote the first, which then expanded wrong
  // and was no longer masked), so a taken token is never reused: the serial moves on and the next
  // candidate is drawn. The shape stays `secret:<kind>#<6 hex>`, which every consumer matches.
  let token;
  do { serial += 1; token = `secret:${kind}#${shortHash(`${serial}:${value}`)}`; } while (tokens.has(token) || token === value || values.has(token));
  const entry = { kind, value };
  tokens.set(token, entry);
  indexEntry(token, kind, value);
  values.add(value);
  const shadowed = tokens.get(value);
  if (shadowed && tokenByValue.get(shadowed.value) === value) tokenByValue.delete(shadowed.value);
  tokenByValue.set(value, token);
  pending.push({ token, kind, value });
  return token;
}

export function knownValueOccurrences(text, eligible = () => true, activeCategories = new Set(['unconditional', 'email', 'ipAddress', 'credential'])) {
  const matches = [];
  const inactiveEligible = inactiveEligibleEntries(eligible, activeCategories);
  collectShortOccurrences(text, eligibleGroups(shortEntries, activeCategories, inactiveEligible), matches);
  collectPrefixOccurrences(text, activeCategories, inactiveEligible, matches);
  matches.sort((left, right) => left.order - right.order || left.from - right.from);
  return matches;
}

export function substituteTokens(command) {
  // Whole tokens only, each looked up exactly: no token can rewrite part of another.
  return command.replace(/secret:[a-z-]+#[a-f0-9]{6}/g, (token) => tokens.get(token)?.value ?? token);
}

export function knownTokens() { return tokens; }
// A token-shaped text is an ISSUED token - exempt from scrubbing and outbound findings - only when this
// vault minted it AND no value it holds is spelled that way. A value registered after a token of the same
// spelling was issued (a crafted value, or one that happens to be a token) makes that spelling ambiguous,
// and an ambiguous spelling is masked: a secret shown is worse than a token that rehydrates to the wrong value.
export function isIssuedToken(text) { return tokens.has(text) && !values.has(text); }
// The text that REPLACES the value an issued token stands for. Every emitter goes through here, so no
// replacement is ever spelled like a held value: an ambiguous token is replaced by the fresh token
// tokenize issues for the same value (Astra at 7323b6d2).
export function replacementFor(token) {
  if (isIssuedToken(token)) return token;
  const entry = tokens.get(token);
  return entry ? tokenize(entry.kind, entry.value) : token;
}
export function takePending() { const result = pending; pending = []; return result; }
export function restorePending(entries) { pending = [...entries, ...pending]; }
export function testState() { return new Map(tokens); }
export function testResetVaultWork() { for (const key of Object.keys(work)) work[key] = 0; }
export function testVaultWork() { return { ...work, ...indexStats, prefixKeys: prefixIndex.size, maxIndexedValueLength: MAX_INDEXED_VALUE_LENGTH }; }
export function testVaultSnapshot() {
  return {
    tokens: new Map(tokens), values: new Set(values), tokenByValue: new Map(tokenByValue), serial, entryOrder, pending: [...pending],
  };
}
export function testRestoreVault(snapshot) {
  tokens.clear(); for (const entry of snapshot.tokens) tokens.set(...entry);
  values.clear(); for (const value of snapshot.values) values.add(value);
  tokenByValue.clear(); for (const entry of snapshot.tokenByValue) tokenByValue.set(...entry);
  prefixIndex.clear(); shortEntries.length = 0; categoryCounts.clear(); longCategoryMinLengths.clear();
  entryOrder = 0; indexStats.oversizedValues = 0; indexStats.prefixEntries = 0; indexStats.prefixKeyCharacters = 0;
  for (const [token, entry] of tokens) indexEntry(token, entry.kind, entry.value);
  serial = snapshot.serial; entryOrder = snapshot.entryOrder; pending = [...snapshot.pending];
}
