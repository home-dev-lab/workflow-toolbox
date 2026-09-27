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

// Tokenize only top-level atoms. Unknown first sets are deliberately left undecided.
function branches(body) {
  const result = [[]];
  for (let i = 0; i < body.length;) {
    if (body[i] === '|') { result.push([]); i++; continue; }
    let first = null;
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
    if (count) i += count[0].length;
    else if (quantified) i++;
    if (quantified && body[i] === '?') i++; // lazy quantifier
    result[result.length - 1].push({ first, repeated });
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
    if (pattern[i] === '(') groups.push(i);
    if (pattern[i] !== ')' || !groups.length) continue;
    const start = groups.pop();
    if (!unbounded(pattern, i + 1)) continue;
    const body = pattern.slice(start + (pattern.startsWith('(?:', start) ? 3 : 1), i);
    const alternatives = branches(body);
    const singleRepeated = alternatives.length === 1 && alternatives[0].length === 1 && alternatives[0][0].repeated;
    const heads = alternatives.map((branch) => branch[0]?.first).filter((head) => head !== null && head !== undefined);
    const overlapping = heads.length !== new Set(heads).size;
    if (singleRepeated || overlapping) throw new Error(`${rule}: regex has a repeated single unbounded element or overlapping alternation (same literal first character) in ${pattern}`);
  }
  return new RegExp(pattern, flags);
}
