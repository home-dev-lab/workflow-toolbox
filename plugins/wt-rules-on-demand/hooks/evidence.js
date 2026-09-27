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


// Regex guard: a DETERMINISTIC-ITERATION checker. A quantifier that can take more than one iteration over a group is
// accepted only when every iteration of that group can match a given input position in AT MOST ONE way. Then the
// only choice the engine can backtrack over is the iteration count, as for a single repeated character, and the
// cost stays polynomial instead of exponential. The rule is conservative by construction: every shape it cannot
// prove deterministic is refused, including shapes that happen to be safe.
//
// Inside a repeated group, every item of every alternative must be one of:
//   - a zero-width assertion (^ $ \b \B);
//   - a FIXED item: a character atom or a group whose body is fixed-width and deterministic, repeated an exact number
//     of times ({k});
//   - a RUN: one character atom under a variable quantifier (?, *, +, {m,n}), followed by a non-optional item whose
//     first character the run cannot consume. For the last item of an alternative, that follower is the first item of
//     every alternative (the next iteration).
// Alternatives must be told apart by a fixed-width prefix: at some position their character sets are disjoint.
// Character-set disjointness is decided by sampling every code point 0-255, the code points each atom names (and
// their neighbours, so range endpoints are covered) and a fixed set of non-ASCII representatives; an atom whose set
// cannot be sampled (a property escape) is treated as overlapping everything. Under ignore-case, non-ASCII class
// ranges are refused instead of relying on the samples to model Unicode folding.

const PATTERN_CAP = 8192;
const REPETITION_CAP = 1024;
const DEPTH_CAP = 64;
const ANALYSIS_CAP = 16384;
const COMPARISON_CAP = 1_000_000;

const quantifierAt = (text, at) => {
  const brace = /^\{(\d+)(?:(,)(\d*))?\}/.exec(text.slice(at));
  let min, max, length;
  if (text[at] === '*') [min, max, length] = [0, Infinity, 1];
  else if (text[at] === '+') [min, max, length] = [1, Infinity, 1];
  else if (text[at] === '?') [min, max, length] = [0, 1, 1];
  else if (brace) {
    const lower = Number(brace[1]);
    let upper = lower;
    if (brace[2]) upper = brace[3] === '' ? Infinity : Number(brace[3]);
    if (!Number.isSafeInteger(lower) || lower > REPETITION_CAP || upper !== Infinity && (!Number.isSafeInteger(upper) || upper > REPETITION_CAP)) throw new Error('repetition count exceeds analysis budget');
    [min, max, length] = [lower, upper, brace[0].length];
  }
  else return { min: 1, max: 1, length: 0 };
  if (text[at + length] === '?') length++;
  return { min, max, length };
};

// Escape shapes, longest first; an escape matching none of them (a backslash before a line break) fails the parse.
const ESCAPES = [/^\\u[\da-f]{4}/i, /^\\x[\da-f]{2}/i, /^\\c[a-z]/i, /^\\k<[^>]+>/, /^\\[pP]\{[^}]+\}/,
  /^\\[1-9]\d*/, /^\\./];

function parseRegex(pattern, flags) {
  let i = 0;
  const atom = (depth) => {
    const start = i;
    const c = pattern[i];
    if (c === '(') {
      if (depth >= DEPTH_CAP) throw new Error('group nesting exceeds analysis budget');
      let kind = 'group';
      if (pattern.startsWith('(?:', i)) i += 3;
      else if (/^\(\?<?[=!]/.test(pattern.slice(i))) { kind = 'look'; i += pattern[i + 2] === '<' ? 4 : 3; }
      else if (pattern.startsWith('(?<', i)) i = pattern.indexOf('>', i) + 1;
      else i++;
      const alt = alternation(depth + 1);
      if (pattern[i] !== ')') throw new Error('unbalanced group');
      i++;
      return { type: kind, alt, source: pattern.slice(start, i) };
    }
    if (c === '[') {
      i++;
      if (pattern[i] === '^') i++;
      // [] matches nothing; [^] matches any character. In both cases the initial ] closes the class.
      if (pattern[i] === ']') { i++; return { type: 'char', source: pattern.slice(start, i) }; }
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      if (i >= pattern.length) throw new Error('unclosed class');
      i++;
      const source = pattern.slice(start, i);
      if (!flags.includes('u') && source.includes('\\u{')) throw new Error('unsupported legacy class escape');
      return { type: 'char', source };
    }
    if (c === '\\') {
      const shapes = flags.includes('u') ? [/^\\u\{[\da-f]+\}/i, ...ESCAPES] : ESCAPES;
      const escape = shapes.map((shape) => shape.exec(pattern.slice(i))).find(Boolean)?.[0];
      if (!escape) throw new Error('unsupported escape');
      i += escape.length;
      if (/^\\[bB]$/.test(escape)) return { type: 'assert', source: escape };
      if (/^\\(?:k<|[1-9])/.test(escape)) return { type: 'unknown', source: escape };
      if (/^\\[pP]/.test(escape)) return { type: 'char', source: escape, opaque: true };
      return { type: 'char', source: escape };
    }
    i++;
    if (c === '^' || c === '$') return { type: 'assert', source: c };
    return { type: 'char', source: c };
  };
  const sequence = (depth) => {
    const items = [];
    while (i < pattern.length && pattern[i] !== '|' && pattern[i] !== ')') {
      const node = atom(depth);
      const quantifier = quantifierAt(pattern, i);
      i += quantifier.length;
      items.push({ node, min: quantifier.min, max: quantifier.max });
    }
    return items;
  };
  const alternation = (depth) => {
    const branches = [sequence(depth)];
    while (pattern[i] === '|') { i++; branches.push(sequence(depth)); }
    return branches;
  };
  const tree = alternation(0);
  if (i !== pattern.length) throw new Error('unbalanced group');
  return tree;
}

function characterSets(tree, flags) {
  const cleanFlags = flags.replace(/[gy]/g, '');
  const points = new Set([...Array(256).keys(), 0xa0, 0x1680, 0x2000, 0x2028, 0x2029, 0x3000, 0xfeff, 0xe9, 0x391, 0x3b1, 0x410, 0x430, 0x4e2d, 0x1f600]);
  const visit = (branches, depth = 0) => {
    if (depth > DEPTH_CAP) throw new Error('analysis depth exceeded');
    for (const branch of branches) for (const { node } of branch) {
      if (node.alt) visit(node.alt, depth + 1);
      if (node.type !== 'char') continue;
      const nonAscii = [...node.source].some((char) => char.codePointAt(0) > 127);
      if (flags.includes('i') && node.source.startsWith('[') && node.source.includes('-') && (nonAscii || node.source.includes('\\u') || node.source.includes('\\x'))) throw new Error('case folding of non-ASCII class ranges could not be analysed');
      for (const char of node.source) for (const near of [-1, 0, 1]) points.add(Math.max(0, char.codePointAt(0) + near));
      for (const match of node.source.matchAll(/\\u\{([\da-f]+)\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi)) {
        for (const near of [-1, 0, 1]) points.add(Math.max(0, parseInt(match[1] ?? match[2] ?? match[3], 16) + near));
      }
    }
  };
  visit(tree);
  const samples = new Set([...points].filter((point) => point <= 0x10ffff).map((point) => String.fromCodePoint(point)));
  if (flags.includes('i')) for (const char of [...samples]) { samples.add(char.toLowerCase()); samples.add(char.toUpperCase()); }
  const cache = new Map();
  let comparisons = 0;
  const matcher = (node) => {
    if (node.opaque) return null;
    if (!cache.has(node.source)) {
      let regex;
      try { regex = new RegExp(`^(?:${node.source})$`, cleanFlags); } catch { regex = null; }
      cache.set(node.source, regex);
    }
    return cache.get(node.source);
  };
  return (left, right) => {
    const a = matcher(left), b = matcher(right);
    if (!a || !b) return false;
    for (const char of samples) {
      if (++comparisons > COMPARISON_CAP) throw new Error('character-set comparisons exceed analysis budget');
      if (a.test(char) && b.test(char)) return false;
    }
    return true;
  };
}

// Fixed width of an item that matches in exactly one way, or null.
function fixedWidth(item, disjoint) {
  if (item.node.type === 'assert') return item.min === item.max ? 0 : null;
  if (item.min !== item.max) return null;
  if (item.node.type === 'char') return item.min;
  if (item.node.type !== 'group') return null;
  const width = alternativesWidth(item.node.alt, disjoint);
  return width === null ? null : width * item.min;
}

// Character-set positions an item contributes to a fixed prefix (stops at anything not a plain fixed item).
function prefixPositions(items) {
  const positions = [];
  for (const item of items) {
    if (item.node.type === 'assert' && item.min === item.max) continue;
    if (item.node.type !== 'char') break;
    if (item.min !== item.max) {
      // A run that must take at least one character still fixes the character set of its first position.
      if (item.min >= 1) positions.push(item.node);
      break;
    }
    for (let k = 0; k < item.min; k++) positions.push(item.node);
  }
  return positions;
}

function distinguishable(branches, disjoint) {
  const prefixes = branches.map(prefixPositions);
  return prefixes.every((left, index) => prefixes.slice(index + 1).every((right) => {
    for (let at = 0; at < Math.min(left.length, right.length); at++) if (disjoint(left[at], right[at])) return true;
    return false;
  }));
}

function alternativesWidth(branches, disjoint) {
  const widths = branches.map((branch) => branch.reduce((sum, item) => {
    const width = fixedWidth(item, disjoint);
    return sum === null || width === null ? null : sum + width;
  }, 0));
  if (widths.some((width) => width === null) || new Set(widths).size !== 1) return null;
  if (branches.length > 1 && !distinguishable(branches, disjoint)) return null;
  return widths[0];
}

// The first character atom an item must consume, or null when it cannot be named.
function firstAtom(item) {
  if (item.node.type === 'char') return item.node;
  if (item.node.type === 'group' && item.node.alt.length === 1) {
    const first = item.node.alt[0].find((inner) => inner.node.type !== 'assert');
    return first && first.min >= 1 ? firstAtom(first) : null;
  }
  return null;
}

// A group taken exactly once distributes over its alternatives: x(?:a|b)y and xay|xby match the same inputs in the same
// number of ways. Expanding such groups lets the rules below see every concrete sequence an iteration can take.
const EXPANSION_CAP = 256;
function expandOnceGroups(branches) {
  let current = branches;
  for (let rounds = 0; rounds <= ANALYSIS_CAP; rounds++) {
    let changed = false;
    const next = [];
    let size = 0;
    for (const branch of current) {
      const at = branch.findIndex((item) => item.node.type === 'group' && item.min === 1 && item.max === 1);
      if (at < 0) { next.push(branch); size += branch.length; continue; }
      changed = true;
      for (const inner of branch[at].node.alt) {
        const length = branch.length - 1 + inner.length;
        if (next.length >= EXPANSION_CAP || size + length > ANALYSIS_CAP) return null;
        next.push([...branch.slice(0, at), ...inner, ...branch.slice(at + 1)]);
        size += length;
      }
    }
    if (!changed) return current;
    current = next;
  }
  return null;
}

function iterationDeterministic(original, disjoint) {
  const branches = expandOnceGroups(original);
  if (!branches) return false;
  if (branches.length > 1 && !distinguishable(branches, disjoint)) return false;
  const heads = branches.map((branch) => branch.find((item) => item.node.type !== 'assert'));
  if (heads.some((head) => !head || head.min < 1)) return false;
  return branches.every((branch) => branch.every((item, index) => {
    if (item.node.type === 'assert') return item.min === item.max;
    if (fixedWidth(item, disjoint) !== null) return true;
    if (item.node.type !== 'char') return false;
    const next = branch.slice(index + 1).find((following) => following.node.type !== 'assert');
    const followers = next ? [next] : heads;
    return followers.every((follower) => {
      const atom = follower.min >= 1 ? firstAtom(follower) : null;
      return atom !== null && disjoint(item.node, atom);
    });
  }));
}

export function safeRegex(rule, source, flags = '') {
  const pattern = String(source);
  const refuse = (reason) => { throw new Error(`${rule}: regex could not be analysed for nested repetition (${reason}) in ${pattern}`); };
  if (pattern.length > PATTERN_CAP) refuse('pattern length exceeds analysis budget');
  if (flags.includes('v')) refuse('unsupported v-flag grammar');
  let tree;
  try { tree = parseRegex(pattern, flags); } catch { tree = null; }
  if (!tree) {
    const regex = new RegExp(pattern, flags); // an invalid pattern keeps its own syntax error
    if (regex) throw new Error(`${rule}: regex could not be analysed for nested repetition in ${pattern}`);
  }
  {
    let disjoint;
    try { disjoint = characterSets(tree, flags); } catch (error) { refuse(error.message); }
    const check = (branches, depth = 0) => {
      if (depth > DEPTH_CAP) refuse('analysis depth exceeded');
      for (const branch of branches) for (const item of branch) {
        if (item.node.type === 'unknown') refuse('backreference is unsupported');
        if (!item.node.alt) continue;
        if (item.max > 1 && !iterationDeterministic(item.node.alt, disjoint)) {
          throw new Error(`${rule}: regex has nested unbounded groups (an iteration can match the same input more than one way) in ${pattern}`);
        }
        check(item.node.alt, depth + 1);
      }
    };
    try { check(tree); } catch (error) {
      if (error.message === 'character-set comparisons exceed analysis budget') refuse(error.message);
      throw error;
    }
  }
  return new RegExp(pattern, flags);
}
