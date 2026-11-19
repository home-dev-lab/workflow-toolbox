// Evidence eligibility only: this module grants no dispatch or mutation authority.
const id = value => typeof value === 'string' && value.length > 0 && !/[^A-Za-z0-9._:-]/.test(value);
const hash = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const bool = value => typeof value === 'boolean';
const choices = (...values) => value => values.includes(value);
const nullable = check => value => value === null || check(value);
const unique = values => [...new Set(values)].sort();
const pointer = key => key.replaceAll('~', '~0').replaceAll('/', '~1');
const numeric = ['denominator', 'bad', 'triggerUnmatched', 'engineMiss', 'unattributable',
  'unobservable', 'unresolved', 'servedBytes', 'staticBytes', 'contextsUnknownTiming'];
const units = { misses: 'governed-act', noise: 'resolved-delivery', cost: 'effective-context' };
const required = {
  misses: ['denominator', 'bad', 'triggerUnmatched', 'engineMiss', 'unattributable', 'unobservable'],
  noise: ['denominator', 'bad', 'unresolved'],
  cost: ['denominator', 'servedBytes', 'staticBytes', 'contextsUnknownTiming'],
};
const times = ['windowStartMs', 'windowEndMs', 'evaluatedAtMs', 'capturedAtMs'];
const binding = { rootId: nullable(id), ruleId: nullable(id), scope: nullable(choices('user', 'project')),
  snapshotHash: nullable(hash), generation: nullable(id) };
const schema = {
  schemaVersion: choices(1),
  request: {
    action: choices('revert-static', 'fix-trigger', 'delete', 'merge', 'edit-body', 'edit-shipped-source', 'convert-guard'),
    measureKind: choices('misses', 'noise', 'cost', 'driftMigration', 'driftAdopted', 'health', 'coverage', 'delete', 'guard'),
    bodyUnchanged: nullable(bool), checkUnchanged: nullable(bool),
  },
  target: { binding, identityKnown: nullable(bool), storage: nullable(choices('local', 'adopted-local', 'shipped-plugin')),
    provenance: nullable(choices('local', 'plugin')) },
  evaluation: {
    id: nullable(id), manifestHash: nullable(hash), policyHash: nullable(hash), scannerHash: nullable(hash), binding,
    ...Object.fromEntries(times.map(key => [key, nullable(count)])),
    ...Object.fromEntries(['complete', 'coherent', 'due', 'gap', 'cached'].map(key => [key, nullable(bool)])),
    measureStatus: nullable(choices('problem', 'OK', 'watch', 'unknown', 'unmeasurable')),
    denominatorUnit: nullable(choices(...Object.values(units))),
    ...Object.fromEntries(numeric.map(key => [key, nullable(count)])),
  },
  policy: { id: nullable(id), hash: nullable(hash), scannerHash: nullable(hash),
    asOfMs: nullable(count), maxAgeMs: nullable(count) },
};

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonContainer(value, seen) {
  const array = Array.isArray(value);
  if (!array && !record(value)) return false;
  if (array && Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter(key => !(array && key === 'length'));
  const valid = keys.every(key => jsonProperty(key, descriptors[key], array));
  const dense = !array || keys.length === value.length;
  if (!valid || !dense) throw Error('Non-JSON container');
  return keys.map(key => [key, descriptors[key].value]);
}

function jsonProperty(key, descriptor, array) {
  if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  if (array && !/^(0|[1-9]\d*)$/.test(key)) return false;
  return true;
}

function jsonScalar(value) {
  return value === null || ['string', 'boolean'].includes(typeof value) ||
    (typeof value === 'number' && Number.isFinite(value));
}

function dataSnapshot(input) {
  const holder = {};
  const seen = new Set();
  const stack = [{ value: input, parent: holder, key: 'input' }];
  while (stack.length) {
    const { value, parent, key, exit } = stack.pop();
    if (exit) { seen.delete(value); continue; }
    if (jsonScalar(value)) {
      Object.defineProperty(parent, key, { value, enumerable: true });
      continue;
    }
    if (typeof value !== 'object' || value === null) throw Error('Non-JSON value');
    const entries = jsonContainer(value, seen);
    if (entries === false) throw Error('Non-JSON container');
    const copy = Array.isArray(value) ? [] : Object.create(null);
    Object.defineProperty(parent, key, { value: copy, enumerable: true });
    stack.push({ value, exit: true });
    for (const [childKey, child] of entries) stack.push({ value: child, parent: copy, key: childKey });
  }
  return holder.input;
}

function shape(value, expected, path, errors) {
  if (typeof expected === 'function') {
    if (!expected(value)) errors.push(`schema:${path || '/'}`);
    return;
  }
  if (!record(value)) { errors.push(`schema:${path || '/'}`); return; }
  for (const key of Object.keys(expected)) {
    const next = `${path}/${pointer(key)}`;
    if (!Object.hasOwn(value, key)) errors.push(`schema:${next}`);
    else shape(value[key], expected[key], next, errors);
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(expected, key)) errors.push(`schema:${path}/${pointer(key)}`);
  }
}

function knownNumbers(value, keys) {
  return keys.every(key => count(value[key]));
}

function measureErrors(input) {
  const e = input.evaluation;
  const kind = input.request?.measureKind;
  if (!record(e) || !schema.request.measureKind(kind)) return [];
  return [...fieldConsistency(e, kind), ...countConsistency(e, kind)];
}

function fieldConsistency(e, kind) {
  const errors = [];
  const fields = Object.hasOwn(required, kind) ? required[kind] : [];
  const irrelevant = numeric.filter(key => !fields.includes(key));
  if (!Object.hasOwn(units, kind)) irrelevant.push('denominatorUnit');
  if (irrelevant.some(key => Object.hasOwn(e, key) && e[key] !== null && schema.evaluation[key](e[key]))) {
    errors.push('inconsistent:irrelevant-fields');
  }
  if (Object.hasOwn(units, kind) && e.denominatorUnit !== null &&
      schema.evaluation.denominatorUnit(e.denominatorUnit) && e.denominatorUnit !== units[kind]) {
    errors.push('inconsistent:unit');
  }
  return errors;
}

function countConsistency(e, kind) {
  const errors = [];
  if (['misses', 'noise'].includes(kind) && knownNumbers(e, ['bad', 'denominator']) && e.bad > e.denominator) {
    errors.push('inconsistent:bad-denominator');
  }
  if (kind === 'misses' && knownNumbers(e, ['bad', 'triggerUnmatched', 'engineMiss', 'unattributable']) &&
      BigInt(e.bad) !== BigInt(e.triggerUnmatched) + BigInt(e.engineMiss) + BigInt(e.unattributable)) {
    errors.push('inconsistent:miss-total');
  }
  return errors;
}

function semanticErrors(input) {
  if (!record(input)) return [];
  const errors = measureErrors(input);
  const e = input.evaluation;
  if (record(e) && knownNumbers(e, times) &&
      !(e.windowStartMs < e.windowEndMs && e.windowEndMs <= e.evaluatedAtMs && e.evaluatedAtMs <= e.capturedAtMs)) {
    errors.push('inconsistent:time-order');
  }
  return errors;
}

function validateSnapshot(input) {
  if (!record(input)) return { valid: false, errors: ['schema:/'] };
  const errors = [];
  shape(input, schema, '', errors);
  errors.push(...semanticErrors(input));
  const sorted = unique(errors);
  return { valid: sorted.length === 0, errors: sorted };
}

function prepare(input) {
  try {
    // Descriptor copying never invokes getters and does not consume the call stack.
    const snapshot = dataSnapshot(input);
    const validation = validateSnapshot(snapshot);
    if (!validation.valid) return { validation };
    // Reject proxies, including ones lying about descriptors. Closed-schema data
    // is shallow; reject deep extras before the native clone's recursion limit.
    structuredClone(input);
    return { snapshot, validation };
  } catch {
    return { validation: { valid: false, errors: ['schema:/'] } };
  }
}

export function validateIntervention(input) {
  return prepare(input).validation;
}

function mismatches(input) {
  const { target: t, evaluation: e, policy: p } = input;
  const errors = [];
  for (const key of Object.keys(binding)) {
    if (t.binding[key] !== null && e.binding[key] !== null && t.binding[key] !== e.binding[key]) {
      errors.push(`binding:${key}`);
    }
  }
  for (const [left, right] of [['policyHash', 'hash'], ['scannerHash', 'scannerHash']]) {
    if (e[left] !== null && p[right] !== null && e[left] !== p[right]) errors.push(`binding:${left}`);
  }
  return unique(errors);
}

function identityBlockers(input) {
  const { target: t, evaluation: e, policy: p, request: r } = input;
  const result = [];
  if (!['revert-static', 'fix-trigger'].includes(r.action)) result.push('action:proposal-only');
  if (t.storage === 'shipped-plugin') result.push('storage:proposal-only');
  if (t.identityKnown !== true || [...Object.values(t.binding), ...Object.values(e.binding),
    t.storage, t.provenance].includes(null)) result.push('unknown:identity');
  if (t.storage !== null && t.provenance !== (t.storage === 'local' ? 'local' : 'plugin')) {
    result.push('origin:inconsistent');
  }
  if ([p.id, p.hash, p.scannerHash, p.asOfMs, p.maxAgeMs, e.id, e.manifestHash,
    e.policyHash, e.scannerHash].includes(null)) result.push('unknown:contract');
  return result;
}

function evidenceBlockers({ evaluation: e, policy: p, request: r }) {
  const result = timeBlockers(e, p);
  if (e.complete !== true || e.coherent !== true) result.push('evidence:incomplete');
  if (e.due !== true || e.gap !== false || e.cached !== false) result.push('evidence:not-current');
  if (e.measureStatus !== 'problem') result.push('evidence:not-problem');
  if (r.bodyUnchanged !== true || r.checkUnchanged !== true) result.push('action:changes-body-or-check');
  return result;
}

function timeBlockers(e, p) {
  const unknownTime = [...times.map(key => e[key]), p.asOfMs, p.maxAgeMs].includes(null);
  if (unknownTime) return ['evidence:time-unknown'];
  if (e.capturedAtMs > p.asOfMs || p.asOfMs - e.evaluatedAtMs > p.maxAgeMs) return ['evidence:time-outside'];
  return [];
}

const causal = {
  misses: e => e.denominator > 0 && 5n * BigInt(e.triggerUnmatched) > BigInt(e.denominator) &&
    e.engineMiss === 0 && e.unattributable === 0 && e.unobservable === 0,
  noise: e => e.denominator > 0 && 2n * BigInt(e.bad) > BigInt(e.denominator) && e.unresolved === 0,
  cost: e => e.staticBytes > 0 && e.servedBytes > e.staticBytes && e.contextsUnknownTiming === 0,
};

function supported(r) {
  return (r.action === 'fix-trigger' && ['misses', 'noise'].includes(r.measureKind)) ||
    (r.action === 'revert-static' && r.measureKind === 'cost');
}

function measureBlockers({ request: r, evaluation: e }) {
  if (!supported(r)) return ['measure:unsupported'];
  const result = [];
  const known = required[r.measureKind].every(key => e[key] !== null);
  if (!known || e.denominatorUnit === null) result.push('measure:unknown');
  if (e.denominator !== null && e.denominator < 5) result.push('measure:too-few');
  if (known && !causal[r.measureKind](e)) result.push('measure:not-causal');
  return result;
}

export function interventionEligibility(input) {
  const { snapshot, validation } = prepare(input);
  if (!validation.valid) return { mode: 'reject', reasons: validation.errors };
  const unequal = mismatches(snapshot);
  if (unequal.length) return { mode: 'reject', reasons: unequal };
  const reasons = unique([...identityBlockers(snapshot), ...evidenceBlockers(snapshot), ...measureBlockers(snapshot)]);
  return { mode: reasons.length ? 'proposal' : 'eligible', reasons };
}
