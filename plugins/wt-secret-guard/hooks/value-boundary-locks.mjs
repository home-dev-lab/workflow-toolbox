import assert from 'node:assert/strict';
import { classifyOutbound } from './outbound-tools.js';
import { classifyOutbound as baseClassify } from './fixtures/base-outbound-tools.frozen.mjs';
import { rows, objectRows } from './fixtures/value-boundary-rows.mjs';
import { contextualMatches } from './detector.js';
import { blankReferences, discoverCandidates, referenceProof, valueExtent } from './value-boundary.js';

const findings = async (content, classify = classifyOutbound) => (await classify({}, { tool: 'Write', content })).findings;
const groupOf = (id) => id.match(/^(?:AR|AF|CTL|SEED|[A-Z]|7)/)[0];

export function* variants(source = rows) {
  for (const [id, , content] of source.filter((row) => row[1] !== 'X')) {
    yield [id, content];
    for (const ending of ['\n', '\r\n', '\r']) for (const header of ['', '[s]\n']) {
      for (const indent of ['  ', '\t', '\u00a0', '\f', '\v']) for (const gap of ['\n', '\n# gap\n']) {
        for (const quoted of [false, true]) for (const tail of ['', ', Q7m9Ab12']) {
          const reference = quoted ? '"${VARIANT}"' : '${VARIANT}';
          const next = `${header}${content}${gap}${indent}${reference}${tail}`.replace(/\r?\n/g, ending);
          yield [id, next];
        }
      }
    }
  }
}

async function probeLocks(f) {
  const groups = new Map();
  for (const row of rows.filter((row) => row[1] !== 'X')) {
    const group = groupOf(row[0]);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  for (const [group, cases] of groups) await f.test(`VB probe group ${group}`, () => f.freshVault(async () => {
    for (const [id, want, content] of cases) assert.equal((await findings(content)).length > 0, want === 'R', id);
  }));
  await f.test('VB object probe group K', () => f.freshVault(async () => {
    for (const [id, want, input] of objectRows) {
      const result = await classifyOutbound({}, { tool: 'mcp__fixture__send', ...input });
      assert.equal(result.findings.length > 0, want === 'R', id);
      if (id.startsWith('AR6 ')) assert.ok(result.findings.some((item) => item.value === 'Q7m9Ab12'), 'object key credential was not held');
    }
  }));
}

async function containmentLock(f) {
  await f.test('VB blanked value-bearing capture containment', () => f.freshVault(async () => {
    let count = 0;
    for (const [, text] of variants()) {
      const candidates = discoverCandidates(text);
      for (const item of candidates.filter((candidate) => candidate.base)) {
        const extent = valueExtent(text, item, candidates);
        assert.equal(extent.start, item.valueStart, 'proof did not start at detector valueStart');
        assert.ok(extent.start <= Math.max(item.valueStart, item.captureStart) && extent.end >= item.captureEnd, 'extent lost value-bearing base capture');
        count += 1;
      }
    }
    console.log(`VB CONTAINMENT=${count}`);
  }));
}

async function preservedValues(text) {
  const { referenceProof, discoverCandidates, valueExtent } = await import('./value-boundary.js');
  const current = await findings(text);
  const candidates = discoverCandidates(text);
  for (const item of await findings(text, baseClassify)) {
    const original = candidates.find((candidate) => candidate.base && candidate.kind === item.kind && candidate.finding.value === item.value);
    if (!original || referenceProof(original.finding.value) || referenceProof(valueExtent(text, original, candidates).text)) continue;
    assert.ok(current.some((next) => next.kind === item.kind && next.value === item.value), 'uncancelled base finding changed');
  }
}

async function findingLocks(f) {
  await f.test('VB no reference-derived finding is a complete reference', () => f.freshVault(async () => {
    for (const [id, text] of variants()) for (const item of await findings(text)) {
      assert.equal(referenceProof(item.value), false, `reference-derived finding stayed a reference: ${id} ${JSON.stringify(item.value)}`);
    }
  }));
  await f.test('VB genuine uncancelled base values are unchanged', () => f.freshVault(async () => {
    for (const [, text] of variants()) await preservedValues(text);
  }));
  await f.test('VB raw residue values and short fallback', () => f.freshVault(async () => {
    assert.ok((await findings('password: ${HOME}\n  Q7m9Ab12\n')).some((item) => item.value === 'Q7m9Ab12'), 'raw residue was not held separately');
    const text = '[s]\npassword=${HOME}\n  x=ab\n  y=cd\n';
    assert.ok((await findings(text)).some((item) => item.value === '${HOME}\n  x=ab\n  y=cd'), 'short residue fallback changed');
  }));
}

function* differentialCases() {
  for (const [id, text] of variants()) yield [id, { tool: 'Write', content: text }];
  for (const [id, want, input] of objectRows) {
    const key = Object.keys(input)[0];
    for (const [, text] of variants([[id, want, input[key]]])) yield [id, { tool: 'mcp__fixture__send', [key]: text }];
  }
}

function occurrenceProofs(key, text) {
  const candidates = discoverCandidates(text);
  const direct = candidates.filter((item) => item.base).map((item) => ({
    kind: item.kind, value: item.finding.value, proof: valueExtent(text, item, candidates),
  }));
  const prefix = `${key}: `;
  for (const item of contextualMatches(prefix + blankReferences(text))) {
    if (direct.some((entry) => entry.value === item.value)) continue;
    const shifted = Object.fromEntries(['keyStart', 'valueStart', 'captureStart', 'captureEnd'].map((name) => [name, item[name] - prefix.length]));
    const proof = item.keyStart < prefix.length
      ? { text: item.valueStart === prefix.length && referenceProof(text, 'decoded') ? text : '', mode: 'decoded' }
      : valueExtent(text, { ...item, ...shifted, base: true }, candidates);
    direct.push({ kind: item.kind, value: text, proof });
  }
  return direct;
}

function justifyFlip(event, before, id) {
  const [key, text] = Object.entries(event).find(([name]) => name !== 'tool');
  const evidence = occurrenceProofs(key, text);
  for (const item of before) {
    const occurrences = evidence.filter((entry) => entry.kind === item.kind && entry.value === item.value);
    assert.ok(occurrences.length, `independent base finding cancelled: ${id}`);
    for (const entry of occurrences) assert.ok(referenceProof(entry.proof.text, entry.proof.mode), `unproven base occurrence cancelled: ${id}`);
  }
  return evidence.length;
}

async function differentialLock(f) {
  await f.test('VB frozen base credential differential and occurrence proofs', () => f.freshVault(async () => {
    const required = new Set([...rows, ...objectRows].filter((row) => row[1] === 'R').map((row) => row[0]));
    const flips = [];
    let count = 0; let credentials = 0; let exempted = 0; let proofs = 0;
    for (const [id, event] of differentialCases()) {
      const planted = required.has(id) || JSON.stringify(event).includes('Q7m9Ab12');
      const before = (await baseClassify({}, event)).findings;
      if (planted) credentials += 1;
      if (before.length && !(await classifyOutbound({}, event)).findings.length) {
        if (planted) flips.push(id);
        else { proofs += justifyFlip(event, before, id); exempted += 1; }
      }
      count += 1;
    }
    console.log(`VB DIFFERENTIAL=${count} CREDENTIAL_BEARING=${credentials} CREDENTIAL_FLIPS=${flips.length} JUSTIFIED_FLIPS=${exempted} OCCURRENCE_PROOFS=${proofs}`);
    assert.equal(flips.length, 0, `credential-bearing base refusals became written: ${[...new Set(flips)].join('|')}`);
  }));
}

async function sequentialLock(f) {
  await f.test('VB refusal tokenization retains later bare protection', () => f.freshVault(async () => {
    const initial = await findings('password=Q7m9Ab12; note=abcdefghijklmnop');
    assert.ok(initial.length, 'initial assignment was not refused');
    for (const item of initial) f.tokenize(item.kind, item.secret ?? item.value);
    assert.ok((await findings('Q7m9Ab12')).length, 'later bare value was not refused');
  }));
}

async function entryPointLock(f) {
  await f.test('VB real Write handler refuses H2 and accepts M2', () => f.freshVault(async () => {
    for (const id of ['H2', 'M2']) {
      const content = rows.find(([name]) => name.startsWith(`${id} `))[2];
      let forwarded = false;
      const answer = await f.hookForTool('Write')(f.$, { tool: 'Write', content }, async () => { forwarded = true; return {}; });
      assert.equal(Boolean(answer.deny), id === 'H2', `${id} handler verdict`);
      assert.equal(JSON.stringify(answer).includes('Q7m9Ab12'), false, 'refusal printed credential');
      assert.equal(forwarded, id === 'M2');
      console.log(`VB E2E ${id} ${JSON.stringify(answer)} FORWARDED=${forwarded}`);
    }
  }));
}

async function grammarLock(f) {
  await f.test('VB strict reference grammar by source', async () => {
    const { referenceProof } = await import('./value-boundary.js');
    const cases = [
      ['${A}', 'extent', true], ['("${A}" + "${B}")', 'extent', true],
      ['"""${A}"""', 'extent', true], ['${A}word', 'extent', false],
      ['++;,()[]{}', 'extent', false], ['"${A}\n# Q7m9Ab12"', 'extent', false],
      ['${A}, ${B};', 'decoded', true], ['"${A}"', 'decoded', false],
      ['[${A}]', 'decoded', false], ['${A}\n# Q7m9Ab12', 'decoded', false],
      ['<![CDATA[${A}]]>', 'xml', true], ['${A} ${B}', 'xml', true],
      ['${A}, ${B}', 'xml', false], ['${A}&amp;', 'xml', false],
    ];
    for (const [text, mode, want] of cases) assert.equal(referenceProof(text, mode), want, `grammar ${mode}: ${text}`);
  });
}

async function commentLineLock(f) {
  await f.test('VB CRLF comment gap cannot end continuation', () => f.freshVault(async () => {
    const text = '[service]\r\npassword="${HOME}"\r\n# comment\r\n    Q7m9Ab12\r\n\r\n  ${VARIANT}';
    assert.ok((await findings(text, baseClassify)).length, 'control must be refused by base');
    assert.ok((await findings(text)).length, 'CRLF comment gap hid the credential continuation');
  }));
}

async function continuationLocks(f) {
  for (const [name, text] of [
    ['form feed', '[s]\npassword="${HOME}"\n\fQ7m9Ab12\n'],
    ['vertical tab', '[s]\npassword="${HOME}"\n\vQ7m9Ab12\n'],
    ['short reference', '[s]\npassword="${A}"\n  Q7m9Ab12'],
    ['outside extent tail', 'db:\n  password: "${DB_PASSWORD}"\n  user: bob\n\n  ${VARIANT}, Q7m9Ab12'],
  ]) await f.test(`VB credential continuation ${name}`, () => f.freshVault(async () => {
    assert.ok((await findings(text, baseClassify)).length, 'base must refuse control');
    assert.ok((await findings(text)).length, `${name} credential escaped refusal`);
  }));
  await f.test('VB short JSON references project only the key prefix', () => f.freshVault(async () => {
    assert.equal((await findings('{"password":"${A}","token":"${B}"}')).length, 0, 'short reference fallback included key syntax');
  }));
}

async function sequence(f, content, later, refused = true) {
  const event = typeof content === 'string' ? { tool: 'Write', content } : { tool: 'mcp__fixture__send', ...content };
  const initial = (await classifyOutbound({}, event)).findings;
  assert.ok(initial.length, 'initial credential must be refused');
  for (const item of initial) f.tokenize(item.kind, item.secret ?? item.value);
  assert.equal(Boolean((await findings(later)).length), refused, `later ${later} protection verdict`);
  return initial;
}

async function provenanceLocks(f) {
  const reference = 'secret:' + 'env:A1B2C3';
  for (const [name, content, later, refused] of [
    ['reference continuation residue', '[service]\npassword="${HOME}"\n    Q7m9Ab12\n', 'Q7m9Ab12', true],
    ['genuine quoted comma credential', 'password="ab,cd12"', 'ab,cd12', true],
    ['object key credential', { 'password=Q7m9Ab12': '${HOME}' }, 'Q7m9Ab12', true],
    ['reference spelling not held', `[s]\npassword="${reference}"\n  Q7m9Ab12`, reference, false],
  ]) await f.test(`VB provenance ${name}`, () => f.freshVault(async () => {
    const initial = await sequence(f, content, later, refused);
    if (name === 'genuine quoted comma credential') assert.ok(initial.some((item) => item.value === later), 'genuine base credential bytes changed');
    else for (const item of initial) assert.equal(referenceProof(item.value), false, 'reference-derived finding retained reference');
  }));
  await f.test('VB trusted held reference is never filtered', () => f.freshVault(async () => {
    f.tokenize('file', '${HOME}');
    assert.ok((await findings('${HOME}')).some((item) => item.secret === '${HOME}'), 'trusted held reference leaked');
  }));
  await f.test('VB key-origin fallback never drops base evidence', () => f.freshVault(async () => {
    const event = { tool: 'mcp__fixture__send', 'password=': '${HOME}' };
    assert.ok((await baseClassify({}, event)).findings.length, 'base key-origin control');
    assert.ok((await classifyOutbound({}, event)).findings.length, 'key-origin fallback evidence was dropped');
  }));
}

export async function runValueBoundaryLocks(fixture) {
  for (const run of [probeLocks, containmentLock, findingLocks, differentialLock, sequentialLock, entryPointLock, grammarLock, commentLineLock, continuationLocks, provenanceLocks]) await run(fixture);
}
