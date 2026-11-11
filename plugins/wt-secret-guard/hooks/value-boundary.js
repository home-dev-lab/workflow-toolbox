// A cancellation is a narrow literal spelling; discovery stays the frozen detector's.
import { contextualMatches, DISTINCT_VALUE_FLOOR } from './detector.js';

export const WIDE_REFERENCE = /(?:op:\/\/[^\s"']+|secret:(?:env|file|1p):[^\s"']+|\$\{[A-Za-z_][A-Za-z0-9_]*\}|secret:[a-z-]+#[a-f0-9]{6})/gi;
const STRICT = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|secret:(?:env):[A-Za-z_][A-Za-z0-9_]*|(?:secret:(?:file|1p):|op:\/\/)[^\s"'`,;#()\[\]{}<>]+|secret:[a-z-]+#[a-f0-9]{6})$/i;
const RESIDUE_REFERENCE = new RegExp(`${STRICT.source.slice(1, -1)}(?![A-Za-z0-9_])`, 'gi');
const CONTEXTUAL = new Set(['assignment', 'op-output', 'key-value', 'environment-dump']);
const SPACE = /^[\s\u0085\u001c-\u001f]*/u;
export const isContextual = (kind) => CONTEXTUAL.has(kind);
export const blankReferences = (value) => value.replace(WIDE_REFERENCE, (reference) => ' '.repeat(reference.length));
export const referenceProof = (value) => STRICT.test(value);

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

function prefixState(text, end) {
  const state = { quote: '', depth: 0 };
  const brackets = [];
  for (let at = 0; at < end; at += 1) {
    at = prefixCharacter(text, at, state, brackets);
  }
  return state;
}

function prefixCharacter(text, at, state, brackets) {
  if (text[at] === '\\' && state.quote !== "'") return at + 1;
  if (state.quote) return quotedCharacter(text, at, state);
  const reference = text.slice(at).match(new RegExp(`^(?:${WIDE_REFERENCE.source})`, 'i'));
  if (reference) return at + reference[0].length - 1;
  const quote = quoteAt(text, at);
  if (quote) { state.quote = quote; return at + quote.length - 1; }
  updateBrackets(text[at], brackets);
  state.depth = brackets.length;
  return at;
}

function updateBrackets(character, brackets) {
  if ('([{'.includes(character)) brackets.push(character);
  const closing = ')]}'.indexOf(character);
  if (closing >= 0 && brackets.at(-1) === '([{'[closing]) brackets.pop();
}

function quotedCharacter(text, at, state) {
  if (!text.startsWith(state.quote, at)) return at;
  const next = at + state.quote.length - 1;
  state.quote = '';
  return next;
}

function literalParts(text, item) {
  const start = text.lastIndexOf('\n', item.keyStart - 1) + 1;
  const end = text.indexOf('\n', item.keyStart);
  const stop = end < 0 ? text.length : end;
  const line = text.slice(start, stop);
  const raw = text.slice(item.keyStart, stop);
  const match = raw.match(/^("[A-Za-z_][\w.-]*"|[A-Za-z_][\w.-]*)[ \t]*([=:])[ \t]*(.*)$/);
  if (!match) return null;
  return { start, stop, line, match, ...tailParts(match[3]) };
}

function tailParts(tail) {
  const quote = /^["']/.test(tail) ? tail[0] : '';
  const close = quote ? tail.indexOf(quote, 1) : -1;
  const reference = quote ? tail.slice(1, close < 0 ? undefined : close) : tail.match(/^\$\{[^}]*\}|^[^,}\s]+/)?.[0] ?? '';
  const residue = tail.slice(reference.length + (quote ? 2 : 0));
  return { quote, close, reference, residue };
}

function nextLineSafe(text, parts) {
  const next = text.slice(parts.stop + 1).split('\n').find((line) => line.slice(line.match(SPACE)[0].length));
  // Also retain shallow sibling refusals: no writer grammar is inferred beyond this line.
  return next === undefined;
}

export function routeSMatch(text, item) {
  const parts = literalParts(text, item);
  if (!parts) return false;
  const state = prefixState(text, item.keyStart);
  const checks = routeChecks(text, parts, state);
  return allChecks(checks);
}

function validShape(parts) {
  return (!parts.quote || parts.close > 0) && (!parts.match[1].startsWith('"') || (parts.match[2] === ':' && parts.quote === '"'));
}

function routeChecks(text, parts, state) {
  return {
    shape: validShape(parts),
    reference: STRICT.test(parts.reference),
    terminator: /^(?:[,}]*)$/.test(parts.residue),
    deeper: nextLineSafe(text, parts),
    literal: !state.quote,
    bracket: !state.depth,
    backslash: !/\\$/.test(parts.line) && !/\\\n$/.test(text.slice(0, parts.start)),
    line: !/[\r\u0085\u2028\u2029]/u.test(parts.line),
    eof: parts.stop < text.length || !parts.residue,
  };
}

function allChecks(checks) {
  return checks.shape && checks.reference && checks.terminator && checks.deeper
    && checks.literal && checks.bracket && checks.backslash && checks.line && checks.eof;
}

export function boundaryFindings(text) {
  const found = [];
  for (const item of discoverCandidates(text)) {
    if (routeSMatch(text, item)) continue;
    if (item.base) {
      found.push(item.finding);
      if ([...item.finding.value.matchAll(WIDE_REFERENCE)].length) for (const raw of rawFindings(text, item)) found.push(raw);
    }
    else for (const raw of rawFindings(text, item)) found.push(raw);
  }
  for (const element of xmlElements(text)) {
    if (!referenceProof(element.text)) for (const raw of residueFindings(element.text, 'xml-element', element.start)) found.push(raw);
  }
  return found;
}

function rawFindings(text, item) {
  const value = text.slice(item.valueStart);
  // Frozen discovery accepts a bare reference terminated by CRLF. Do not promote
  // its raw-only candidate into a new finding merely because Route S rejects CR.
  if (referenceProof(value.trim().replace(/^(["'])(.*)\1$/s, '$2'))) return [];
  return residueFindings(value, item.kind, item.valueStart);
}

export function residueFindings(text, kind, index = 0) {
  const residue = text.replace(RESIDUE_REFERENCE, (reference) => ' '.repeat(reference.length));
  const runs = [...residue.matchAll(/[^\s"'`,;()\[\]{}<>]+/g)].filter((match) => match[0].length >= DISTINCT_VALUE_FLOOR);
  if (runs.length) return runs.map((match) => ({ kind, value: match[0], index: index + match.index }));
  return text.trim() && !referenceProof(text.trim()) ? [{ kind, value: text.trim(), index }] : [];
}

export function xmlElements(text) {
  const opening = /<(password|token|secret|credential)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  const found = [];
  for (const match of text.matchAll(opening)) {
    const start = match.index + match[0].length;
    const closing = new RegExp(`</${match[1]}\\s*>`, 'g');
    closing.lastIndex = start;
    const close = closing.exec(text);
    found.push({ start, text: text.slice(start, close?.index ?? text.length) });
  }
  return found;
}
