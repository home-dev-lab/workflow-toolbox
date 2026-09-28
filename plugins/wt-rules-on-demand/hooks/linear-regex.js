// A bounded Thompson VM. Native RegExp is used only for syntax checking and
// single-character predicates; no subject is passed to a backtracking engine.
const SOURCE_LIMIT = 8192;
const REPEAT_LIMIT = 1024;
const DEPTH_LIMIT = 64;
const PROGRAM_LIMIT = 16384;
// A fixed cap bounds synchronous latency even for large admitted programs.
const CALL_STEP_LIMIT = 8000000;
const CAPTURE_STEP_LIMIT = 600000;
// 8M membership steps took ~250 ms on the measured host: 64M is ~2 s.
// The wall deadline is authoritative under contention; a clock read every
// 4096 steps costs less than one thousandth of the scanning work.
export function regexCallBudget(clock = Date.now) {
  const deadline = clock() + 2000;
  return {
    steps: 0, exhausted: false, unresolved: new Set(),
    check() {
      if (this.exhausted || this.steps >= 64000000 || clock() >= deadline) {
        this.exhausted = true;
        throw new Error('shared regex call budget exhausted; verdict unresolved');
      }
    },
    tick() {
      this.steps++;
      if (this.steps % 4096 === 0 || this.steps >= 64000000) this.check();
    },
  };
}
const workExceeded = (ctx) => new Error(`regex ${ctx.iterating ? 'iteration ' : ''}work budget exceeded; verdict unresolved`);

function parse(source, flags, capture) {
  let i = 0, groups = 0;
  const unicode = flags.includes('u');
  const fail = (why) => { throw new Error(why); };
  const atom = (depth, repeated, looking) => {
    if (depth > DEPTH_LIMIT) fail('group nesting exceeds budget');
    const start = i;
    const c = source[i++];
    if (c === '(') {
      let look = null, group = false;
      if (source[i] === '?') {
        i++;
        if (source[i] === ':') i++;
        else if (source[i] === '=' || source[i] === '!') look = { ahead: true, negative: source[i++] === '!' };
        else if (source[i] === '<' && (source[i + 1] === '=' || source[i + 1] === '!')) {
          i++;
          look = { ahead: false, negative: source[i++] === '!' };
        } else if (source[i] === '<') {
          const end = source.indexOf('>', i + 1);
          if (end < 0) fail('unclosed group name');
          i = end + 1;
          group = true;
        } else fail('unsupported group syntax');
      } else group = true;
      const number = group ? ++groups : 0;
      if (capture && number === 1 && (repeated || looking || look)) fail('group 1 inside repetition or lookaround is unsupported for capture-reading fields; instead, put the captured group outside every quantifier and lookaround, e.g. x(\\S+) rather than (?:x(\\S))+');
      const body = alternatives(depth + 1, repeated, looking || !!look);
      if (source[i++] !== ')') fail('unclosed group');
      return look ? { type: 'look', ...look, body } : { type: 'group', number, body };
    }
    if (c === '[') {
      if (source[i] === '^') i++;
      if (source[i] === ']') i++;
      else {
        while (i < source.length && source[i] !== ']') {
          if (source[i] === '\\') i++;
          i++;
        }
        if (source[i++] !== ']') fail('unclosed character class');
      }
      return { type: 'char', value: source.slice(start, i) };
    }
    if (c === '\\') {
      const kind = source[i++];
      if (!kind) fail('trailing escape');
      if (/[1-9]/.test(kind) || kind === 'k' && source[i] === '<') fail('backreference is unsupported');
      if (kind === '0' && /\d/.test(source[i] ?? '')) fail('legacy octal escape is unsupported');
      if (kind === 'b' || kind === 'B') return { type: 'assert', value: `\\${kind}` };
      if (kind === 'p' || kind === 'P') {
        if (!unicode || source[i] !== '{') fail('property escape requires u and braces');
        const end = source.indexOf('}', i);
        if (end < 0) fail('unclosed property escape');
        i = end + 1;
      } else if (kind === 'u') {
        if (source[i] === '{' && unicode) {
          const end = source.indexOf('}', i);
          if (end < 0) fail('unclosed Unicode escape');
          i = end + 1;
        } else if (/^[\da-f]{4}/i.test(source.slice(i))) i += 4;
        else fail('unsupported Unicode escape');
      } else if (kind === 'x') {
        if (!/^[\da-f]{2}/i.test(source.slice(i))) fail('unsupported hex escape');
        i += 2;
      } else if (kind === 'c') {
        if (!/[a-z]/i.test(source[i] ?? '')) fail('unsupported control escape');
        i++;
      }
      // Adjacent escaped halves are one code point under u, just like literal pairs.
      if (unicode && kind === 'u' && /^\\u[dD][89aAbB][\da-fA-F]{2}$/.test(source.slice(start, i))
        && /^\\u[dD][c-fC-F][\da-fA-F]{2}/.test(source.slice(i))) i += 6;
      return { type: 'char', value: source.slice(start, i) };
    }
    if (c === '^' || c === '$') return { type: 'assert', value: c };
    if (c === '.' ) return { type: 'char', value: c };
    if ('*+?{}'.includes(c)) fail('unsupported bare quantifier');
    // In non-unicode mode, astral source characters are two separate atoms.
    if (!unicode && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdbff && source.charCodeAt(i) >= 0xdc00 && source.charCodeAt(i) <= 0xdfff) {
      return { type: 'seq', items: [{ type: 'char', value: c }, { type: 'char', value: source[i++] }] };
    }
    if (unicode && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdbff && source.charCodeAt(i) >= 0xdc00 && source.charCodeAt(i) <= 0xdfff) i++;
    return { type: 'char', value: source.slice(start, i) };
  };
  const sequence = (depth, repeated, looking) => {
    const items = [];
    while (i < source.length && source[i] !== ')' && source[i] !== '|') {
      const start = i;
      // Determine repetition before parsing a group, so group 1 restrictions are checked inside it.
      const node = atom(depth, repeated, looking);
      let min = 1, max = 1, lazy = false, quantified = false;
      const q = source[i];
      if (q === '*' || q === '+' || q === '?') {
        quantified = true;
        i++;
        if (q === '*') [min, max] = [0, Infinity];
        else if (q === '+') [min, max] = [1, Infinity];
        else [min, max] = [0, 1];
      } else if (q === '{') {
        const match = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(i));
        if (match) {
          quantified = true;
          i += match[0].length;
          min = Number(match[1]);
          if (match[2] === undefined) max = min;
          else if (match[2] === '') max = Infinity;
          else max = Number(match[2]);
        }
      }
      if (quantified) {
        if (min > REPEAT_LIMIT || max !== Infinity && max > REPEAT_LIMIT) fail('repetition count exceeds budget');
        if (source[i] === '?') { i++; lazy = true; }
        // Captures nested within quantified groups cannot be observed exactly without capture histories.
        if (capture && (max > 1 || min !== 1)) checkCapture(node);
      }
      if (quantified && node.type === 'seq' && node.items.length === 2 && node.items[0].value?.charCodeAt(0) >= 0xd800) {
        items.push(node.items[0]);
        items.push({ type: 'repeat', body: node.items[1], min, max, lazy });
      } else items.push(quantified ? { type: 'repeat', body: node, min, max, lazy } : node);
      if (i === start) fail('parser made no progress');
    }
    return { type: 'seq', items };
  };
  const alternatives = (depth, repeated, looking) => {
    const branches = [sequence(depth, repeated, looking)];
    while (source[i] === '|') { i++; branches.push(sequence(depth, repeated, looking)); }
    return branches.length === 1 ? branches[0] : { type: 'alt', branches };
  };
  const tree = alternatives(0, false, false);
  if (i !== source.length) fail('unbalanced group');
  return tree;
}

function checkCapture(node) {
  if (node.type === 'group' && node.number === 1) throw new Error('group 1 inside repetition is unsupported for capture-reading fields; instead, put the captured group outside every quantifier, e.g. x(\\S+) rather than (?:x(\\S))+');
  for (const child of node.items ?? node.branches ?? (node.body ? [node.body] : [])) checkCapture(child);
}

function size(node) {
  let count = 1;
  if (node.type === 'repeat') count = (size(node.body) + 2) * (node.max === Infinity ? node.min + 1 : node.max) + 1;
  else for (const child of node.items ?? node.branches ?? (node.body ? [node.body] : [])) count += size(child);
  if (count > PROGRAM_LIMIT) throw new Error(`expanded program exceeds ${PROGRAM_LIMIT} instructions`);
  return count;
}

function nullable(node) {
  if (node.type === 'seq') return node.items.every(nullable);
  if (node.type === 'alt') return node.branches.some(nullable);
  if (node.type === 'repeat') return node.min === 0 || nullable(node.body);
  if (node.type === 'group') return nullable(node.body);
  return node.type === 'assert' || node.type === 'look';
}

function checkNullableCaptureRepeat(node) {
  if (node.type === 'repeat' && (node.min !== 1 || node.max !== 1) && nullable(node.body))
    throw new Error('nullable quantified body is unsupported for capture-reading fields (except exact {1}); instead, quantify a body that consumes at least one character, e.g. (\\S+) rather than (\\S*?)*');
  for (const child of node.items ?? node.branches ?? (node.body ? [node.body] : [])) checkNullableCaptureRepeat(child);
}

// A mandatory literal in every alternative is a sound negative prefilter.
// Only raw ASCII letters/digits and case-sensitive patterns qualify; escaped
// atoms, character classes and case folding are left to the VM.
function requiredLiterals(node) {
  if (node.type === 'char') return /^[a-zA-Z0-9]$/.test(node.value) ? [node.value] : [];
  if (node.type === 'group' || node.type === 'repeat' && node.min > 0 || node.type === 'look' && !node.negative)
    return requiredLiterals(node.body);
  if (node.type === 'alt') {
    const branches = node.branches.map(requiredLiterals);
    return branches.every((row) => row.length) && branches.flat().length <= 16 ? branches.flat() : [];
  }
  if (node.type === 'seq') {
    let best = [], run = '';
    for (const item of node.items) {
      if (item.type === 'char' && /^[a-zA-Z0-9]$/.test(item.value)) run += item.value;
      else {
        if (run.length > (best[0]?.length ?? 0)) best = [run];
        run = '';
        const other = requiredLiterals(item);
        if (other.length && Math.min(...other.map((value) => value.length)) > (best[0]?.length ?? 0)) best = other;
      }
    }
    if (run.length > (best[0]?.length ?? 0)) best = [run];
    return best;
  }
  return [];
}

function reverse(node) {
  if (node.type === 'seq') return { ...node, items: node.items.toReversed().map(reverse) };
  if (node.type === 'alt') return { ...node, branches: node.branches.map(reverse) };
  // A lookaround is a positional predicate. Its own compilation chooses the
  // scan direction; reversing an enclosing expression must not reverse it.
  if (node.type === 'look') return node;
  if (node.body) return { ...node, body: reverse(node.body) };
  return node;
}

function compile(tree, programs, reversed = false) {
  const code = [];
  const emit = (op, extra = {}) => (code.push({ op, ...extra }), code.length - 1);
  const build = (node, next) => {
    if (node.type === 'seq') {
      for (let k = node.items.length - 1; k >= 0; k--) next = build(node.items[k], next);
      return next;
    }
    if (node.type === 'alt') {
      let branch = build(node.branches.at(-1), next);
      for (let k = node.branches.length - 2; k >= 0; k--) branch = emit('split', { a: build(node.branches[k], next), b: branch });
      next = branch;
      return next;
    }
    if (node.type === 'repeat') {
      if (node.max === Infinity) {
        const split = emit('split');
        const loop = nullable(node.body) ? emit('loop', { next: split, id: split }) : split;
        const body = build(node.body, loop);
        Object.assign(code[split], { a: node.lazy ? next : body, b: node.lazy ? body : next });
        if (loop !== split) code[split].loopBody = body;
        next = split;
      } else for (let k = node.min; k < node.max; k++) {
        const split = emit('split');
        const guard = node.max > 1 && nullable(node.body) ? emit('loop', { next, id: split }) : next;
        const body = build(node.body, guard);
        Object.assign(code[split], { a: node.lazy ? next : body, b: node.lazy ? body : next });
        if (guard !== next) code[split].loopBody = body;
        next = split;
      }
      for (let k = 0; k < node.min; k++) next = build(node.body, next);
      return next;
    }
    if (node.type === 'group') {
      if (node.number !== 1) return build(node.body, next);
      const end = emit('saveEnd', { next });
      return emit('saveStart', { next: build(node.body, end) });
    }
    if (node.type === 'look') {
      const id = programs.length;
      programs.push(null);
      programs[id] = compile(node.ahead ? reverse(node.body) : node.body, programs, node.ahead);
      return emit('look', { id, negative: node.negative, next });
    }
    return emit(node.type, { value: node.value, next });
  };
  const end = emit('match');
  return { code, start: build(tree, end), reversed };
}

const terminal = (c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';

function context(subject, flags, programs) {
  // Keep every UTF-16 boundary: V8 evaluates zero-width assertions even
  // between surrogate halves. Consuming atoms can still span a full pair.
  const chars = subject.split('');
  const offsets = new Array(chars.length + 1);
  let offset = 0;
  for (let j = 0; j < chars.length; j++) { offsets[j] = offset; offset += chars[j].length; }
  offsets[chars.length] = offset;
  const atoms = new Map();
  const nativeFlags = flags.replace(/[gy]/g, '');
  const atom = (value, char) => {
    let row = atoms.get(value);
    if (!row) { row = { regex: new RegExp(`^(?:${value})$`, nativeFlags), cache: new Map() }; atoms.set(value, row); }
    if (!row.cache.has(char)) {
      const result = row.regex.test(char);
      if (row.cache.size < 512) row.cache.set(char, result);
      return result;
    }
    return row.cache.get(char);
  };
  const word = (char) => char !== undefined && atom('\\w', char);
  const assertion = (value, p) => {
    if (value === '^') return p === 0 || flags.includes('m') && terminal(chars[p - 1]);
    if (value === '$') return p === chars.length || flags.includes('m') && terminal(chars[p]);
    const boundary = word(chars[p - 1]) !== word(chars[p]);
    return value === '\\b' ? boundary : !boundary;
  };
  const tables = programs.map(() => null);
  const unicode = flags.includes('u');
  const character = (pos, backwards) => {
    const at = backwards ? pos - 1 : pos;
    if (at < 0 || at >= chars.length) return ['', 0];
    const first = chars[backwards ? at - 1 : at];
    if (unicode && first && /[\uD800-\uDBFF]/.test(first) && /[\uDC00-\uDFFF]/.test(chars[backwards ? at : at + 1] ?? ''))
      return [subject.slice(backwards ? at - 1 : at, backwards ? pos : at + 2), 2];
    return [chars[at], 1];
  };
  return { chars, offsets, atom, assertion, tables, programs, steps: 0, subject, character };
}

// Epsilon closure: first arrival at a program counter wins. A visited counter
// also prevents empty repetitions from cycling indefinitely.
function closure(program, seeds, position, ctx, capture = false) {
  const output = [], seen = new Set();
  const { code } = program;
  // Explicit DFS preserves branch priority without pattern-controlled stack depth.
  const stack = seeds.toReversed();
  while (stack.length) {
    const thread = stack.pop();
    const pc = thread.pc;
    if (seen.has(pc)) continue;
    seen.add(pc);
    ctx.steps++;
    if (ctx.steps > CAPTURE_STEP_LIMIT) throw workExceeded(ctx);
    const inst = code[pc];
    if (inst.op === 'split') {
      const branch = (pc) => ({ ...thread, pc, ...(pc === inst.loopBody ? { loops: { ...thread.loops, [thread.pc]: position } } : {}) });
      stack.push(branch(inst.b), branch(inst.a));
    }
    else if (inst.op === 'loop') { if (thread.loops?.[inst.id] !== position) stack.push({ ...thread, pc: inst.next }); }
    else if (inst.op === 'assert') { if (ctx.assertion(inst.value, position)) stack.push({ ...thread, pc: inst.next }); }
    else if (inst.op === 'look') { if (Boolean(ctx.tables[inst.id][position]) !== inst.negative) stack.push({ ...thread, pc: inst.next }); }
    else if (inst.op === 'saveStart' || inst.op === 'saveEnd') {
      stack.push({ ...thread, pc: inst.next, ...(capture ? { [inst.op === 'saveStart' ? 's' : 'e']: ctx.offsets[position] } : {}) });
    } else output.push(inst.op === 'match' && capture ? { ...thread, end: thread.end ?? ctx.offsets[position] } : thread);
  }
  return output;
}

function scan(program, ctx, start = 0, captures = false, table = null, budget = Infinity, sticky = false) {
  const n = ctx.chars.length;
  const backwards = program.reversed;
  let active = [];
  const delayed = new Map();
  const begin = backwards ? n : start, delta = backwards ? -1 : 1;
  for (let pos = begin; backwards ? pos >= 0 : pos <= n; pos += delta) {
    const seeds = [...active, ...(delayed.get(pos) ?? []), ...sticky && pos !== start ? [] : [{ pc: program.start, start: ctx.offsets[pos] }]];
    delayed.delete(pos);
    active = closure(program, seeds, pos, ctx, captures);
    if (ctx.steps > budget) throw new Error('regex iteration work budget exceeded; verdict unresolved');
    const found = active.findIndex((thread) => program.code[thread.pc].op === 'match');
    if (found >= 0) {
      if (table) table[pos] = 1;
      else if (!captures) return true;
      else {
        active.length = found + 1;
        if (found === 0) return result(active[0], ctx);
      }
    }
    const next = [], [char, width] = ctx.character(pos, backwards);
    if (!width) {
      if (captures && found >= 0) return result(active[found], ctx);
      continue;
    }
    for (const thread of active) {
      const inst = program.code[thread.pc];
      if (inst.op === 'char' && ctx.atom(inst.value, char)) {
        const target = width === 2 ? delayed.get(pos + delta * width) ?? [] : next;
        target.push({ ...thread, pc: inst.next });
        if (width === 2) delayed.set(pos + delta * width, target);
      }
      else if (captures && inst.op === 'match') next.push(thread);
    }
    active = next;
  }
  if (table) return table;
  return captures ? null : false;
}

// Boolean matching needs neither capture histories nor thread priority. A
// dense instruction bitmap keeps the hot path allocation bounded by program
// size, independent of the number of starts competing at a position.
function scanTest(program, ctx, start = 0, table = null) {
  const code = program.code;
  const visited = new Uint8Array(code.length);
  const reverse = program.reversed;
  const n = ctx.chars.length;
  let active = [], next = [];
  const delayed = new Map();
  for (let pos = reverse ? n : start; reverse ? pos >= 0 : pos <= n; pos += reverse ? -1 : 1) {
    visited.fill(0);
    const stack = active;
    stack.push(...(delayed.get(pos) ?? []));
    delayed.delete(pos);
    stack.push(program.start);
    active = [];
    while (stack.length) {
      const pc = stack.pop();
      if (visited[pc]) continue;
      visited[pc] = 1;
      ctx.steps++;
      ctx.budget?.tick();
      if (ctx.steps > CALL_STEP_LIMIT) throw workExceeded(ctx);
      const inst = code[pc];
      if (inst.op === 'split') stack.push(inst.b, inst.a);
      else if (inst.op === 'loop') stack.push(inst.next);
      else if (inst.op === 'assert') { if (ctx.assertion(inst.value, pos)) stack.push(inst.next); }
      else if (inst.op === 'look') { if (Boolean(ctx.tables[inst.id][pos]) !== inst.negative) stack.push(inst.next); }
      else if (inst.op === 'saveStart' || inst.op === 'saveEnd') stack.push(inst.next);
      else if (inst.op === 'match') {
        if (table) table[pos] = 1;
        else return true;
      } else active.push(pc);
    }
    const [char, width] = ctx.character(pos, reverse);
    if (!width) break;
    next.length = 0;
    for (const pc of active) if (ctx.atom(code[pc].value, char)) {
      if (width === 1) next.push(code[pc].next);
      else {
        const target = pos + (reverse ? -width : width);
        const pending = delayed.get(target) ?? [];
        pending.push(code[pc].next);
        delayed.set(target, pending);
      }
    }
    [active, next] = [next, active];
  }
  return table ?? false;
}

function result(thread, ctx) {
  const matched = ctx.subject.slice(thread.start, thread.end);
  const value = [matched, thread.s === undefined ? undefined : ctx.subject.slice(thread.s, thread.e ?? thread.end)];
  value.index = thread.start;
  return value;
}

function prepare(ctx, programs, budget) {
  ctx.budget = budget;
  // Compilation inserts children before their parent. Reverse scans compute
  // all lookahead starts; forward scans compute all lookbehind endpoints.
  for (let id = programs.length - 1; id >= 0; id--) {
    const table = new Uint8Array(ctx.chars.length + 1);
    scanTest(programs[id], ctx, 0, table);
    ctx.tables[id] = table;
  }
  return ctx;
}

export function linearRegex(source, flags = '', { capture = false } = {}) {
  source = String(source);
  if (source.length > SOURCE_LIMIT) throw new Error('pattern length exceeds budget');
  if (flags.includes('v')) throw new Error('unsupported v-flag grammar');
  if (!/^(?!.*(.).*\1)[gimsuy]*$/.test(flags)) throw new Error('unsupported or repeated regex flag');
  if (!capture && /[gy]/.test(flags)) throw new Error('stateful g/y flags require capture mode');
  // Syntax validation compiles only; the resulting native object never sees a subject.
  const validatedSource = new RegExp(source, flags).source;
  if (validatedSource.length > SOURCE_LIMIT * 2) throw new Error('normalized source exceeds budget');
  const tree = parse(source, flags, capture);
  if (capture) checkNullableCaptureRepeat(tree);
  size(tree);
  const candidates = requiredLiterals(tree);
  const literals = !flags.includes('i') && candidates.length && candidates.every((value) => value.length >= 2) ? candidates : [];
  const programs = [];
  const main = compile(tree, programs);
  let lastIndex = 0;
  const matcher = {
    source, flags,
    get lastIndex() { return lastIndex; },
    set lastIndex(value) { lastIndex = value; },
    test(subject, budget) { return execute(subject, flags.includes('g') || flags.includes('y'), budget) !== null; },
    exec(subject) { requireCapture('exec'); return execute(subject, true); },
    matchAll(subject) { requireCapture('matchAll'); return iterate(subject); },
    steps: 0,
    run(subject, withCaptures) { requireCapture('run'); return execute(subject, withCaptures); },
  };
  function requireCapture(operation) {
    if (!capture) throw new Error(`${operation} requires capture mode; compile with { capture: true }`);
  }
  function* iterate(subject) {
    matcher.steps = 0;
    const text = String(subject);
    const ctx = context(text, flags, programs);
    try {
      prepare(ctx, programs);
      ctx.iterating = true;
      const offsets = ctx.offsets;
      const positions = new Uint32Array(text.length + 1);
      for (let index = 0; index < ctx.chars.length; index++) {
        for (let at = offsets[index]; at < offsets[index + 1]; at++) positions[at] = index;
      }
      positions[text.length] = ctx.chars.length;
      let at = Math.max(0, Math.trunc(Number(lastIndex)) || 0);
      const budget = Math.min(CAPTURE_STEP_LIMIT, 16 * (text.length + 1) * (main.code.length + programs.reduce((sum, program) => sum + program.code.length, 1)));
      while (true) {
        if (at > text.length) return;
        const start = flags.includes('u') && at > 0 && /[\uDC00-\uDFFF]/.test(text[at] ?? '') && /[\uD800-\uDBFF]/.test(text[at - 1]) ? at - 1 : at;
        const match = scan(main, ctx, positions[start], true, null, budget, flags.includes('y'));
        if (match === null) return;
        if (ctx.steps > budget) throw new Error('regex iteration work budget exceeded; verdict unresolved');
        yield match;
        at = match.index + match[0].length;
        if (!match[0].length) {
          at += flags.includes('u') && /[\uD800-\uDBFF]/.test(text[at] ?? '') && /[\uDC00-\uDFFF]/.test(text[at + 1] ?? '') ? 2 : 1;
        }
      }
    } finally { matcher.steps = ctx.steps; }
  }
  function execute(subject, withCaptures, budget) {
    matcher.steps = 0;
    budget?.check();
    const text = String(subject);
    const stateful = flags.includes('g') || flags.includes('y');
    const at = stateful ? Math.max(0, Math.trunc(Number(lastIndex)) || 0) : 0;
    if (literals.length && !literals.some((value) => text.includes(value))) {
      matcher.steps = 0;
      if (stateful) lastIndex = 0;
      return null;
    }
    if (at > text.length) {
      if (stateful) lastIndex = 0;
      return null;
    }
    const ctx = context(text, flags, programs);
    try {
      prepare(ctx, programs, budget);
      const index = ctx.offsets.indexOf(at);
      let start = index < 0 ? ctx.offsets.findIndex((offset) => offset > at) - 1 : index;
      if (flags.includes('u') && start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '') && /[\uD800-\uDBFF]/.test(text[start - 1])) start--;
      let value = null;
      if (start >= 0) value = withCaptures ? scan(main, ctx, start, true, null, Infinity, flags.includes('y')) : scanTest(main, ctx, start);
      if (stateful) lastIndex = value ? value.index + value[0].length : 0;
      return value === false ? null : value;
    } finally { matcher.steps = ctx.steps; }
  }
  return matcher;
}
