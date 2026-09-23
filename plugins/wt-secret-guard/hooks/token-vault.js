// Information hiding: raw values stay in this registry and callers operate on stable tokens.
const tokens = new Map();
// Every value the vault holds, so a token is never minted equal to one (verify13 finding 1).
const values = new Set();
let serial = 0;
let pending = [];

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
  for (const [token, entry] of tokens) if (entry.value === value && !values.has(token)) return token;
  // A token names exactly one value. Six hex digits collide (measured by Astra at 5a2134a5: 3,408
  // values gave two of them the same token, the second overwrote the first, which then expanded wrong
  // and was no longer masked), so a taken token is never reused: the serial moves on and the next
  // candidate is drawn. The shape stays `secret:<kind>#<6 hex>`, which every consumer matches.
  let token;
  do { serial += 1; token = `secret:${kind}#${shortHash(`${serial}:${value}`)}`; } while (tokens.has(token) || token === value || values.has(token));
  tokens.set(token, { kind, value });
  values.add(value);
  pending.push({ token, kind, value });
  return token;
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
