// Outbound-only writer-value boundaries. Detector captures remain the inbound contract.
import { contextualMatches, DISTINCT_VALUE_FLOOR } from './detector.js';

export const WIDE_REFERENCE = /(?:op:\/\/[^\s"']+|secret:(?:env|file|1p):[^\s"']+|\$\{[A-Za-z_][A-Za-z0-9_]*\}|secret:[a-z-]+#[a-f0-9]{6})/gi;
const REFERENCE_SOURCE = '(?:\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|secret:(?:env):[A-Za-z_][A-Za-z0-9_]*|(?:secret:(?:file|1p):|op://)[^\\s"\'`,;#()\\[\\]{}<>]+|secret:[a-z-]+#[a-f0-9]{6})(?![A-Za-z0-9_])';
const REFERENCE_AT = new RegExp(`^${REFERENCE_SOURCE}`, 'i');
const REFERENCE_ALL = new RegExp(REFERENCE_SOURCE, 'gi');
const CONTEXTUAL = new Set(['assignment', 'op-output', 'key-value', 'environment-dump']);
// Union of JS \s (including U+2028/U+2029) and Python str.isspace/splitlines.
const LEADING_WHITESPACE = /^[\s\u0085\u001c-\u001f]*/u;
export const isContextual = (kind) => CONTEXTUAL.has(kind);
export const blankReferences = (value) => value.replace(WIDE_REFERENCE, (reference) => ' '.repeat(reference.length));

function passCandidates(text, candidate, base) {
  return contextualMatches(candidate).map((item) => {
    const start = candidate.indexOf(item.value);
    const finding = { kind: item.kind, value: text.slice(start, start + item.value.length), index: start };
    return { ...item, base, finding };
  });
}

export function discoverCandidates(text) {
  const blanked = blankReferences(text);
  const base = passCandidates(text, blanked, true);
  const ranges = [...text.matchAll(WIDE_REFERENCE)].map((match) => [match.index, match.index + match[0].length]);
  const raw = passCandidates(text, text, false).filter((item) =>
    !base.some((previous) => previous.kind === item.kind && previous.keyStart === item.keyStart)
    && !ranges.some(([start, end]) => item.keyStart >= start && item.keyStart < end));
  return [...base, ...raw];
}

function quoteAt(text, at) {
  if (text[at] !== '"' && text[at] !== "'") return '';
  return text.startsWith(text[at].repeat(3), at) ? text[at].repeat(3) : text[at];
}

function scanCharacter(text, at, state) {
  if (state.quote) {
    if (text[at] === '\\' && state.quote[0] !== "'") return at + 2;
    if (text.startsWith(state.quote, at)) { const length = state.quote.length; state.quote = ''; return at + length; }
    return at + 1;
  }
  const quote = quoteAt(text, at);
  if (quote) { state.quote = quote; return at + quote.length; }
  // References contain braces that are not writer brackets.
  const reference = text.slice(at).match(REFERENCE_AT);
  if (reference) return at + reference[0].length;
  if ('([{'.includes(text[at])) state.depth += 1;
  if (')]}'.includes(text[at])) state.depth = Math.max(0, state.depth - 1);
  return at + 1;
}

function lineContext(text, item) {
  const start = Math.max(text.lastIndexOf('\n', item.keyStart - 1), text.lastIndexOf('\r', item.keyStart - 1)) + 1;
  const prefix = text.slice(0, start);
  const header = /(?:^|[\r\n])[ \t]*\[[^\]\r\n]+\][ \t]*(?:\r\n|[\r\n]|$)/.test(prefix);
  const indent = text.slice(start).split(/[\r\n]/, 1)[0].match(LEADING_WHITESPACE)[0].length;
  const colon = text.slice(item.keyStart, item.valueStart).includes(':');
  return { header, indent, deeper: header || colon || Boolean(quoteAt(text, item.valueStart)) };
}

function nextDeeper(text, at, indent) {
  let cursor = at;
  const skipped = [];
  while (cursor < text.length) {
    const newline = text.indexOf('\n', cursor);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(cursor, end);
    const width = line.match(LEADING_WHITESPACE)[0].length;
    if (/^(?:[#;][^\n]*)?$/.test(line.slice(width))) { skipped.push([cursor, end]); cursor = end + 1; continue; }
    return width > indent ? { cursor, skipped } : null;
  }
  return null;
}

function nextKeyBoundary(text, at, item, candidates, context, state) {
  if (context.header || state.quote || !';,'.includes(text[at])) return false;
  const next = candidates.find((candidate) => candidate.keyStart > at && candidate.keyStart !== item.keyStart
    && /^[ \t]*$/.test(text.slice(at + 1, candidate.keyStart)));
  return Boolean(next);
}

export function valueExtent(text, item, candidates = []) {
  const context = lineContext(text, item);
  const state = { quote: '', depth: 0 };
  const skipped = [];
  let at = item.valueStart;
  while (at < text.length) {
    if (nextKeyBoundary(text, at, item, candidates, context, state)) break;
    if (text[at] !== '\n') { at = scanCharacter(text, at, state); continue; }
    if (state.quote || state.depth || text[at - 1] === '\\') { at += 1; continue; }
    const next = context.deeper ? nextDeeper(text, at + 1, context.indent) : null;
    if (!next) break;
    skipped.push(...next.skipped);
    at = next.cursor;
  }
  // Project out only the recognised key prefix, retaining the full writer end.
  return finishedExtent(text, item, at, skipped);
}

function finishedExtent(text, item, at, skipped) {
  const start = item.valueStart;
  const end = Math.max(at, item.base ? item.captureEnd : at);
  let content = text.slice(start, end);
  for (const [from, to] of skipped.reverse()) content = content.slice(0, from - start) + ' '.repeat(to - from) + content.slice(to - start);
  return { start, end, text: content };
}

function proofItem(text, mode) {
  const quote = mode === 'decoded' || mode === 'xml' ? '' : quoteAt(text, 0);
  const reference = text.slice(quote.length).match(REFERENCE_AT)?.[0];
  if (!reference) return 0;
  const end = quote.length + reference.length;
  return !quote || text.startsWith(quote, end) ? end + quote.length : 0;
}

function proofSeparator(text, quotedJoin) {
  const plain = text.match(/^\s*[,;]?\s*/)[0];
  if (plain.length) return plain.length;
  if (quotedJoin && /^["']/.test(text)) return 0;
  return -1;
}

function proofTail(text, mode) {
  return !text.trim() || (mode !== 'xml' && /^\s*[,;]\s*$/.test(text));
}

function itemSeparator(text, mode, quoted) {
  if (mode === 'xml') return text.match(/^\s+/)?.[0].length ?? -1;
  const plus = quoted ? text.match(/^\s*\+\s*(?=["'])/)?.[0] : undefined;
  return plus?.length ?? proofSeparator(text, quoted);
}

function proofText(value, mode) {
  const text = mode === 'xml' ? value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : value;
  if (mode === 'xml' && /[<&]/.test(text)) return null;
  return text.trim();
}

export function referenceProof(value, mode = 'extent') {
  let text = proofText(value, mode);
  if (text === null) return false;
  if (mode === 'extent') text = text.replace(/^[([{]+\s*/, '');
  let items = 0;
  while (text) {
    const quoted = /^["']/.test(text);
    const length = proofItem(text, mode);
    if (!length) return false;
    items += 1;
    text = text.slice(length);
    if (mode === 'extent') text = text.replace(/^\s*[)\]}]+\s*/, '');
    if (proofTail(text, mode)) return true;
    const sep = itemSeparator(text, mode, quoted);
    if (sep < 0) return false;
    text = text.slice(sep);
  }
  return items > 0;
}

export function residueFindings(text, kind, index = 0) {
  const residue = text.replace(REFERENCE_ALL, (reference) => ' '.repeat(reference.length));
  const runs = [...residue.matchAll(/[^\s"'`,;()\[\]{}<>]+/g)].filter((match) => match[0].length >= DISTINCT_VALUE_FLOOR);
  if (runs.length) return runs.map((match) => ({ kind, value: match[0], index: index + match.index }));
  return [{ kind, value: text.trim(), index }];
}

export function xmlElements(text) {
  const opening = /<(password|token|secret|credential)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  const found = [];
  for (const match of text.matchAll(opening)) {
    const start = match.index + match[0].length;
    const closing = new RegExp(`</${match[1]}\\s*>`, 'g');
    closing.lastIndex = start;
    const close = closing.exec(text);
    found.push({ start, end: close?.index ?? text.length, text: text.slice(start, close?.index ?? text.length) });
  }
  return found;
}

export function boundaryFindings(text) {
  const candidates = discoverCandidates(text);
  const found = [];
  for (const item of candidates) {
    const extent = valueExtent(text, item, candidates);
    if (referenceProof(extent.text)) continue;
    const genuine = item.base && !referenceProof(item.finding.value);
    found.push(...(genuine ? [item.finding] : residueFindings(extent.text, item.kind, extent.start)));
  }
  for (const element of xmlElements(text)) {
    if (!referenceProof(element.text, 'xml')) found.push(...residueFindings(element.text, 'xml-element', element.start));
  }
  return found;
}
