import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
// One module URL for the main thread and the workers; an override may be a file URL or a native path.
const override = process.env.WT_INTERVENTION_POLICY_MODULE;
const moduleUrl = !override ? new URL('../scripts/intervention-policy.mjs', import.meta.url).href
  : override.startsWith('file:') ? override : pathToFileURL(override).href;
const { interventionEligibility, validateIntervention: validate } = await import(moduleUrl);
const eligible = interventionEligibility;

const hash = 'a'.repeat(64);
const units = { misses: 'governed-act', noise: 'resolved-delivery', cost: 'effective-context' };
const numeric = ['denominator', 'bad', 'triggerUnmatched', 'engineMiss', 'unattributable',
  'unobservable', 'unresolved', 'servedBytes', 'staticBytes', 'contextsUnknownTiming'];
const fields = {
  misses: ['denominator', 'bad', 'triggerUnmatched', 'engineMiss', 'unattributable', 'unobservable'],
  noise: ['denominator', 'bad', 'unresolved'],
  cost: ['denominator', 'servedBytes', 'staticBytes', 'contextsUnknownTiming'],
};

function record(kind = 'misses') {
  const binding = { rootId: 'root:1', ruleId: 'rule:1', scope: 'project', snapshotHash: hash, generation: 'g:1' };
  const counts = Object.fromEntries(numeric.map(key => [key, null]));
  const values = { denominator: 5, bad: 3, triggerUnmatched: 3, engineMiss: 0,
    unattributable: 0, unobservable: 0, unresolved: 0, servedBytes: 101,
    staticBytes: 100, contextsUnknownTiming: 0 };
  for (const key of fields[kind]) counts[key] = values[key];
  return {
    schemaVersion: 1,
    request: { action: kind === 'cost' ? 'revert-static' : 'fix-trigger', measureKind: kind,
      bodyUnchanged: true, checkUnchanged: true },
    target: { binding: { ...binding }, identityKnown: true, storage: 'local', provenance: 'local' },
    evaluation: { id: 'eval:1', manifestHash: hash, policyHash: hash, scannerHash: hash,
      binding: { ...binding }, evaluatedAtMs: 20, capturedAtMs: 21, windowStartMs: 0,
      windowEndMs: 10, complete: true, coherent: true, due: true, gap: false, cached: false,
      measureStatus: 'problem', denominatorUnit: units[kind], ...counts },
    policy: { id: 'policy:1', hash, scannerHash: hash, asOfMs: 25, maxAgeMs: 5 },
  };
}

function assertEligibility(input, mode, reasons = []) {
  assert.deepEqual(eligible(input), { mode, reasons });
}

function freeze(value) {
  if (value && typeof value === 'object') Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

for (const kind of Object.keys(units)) {
  test(`${kind}: positive, deterministic and immutable`, () => {
    const input = freeze(record(kind));
    const before = JSON.stringify(input);
    assert.deepEqual(validate(input), { valid: true, errors: [] });
    assertEligibility(input, 'eligible'); assertEligibility(input, 'eligible');
    assert.equal(JSON.stringify(input), before);
  });
  test(`${kind}: adopted copy has editable storage`, () => {
    const input = record(kind); input.target.storage = 'adopted-local'; input.target.provenance = 'plugin';
    assertEligibility(input, 'eligible');
  });
  test(`${kind}: known incorrect unit rejects independently of action`, () => {
    const input = record(kind);
    input.evaluation.denominatorUnit = Object.values(units).find(unit => unit !== units[kind]);
    assertEligibility(input, 'reject', ['inconsistent:unit']);
  });
  for (let cases = 0; cases < 5; cases++) {
    test(`${kind}: floor ${cases}`, () => {
      const input = record(kind);
      input.evaluation.denominator = cases;
      if (kind !== 'cost') input.evaluation.bad = Math.min(cases, 3);
      if (kind === 'misses') input.evaluation.triggerUnmatched = input.evaluation.bad;
      const reasons = ['measure:too-few'];
      if (cases === 0 && kind !== 'cost') reasons.unshift('measure:not-causal');
      const fourCaseRecord = input;
      assert.notEqual(interventionEligibility(fourCaseRecord).mode, 'eligible');
      assertEligibility(input, 'proposal', reasons);
    });
  }
  for (const key of [...fields[kind], 'denominatorUnit']) {
    test(`${kind}: unknown ${key}`, () => {
      const input = record(kind); input.evaluation[key] = null;
      assertEligibility(input, 'proposal', ['measure:unknown']);
    });
  }
  for (const key of numeric.filter(key => !fields[kind].includes(key))) {
    test(`${kind}: irrelevant ${key}`, () => {
      const input = record(kind); input.evaluation[key] = 0;
      assertEligibility(input, 'reject', ['inconsistent:irrelevant-fields']);
    });
  }
}

test('nullable units and unsupported actions have exact distinct outputs', () => {
  const input = record(); input.evaluation.denominatorUnit = null;
  assertEligibility(input, 'proposal', ['measure:unknown']);
  input.request.action = 'revert-static';
  assertEligibility(input, 'proposal', ['measure:unsupported']);
  input.evaluation.denominatorUnit = 'governed-act';
  assertEligibility(input, 'proposal', ['measure:unsupported']);
  input.evaluation.denominatorUnit = 'resolved-delivery';
  assertEligibility(input, 'reject', ['inconsistent:unit']);
});

for (const [kind, patch] of [
  ['misses', { bad: 1, triggerUnmatched: 1 }],
  ['noise', { denominator: 6, bad: 3 }], ['noise', { denominator: 2, bad: 1 }],
  ['cost', { servedBytes: 100 }], ['cost', { staticBytes: 0 }],
  ['misses', { triggerUnmatched: 0, engineMiss: 3 }],
  ['misses', { triggerUnmatched: 0, unattributable: 3 }],
  ['misses', { triggerUnmatched: 2, engineMiss: 1 }],
  ['misses', { unobservable: 1 }], ['noise', { unresolved: 1 }],
  ['cost', { contextsUnknownTiming: 1 }],
].entries()) {
  const [measure, changes] = patch;
  test(`causal boundary ${kind}`, () => {
    const input = record(measure); Object.assign(input.evaluation, changes);
    const reasons = ['measure:not-causal'];
    if (input.evaluation.denominator < 5) reasons.push('measure:too-few');
    assertEligibility(input, 'proposal', reasons);
  });
}

const unknownReasons = {
  request: { bodyUnchanged: ['action:changes-body-or-check'], checkUnchanged: ['action:changes-body-or-check'] },
  target: { identityKnown: ['unknown:identity'], storage: ['unknown:identity'],
    provenance: ['origin:inconsistent', 'unknown:identity'] },
  evaluation: { id: ['unknown:contract'], manifestHash: ['unknown:contract'], policyHash: ['unknown:contract'],
    scannerHash: ['unknown:contract'], evaluatedAtMs: ['evidence:time-unknown'],
    capturedAtMs: ['evidence:time-unknown'], windowStartMs: ['evidence:time-unknown'],
    windowEndMs: ['evidence:time-unknown'], complete: ['evidence:incomplete'], coherent: ['evidence:incomplete'],
    due: ['evidence:not-current'], gap: ['evidence:not-current'], cached: ['evidence:not-current'],
    measureStatus: ['evidence:not-problem'] },
  policy: { id: ['unknown:contract'], hash: ['unknown:contract'], scannerHash: ['unknown:contract'],
    asOfMs: ['evidence:time-unknown', 'unknown:contract'], maxAgeMs: ['evidence:time-unknown', 'unknown:contract'] },
};
for (const [section, keys] of Object.entries(unknownReasons)) {
  for (const [key, reasons] of Object.entries(keys)) {
    test(`unknown ${section}/${key}`, () => {
      const input = record(); input[section][key] = null; assertEligibility(input, 'proposal', reasons);
    });
  }
}
for (const section of ['target', 'evaluation']) {
  for (const key of Object.keys(record()[section].binding)) {
    test(`unknown binding ${section}/${key}`, () => {
      const input = record(); input[section].binding[key] = null;
      assertEligibility(input, 'proposal', ['unknown:identity']);
    });
    test(`mismatch ${section}/${key} rejects before proposal`, () => {
      const input = record(); input.request.action = 'delete';
      const changes = { scope: 'user', snapshotHash: 'b'.repeat(64) };
      input[section].binding[key] = changes[key] ?? 'different';
      assertEligibility(input, 'reject', [`binding:${key}`]);
    });
  }
}
for (const key of ['policyHash', 'scannerHash']) {
  test(`mismatch ${key}`, () => {
    const input = record(); input.evaluation[key] = 'b'.repeat(64);
    assertEligibility(input, 'reject', [`binding:${key}`]);
  });
}
for (const [section, key] of [['request', 'bodyUnchanged'], ['request', 'checkUnchanged'],
  ['target', 'identityKnown'], ['evaluation', 'complete'], ['evaluation', 'coherent'],
  ['evaluation', 'due'], ['evaluation', 'gap'], ['evaluation', 'cached']]) {
  test(`flipped guard ${section}/${key}`, () => {
    const input = record(); input[section][key] = !input[section][key];
    assertEligibility(input, 'proposal', unknownReasons[section][key]);
  });
}

test('freshness boundaries, future capture, invalid time order', () => {
  const input = record(); assertEligibility(input, 'eligible');
  input.policy.asOfMs++; assertEligibility(input, 'proposal', ['evidence:time-outside']);
  input.policy.asOfMs = 20; assertEligibility(input, 'proposal', ['evidence:time-outside']);
  input.evaluation.windowStartMs = 10;
  assertEligibility(input, 'reject', ['inconsistent:time-order']);
});

for (const action of ['delete', 'merge', 'edit-body', 'edit-shipped-source', 'convert-guard']) {
  test(`proposal-only ${action}`, () => {
    const input = record(); input.request.action = action;
    assertEligibility(input, 'proposal', ['action:proposal-only', 'measure:unsupported']);
  });
}
for (const kind of ['driftMigration', 'driftAdopted', 'health', 'coverage', 'delete', 'guard']) {
  test(`unsupported kind ${kind}`, () => {
    const input = record(); input.request.measureKind = kind;
    for (const key of [...numeric, 'denominatorUnit']) input.evaluation[key] = null;
    assertEligibility(input, 'proposal', ['measure:unsupported']);
    input.evaluation.denominator = 0;
    assertEligibility(input, 'reject', ['inconsistent:irrelevant-fields']);
  });
}
test('storage classification is independent from origin', () => {
  const input = record(); input.target.storage = 'adopted-local'; input.target.provenance = 'plugin';
  assertEligibility(input, 'eligible'); input.target.storage = 'shipped-plugin';
  assertEligibility(input, 'proposal', ['storage:proposal-only']);
  input.target.storage = 'local'; assertEligibility(input, 'proposal', ['origin:inconsistent']);
});

test('legacy engine-only fixture mapping cannot infer trigger authority', () => {
  const report = { complete: true, verdict: 'problem', proposals: ['fix trigger'], measures: {
    rules: { legacy: { origin: 'plugin', measures: { volume: { due: true, gap: false },
      misses: { status: 'problem', cases: 10, count: 3, triggerUnmatched: 0,
        engineMiss: 3, unattributable: 0, unobservable: 0 } } } } } };
  const input = record(); const measures = report.measures.rules.legacy.measures;
  Object.assign(input.evaluation, measures.volume, { complete: report.complete, cached: false,
    measureStatus: measures.misses.status, denominator: measures.misses.cases, bad: measures.misses.count });
  for (const key of ['triggerUnmatched', 'engineMiss', 'unattributable', 'unobservable']) {
    input.evaluation[key] = measures.misses[key];
  }
  input.target.storage = 'adopted-local'; input.target.provenance = report.measures.rules.legacy.origin;
  assertEligibility(input, 'proposal', ['measure:not-causal']);
});

for (const [value, pointer] of [[-1, '/evaluation/denominator'], [0.5, '/evaluation/denominator'],
  [Number.MAX_SAFE_INTEGER + 1, '/evaluation/denominator'], [NaN, '/'], [Infinity, '/']]) {
  test(`invalid count ${String(value)}`, () => {
    const input = record(); input.evaluation.denominator = value;
    assertEligibility(input, 'reject', [`schema:${pointer}`]);
  });
}
test('invalid sums, denominators and known wrong units', () => {
  const input = record(); input.evaluation.bad = 6;
  assertEligibility(input, 'reject', ['inconsistent:bad-denominator', 'inconsistent:miss-total']);
  input.evaluation.denominatorUnit = 'effective-context';
  assertEligibility(input, 'reject', ['inconsistent:bad-denominator', 'inconsistent:miss-total', 'inconsistent:unit']);
});

for (const section of ['request', 'target', 'evaluation', 'policy']) {
  for (const key of Object.keys(record()[section])) {
    test(`missing ${section}/${key}`, () => {
      const input = record(); delete input[section][key];
      assertEligibility(input, 'reject', [`schema:/${section}/${key}`]);
    });
  }
}
test('shape errors collect sorted unique escaped pointers', () => {
  const input = record(); input.request.action = 'bogus'; input.target.binding = [];
  input.policy.hash = 'A'.repeat(64); input['a/b~c'] = true;
  assertEligibility(input, 'reject', ['schema:/a~1b~0c', 'schema:/policy/hash', 'schema:/request/action', 'schema:/target/binding']);
});
for (const value of [undefined, null, [], 1, new Date(), () => {}, new Map()]) {
  test(`non-record root ${String(value)}`, () => assertEligibility(value, 'reject', ['schema:/']));
}
test('non-JSON nested values and cycles fail without invoking getters', () => {
  for (const value of [undefined, () => {}, Symbol('x'), 1n, new Date()]) {
    const input = record(); input.target.extra = value;
    assertEligibility(input, 'reject', ['schema:/']);
  }
  const input = record(); input.target.extra = input;
  assertEligibility(input, 'reject', ['schema:/']);
  delete input.target.extra;
  Object.defineProperty(input.target, 'provenance', { get() { throw Error('must not run'); } });
  assertEligibility(input, 'reject', ['schema:/']);
});
test('multiple blockers sorted and duplicate-suppressed', () => {
  const input = record(); input.evaluation.complete = false; input.evaluation.coherent = false;
  input.policy.hash = null; input.policy.id = null; input.request.bodyUnchanged = false;
  assertEligibility(input, 'proposal', ['action:changes-body-or-check', 'evidence:incomplete', 'unknown:contract']);
});

for (const section of ['request', 'target', 'evaluation', 'policy']) {
  for (const key of Object.keys(record()[section]).filter(key => key !== 'binding')) {
    test(`invalid type ${section}/${key}`, () => {
      const input = record(); input[section][key] = {};
      assertEligibility(input, 'reject', [`schema:/${section}/${key}`]);
    });
  }
}
for (const section of ['target', 'evaluation']) {
  for (const key of Object.keys(record()[section].binding)) {
    test(`missing binding ${section}/${key}`, () => {
      const input = record(); delete input[section].binding[key];
      assertEligibility(input, 'reject', [`schema:/${section}/binding/${key}`]);
    });
  }
}
for (const path of [[], ['request'], ['target'], ['evaluation'], ['policy'],
  ['target', 'binding'], ['evaluation', 'binding']]) {
  test(`extra field ${path.join('/')}`, () => {
    const input = record(); let object = input;
    for (const key of path) object = object[key];
    object.extra = 1;
    assertEligibility(input, 'reject', [`schema:/${[...path, 'extra'].join('/')}`]);
  });
}
test('all guards collect without short circuit', () => {
  const input = record(); input.request.action = 'delete';
  input.target.identityKnown = false; input.target.storage = 'shipped-plugin'; input.target.provenance = 'local';
  input.policy.id = null; input.evaluation.complete = false; input.evaluation.due = false;
  input.policy.asOfMs = null; input.evaluation.measureStatus = 'OK'; input.request.checkUnchanged = false;
  assertEligibility(input, 'proposal', ['action:changes-body-or-check', 'action:proposal-only', 'evidence:incomplete',
    'evidence:not-current', 'evidence:not-problem', 'evidence:time-unknown', 'measure:unsupported',
    'origin:inconsistent', 'storage:proposal-only', 'unknown:contract', 'unknown:identity']);
});
test('JSON descriptors, symbol keys and sparse arrays are not accepted', () => {
  const input = record(); input.target.extra = new Array(2);
  assertEligibility(input, 'reject', ['schema:/']); delete input.target.extra;
  input.target[Symbol('extra')] = 1; assertEligibility(input, 'reject', ['schema:/']);
  const other = record(); Object.defineProperty(other.target, 'extra', { value: 1 });
  assertEligibility(other, 'reject', ['schema:/']);
  const plain = record(); Object.setPrototypeOf(plain, null); assertEligibility(plain, 'eligible');
});
test('ratio decisions use unrounded values', () => {
  const input = record();
  Object.assign(input.evaluation, { denominator: 1000001, bad: 200001, triggerUnmatched: 200001 });
  assertEligibility(input, 'eligible');
  Object.assign(input.evaluation, { denominator: 1000000, bad: 200000, triggerUnmatched: 200000 });
  assertEligibility(input, 'proposal', ['measure:not-causal']);
});
test('identifiers and hashes reject trailing line terminators and empty values', () => {
  for (const value of ['', 'x\n', 'x\r', 'x\u2028', 'with space', 'é']) {
    const input = record(); input.policy.id = value;
    assertEligibility(input, 'reject', ['schema:/policy/id']);
  }
  const input = record(); input.policy.hash = `${hash}\n`;
  assertEligibility(input, 'reject', ['schema:/policy/hash']);
});
for (const key of Object.keys(record())) {
  test(`missing root ${key}`, () => {
    const input = record(); delete input[key];
    assertEligibility(input, 'reject', [`schema:/${key}`]);
  });
}
for (const status of ['OK', 'watch', 'unknown', 'unmeasurable']) {
  test(`non-problem selected measure ${status}`, () => {
    const input = record(); input.evaluation.measureStatus = status;
    assertEligibility(input, 'proposal', ['evidence:not-problem']);
  });
}
test('schema rejection precedes known binding rejection', () => {
  const input = record(); input.evaluation.binding.ruleId = 'other'; input.policy.id = '';
  assertEligibility(input, 'reject', ['schema:/policy/id']);
});
test('unknown unit still collects independently known causal and sample blockers', () => {
  const input = record(); input.evaluation.denominatorUnit = null;
  Object.assign(input.evaluation, { denominator: 0, bad: 0, triggerUnmatched: 0 });
  assertEligibility(input, 'proposal', ['measure:not-causal', 'measure:too-few', 'measure:unknown']);
});

test('window end cannot follow evaluation', () => {
  const input = record(); input.evaluation.windowEndMs = 21;
  assertEligibility(input, 'reject', ['inconsistent:time-order']);
});
test('capture cannot precede evaluation', () => {
  const input = record(); input.evaluation.capturedAtMs = 19;
  assertEligibility(input, 'reject', ['inconsistent:time-order']);
});
test('adopted-local requires plugin provenance', () => {
  const input = record(); input.target.storage = 'adopted-local';
  assertEligibility(input, 'proposal', ['origin:inconsistent']);
});
test('present schema version must be one', () => {
  const input = record(); input.schemaVersion = 2;
  assertEligibility(input, 'reject', ['schema:/schemaVersion']);
});
test('noise bad cannot exceed denominator', () => {
  const input = record('noise'); input.evaluation.bad = 6;
  assertEligibility(input, 'reject', ['inconsistent:bad-denominator']);
});
test('unsupported kind requires null unit independently of counts', () => {
  const input = record(); input.request.measureKind = 'health';
  for (const key of numeric) input.evaluation[key] = null;
  assertEligibility(input, 'reject', ['inconsistent:irrelevant-fields']);
});
test('misses threshold preserves safe-integer precision boundary', () => {
  const input = record();
  Object.assign(input.evaluation, { denominator: 9007199254740989,
    bad: 1801439850948198, triggerUnmatched: 1801439850948198 });
  assertEligibility(input, 'eligible');
});
test('proxy concealed accessor is rejected without executing getter', () => {
  const input = record(); let calls = 0;
  Object.defineProperty(input.target, 'identityKnown', {
    enumerable: true, configurable: true, get() { calls++; return true; },
  });
  input.target = new Proxy(input.target, {
    getOwnPropertyDescriptor(target, key) {
      return key === 'identityKnown'
        ? { value: true, writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.deepEqual(validate(input), { valid: false, errors: ['schema:/'] });
  assertEligibility(input, 'reject', ['schema:/']);
  assert.equal(calls, 0);
});
test('deep extra data returns schema rejection without throwing', () => {
  const input = record(); let tail = input;
  for (let i = 0; i < 10000; i++) { tail.extra = {}; tail = tail.extra; }
  assert.deepEqual(validate(input), { valid: false, errors: ['schema:/extra'] });
  assertEligibility(input, 'reject', ['schema:/extra']);
});

for (const operation of ['validate', 'eligible']) {
  for (const installsGetter of [false, true]) {
    test(`proxy boundary ${operation}: self-removing getter=${installsGetter}`, () => {
      const input = record(); let traps = 0; let getters = 0;
      input.target.identityKnown = false;
      input.target = new Proxy(input.target, {
        getOwnPropertyDescriptor(target, key) {
          traps++;
          if (key !== 'identityKnown') return Reflect.getOwnPropertyDescriptor(target, key);
          input.target = target;
          if (installsGetter) Object.defineProperty(target, key, {
            enumerable: true, configurable: true, get() { getters++; return true; },
          });
          return { value: true, writable: true, enumerable: true, configurable: true };
        },
      });
      const result = operation === 'validate' ? validate(input) : eligible(input);
      assert.equal(traps, 0, 'proxy traps must not run');
      assert.equal(getters, 0, 'installed getters must not run');
      assert.deepEqual(result, operation === 'validate'
        ? { valid: false, errors: ['schema:/'] } : { mode: 'reject', reasons: ['schema:/'] });
    });
  }
}

test('nested proxy rejects before inspecting its prototype, keys or descriptors', () => {
  const input = record(); let traps = 0;
  const trap = () => { traps++; return null; };
  input.extra = { nested: new Proxy({}, {
    getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  }) };
  assert.deepEqual(validate(input), { valid: false, errors: ['schema:/'] });
  assertEligibility(input, 'reject', ['schema:/']);
  assert.equal(traps, 0, 'nested proxy traps must not run');
});

test('revoked proxy rejects without throwing', () => {
  const input = record(); const { proxy, revoke } = Proxy.revocable({}, {});
  revoke(); input.target.binding = proxy;
  assert.deepEqual(validate(input), { valid: false, errors: ['schema:/'] });
  assertEligibility(input, 'reject', ['schema:/']);
});

for (const levels of [22, 64]) {
  test(`shared DAG ${levels} levels stays within linear traversal budget`, { timeout: 1000 }, async t => {
    // A worker lets the timeout interrupt even a synchronous exponential walk.
    const source = `import { parentPort, workerData } from 'node:worker_threads';
      const { validateIntervention, interventionEligibility } = await import(workerData.module);
      let node = {};
      for (let i = 0; i < workerData.levels; i++) node = { a: node, b: node };
      workerData.input.extra = node;
      parentPort.postMessage([validateIntervention(workerData.input), interventionEligibility(workerData.input)]);`;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      workerData: { levels, input: record(), module: moduleUrl },
    });
    t.after(() => worker.terminate());
    const results = await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    assert.deepEqual(results, [{ valid: false, errors: ['schema:/extra'] },
      { mode: 'reject', reasons: ['schema:/extra'] }]);
  });
}

for (const [reason, patch] of [
  ['time-order', { capturedAtMs: 19 }],
  ['bad-denominator', { denominator: 2 }],
  ['miss-total', { triggerUnmatched: 2 }],
  ['unit', { denominatorUnit: 'resolved-delivery' }],
  ['irrelevant-fields', { unresolved: 0 }],
]) {
  test(`validator directly rejects inconsistent:${reason}`, () => {
    const input = record(); Object.assign(input.evaluation, patch);
    assert.deepEqual(validate(input), { valid: false, errors: [`inconsistent:${reason}`] });
  });
}

test('validator reports every consistency error, not only the first', () => {
  const input = record(); input.evaluation.bad = 6;
  assert.deepEqual(validate(input), { valid: false,
    errors: ['inconsistent:bad-denominator', 'inconsistent:miss-total'] });
});
