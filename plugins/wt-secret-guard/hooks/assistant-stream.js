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
import { knownTokens, tokenize } from './token-vault.js';

const FRAGMENT = 8;
const HOLD = 512;
const CONTEXT = 256;
const MAX_BUFFER = 65536;
const OVERSIZED = '[wt-secret-guard: oversized secret-bearing stream block masked]';
const BEGIN = '-----BEGIN ';
const END = '-----END ';
const OPEN_ASSIGNMENT = /(?:password|token|secret)\s*[=:]\s*(["'])(?:(?!\1)[^\n])*$/i;

function cleanText(text) { return scrub(text, '').value; }

function unquote(value) {
  const trimmed = value.trim();
  return /^(["'])[\s\S]*\1$/.test(trimmed) && trimmed.length > 1 ? trimmed.slice(1, -1) : trimmed;
}

// A detected value carries its own syntax ("export FOO_TOKEN=x", "password: y"). Only the part that
// is actually confidential earns fragment matching; the key name is ordinary text everywhere else.
function cores(kind, value) {
  if (kind === 'assignment' || kind === 'environment-dump') return [unquote(value.slice(value.indexOf('=') + 1))];
  if (kind === 'op-output') return [unquote(value.slice(value.indexOf(':') + 1))];
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

function fragmentIndex() {
  const vault = knownTokens();
  const options = config();
  if (fragments.size === vault.size && fragments.emails === options.maskEmails && fragments.addresses === options.maskIpAddresses) return fragments.index;
  const index = new Map();
  for (const [label, entry] of vault) {
    if (typeof entry.value !== 'string' || !eligible(entry.kind, options)) continue;
    for (const core of cores(entry.kind, entry.value)) {
      for (let at = 0; at + FRAGMENT <= core.length; at += 1) {
        const gram = core.slice(at, at + FRAGMENT);
        if (!index.has(gram)) index.set(gram, label);
      }
    }
  }
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
  const index = fragmentIndex();
  if (index.size) {
    // Contiguous matches are merged as they are found: a 6,000-character run is one span, not
    // 6,000 of them, which keeps the cut search linear instead of quadratic.
    let run = null;
    for (let at = Math.max(0, from - FRAGMENT + 1); at + FRAGMENT <= text.length; at += 1) {
      const label = index.get(text.slice(at, at + FRAGMENT));
      if (label === undefined) { run = null; continue; }
      if (run && at <= run.end) { run.end = at + FRAGMENT; continue; }
      run = { start: at, end: at + FRAGMENT, label };
      spans.push(run);
    }
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
  if (final) {
    const open = OPEN_ASSIGNMENT.exec(text);
    if (open) spans.push({ start: open.index, end: text.length, kind: 'assignment', hidden: text.slice(open.index) });
    const begin = text.lastIndexOf(BEGIN);
    if (begin !== -1 && text.indexOf(END, begin) === -1) spans.push({ start: begin, end: text.length, kind: 'private-key', hidden: text.slice(begin) });
  }
  return spans.filter((span) => span.end > from).sort((left, right) => left.start - right.start || right.end - left.end);
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

function labelFor(span) { return span.label ?? tokenize(span.kind, span.hidden); }

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
