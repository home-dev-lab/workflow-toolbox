// Information hiding: raw values stay in this registry and callers operate on stable tokens.
const tokens = new Map();
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
  for (const [token, entry] of tokens) if (entry.value === value) return token;
  // A token names exactly one value. Six hex digits collide (measured by Astra at 5a2134a5: 3,408
  // values gave two of them the same token, the second overwrote the first, which then expanded wrong
  // and was no longer masked), so a taken token is never reused: the serial moves on and the next
  // candidate is drawn. The shape stays `secret:<kind>#<6 hex>`, which every consumer matches.
  let token;
  do { serial += 1; token = `secret:${kind}#${shortHash(`${serial}:${value}`)}`; } while (tokens.has(token));
  tokens.set(token, { kind, value });
  pending.push({ token, kind, value });
  return token;
}

export function substituteTokens(command) {
  // Whole tokens only, each looked up exactly: no token can rewrite part of another.
  return command.replace(/secret:[a-z-]+#[a-f0-9]{6}/g, (token) => tokens.get(token)?.value ?? token);
}

export function knownTokens() { return tokens; }
export function takePending() { const result = pending; pending = []; return result; }
export function restorePending(entries) { pending = [...entries, ...pending]; }
export function testState() { return new Map(tokens); }
