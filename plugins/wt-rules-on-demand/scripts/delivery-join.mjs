// Exact in-hook verdict/serve join. All filtering is reader-side; the journal and JSONL stay append-only.
import { contextLast, legacyContextSeg, legacyServedSeg } from '../hooks/store-budget.js';
const number = (value) => typeof value === 'number' && Number.isFinite(value);
const token = (id) => String(id ?? '').replace(/-\d+$/, '');
const sameSession = (row, delivery) => row.sessionId == null || delivery.sessionId == null || row.sessionId === delivery.sessionId;
const compatible = (claim, delivery) => sameSession(claim.row, delivery);
const keyOf = (claim) => JSON.stringify([claim.deliveryId, claim.row.sessionId]);
const order = (a, b) => (number(a.row.actSeq) ? a.row.actSeq : Infinity) - (number(b.row.actSeq) ? b.row.actSeq : Infinity)
  || String(a.row.decidedAt ?? '').localeCompare(String(b.row.decidedAt ?? '')) || a.index - b.index;

function greaterClose(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing.token === incoming.token && existing.seq !== incoming.seq) return existing.seq > incoming.seq ? existing : incoming;
  const order = Date.parse(existing.at) - Date.parse(incoming.at) || String(existing.token).localeCompare(String(incoming.token));
  return order >= 0 ? existing : incoming;
}

const closeMarkersOf = (context) => context.closeMarkers ?? (context.lastClose ? [context.lastClose] : []);

function mergeCloseMarkers(previous, context) {
  const byToken = new Map();
  for (const marker of [...closeMarkersOf(previous), ...closeMarkersOf(context)]) {
    byToken.set(marker.token, greaterClose(byToken.get(marker.token), marker));
  }
  return [...byToken.values()].sort((a, b) => String(a.token).localeCompare(String(b.token)));
}

export function mergeSessions(stores) {
  const sessions = {};
  for (const store of stores) for (const [id, session] of Object.entries(store.sessions ?? {})) {
    const existing = sessions[id] ?? {};
    const contexts = { ...existing.contexts };
    for (const [key, context] of Object.entries(session.contexts ?? {})) {
      const previous = contexts[key] ?? {};
      const seen = new Set();
      const complianceInjected = [...(previous.complianceInjected ?? []), ...(context.complianceInjected ?? [])].filter((entry) => {
        if (!entry.deliveryId) return true;
        if (seen.has(entry.deliveryId)) return false;
        seen.add(entry.deliveryId);
        return true;
      });
      const closeMarkers = mergeCloseMarkers(previous, context);
      const lastClose = closeMarkers.reduce(greaterClose, undefined);
      contexts[key] = { ...previous, ...context, complianceInjected, closeMarkers, lastClose };
    }
    sessions[id] = { ...existing, ...session, contexts };
  }
  return sessions;
}

// The hook moves the oldest contexts of an over-budget `sessions` key to archive files: one context can then live in
// several archives plus the live store, each holding a disjoint SEGMENT of its rows. Segments are SUMMED (counters
// added, rows concatenated, governed acts merged by rule identity, close markers merged), unlike mergeSessions, which
// merges COPIES of one store (mirror directories) and must not double count them.
const COUNTER_FIELDS = ['served', 'suppressedCap', 'servedIdentity', 'suppressedIdentity'];
const later = (a, b) => (String(b ?? '') > String(a ?? '') ? b : a);
const earlier = (a, b) => (a == null || (b != null && String(b) < String(a)) ? b : a);
function sumCounters(a = {}, b = {}) {
  const out = { ...a };
  for (const [key, count] of Object.entries(b ?? {})) out[key] = (Number(out[key]) || 0) + (Number(count) || 0);
  return out;
}
function sumActs(a = [], b = []) {
  const byRule = new Map();
  for (const act of [...a, ...b]) {
    const id = act?.ruleIdentity ?? act?.rule;
    const existing = byRule.get(id);
    if (!existing) { byRule.set(id, { ...act }); continue; }
    existing.count = (Number(existing.count) || 0) + (Number(act.count) || 0);
    existing.at = earlier(existing.at, act.at);
    existing.last = later(existing.last, act.last);
  }
  return [...byRule.values()];
}
export function sumContexts(a = {}, b = {}) {
  const out = { ...a, ...b };
  for (const field of COUNTER_FIELDS) if (a[field] || b[field]) out[field] = sumCounters(a[field], b[field]);
  const seen = new Set();
  out.complianceInjected = [...(a.complianceInjected ?? []), ...(b.complianceInjected ?? [])].filter((entry) => {
    if (!entry?.deliveryId) return true;
    if (seen.has(entry.deliveryId)) return false;
    seen.add(entry.deliveryId);
    return true;
  });
  out.governedActs = sumActs(a.governedActs, b.governedActs);
  if (a.triggerErrors || b.triggerErrors) out.triggerErrors = [...(a.triggerErrors ?? []), ...(b.triggerErrors ?? [])];
  const closeMarkers = mergeCloseMarkers(a, b);
  if (closeMarkers.length) { out.closeMarkers = closeMarkers; out.lastClose = closeMarkers.reduce(greaterClose, undefined); }
  if (a.last || b.last) out.last = later(a.last, b.last);
  return out;
}
// One copy of a segment per (session, context, seg) or (rule, seg): the one written last, which holds every row of the
// others (a segment only grows until it is evicted); equal stamps fall to the longer, then the greater, JSON text.
const segmentText = (value) => JSON.stringify(value) ?? '';
function newerCopy(a, b, lastOf) {
  const order = String(lastOf(a) ?? '').localeCompare(String(lastOf(b) ?? '')) || segmentText(a).length - segmentText(b).length
    || segmentText(a).localeCompare(segmentText(b));
  return order >= 0 ? a : b;
}
// Segments in any order: archives and the live store, mirrors already merged. Copies of one segment count once (an
// archive written before a store write that never landed, or two processes archiving one value); distinct segments of
// a context are summed, oldest first.
export function sumSessions(segments) {
  const sessions = {};
  const copies = new Map();
  for (const segment of segments) for (const [id, session] of Object.entries(segment ?? {})) {
    const existing = sessions[id];
    const fields = { ...session };
    delete fields.contexts;
    sessions[id] = existing ? { ...existing, ...fields, first: earlier(existing.first, session.first), last: later(existing.last, session.last) } : { ...fields };
    for (const [key, context] of Object.entries(session?.contexts ?? {})) {
      const slot = JSON.stringify([id, key]);
      if (!copies.has(slot)) copies.set(slot, { id, key, bySeg: new Map() });
      const { bySeg } = copies.get(slot);
      const seg = context?.seg ?? legacyContextSeg(id, key);
      bySeg.set(seg, bySeg.has(seg) ? newerCopy(bySeg.get(seg), context, (ctx) => contextLast(ctx, session)) : context);
    }
  }
  for (const session of Object.values(sessions)) session.contexts = {};
  for (const { id, key, bySeg } of copies.values()) {
    const parts = [...bySeg.entries()].sort(([segA, a], [segB, b]) => String(contextLast(a, sessions[id]) ?? '').localeCompare(String(contextLast(b, sessions[id]) ?? '')) || segA.localeCompare(segB))
      .map(([, context]) => context);
    sessions[id].contexts[key] = parts.length === 1 ? parts[0] : parts.reduce((sum, context) => sumContexts(sum, context));
  }
  return sessions;
}
export function sumServed(segments) {
  const copies = new Map();
  for (const segment of segments) for (const [key, item] of Object.entries(segment ?? {})) {
    if (!copies.has(key)) copies.set(key, new Map());
    const bySeg = copies.get(key);
    const seg = item?.seg ?? legacyServedSeg(key);
    bySeg.set(seg, bySeg.has(seg) ? newerCopy(bySeg.get(seg), item, (copy) => copy?.last) : item);
  }
  const served = {};
  for (const [key, bySeg] of copies) {
    const items = [...bySeg.entries()].sort(([segA, a], [segB, b]) => String(a?.last ?? '').localeCompare(String(b?.last ?? '')) || segA.localeCompare(segB))
      .map(([, item]) => item);
    served[key] = items.slice(1).reduce((sum, item) => ({ ...sum, ...item, count: (Number(sum.count) || 0) + (Number(item?.count) || 0),
      last: later(sum.last, item?.last), byChannel: sumCounters(sum.byChannel, item?.byChannel) }), { ...items[0] });
  }
  return served;
}
// The parsed store archives of one key as segments for sumSessions / sumServed. A sessions archive of format 2 holds a
// list of units `{ sessionId, first, last, key, context }`; format 1 holds the key's value itself.
const unitSegment = ({ sessionId, first, last, key, context }) => ({ [sessionId]: { first, last, contexts: key == null ? {} : { [key]: context } } });
export const archivedSegments = (archives, key) => archives.filter((archive) => archive?.key === key)
  .flatMap((archive) => (Array.isArray(archive.value) ? archive.value.map(unitSegment) : [archive.value ?? {}]));
export function journalDeliveries(sessions = {}) {
  const deliveries = [];
  for (const [sessionId, session] of Object.entries(sessions)) for (const [context, data] of Object.entries(session.contexts ?? {})) {
    for (const entry of data.complianceInjected ?? []) if (entry.deliveryId) deliveries.push({ ...entry, sessionId, context,
      lastClose: data.lastClose, closeMarkers: data.closeMarkers });
  }
  return deliveries;
}

function closesDelivery(close, delivery, tokenOf) {
  if (close.token === tokenOf(delivery.deliveryId)) return number(close.seq) && close.seq > delivery.deliverySeq;
  return Date.parse(close.at) > Date.parse(delivery.at);
}

function classification(delivery, kept, contexts, tokenOf) {
  const session = delivery.sessionId;
  const identity = delivery.ruleIdentity ?? delivery.rule;
  if (kept.some((row) => sameSession(row, delivery) && (row.ruleIdentity ?? row.rule) === identity
    && tokenOf(row.verdictId) === tokenOf(delivery.deliveryId) && row.actSeq === delivery.servingSeq)) return 'dischargedBySameAct';
  const context = contexts?.[session]?.[delivery.context] ?? {};
  const closeMarkers = delivery.closeMarkers ?? context.closeMarkers ?? closeMarkersOf({ lastClose: delivery.lastClose ?? context.lastClose });
  if (closeMarkers.some((close) => closesDelivery(close, delivery, tokenOf))) return 'settled';
  if (delivery.context != null && /^\d+$/.test(delivery.context) && Object.keys(contexts?.[session] ?? {})
    .some((key) => /^\d+$/.test(key) && Number(key) > Number(delivery.context))) return 'settled';
  return 'open';
}

function groupsOf(claims, dropped) {
  const groups = new Map();
  for (const claim of claims) if (!dropped.has(claim.index) && !claim.void && !claim.ambiguous) {
    const key = claim.delivery ? claim.delivery : keyOf(claim);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(claim);
  }
  for (const group of groups.values()) group.sort(order);
  return groups;
}

export function joinDeliveries(rows, deliveries, { archiveRows = [], archivesRead = 0, contexts = {}, sessionOf, tokenOf = token } = {}) {
  const copies = [], discarded = [], voidedClaims = [], ambiguous = [];
  const seen = new Set(), legacy = new Set();
  let legacyIdenticalLines = 0;
  const original = rows.filter((row) => {
    if (row.verdictId != null) {
      const id = JSON.stringify([row.verdictId, row.sessionId]);
      if (seen.has(id)) { copies.push(row); return false; }
      seen.add(id);
    } else {
      const line = JSON.stringify(row);
      if (legacy.has(line)) legacyIdenticalLines++;
      legacy.add(line);
    }
    return true;
  });
  const byId = new Map();
  for (const delivery of deliveries.filter((item) => item.deliveryId)) {
    if (!byId.has(delivery.deliveryId)) byId.set(delivery.deliveryId, []);
    byId.get(delivery.deliveryId).push(delivery);
  }
  const sessions = sessionOf ?? new Set(deliveries.map((item) => item.sessionId));
  const hasSession = (id) => sessions instanceof Set ? sessions.has(id) : Object.hasOwn(sessions, id);
  const withoutDelivery = { sessionMissing: [], idMissing: [] };
  const claims = [];
  original.forEach((row, index) => {
    if (row.verdictId == null) return;
    const entries = [...(row.deliveryId ? [{ ...row, own: true }] : []), ...(Array.isArray(row.discharged) ? row.discharged.map((item) => ({ ...item, own: false })) : [])];
    for (const entry of entries) {
      if (!entry.deliveryId) continue;
      const claim = { row, index, own: entry.own, deliveryId: entry.deliveryId, deliverySeq: entry.deliverySeq, servingSeq: entry.servingSeq };
      const possible = (byId.get(entry.deliveryId) ?? []).filter((item) => compatible(claim, item));
      if (possible.length === 1) claim.delivery = possible[0];
      else if (possible.length > 1) { claim.ambiguous = true; ambiguous.push(claim); }
      else withoutDelivery[!hasSession(row.sessionId) ? 'sessionMissing' : 'idMissing'].push(claim);
      claim.void = number(row.actSeq) && number(entry.deliverySeq) && number(entry.servingSeq)
        && row.actSeq < entry.deliverySeq && row.actSeq !== entry.servingSeq;
      if (claim.void) {
        if (claim.own) discarded.push(row);
        else voidedClaims.push(claim);
      }
      claims.push(claim);
    }
  });
  const dropped = new Set(claims.filter((claim) => claim.void && claim.own).map((claim) => claim.index));
  const initialGroups = groupsOf(claims, dropped);
  const duplicateIds = [], conflicting = [], duplicateRows = [];
  for (const [key, group] of initialGroups) if (group.length > 1) {
    duplicateIds.push(group[0].delivery ?? key);
    if (new Set(group.map((claim) => claim.row.verdict)).size > 1) conflicting.push(group[0].delivery ?? key);
  }
  // Drop the earliest losing row, then recompute: its discharges cannot defeat later rows.
  // Ordering the losers also makes this fixpoint independent of group insertion order.
  while (true) {
    const losers = [...groupsOf(claims, dropped).values()].flatMap((group) => group.slice(1)).filter((claim) => claim.own).sort(order);
    if (!losers.length) break;
    dropped.add(losers[0].index);
    duplicateRows.push(losers[0].row);
  }
  const kept = original.filter((_, index) => !dropped.has(index));
  const winners = new Set([...groupsOf(claims, dropped).values()].map((group) => group[0].delivery).filter(Boolean));
  const bound = archivesRead && archiveRows.length ? archiveRows.reduce((oldest, row) => {
    const time = Date.parse(row.decidedAt);
    return Number.isFinite(time) ? Math.min(oldest, time) : oldest;
  }, Infinity) : null;
  let outOfReach = 0;
  const unjudged = [];
  for (const delivery of deliveries.filter((item) => item.deliveryId)) {
    if (bound !== null && Date.parse(delivery.at) < bound) { outOfReach++; continue; }
    if (winners.has(delivery)) continue;
    const status = classification(delivery, kept, contexts, tokenOf);
    unjudged.push({ ...delivery, status });
  }
  return { rows: kept, copies, duplicateRows, duplicates: duplicateRows, duplicateIds, discarded, voidedClaims,
    conflicting, unjudged, bound: bound === null || bound === Infinity ? null : new Date(bound).toISOString(), outOfReach,
    withoutDelivery, ambiguous, legacyIdenticalLines, claims };
}
