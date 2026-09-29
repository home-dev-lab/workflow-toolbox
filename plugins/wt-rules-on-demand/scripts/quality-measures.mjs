import { createHash } from 'node:crypto';
import { stripGeneratedFrontmatter, triggersHash } from './rule-lifecycle-lib.mjs';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';

const judged = new Set(['check', 'bash-command', 'tool-input', 'turn-correlation']);
// Required evidence for each measure. [] means rule text alone; health growth and
// aggregate coverage are separate fields with their own (optional) inputs.
export const measureDependencies = Object.freeze({
  misses: ['rows'], noise: ['rows', 'deliveries', 'store'], cost: ['effective', 'deliveries'], coverage: [],
  driftMigration: ['ledger'], driftAdopted: ['pluginRulesDir'], delete: ['rows'], guard: ['rows'],
  volume: ['rows', 'previousState'], health: ['store'], healthGrowth: ['previousState', 'storeBytes'],
  governedWithoutScannerCheck: ['acts'], uncoveredCandidates: ['acts'],
});
export const ruleId = (item) => `${item.scope}:${item.rulesDir}:${item.rule ?? item.name}`;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const fingerprint = (text) => hash(text).slice(0, 12);
const contentFingerprint = (text) => fingerprint(text.trimEnd());
const banner = /<!-- installed from workflow-toolbox v[^\n]*?content sha256:([a-f0-9]{12})[^\n]*?-->(?:\r?\n){1,2}/;
const bodyOf = (text) => { try { return stripGeneratedFrontmatter(text); } catch { return text; } };
function status(cases, bad = false) {
  if (cases === null || cases === 0) return 'unknown';
  if (cases < 5) return 'watch';
  return bad ? 'problem' : 'OK';
}
const metric = (cases, bad, detail = {}) => ({ cases, status: status(cases, bad), ...detail,
  ...(cases !== null && cases >= 5 && detail.count !== undefined ? { rate: detail.count / cases } : {}) });

function migrationDrift(rule, migration) {
  const basis = [];
  let changed = false;
  if (typeof migration?.bodyHash === 'string') {
    try {
      changed = hash(stripGeneratedFrontmatter(rule.text)) !== migration.bodyHash;
      basis.push('body');
    } catch { /* The body cannot be isolated. */ }
  }
  if (typeof migration?.triggersHash === 'string') {
    try {
      const current = parseRuntimeRule(rule.name, rule.text, { rawTriggers: true }).rawTriggers;
      // JSON specs may have boolean flags; rendered YAML quotes them, so the
      // runtime parser yields strings. Both are exact preimages of this file.
      const booleanFlags = new Set(['unconditional', 'before-first-act', 'mentions', 'command-head']);
      const candidates = [current];
      for (let index = 0; index < current.length; index++) for (const [key, value] of Object.entries(current[index])) {
        if (!booleanFlags.has(key) || !['true', 'false'].includes(value)) continue;
        if (candidates.length >= 256) { candidates.length = 0; break; }
        candidates.push(...candidates.map((candidate) => candidate.map((entry, n) => n === index ? { ...entry, [key]: value === 'true' } : entry)));
      }
      if (!candidates.length) throw new Error('ambiguous trigger flag preimages');
      changed = !candidates.some((candidate) => triggersHash(candidate) === migration.triggersHash) || changed;
      basis.push('triggers');
    } catch { /* The current triggers cannot be parsed. */ }
  }
  let value = 'unknown';
  if (basis.length) value = changed ? 'changed' : 'unchanged';
  return { value, basis };
}

function shippedSource(pluginRulesDir, rule) {
  if (pluginRulesDir == null) return undefined;
  const id = ruleId(rule);
  if (Object.hasOwn(pluginRulesDir, id)) return pluginRulesDir[id];
  if (Object.hasOwn(pluginRulesDir, rule.name)) return pluginRulesDir[rule.name];
  return undefined;
}

function drift(rule, migration, pluginRulesDir) {
  const body = bodyOf(rule.text);
  const since = migrationDrift(rule, migration);
  const match = banner.exec(body);
  if (!match) return { origin: rule.scope, since, adopted: 'not adopted' };
  const local = body.replace(banner, '');
  const edited = ![fingerprint(local), contentFingerprint(local)].includes(match[1]);
   const source = shippedSource(pluginRulesDir, rule);
  const shipped = source && typeof source === 'object' ? source.text : source;
  let adopted = 'unknown';
  if (source?.ambiguous) adopted = 'ambiguous shipped source';
  else if (shipped === null) adopted = 'no shipped source';
  else if (shipped !== undefined) {
    const behind = ![fingerprint(shipped), contentFingerprint(shipped)].includes(match[1]);
    if (behind && edited) adopted = 'behind and locally edited';
    else if (behind) adopted = 'behind';
    else if (edited) adopted = 'locally edited';
    else adopted = 'current';
  }
  return { origin: 'plugin', since, adopted, ...(source?.versions ? { versions: source.versions } : {}) };
}

function profileHealthStatus(profile, counts, windowDays) {
  if (!profile.recorded) return 'unknown';
  if (counts.errors || counts.calls && counts.slow >= 5 && counts.slow / counts.calls >= .01) return 'problem';
  if (counts.calls && windowDays <= 31) return 'OK';
  return 'unknown';
}

function overallHealthStatus(totals, triggerErrors, profiles, growthPerDay, retentionGap) {
  if (totals.errors || triggerErrors || profiles.some((profile) => profile.status === 'problem') ||
    totals.calls && totals.slow >= 5 && totals.slow / totals.calls >= .01 || growthPerDay > 1048576) return 'problem';
  if (totals.calls && !retentionGap && profiles.every((profile) => profile.status === 'OK')) return 'OK';
  return 'unknown';
}

function engineHealth(store, previousState, now, days, storeBytes) {
  const windowDays = Math.ceil(days), start = Date.parse(new Date(now).toISOString().slice(0, 10)) - (windowDays - 1) * 86400000;
  const entries = Object.entries(store?.health?.days ?? {}).filter(([day]) => Date.parse(day) >= start && Date.parse(day) <= now);
  const totals = entries.reduce((out, [, day]) => {
    for (const key of ['calls', 'errors', 'totalMs', 'slow']) out[key] += day[key] ?? 0;
    out.maxMs = Math.max(out.maxMs, day.maxMs ?? 0);
    return out;
  }, { calls: 0, errors: 0, totalMs: 0, maxMs: 0, slow: 0 });
  const previous = previousState?.store;
  const elapsedDays = previous && (now - previous.at) / 86400000;
  const growthPerDay = elapsedDays > 0 && Number.isFinite(storeBytes) ? (storeBytes - previous.bytes) / elapsedDays : null;
  const allSessions = store?.profiles?.length ? store.profiles.flatMap((profile) => Object.values(profile.sessions ?? {})) : Object.values(store?.sessions ?? {});
  const triggerErrors = allSessions.reduce((sum, session) => sum + Object.values(session.contexts ?? {}).reduce((n, context) => n + (context.triggerErrors ?? [])
    .filter((item) => Number.isFinite(Date.parse(item.at)) && Date.parse(item.at) >= start && Date.parse(item.at) <= now).length, 0), 0);
  const state = Number.isFinite(storeBytes) ? { at: now, bytes: storeBytes } : previous;
  const profiles = (store?.profiles ?? []).map((profile) => {
    const counts = Object.entries(profile.health?.days ?? {}).filter(([day]) => Date.parse(day) >= start && Date.parse(day) <= now)
      .reduce((out, [, day]) => ({ calls: out.calls + (day.calls ?? 0), errors: out.errors + (day.errors ?? 0), slow: out.slow + (day.slow ?? 0) }), { calls: 0, errors: 0, slow: 0 });
    return { configDir: profile.configDir, recorded: profile.recorded, ...counts, status: profileHealthStatus(profile, counts, windowDays) };
  });
  const missing = profiles.filter((profile) => !profile.recorded).map((profile) => profile.configDir);
  const metadata = { windowDays, alignment: 'utc-day', retentionGap: windowDays > 31, unrecorded: missing, profiles };
  if (!store?.health || missing.length) return { ...metadata, ...totals,
    status: overallHealthStatus(totals, triggerErrors, profiles, growthPerDay, true) === 'problem' ? 'problem' : 'unknown',
    reason: 'engine health unrecorded for one or more profiles', triggerErrors,
    storeBytes: storeBytes ?? null, sessionCount: allSessions.length, state };
  return { ...totals, meanMs: totals.calls ? totals.totalMs / totals.calls : null, triggerErrors,
    lastErrors: store.health.lastErrors ?? [], storeBytes: storeBytes ?? null, sessionCount: allSessions.length,
    growthPerDay, ...metadata, status: overallHealthStatus(totals, triggerErrors, profiles, growthPerDay, metadata.retentionGap), state };
}

function actIdentity(row) { return JSON.stringify([row.file, row.line, row.toolUseId, row.segment, row.contextId]); }

function proposal(name, item) {
  const { count, cases, servedBytes, staticBytes } = item;
  const actions = {
    misses: `fix trigger (${count} of ${cases} governed acts not served)`,
    noise: `narrow trigger (${count} of ${cases} deliveries with no governed act)`,
    cost: `return to static (served ${servedBytes} bytes vs static ${staticBytes})`,
    driftMigration: 're-prove triggers (rule changed since migration)',
    driftAdopted: item.value?.includes('locally edited') ? 'reconcile local edit with shipped source' : 'refresh adopted copy',
    delete: `delete: followed even when not served (${count} of ${item.unservedApplicable})`,
    guard: `convert to a guard (${count} of ${cases} violated, code-checkable)`,
  };
  return actions[name] ?? `${name}: review evidence`;
}

function deletionMeasure(unserved, served, deletion) {
  const count = unserved.filter((row) => row.checkVerdict === 'followed').length;
  const result = metric(Math.min(unserved.length, served.length), deletion, { count, servedApplicable: served.length, unservedApplicable: unserved.length });
  if (result.rate !== undefined) result.rate = count / unserved.length;
  return result;
}

function costMeasure(contexts, servedBytes, staticBytes, contextsUnknownTiming) {
  if (!contexts || servedBytes === null) return { cases: null, status: 'unknown', servedBytes, staticBytes, contextsUnknownTiming };
  const detail = { servedBytes, staticBytes, estimatedServedTokens: servedBytes / 4, estimatedStaticTokens: staticBytes / 4,
    tokenUnit: 'estimate (bytes/4)', contextsUnknownTiming };
  if (contexts >= 5) detail.ratio = staticBytes ? servedBytes / staticBytes : null;
  return metric(contexts, servedBytes > staticBytes, detail);
}

function coverageMeasure(checkable, kind) {
  if (checkable) return { cases: null, status: 'OK', kind: 'scanner check' };
  return { cases: null, status: 'unknown', kind: kind === 'test-before-edit' ? 'scanner lacks it' : 'no possible check' };
}

function migrationMeasure({ value, basis }) {
  let result = 'OK';
  if (value === 'changed') result = 'problem';
  else if (value === 'unknown') result = 'unknown';
  return { cases: null, status: result, value, basis };
}

function adoptedMeasure(drifted) {
  const value = drifted.adopted;
  let result = 'OK';
  if (value === 'behind') result = 'problem';
  else if (['behind and locally edited', 'locally edited'].includes(value)) result = 'unknown';
  else if (['unknown', 'no shipped source', 'ambiguous shipped source'].includes(value)) result = 'unknown';
  return { cases: null, status: result, value,
    ...(['behind and locally edited', 'locally edited'].includes(value)
      ? { reason: 'local text disagrees with the banner fingerprint; shipped-text comparison is not implemented yet' } : {}),
    ...(drifted.versions ? { versions: drifted.versions } : {}) };
}

function volumeMeasure(pending, newActs, volume, due, gap) {
  let status = 'waiting', label = `waiting ${pending}/${volume}`;
  if (due) { status = 'due'; label = `due ${pending}/${volume}`; }
  if (gap) { status = 'unknown'; label = 'gap'; }
  return { cases: pending, newActs, status, label, due, gap };
}

function combinedVerdict(measures) {
  const statuses = Object.entries(measures).filter(([name]) => name !== 'volume').map(([, item]) => item.status);
  if (statuses.includes('problem')) return 'problem';
  if (statuses.includes('watch')) return 'watch';
  if (statuses.some((value) => ['unknown', 'unmeasurable'].includes(value))) return 'unknown';
  return 'OK';
}

function coverageCount(act, kind) {
  if (act[kind] !== undefined) return act[kind];
  if (kind === 'governedWithoutScannerCheck') return act.matchedAnyRule && !act.scannerCheck ? act.count : 0;
  return act.matchedAnyRule ? 0 : act.count;
}

function coverageKeys(acts, kind) {
  return Object.entries(acts).filter(([, act]) => coverageCount(act, kind) >= 5)
    .sort((a, b) => coverageCount(b[1], kind) - coverageCount(a[1], kind))
    .slice(0, 20).map(([key, value]) => ({ key, count: coverageCount(value, kind) }));
}

export function measureRules(input = {}) {
  const { rows = [], deliveries = [], acts = {}, effective = [], rules = [], ledger = {}, store = {}, previousState = {}, pluginRulesDir,
    volume = 20, now = Date.now(), days = 7, healthDays = days, storeBytes = null } = input;
  const available = (key) => input[key] != null;
  const withEvidence = (name, item) => measureDependencies[name].some((key) => !available(key))
    ? { ...item, status: 'unknown', ...(item.rate !== undefined ? { rate: undefined } : {}), ...(item.ratio !== undefined ? { ratio: undefined } : {}) }
    : item;
  if (!Number.isInteger(volume) || volume < 1) throw new Error('volume must be a positive integer');
  const output = {}, nextState = { rules: {}, store: previousState.store };
  for (const rule of rules) {
    const id = ruleId(rule), samples = rows.filter((row) => ruleId(row) === id), received = deliveries.filter((delivery) => ruleId(delivery) === id);
    const observable = samples.filter((row) => ['followed', 'not followed', 'trigger miss'].includes(row.verdict) && ['followed', 'not followed'].includes(row.checkVerdict));
    const misses = observable.filter((row) => row.verdict === 'trigger miss');
    const served = observable.filter((row) => row.served);
    const unserved = misses;
    const checkable = judged.has(rule.complianceKind);
    const attributable = !rule.promptTrigger;
    const applicable = (row) => row.contextId === undefined ? false : ['followed', 'not followed'].includes(row.checkVerdict);
    const related = (row, delivery) => row.contextId === delivery.contextId && (row.line >= delivery.line || delivery.toolUseId && row.toolUseId === delivery.toolUseId ||
      delivery.messageId && row.messageId === delivery.messageId);
    const unresolved = received.filter((delivery) => !samples.some((row) => applicable(row) && related(row, delivery)) &&
      (samples.some((row) => row.contextId === delivery.contextId && row.checkVerdict === 'unresolved') ||
        (store?.uncertainContexts ?? []).some((entry) => entry.ruleId === id && entry.contextId === delivery.contextId)));
    const noise = received.filter((delivery) => !unresolved.includes(delivery) && !samples.some((row) => applicable(row) && related(row, delivery)));
    const contextsUnknownTiming = effective.filter((entry) => entry.rules.includes(id) && !entry.at?.some((stamp) => Number.isFinite(Date.parse(stamp)))).length;
    const contexts = effective.filter((entry) => entry.rules.includes(id) && entry.at?.some((stamp) => Number.isFinite(Date.parse(stamp)) && Date.parse(stamp) >= now - days * 86400000 && Date.parse(stamp) <= now)).length;
    const staticBytes = Buffer.byteLength(bodyOf(rule.text)) * contexts;
    const servedBytes = received.every((delivery) => Number.isFinite(delivery.bytes)) ? received.reduce((sum, delivery) => sum + delivery.bytes, 0) : null;
    const drifted = drift(rule, ledger[id], pluginRulesDir);
    const threshold = Number(/rollback-threshold:\s*['"]?([\d.]+)/.exec(rule.text)?.[1] ?? .8);
    const servedRate = served.length >= 5 ? served.filter((row) => row.checkVerdict === 'followed').length / served.length : null;
    const unservedRate = unserved.length >= 5 ? unserved.filter((row) => row.checkVerdict === 'followed').length / unserved.length : null;
    const deletion = unservedRate !== null && servedRate !== null && unservedRate >= .95 && unservedRate >= servedRate;
    const guard = checkable && servedRate !== null && servedRate < threshold;
    const previous = previousState.rules?.[id];
    const stamped = observable.filter((row) => Number.isFinite(Date.parse(row.at)));
    const seen = new Set(previous?.seen ?? []);
    const newActs = stamped.filter((item) => !seen.has(actIdentity(item))).length;
    const pending = (previous?.pending ?? 0) + newActs;
    const gap = !!previous?.lastRunAt && previous.lastRunAt < now - days * 86400000;
    const due = !previous || pending >= volume;
    const measured = {
      misses: checkable ? metric(observable.length, misses.length / (observable.length || 1) > .2, { count: misses.length,
        triggerUnmatched: attributable ? misses.filter((row) => !row.triggerMatched).length : null,
        engineMiss: attributable ? misses.filter((row) => row.triggerMatched).length : null,
        unattributable: attributable ? 0 : misses.length, unobservable: samples.length - observable.length }) : { cases: null, status: 'unmeasurable' },
      noise: checkable ? { ...metric(received.length - unresolved.length, noise.length / ((received.length - unresolved.length) || 1) > .5, { count: noise.length }), unresolved: unresolved.length,
        ...((unresolved.length && (received.length - unresolved.length < 5 || noise.length / received.length <= .5 && (noise.length + unresolved.length) / received.length > .5)) ? { status: 'unknown' } : {}) } : { cases: null, status: 'unmeasurable' },
      cost: costMeasure(contexts, servedBytes, staticBytes, contextsUnknownTiming),
      coverage: coverageMeasure(checkable, rule.complianceKind),
      driftMigration: migrationMeasure(drifted.since),
      driftAdopted: adoptedMeasure(drifted),
      delete: deletionMeasure(unserved, served, deletion),
      guard: checkable ? metric(served.length, guard, { count: served.filter((row) => row.checkVerdict === 'not followed').length }) : { cases: null, status: 'unmeasurable' },
      volume: volumeMeasure(pending, newActs, volume, due, gap),
    };
    const measures = Object.fromEntries(Object.entries(measured).map(([name, item]) => [name,
      name === 'driftAdopted' && drifted.adopted === 'not adopted' ? item : withEvidence(name, item)]));
    const proposals = [];
    for (const [name, item] of Object.entries(measures)) if (item.status === 'problem') proposals.push(proposal(name, item));
    const currentVerdict = combinedVerdict(measures);
    const verdict = due ? currentVerdict : previous.verdict;
    nextState.rules[id] = { seen: [...new Set(stamped.map(actIdentity))], pending: due ? 0 : pending, lastRunAt: now,
      lastEvaluatedAt: due ? now : previous.lastEvaluatedAt, verdict, proposals: due ? proposals : previous.proposals ?? [] };
    output[id] = { origin: drifted.origin, measures, verdict, proposals: due ? proposals : previous.proposals ?? [], observedVerdict: currentVerdict };
  }
   const health = engineHealth(store, previousState, now, healthDays, storeBytes);
   if (!available('store')) health.status = 'unknown';
  nextState.store = health.state;
  delete health.state;
   const uncovered = coverageKeys(acts, 'governedWithoutScannerCheck');
   const candidates = coverageKeys(acts, 'unmatched');
  return { rules: output, coverage: { noPossibleCheck: rules.filter((rule) => !judged.has(rule.complianceKind) && rule.complianceKind !== 'test-before-edit').map(ruleId),
    scannerLacksCheck: rules.filter((rule) => rule.complianceKind === 'test-before-edit').map(ruleId), governedWithoutScannerCheck: uncovered, uncoveredCandidates: candidates },
  health, state: nextState };
}
