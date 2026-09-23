// Bounded streaming defense for visible assistant text. Tool input stays raw for tool.call refusal.
//
// INVARIANT, locked by the "stream fragment invariant" property test in hooks.selftest.mjs:
// emitted text never carries a raw run of FRAGMENT or more characters of any value that is known
// (the token vault) or detected at the moment of emission. Text carrying no such run is emitted
// unchanged - possibly later, and split across different chunk boundaries. Any masking carries the
// redaction note once per stream and one journal callback.
//
// The cut between "emit now" and "hold" is never chosen by length alone: it is pushed back out of
// every secret span, so a secret can never be cut in half and released as two harmless-looking
// halves.
import { config } from './config.js';
import { detections, optionalDetections } from './detector.js';
import { scrub } from './scrub.js';
import { knownTokens, replacementFor, tokenize } from './token-vault.js';

const FRAGMENT = 8;
const HOLD = 512;
const CONTEXT = 256;
const MAX_BUFFER = 65536;
const OVERSIZED = '[wt-secret-guard: oversized secret-bearing stream block masked]';
const BEGIN = '-----BEGIN ';
const END = '-----END ';
// An unfinished quoted assignment holds until its closing quote arrives. The value may span LINES -
// a newline does not close a quote - so the hold follows the quote, never the line.
const OPEN_ASSIGNMENT = /(?:password|token|secret)["']?\s*[=:]\s*(["'])(?:(?!\1)[\s\S])*$/i;
// An unquoted value still running at the end of the text. It ends at the LINE: `password: value`
// is detected to the end of its line, and ending `password=value` there too only over-masks the rest
// of that line, which is the safe direction. `(?![ \t"'])` stops the space run from backtracking onto
// the opening quote of an already-closed quoted value.
const OPEN_UNQUOTED = /(?:password|token|secret)\s*[=:][ \t]*(?![ \t"'])[^\n]*$/i;
const UNQUOTED_END = /\n/;

function cleanText(text) { return scrub(text, '').value; }

function unquote(value) {
  const trimmed = value.trim();
  return /^(["'])[\s\S]*\1$/.test(trimmed) && trimmed.length > 1 ? trimmed.slice(1, -1) : trimmed;
}

// A detected value carries its own syntax ("export FOO_TOKEN=x", "password: y"). Only the part that
// is actually confidential earns fragment matching; the key name is ordinary text everywhere else.
function cores(kind, value) {
  if (kind === 'assignment' || kind === 'environment-dump') return [unquote(value.slice(value.indexOf('=') + 1))];
  if (kind === 'op-output' || kind === 'key-value') return [unquote(value.slice(value.indexOf(':') + 1))];
  if (kind === 'private-key') return value.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('-----'));
  return [value];
}

function eligible(kind, options) {
  if (kind === 'credential-uuid') return false;
  if (kind === 'email') return options.maskEmails === true;
  if (kind === 'ip-address') return options.maskIpAddresses === true;
  return true;
}

let fragments = { size: -1, emails: null, addresses: null, index: new Map() };

// Every FRAGMENT-long window of a value's confidential core, mapped to what a span carrying it
// renders as: a vault label, or - for a value this emission is the first to detect - the kind and
// hidden text that `labelFor` tokenises into the same label its whole occurrence gets.
function addGrams(index, kind, value, descriptor, options) {
  if (typeof value !== 'string' || !value || !eligible(kind, options)) return index;
  for (const core of cores(kind, value)) {
    for (let at = 0; at + FRAGMENT <= core.length; at += 1) {
      const gram = core.slice(at, at + FRAGMENT);
      if (!index.has(gram)) index.set(gram, descriptor);
    }
  }
  return index;
}

function fragmentIndex() {
  const vault = knownTokens();
  const options = config();
  if (fragments.size === vault.size && fragments.emails === options.maskEmails && fragments.addresses === options.maskIpAddresses) return fragments.index;
  const index = new Map();
  for (const [label, entry] of vault) addGrams(index, entry.kind, entry.value, { label }, options);
  fragments = { size: vault.size, emails: options.maskEmails, addresses: options.maskIpAddresses, index };
  return index;
}

function occurrences(text, value, from) {
  const found = [];
  for (let at = text.indexOf(value, Math.max(0, from - value.length)); at !== -1; at = text.indexOf(value, at + 1)) found.push(at);
  return found;
}

function secretSpans(text, from, final) {
  const options = config();
  const spans = [];
  for (const [label, entry] of knownTokens()) {
    if (typeof entry.value !== 'string' || !entry.value || !eligible(entry.kind, options)) continue;
    if (entry.value.length >= FRAGMENT) continue; // longer values are covered by the fragment index
    for (const at of occurrences(text, entry.value, from)) spans.push({ start: at, end: at + entry.value.length, label });
  }
  const found = [
    ...detections(text),
    ...optionalDetections(text, { emails: options.maskEmails, ipAddresses: options.maskIpAddresses }),
  ];
  for (const finding of found) {
    if (typeof finding.value !== 'string' || !finding.value) continue;
    const hidden = finding.secret ?? finding.value;
    for (const at of occurrences(text, finding.value, from)) spans.push({ start: at, end: at + finding.value.length, kind: finding.kind, hidden });
  }
  const index = fragmentIndex();
  // THIS emission's detections are indexed too, before the scan: a value detected for the first time
  // here must protect its own fragments in the same text, or its whole occurrence is masked while a
  // shorter run of it beside is released raw.
  const local = new Map();
  for (const finding of found) addGrams(local, finding.kind, finding.value, { kind: finding.kind, hidden: finding.secret ?? finding.value }, options);
  if (index.size || local.size) {
    // Contiguous matches are merged as they are found: a 6,000-character run is one span, not
    // 6,000 of them, which keeps the cut search linear instead of quadratic.
    let run = null;
    for (let at = Math.max(0, from - FRAGMENT + 1); at + FRAGMENT <= text.length; at += 1) {
      const gram = text.slice(at, at + FRAGMENT);
      const carrier = index.get(gram) ?? local.get(gram);
      if (carrier === undefined) { run = null; continue; }
      if (run && at <= run.end) { run.end = at + FRAGMENT; continue; }
      run = { start: at, end: at + FRAGMENT, ...carrier };
      spans.push(run);
    }
  }
  if (final) {
    const open = OPEN_ASSIGNMENT.exec(text);
    if (open) spans.push({ start: open.index, end: text.length, kind: 'assignment', hidden: text.slice(open.index) });
    const begin = text.lastIndexOf(BEGIN);
    if (begin !== -1 && text.indexOf(END, begin) === -1) spans.push({ start: begin, end: text.length, kind: 'private-key', hidden: text.slice(begin) });
  }
  return spans.filter((span) => span.end > from).sort((left, right) => left.start - right.start || right.end - left.end);
}

// What a discarded buffer was in the MIDDLE of, and the text that will end it. Discarding the bytes
// at the size cap must not discard this: the continuation of an unfinished value matches no detector
// on its own, so without it the opening is masked and the rest is released.
//
// Three shapes, each with its own terminator:
// - a quoted assignment ends at its closing quote (consumed with the value);
// - a private key ends at `-----END `, which can arrive split across chunks, so `carry` keeps the
//   last characters that could be its beginning;
// - ANY other detection still running at the end of the buffer - whatever its kind - ends at the end
//   of its line; the newline is ordinary text, so it is kept. The test is "a detection reaches the
//   buffer's end", not a list of kinds: a list is exactly what let `API_KEY=` and `credential:` through.
function openState(text) {
  const open = OPEN_ASSIGNMENT.exec(text);
  if (open) return { kind: 'assignment', terminator: open[1], carry: 0 };
  const begin = text.lastIndexOf(BEGIN);
  if (begin !== -1 && text.indexOf(END, begin) === -1) return { kind: 'private-key', terminator: END, carry: END.length - 1 };
  if (OPEN_UNQUOTED.test(text)) return { kind: 'assignment', pattern: UNQUOTED_END, carry: 0 };
  const reachesEnd = detections(text).some(({ value }) => typeof value === 'string' && value && text.endsWith(value));
  if (reachesEnd) return { kind: 'detected', pattern: UNQUOTED_END, carry: 0 };
  return null;
}

// Where the open value ends in `text`: the index the ordinary text resumes at, or -1.
function closeOf(open, text) {
  if (open.pattern) { const found = open.pattern.exec(text); return found ? found.index : -1; }
  const at = text.indexOf(open.terminator);
  return at < 0 ? -1 : at + open.terminator.length;
}

function cutPoint(raw, spans, offset) {
  let cut = raw.length - HOLD;
  const begin = raw.lastIndexOf(BEGIN);
  if (begin !== -1 && raw.indexOf(END, begin) === -1) cut = Math.min(cut, begin);
  const open = OPEN_ASSIGNMENT.exec(raw);
  if (open) cut = Math.min(cut, open.index);
  for (let moved = true; moved && cut > 0;) {
    moved = false;
    for (const span of spans) {
      const start = span.start - offset;
      const end = span.end - offset;
      if (start < cut && cut < end) { cut = start; moved = true; }
    }
    const code = cut > 0 && cut < raw.length ? raw.charCodeAt(cut) : 0;
    if (code >= 0xdc00 && code <= 0xdfff) { cut -= 1; moved = true; }
  }
  return Math.max(0, Math.min(cut, raw.length));
}

// A held value is never emitted as another held value's spelling (see replacementFor).
function labelFor(span) { return span.label ? replacementFor(span.label) : tokenize(span.kind, span.hidden); }

function render(text, from, to, spans) {
  const ranges = [];
  for (const span of spans) {
    const start = Math.max(span.start, from);
    const end = Math.min(span.end, to);
    if (end <= start) continue;
    const last = ranges.at(-1);
    if (last && start <= last.end) { last.end = Math.max(last.end, end); continue; }
    ranges.push({ start, end, span });
  }
  let value = '';
  let cursor = from;
  for (const range of ranges) { value += text.slice(cursor, range.start) + labelFor(range.span); cursor = range.end; }
  value += text.slice(cursor, to);
  return { value, changed: ranges.length > 0 };
}

export async function* maskTurnStep(event, next, note, masked) {
  const blocks = new Map();
  let noted = false;
  let journaled = false;
  const announce = async () => { if (!journaled) { journaled = true; await masked(); } };

  const emit = async function* (key, final) {
    const block = blocks.get(key);
    if (!block) return;
    if (block.open) {
      // The buffer carrying this value's opening was discarded at the size cap. Everything that
      // follows is still inside it, and nothing in it looks confidential on its own, so it is
      // dropped until its terminator arrives rather than emitted.
      if (block.raw) { block.masked = true; await announce(); }
      // The tail kept from earlier chunks is searched WITH the new text, so a terminator split across
      // a chunk boundary is still found whole.
      const scanned = `${block.carry ?? ''}${block.raw}`;
      const resume = closeOf(block.open, scanned);
      if (resume < 0) {
        block.carry = block.open.carry ? scanned.slice(-block.open.carry) : '';
        block.raw = '';
        if (!final) return;
        blocks.delete(key);
        if (block.masked && !noted) { noted = true; yield { ...block.chunk, text: note }; }
        return;
      }
      block.raw = scanned.slice(resume);
      block.carry = '';
      block.context = '';
      block.open = null;
    }
    const text = `${block.context}${block.raw}`;
    const offset = block.context.length;
    const spans = secretSpans(text, offset, final);
    const cut = final ? block.raw.length : cutPoint(block.raw, spans, offset);
    if (final) blocks.delete(key);
    if (!final && cut <= 0) return;
    const rendered = render(text, offset, offset + cut, spans);
    block.context = `${block.context}${block.raw.slice(0, cut)}`.slice(-CONTEXT);
    block.raw = block.raw.slice(cut);
    let value = rendered.value;
    if (rendered.changed) { block.masked = true; await announce(); }
    if (final && block.masked && !noted) { value = `${value}\n${note}`; noted = true; }
    if (value) yield { ...block.chunk, text: value };
  };
  const flushAll = async function* (except) {
    for (const key of [...blocks.keys()]) if (key !== except) yield* emit(key, true);
  };

  const iterator = next(event)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        yield* flushAll();
        const cleaned = scrub(step.value, '');
        if (cleaned.changed) await announce();
        return cleaned.value;
      }
      const chunk = step.value;
      if (chunk.kind !== 'text') {
        yield* flushAll();
        yield chunk;
        continue;
      }
      const key = `${chunk.kind}:${chunk.index}`;
      yield* flushAll(key);
      const block = blocks.get(key) ?? { raw: '', context: '', masked: false, chunk };
      block.chunk = chunk;
      block.raw += chunk.text ?? '';
      blocks.set(key, block);
      yield* emit(key, false);
      if (block.raw.length > MAX_BUFFER) {
        const discarded = `${block.context}${block.raw}`;
        block.open = openState(discarded);
        // The tail of the DISCARDED text is kept too: a terminator whose first half ends this very
        // chunk must still be found whole when its second half arrives.
        block.carry = block.open?.carry ? discarded.slice(-block.open.carry) : '';
        block.raw = '';
        block.context = '';
        block.masked = true;
        await announce();
        yield { ...chunk, text: OVERSIZED };
      }
    }
  } finally {
    yield* flushAll();
  }
}

export async function maskAssistantRender(event, next) {
  const text = event.props?.text;
  if (typeof text !== 'string') return next(event);
  const cleaned = cleanText(text);
  return next(cleaned === text ? event : { ...event, props: { ...event.props, text: cleaned } });
}
