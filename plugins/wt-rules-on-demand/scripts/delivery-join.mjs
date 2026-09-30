// Exact in-hook verdict/serve join. All filtering is reader-side; the journal and JSONL stay append-only.
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
  if (existing.token === incoming.token) return existing.seq >= incoming.seq ? existing : incoming;
  return Date.parse(existing.at) >= Date.parse(incoming.at) ? existing : incoming;
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
      contexts[key] = { ...previous, ...context, complianceInjected, lastClose: greaterClose(previous.lastClose, context.lastClose) };
    }
    sessions[id] = { ...existing, ...session, contexts };
  }
  return sessions;
}

export function journalDeliveries(sessions = {}) {
  const deliveries = [];
  for (const [sessionId, session] of Object.entries(sessions)) for (const [context, data] of Object.entries(session.contexts ?? {})) {
    for (const entry of data.complianceInjected ?? []) if (entry.deliveryId) deliveries.push({ ...entry, sessionId, context, lastClose: data.lastClose });
  }
  return deliveries;
}

function classification(delivery, kept, contexts, tokenOf) {
  const session = delivery.sessionId;
  const identity = delivery.ruleIdentity ?? delivery.rule;
  if (kept.some((row) => sameSession(row, delivery) && (row.ruleIdentity ?? row.rule) === identity
    && tokenOf(row.verdictId) === tokenOf(delivery.deliveryId) && row.actSeq === delivery.servingSeq)) return 'dischargedBySameAct';
  const context = contexts?.[session]?.[delivery.context] ?? {};
  const close = delivery.lastClose ?? context.lastClose;
  if (close && (close.token === tokenOf(delivery.deliveryId) && number(close.seq) && close.seq > delivery.deliverySeq
    || close.token !== tokenOf(delivery.deliveryId) && Date.parse(close.at) > Date.parse(delivery.at))) return 'settled';
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
