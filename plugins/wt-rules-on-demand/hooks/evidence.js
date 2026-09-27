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
    let first = null;
    const group = body[i] === '(';
    if (body[i] === '\\') {
      if (!/[dDsSwWbBpPkK]/.test(body[i + 1] ?? '')) first = body[i + 1] ?? null;
      i += 2;
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
    const repeated = unbounded(body, i);
    const count = /^\{\d+(?:,\d*)?\}/.exec(body.slice(i));
    const quantified = Boolean(count || '*+?'.includes(body[i] ?? ''));
    const optional = body[i] === '*' || body[i] === '?' || /^\{0[,}]/.test(body.slice(i));
    if (count) i += count[0].length;
    else if (quantified) i++;
    if (quantified && body[i] === '?') i++; // lazy quantifier
    result[result.length - 1].push({ first, repeated, anchor: !repeated && !optional && (first !== null || group) });
  }
  return result;
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
    if (containsUnbounded && multiplies(pattern, i + 1) && branches(body).some((branch) => !branch.some((atom) => atom.anchor))) throw new Error(`${rule}: regex has nested unbounded groups (bounded repeat of an unbounded body) in ${pattern}`);
    if (!unbounded(pattern, i + 1)) continue;
    // Two independently repeatable nesting levels can partition the same input
    // in exponentially many ways, even when the inner alternatives begin with
    // distinct characters. Refuse the shape without evaluating a sample input.
    if (repeatedChild || containsUnbounded) throw new Error(`${rule}: regex has nested unbounded groups (single unbounded element or overlapping alternation) in ${pattern}`);
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
