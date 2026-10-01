// Bounded store keys. The host refuses a store write when the WHOLE store would exceed STORE_LIMIT characters of compact
// JSON text, so every key this hook writes has a budget in that same measure, the budgets plus the JSON punctuation of the
// store object leave STORE_MARGIN free, and a write that would cross a budget first moves the oldest data to an archive
// file in the quality data directory, where the readers (rollback-check, compliance-report, serve-verdict-reconcile,
// quality-check) read it back. Nothing leaves the store without being written to an archive first.
// Pure: the host I/O that applies these plans lives in hooks.js (a Function Hooks module passes `$` to nothing it imports).

export const STORE_LIMIT = 4_194_304;
export const VERDICTS = 'compliance-verdicts-jsonl';
export const STORE_BUDGETS = Object.freeze({ [VERDICTS]: 1_200_000, sessions: 2_000_000, served: 200_000, health: 50_000 });
// Keys this version never writes (an older version's) are counted against this allowance and never evicted.
export const FOREIGN_KEYS_BUDGET = 50_000;
// `{`, `}`, one comma between keys, and `"name":` per budgeted key.
export const STORE_OVERHEAD = 2 + Object.keys(STORE_BUDGETS).length - 1 + Object.keys(STORE_BUDGETS).reduce((sum, name) => sum + JSON.stringify(name).length + 1, 0);
export const STORE_MARGIN = STORE_LIMIT - FOREIGN_KEYS_BUDGET - STORE_OVERHEAD - Object.values(STORE_BUDGETS).reduce((sum, budget) => sum + budget, 0);
// Hysteresis: an over-budget key is cut to this fraction of its budget, so steady state archives once per many acts.
export const EVICT_TO = 0.6;
// The host refuses a file write over 4 MiB: an archive file is cut into parts of at most this many UTF-8 bytes.
export const ARCHIVE_PART_BYTES = 3_000_000;
// Verdict archives keep the newest files up to this many bytes on disk: 14 files of 3.5 MB, the verdict history the
// previous rotation kept, now independent of how often a smaller budget rotates. Store-key archives (sessions, served,
// health) are never deleted: they hold the only copy of what left the store, and they grow slowly.
export const ARCHIVE_RETENTION_BYTES = 49_000_000;
export const VERDICT_ARCHIVE = { prefix: 'compliance-verdicts-archive-', suffix: '.jsonl', unknownSize: 3_500_000, retained: ARCHIVE_RETENTION_BYTES };
export const STORE_ARCHIVE = { prefix: 'rod-store-archive-', suffix: '.json', unknownSize: ARCHIVE_PART_BYTES, retained: Infinity };
export const MIN_BUDGET = 1024;

export const jsonLength = (value) => (value === undefined ? 0 : JSON.stringify(value).length);
const byteLength = (text) => new TextEncoder().encode(text).length;
const stamp = (value) => (typeof value === 'string' ? value : '');
export const property = (name, value) => jsonLength(name) + 1 + jsonLength(value) + 1;

// The newest instant a context was written at: its own stamp, else the newest one its rows carry.
export function contextLast(ctx, session) {
  if (typeof ctx?.last === 'string') return ctx.last;
  const rows = (field) => (Array.isArray(ctx?.[field]) ? ctx[field] : []);
  const stamps = [ctx?.lastClose?.at, rows('complianceInjected').at(-1)?.at, rows('triggerErrors').at(-1)?.at,
    ...rows('governedActs').map((item) => item?.last ?? item?.at)].map(stamp).filter(Boolean).sort();
  return stamps.at(-1) ?? stamp(session?.first);
}
export const emptyContext = () => ({ served: {}, suppressedCap: {}, governedActs: [], complianceInjected: [] });
// Segment identity. A context or served counter gets a `seg` when it is created and a new one when it restarts empty after
// an eviction, so every copy of one segment (an archive and the live value after a crash between the two writes, or two
// processes archiving the same value) is one segment to a reader, which counts it once. A unit written before segments
// existed gets this deterministic one when it is archived: such a unit exists once, until its first eviction.
export const legacyContextSeg = (sessionId, key) => `legacy:${sessionId}:${key}`;
export const legacyServedSeg = (key) => `legacy:served:${key}`;

// Verdict lines: everything but the line being appended moves out, as the rotation always did.
function shrinkVerdicts(text, budget, keep) {
  const value = String(text ?? '');
  if (jsonLength(value) <= budget) return { value, evicted: null };
  const tail = keep?.line && value.endsWith(keep.line) && jsonLength(keep.line) <= budget ? keep.line : '';
  return { value: tail, evicted: value.slice(0, value.length - tail.length) };
}

// Sessions: whole contexts move out, oldest last activity first; the context being written goes last, and when it alone
// is over the budget it moves out too and restarts empty under a new segment. A session left with no context moves out
// whole. What moves out is a list of units `{ sessionId, first, last, key, context }` (`key` null for a whole session),
// each context carrying its segment, so a later pass appends to the list and never replaces an earlier unit.
function shrinkSessions(sessions, budget, keep) {
  let size = jsonLength(sessions);
  if (size <= budget) return { value: sessions, evicted: null };
  const target = Math.floor(budget * EVICT_TO);
  const value = { ...sessions };
  const evicted = [];
  const units = [];
  for (const [id, session] of Object.entries(value)) {
    const contexts = Object.entries(session?.contexts ?? {});
    if (!contexts.length) units.push({ id, last: stamp(session?.last), current: keep?.id === id });
    for (const [ck, ctx] of contexts) units.push({ id, ck, last: contextLast(ctx, session), current: keep?.id === id && keep?.ck === ck });
  }
  units.sort((a, b) => Number(a.current) - Number(b.current) || a.last.localeCompare(b.last));
  const copied = new Set();
  for (const unit of units) {
    if (size <= target) break;
    const session = value[unit.id];
    if (!session) continue;
    if (unit.ck === undefined) {
      evicted.push({ sessionId: unit.id, first: session.first, last: session.last, key: null, context: null });
      size -= property(unit.id, session);
      delete value[unit.id];
      continue;
    }
    if (!copied.has(unit.id)) { copied.add(unit.id); value[unit.id] = { ...session, contexts: { ...session.contexts } }; }
    const live = value[unit.id];
    const ctx = live.contexts[unit.ck];
    evicted.push({ sessionId: unit.id, first: session.first, last: session.last, key: unit.ck, context: { ...ctx, seg: ctx?.seg ?? legacyContextSeg(unit.id, unit.ck) } });
    size -= property(unit.ck, ctx);
    if (unit.current) {
      live.contexts[unit.ck] = { ...emptyContext(), last: ctx?.last, seg: keep?.newSeg?.() ?? `${legacyContextSeg(unit.id, unit.ck)}:${evicted.length}` };
      size += property(unit.ck, live.contexts[unit.ck]);
    } else delete live.contexts[unit.ck];
    if (!Object.keys(live.contexts).length && keep?.id !== unit.id) { size -= property(unit.id, live); delete value[unit.id]; }
  }
  return { value, evicted };
}

// Served counters: the rules served longest ago move out; a reader sums them back.
function shrinkServed(served, budget) {
  let size = jsonLength(served);
  if (size <= budget) return { value: served, evicted: null };
  const target = Math.floor(budget * EVICT_TO);
  const value = { ...served };
  const evicted = {};
  for (const [name, item] of Object.entries(value).sort((a, b) => stamp(a[1]?.last).localeCompare(stamp(b[1]?.last)))) {
    if (size <= target) break;
    evicted[name] = { ...item, seg: item?.seg ?? legacyServedSeg(name) };
    size -= property(name, item);
    delete value[name];
  }
  return { value, evicted };
}

// Health is bounded by construction (31 days of five numbers, 20 errors of 160 characters); past its budget it moves out whole.
function shrinkHealth(health, budget) {
  if (jsonLength(health) <= budget) return { value: health, evicted: null };
  return { value: { days: {}, lastErrors: [] }, evicted: health };
}

const SHRINK = { [VERDICTS]: shrinkVerdicts, sessions: shrinkSessions, served: shrinkServed, health: shrinkHealth };

// Cut to the budget; a context or session measured above it by an estimate is caught by the exact measure and cut again.
export function shrink(name, value, budget = STORE_BUDGETS[name], keep = null) {
  let current = value, evicted = null;
  for (let pass = 0; pass < 4 && jsonLength(current) > budget; pass++) {
    const result = SHRINK[name](current, budget, keep);
    if (!result.evicted) break;
    evicted = mergeEvicted(name, evicted, result.evicted);
    current = result.value;
  }
  return { value: current, evicted };
}
// A later pass only adds: sessions append their units, verdict text is concatenated, and a served counter or the health
// value that a later pass moves out again cannot already be in the earlier part (it left the value in that pass).
function mergeEvicted(name, previous, next) {
  if (!previous) return next;
  if (name === VERDICTS) return previous + next;
  if (name === 'sessions') return [...previous, ...next];
  if (name === 'served') return { ...previous, ...next };
  return [].concat(previous, next);
}

// Archive texts, each under ARCHIVE_PART_BYTES: verdict lines as JSONL, store keys as `{ format, key, archivedAt, value }`.
export function archiveTexts(name, evicted, archivedAt = new Date().toISOString()) {
  if (name === VERDICTS) {
    const parts = [];
    let part = [], bytes = 0;
    for (const line of String(evicted).split('\n').filter(Boolean)) {
      const size = byteLength(line) + 1;
      if (part.length && bytes + size > ARCHIVE_PART_BYTES) { parts.push(`${part.join('\n')}\n`); part = []; bytes = 0; }
      part.push(line);
      bytes += size;
    }
    if (part.length) parts.push(`${part.join('\n')}\n`);
    return parts;
  }
  // Sessions are format 2: `value` is the list of units. Served and health stay format 1: `value` is the key's value.
  if (name === 'sessions') return chunk(evicted, (part) => JSON.stringify({ format: 2, key: name, archivedAt, value: part }), [], (part, unit) => part.push(unit));
  const text = (value) => JSON.stringify({ format: 1, key: name, archivedAt, value });
  if (name === 'served') return chunk(Object.entries(evicted).map(([key, item]) => ({ [key]: item })), text, {}, (part, unit) => Object.assign(part, unit));
  return [].concat(evicted).map(text);
}
function chunk(units, text, empty, add) {
  const parts = [];
  let part = null, bytes = 0;
  for (const unit of units) {
    const size = byteLength(JSON.stringify(unit));
    if (part && bytes + size > ARCHIVE_PART_BYTES) { parts.push(text(part)); part = null; bytes = 0; }
    part ??= Array.isArray(empty) ? [] : {};
    add(part, unit);
    bytes += size;
  }
  if (part) parts.push(text(part));
  return parts;
}

// The quality data directory's physical path must not sit in a rules or git directory, as for the verdict rotation.
export const unsafeQualityPath = (physical) => /(^|[\\/])(?:rules|rules-on-demand|\.git)(?:[\\/]|$)/.test(physical);
// The host's own refusal of a store over its limit ("the store would be N characters, over the L limit").
export const isSizeRefusal = (error) => /over the \d+ limit/.test(String(error?.message ?? error));

export const familyOf = (name) => (name === VERDICTS ? VERDICT_ARCHIVE : STORE_ARCHIVE);
const numbersOf = (family, name) => name.slice(family.prefix.length, -family.suffix.length).split('-').map(Number);
export const isArchive = (family, name) => name.startsWith(family.prefix) && name.endsWith(family.suffix)
  && numbersOf(family, name).length === 2 && numbersOf(family, name).every((n) => Number.isSafeInteger(n) && n >= 0);
export const archiveName = (family, time, sequence) => `${family.prefix}${time}-${sequence}${family.suffix}`;
// The numeric sequence part of an archive name: the writer's owner number (from its pid, see hooks.js) above a counter
// of SEQUENCE_SPAN, so two processes writing in the same millisecond never produce one name.
export const SEQUENCE_SPAN = 1_000_000;
export const sequenceNumber = (owner, counter) => owner * SEQUENCE_SPAN + (counter % SEQUENCE_SPAN);

// The archives of one family to remove: everything past the family's retained bytes on disk, newest kept first (a
// listing without a size counts the family's largest file); the newest file is always kept. Store archives: none.
export function retentionVictims(entries, family) {
  if (!Number.isFinite(family.retained)) return [];
  const files = entries.filter((item) => isArchive(family, item.name))
    .sort((a, b) => numbersOf(family, b.name)[0] - numbersOf(family, a.name)[0] || numbersOf(family, b.name)[1] - numbersOf(family, a.name)[1]);
  const victims = [];
  let total = 0;
  for (const [index, item] of files.entries()) {
    total += Number.isFinite(item.size) && item.size > 0 ? item.size : family.unknownSize;
    if (index > 0 && total > family.retained) victims.push(item.name);
  }
  return victims;
}
