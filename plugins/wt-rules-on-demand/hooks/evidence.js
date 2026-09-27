// Shared with transcript tooling; the Function Hooks host cannot import Node builtins.
export const SUBJECT_CAP = 16 * 1024;
export const RULE_CAP = 256 * 1024;
export const bounded = (value) => String(value ?? '').slice(0, SUBJECT_CAP);
export function argumentEvidence(input) {
  if (typeof input === 'string') return bounded(input);
  if (!input || typeof input !== 'object') return null;
  // Reserve space for every key and non-string value before allocating the
  // remaining budget to strings (including strings nested in arrays/objects).
  const trim = (value, max) => {
    if (typeof value === 'string') return value.slice(0, max);
    if (Array.isArray(value)) return value.map((item) => trim(item, max));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trim(item, max)]));
    return value;
  };
  let low = 0, high = SUBJECT_CAP;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(trim(input, mid)).length <= SUBJECT_CAP) low = mid;
    else high = mid - 1;
  }
  return bounded(JSON.stringify(trim(input, low)));
}

const unbounded = (text, at) => text[at] === '*' || text[at] === '+' || /^\{\d+,\}/.test(text.slice(at));
const multiplies = (text, at) => {
  const count = /^\{(\d+)(?:,(\d+))?\}/.exec(text.slice(at));
  return Boolean(count) && Number(count[2] ?? count[1]) > 1;
};

// Tokenize only top-level atoms. Unknown first sets are deliberately left undecided.
function branches(body) {
  const result = [[]];
  for (let i = 0; i < body.length;) {
    if (body[i] === '|') { result.push([]); i++; continue; }
    const start = i;
    let first = null;
    const group = body[i] === '(';
    if (body[i] === '\\') {
      const escape = /^(?:\\u\{[\da-f]+\}|\\u[\da-f]{4}|\\x[\da-f]{2}|\\k<[^>]+>|\\c.|\\.)/i.exec(body.slice(i));
      if (escape && /^\\[^dDsSwWbBpPkK1-9uxc]/.test(escape[0])) first = escape[0][1];
      i += escape?.[0].length ?? 2;
    } else if (body[i] === '[') {
      i++;
      if (body[i] === '^') i++;
      while (i < body.length && body[i] !== ']') i += body[i] === '\\' ? 2 : 1;
      i++;
    } else if (body[i] === '(') {
      let depth = 1;
      i++;
      while (i < body.length && depth) {
        if (body[i] === '\\') i += 2;
        else if (body[i] === '[') {
          i++;
          while (i < body.length && body[i] !== ']') i += body[i] === '\\' ? 2 : 1;
          i++;
        } else {
          if (body[i] === '(') depth++;
          if (body[i] === ')') depth--;
          i++;
        }
      }
    } else {
      if (!'.^$*+?{}'.includes(body[i])) first = body[i];
      i++;
    }
    const source = body.slice(start, i);
    const repeated = unbounded(body, i);
    const count = /^\{\d+(?:,\d*)?\}/.exec(body.slice(i));
    const quantified = Boolean(count || '*+?'.includes(body[i] ?? ''));
    const optional = body[i] === '*' || body[i] === '?' || /^\{0[,}]/.test(body.slice(i));
    if (count) i += count[0].length;
    else if (quantified) i++;
    if (quantified && body[i] === '?') i++; // lazy quantifier
    result[result.length - 1].push({ first, source, repeated: repeated || multiplies(body, start + source.length), optional, anchor: !repeated && !optional && (first !== null || group) });
  }
  return result;
}

// An iteration boundary is fixed if an atom's next possible character cannot be
// consumed by that atom. Unknown atoms intentionally fail this proof.
function deterministic(body, flags) {
  const alternatives = branches(body);
  const samples = new Set([...Array(256).keys(), 0xa0, 0x1680, 0x2000, 0x2028, 0x2029, 0x3000, 0xfeff, 0xe9, 0x391, 0x410, 0x4e2d]);
  for (const atom of alternatives.flat()) {
    for (const char of atom.source) {
      const point = char.codePointAt(0);
      for (const near of [point - 1, point, point + 1]) if (near >= 0 && near <= 0x10ffff) samples.add(near);
    }
    for (const match of atom.source.matchAll(/\\u\{([\da-f]+)\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi)) {
      const point = parseInt(match[1] ?? match[2] ?? match[3], 16);
      for (const near of [point - 1, point, point + 1]) if (near >= 0 && near <= 0x10ffff) samples.add(near);
    }
  }
  const chars = new Set([...samples].map((point) => String.fromCodePoint(point)));
  if (flags.includes('i')) for (const char of [...chars]) { chars.add(char.toLowerCase()); chars.add(char.toUpperCase()); }
  const cache = new Map();
  const matcher = (atom) => {
    if (cache.has(atom.source)) return cache.get(atom.source);
    // Preserve a deterministic prefix for a grouped list of literal options
    // (e.g. -C|--dir); every alternative must start with the same literal.
    let source = atom.source;
    if (source.startsWith('(')) {
      const options = /^\(\?:([^()]+)\)$/.exec(source)?.[1].split('|');
      const initial = options?.[0]?.[0];
      if (!initial || '\\.^$[*+?{'.includes(initial) || !options.every((option) => option[0] === initial)) return null;
      source = initial.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
    if (/^\\(?:[pPkKbB1-9])/.test(source) || !source || '^$'.includes(source)) return null;
    try {
      const regex = new RegExp(`^(?:${source})$`, flags.replace(/[gy]/g, ''));
      cache.set(atom.source, regex);
      return regex;
    } catch { return null; }
  };
  const disjoint = (left, right) => {
    const a = matcher(left), b = matcher(right);
    return a && b && [...chars].every((char) => !a.test(char) || !b.test(char));
  };
  const first = alternatives.flatMap((branch) => {
    const atoms = [];
    for (const atom of branch) { atoms.push(atom); if (!atom.optional) break; }
    return atoms;
  });
  return alternatives.every((branch) => branch.every((atom, index) => {
    if (atom.source.startsWith('(') && /[+*]|\{\d+,\}/.test(atom.source)) return false;
    if (!atom.repeated) return true;
    const next = [];
    let anchored = false;
    for (const following of branch.slice(index + 1)) {
      next.push(following);
      if (!following.optional) { anchored = true; break; }
    }
    if (!anchored) next.push(...first);
    return next.every((following) => disjoint(atom, following));
  }));
}

// Parse-time heuristic: direct repetition of one unbounded atom, or repeated
// alternatives whose first literal characters are provably the same.
export function safeRegex(rule, source, flags = '') {
  const pattern = String(source);
  const groups = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') { i++; continue; }
    if (pattern[i] === '[') { inClass = true; continue; }
    if (pattern[i] === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (pattern[i] === '(') groups.push({ start: i, repeatedChild: false, unboundedChild: false });
    if (pattern[i] !== ')' || !groups.length) continue;
    const { start, repeatedChild, unboundedChild } = groups.pop();
    const body = pattern.slice(start + (pattern.startsWith('(?:', start) ? 3 : 1), i);
    const containsUnbounded = unboundedChild || branches(body).some((branch) => branch.some((atom) => atom.repeated));
    if (containsUnbounded) for (const parent of groups) parent.unboundedChild = true;
    // A bounded count above one still multiplies the ways an unbounded body can split the input.
    // Each bounded iteration must consume a fixed anchor (a literal or a group, neither repeated nor optional);
    // a branch made only of unbounded or optional atoms lets the iterations split one run of input many ways.
    if (containsUnbounded && multiplies(pattern, i + 1) && !deterministic(body, flags)) throw new Error(`${rule}: regex has nested unbounded groups (bounded repeat of an unbounded body) in ${pattern}`);
    if (!unbounded(pattern, i + 1)) continue;
    // Two independently repeatable nesting levels can partition the same input
    // in exponentially many ways, even when the inner alternatives begin with
    // distinct characters. Refuse the shape without evaluating a sample input.
    if (repeatedChild || containsUnbounded && !deterministic(body, flags)) throw new Error(`${rule}: regex has nested unbounded groups (single unbounded element or overlapping alternation) in ${pattern}`);
    for (const parent of groups) parent.repeatedChild = true;
    const alternatives = branches(body);
    const singleRepeated = alternatives.length === 1 && alternatives[0].length === 1 && alternatives[0][0].repeated;
    // A shared first character is safe when the alternatives diverge at a
    // subsequent literal before either can finish (e.g. -C versus --dir).
    const overlapping = alternatives.some((branch, index) => alternatives.slice(index + 1).some((other) => {
      if (branch[0]?.first !== other[0]?.first || branch[0]?.first == null) return false;
      for (let at = 1; at < Math.min(branch.length, other.length); at++) {
        if (branch[at].first !== other[at].first && branch[at].first != null && other[at].first != null) return false;
        if (branch[at].first == null || other[at].first == null) break;
      }
      return true;
    }));
    if (singleRepeated || overlapping) throw new Error(`${rule}: regex has a repeated single unbounded element or overlapping alternation (same literal first character) in ${pattern}`);
  }
  return new RegExp(pattern, flags);
}
