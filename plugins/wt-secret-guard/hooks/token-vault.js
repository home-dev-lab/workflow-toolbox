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
  serial += 1;
  const token = `secret:${kind}#${shortHash(`${serial}:${value}`)}`;
  tokens.set(token, { kind, value });
  pending.push({ token, kind, value });
  return token;
}

export function substituteTokens(command) {
  let rewritten = command;
  for (const [token, entry] of tokens) rewritten = rewritten.split(token).join(entry.value);
  return rewritten;
}

export function knownTokens() { return tokens; }
export function takePending() { const result = pending; pending = []; return result; }
export function restorePending(entries) { pending = [...entries, ...pending]; }
export function testState() { return new Map(tokens); }
