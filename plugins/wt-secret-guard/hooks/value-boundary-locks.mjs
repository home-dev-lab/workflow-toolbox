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
      for (const indent of ['  ', '\t', '\u00a0', '\f', '\v', '\u0085', '\u001c', '\u001d', '\u001e', '\u001f', '\u2028', '\u2029']) for (const gap of ['\n', '\n# gap\n']) {
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
    kind: item.kind, value: item.finding.value, keyStart: item.keyStart, proof: valueExtent(text, item, candidates),
  }));
  const prefix = `${key}: `;
  for (const item of contextualMatches(prefix + blankReferences(text))) {
    // Frozen key-path deduplication compares the blanked value with raw-mapped values.
    if (direct.some((entry) => entry.value === item.value)) continue;
    const occurrence = direct.find((entry) => entry.kind === item.kind && entry.keyStart === item.keyStart - prefix.length);
    if (occurrence) direct.push({ kind: item.kind, value: text, duplicateOf: occurrence, proof: occurrence.proof });
    else if (item.keyStart < prefix.length && item.valueStart === prefix.length) {
      direct.push({ kind: item.kind, value: text, proof: { start: 0, end: text.length, text, mode: 'decoded' } });
    }
  }
  return direct;
}

function removalRange(text, entry) {
  let start = entry.duplicateOf?.keyStart ?? entry.keyStart ?? 0;
  let end = entry.proof.end;
  const lineStart = Math.max(text.lastIndexOf('\n', start - 1), text.lastIndexOf('\r', start - 1)) + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, start)) && /^(?:\r\n|[\r\n]|$)/.test(text.slice(end))) {
    start = lineStart;
    end += text.slice(end).match(/^(?:\r\n|[\r\n])/)?.[0].length ?? 0;
  }
  return [start, end];
}

function removeOccurrences(text, evidence) {
  const ranges = evidence.filter((entry) => entry.proof.modelled !== false && referenceProof(entry.proof.text, entry.proof.mode))
    .map((entry) => removalRange(text, entry)).sort((a, b) => a[0] - b[0]);
  assert.ok(ranges.length, 'flip control removed no proven occurrence');
  const merged = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  for (const [start, end] of merged.reverse()) text = text.slice(0, start) + text.slice(end);
  return text;
}

function referenceControl(event, evidence) {
  const [key, text] = Object.entries(event).find(([name]) => name !== 'tool');
  return { ...event, [key]: removeOccurrences(text, evidence) };
}

async function justifyFlip(event, before, id) {
  const [key, text] = Object.entries(event).find(([name]) => name !== 'tool');
  const evidence = occurrenceProofs(key, text);
  for (const item of before) {
    const occurrences = evidence.filter((entry) => entry.kind === item.kind && entry.value === item.value);
    assert.ok(occurrences.length, `independent base finding cancelled: ${id}`);
    for (const entry of occurrences) {
      assert.notEqual(entry.proof.modelled, false, `unmodelled base occurrence cancelled: ${id}`);
      assert.ok(referenceProof(entry.proof.text, entry.proof.mode), `unproven base occurrence cancelled: ${id}`);
      if (entry.duplicateOf) assert.ok(before.some((direct) => direct.kind === entry.duplicateOf.kind && direct.value === entry.duplicateOf.value), `whole-field finding lacks direct occurrence: ${id}`);
    }
  }
  assert.equal((await baseClassify({}, referenceControl(event, evidence))).findings.length, 0, `occurrence-removed control still refused: ${id}`);
  return evidence.length;
}

async function recordFlip(counts, reasons, event, before, id, planted) {
  if (id.startsWith('D13 ')) counts.d13 += 1;
  try { counts.proofs += await justifyFlip(event, before, id); }
  catch (error) {
    counts.unjustified += 1;
    if (planted) counts.credentialUnjustified += 1;
    else counts.policyUnjustified += 1;
    reasons.set(id, error.message.split('\n')[0]);
    return;
  }
  if (planted) counts.justified += 1;
  else counts.policy += 1;
}

async function measureDifferential() {
  const counts = { variants: 0, credentials: 0, justified: 0, unjustified: 0, credentialUnjustified: 0, policy: 0, policyUnjustified: 0, proofs: 0, d13: 0 };
  const reasons = new Map();
  for (const [id, event] of differentialCases()) {
    const planted = JSON.stringify(event).includes('Q7m9Ab12') || JSON.stringify(event).includes('ghp_' + 'A'.repeat(36));
    const before = (await baseClassify({}, event)).findings;
    counts.variants += 1;
    if (planted) counts.credentials += 1;
    if (!before.length || (await classifyOutbound({}, event)).findings.length) continue;
    await recordFlip(counts, reasons, event, before, id, planted);
  }
  for (const [id, reason] of reasons) console.log(`VB UNJUSTIFIED ${id}: ${reason}`);
  return counts;
}

async function differentialLock(f) {
  await f.test('VB frozen base credential differential and occurrence proofs', () => f.freshVault(async () => {
    const c = await measureDifferential();
    console.log(`VB DIFFERENTIAL=${c.variants} CREDENTIAL_BEARING=${c.credentials} CONTROL_JUSTIFIED_CREDENTIAL_FLIPS=${c.justified} UNJUSTIFIED_CREDENTIAL_FLIPS=${c.credentialUnjustified} NO_CREDENTIAL_JUSTIFIED_FLIPS=${c.policy} NO_CREDENTIAL_UNJUSTIFIED_FLIPS=${c.policyUnjustified} TOTAL_FLIPS=${c.justified + c.policy + c.unjustified} OCCURRENCE_PROOFS=${c.proofs} D13_FLIPS=${c.d13}`);
    assert.equal(c.unjustified, 0, 'base refusal flipped without occurrence proof and accepted control');
    assert.equal(c.d13, 0, 'INI two-statement policy flipped across line endings');
  }));
  await f.test('VB flip control rejects independently refused bytes', () => f.freshVault(async () => {
    const event = { tool: 'Write', content: 'password="${HOME}"\ntoken=Q7m9Ab12' };
    const before = (await baseClassify({}, event)).findings.filter((item) => item.value === '${HOME}');
    assert.ok(before.length, 'missing reference occurrence control');
    await assert.rejects(justifyFlip(event, before, 'control'), /occurrence-removed control still refused/);
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
  ]) await f.test(`VB credential continuation ${name}`, () => f.freshVault(async () => {
    assert.ok((await findings(text, baseClassify)).length, 'base must refuse control');
    assert.ok((await findings(text)).length, `${name} credential escaped refusal`);
  }));
  await f.test('VB short JSON references project only the key prefix', () => f.freshVault(async () => {
    assert.equal((await findings('{"password":"${A}","token":"${B}"}')).length, 0, 'short reference fallback included key syntax');
  }));
}

async function roundThreeLocks(f) {
  for (const code of [0x85, 0x1c, 0x1d, 0x1e, 0x1f, 0x2028, 0x2029]) {
    await f.test(`VB parser union indentation U+${code.toString(16).toUpperCase()}`, () => f.freshVault(async () => {
      const text = `[s]\npassword="\${HOME}"\n${String.fromCodePoint(code)}Q7m9Ab12\n`;
      assert.ok((await findings(text)).length, `parser whitespace U+${code.toString(16)} hid credential continuation`);
    }));
  }
  for (const [name, ending] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']]) {
    await f.test(`VB section header ending ${name}`, () => f.freshVault(async () => {
      assert.ok((await findings(`[s]${ending}password="\${A}"; token="\${B}"${ending}`)).length, `${name} section header lost INI same-line value`);
    }));
  }
  await independentEvidenceLocks(f);
}

async function independentEvidenceLocks(f) {
  const texts = [
    ['N2 tail', 'db:\n  password: "${DB_PASSWORD}"\n  user: bob\n\n  ${VARIANT}, Q7m9Ab12'],
    ['INI sibling', '[s]\npassword="${HOME}"\nuser=Q7m9Ab12'],
  ];
  for (const [name, text] of texts) {
    await f.test(`VB unheld ${name} has accepted mechanical control`, () => f.freshVault(async () => {
      const before = await findings(text, baseClassify);
      assert.ok(before.length, 'frozen base must refuse incidental duplicate');
      assert.equal((await findings(text)).length, 0, 'unheld bare tail was treated as independent evidence');
      await justifyFlip({ tool: 'Write', content: text }, before, name);
    }));
    await f.test(`VB held ${name} refuses`, () => f.freshVault(async () => {
      f.tokenize('file', 'Q7m9Ab12');
      assert.ok((await findings(text)).some((item) => item.secret === 'Q7m9Ab12'), 'held independent tail evidence lost');
    }));
    await f.test(`VB detector ${name} refuses`, () => f.freshVault(async () => {
      const credential = 'ghp_' + 'A'.repeat(36);
      assert.ok((await findings(text.replace('Q7m9Ab12', credential))).some((item) => item.value === credential), 'recognisable independent tail evidence lost');
    }));
  }
}

async function removalControlLocks(f) {
  for (const ending of ['\n', '\r\n', '\r']) {
    await f.test(`VB removal control preserves sibling bytes ${JSON.stringify(ending)}`, async () => {
      const text = `[s]${ending}password="\${HOME}"${ending}user=Q7m9Ab12`;
      const event = { tool: 'Write', content: text };
      const keyStart = text.indexOf('password');
      const evidence = [{ keyStart, proof: { start: keyStart + 9, end: keyStart + 18, text: '"${HOME}"' } }];
      assert.equal(referenceControl(event, evidence).content,
        `[s]${ending}user=Q7m9Ab12`, 'control must remove key, separator, full value and closing line ending');
    });
  }
  await f.test('VB removal control preserves inline surroundings and unions duplicates', async () => {
    const event = { tool: 'Write', content: 'left password="${HOME}"; token="${OTHER}" right' };
    const proof = { keyStart: 5, proof: { start: 14, end: 23, text: '"${HOME}"' } };
    assert.equal(referenceControl(event, [proof, proof]).content, 'left ; token="${OTHER}" right', 'inline bytes outside occurrence changed');
  });
}

async function roundFiveLocks(f) {
  for (const [name, text] of [
    ['YAML semicolon continuation', 'password: (${HOME}),\n  ;Q7m9Ab12\n  ${OTHER}\n'],
    ['YAML mixed comment endings', 'password: "${HOME}"\n# gap\rconnection: postgres://bob:Q7m9Ab12@db/app\rnote:\n  ${OTHER}\n'],
    ['INI mixed comment endings', '[s]\npassword="${HOME}"\n# gap\rurl=postgres://bob:Q7m9Ab12@db/app\rnote=ok\n  ${OTHER}\n'],
  ]) await f.test(`VB fail closed ${name}`, () => f.freshVault(async () => {
    assert.ok((await findings(text, baseClassify)).length, 'frozen review control must refuse');
    assert.ok((await findings(text)).length, `${name} skipped bytes cancelled frozen refusal`);
  }));
  await f.test('VB scanner sibling agreement LF CRLF CR', () => f.freshVault(async () => {
    for (const ending of ['\n', '\r\n', '\r']) {
      const text = `[s]${ending}password="\${HOME}"${ending}user=Q7m9Ab12`;
      assert.equal((await findings(text)).length, 0, `scanner sibling verdict disagrees for ${JSON.stringify(ending)}`);
      const candidate = discoverCandidates(text).find((item) => item.base);
      const extent = valueExtent(text, candidate, discoverCandidates(text));
      assert.equal(extent.text.includes('user='), false, 'scanner consumed sibling line');
    }
  }));
  await skippedByteLock(f);
  await uncertainGrammarLocks(f);
}

async function uncertainGrammarLocks(f) {
  for (const [name, text] of [
    ['mixed reference line endings', '[s]\npassword="${HOME}"\r\n  ${OTHER}\n  ${NEXT}\r'],
    ['shell CR line ending', 'API_KEY="${HOME}"\r${OTHER}'],
  ]) await f.test(`VB fail closed ${name} without holding references`, () => f.freshVault(async () => {
    assert.ok((await findings(text, baseClassify)).length, 'frozen uncertain grammar control must refuse');
    const result = await findings(text);
    assert.ok(result.length, `${name} cancelled frozen refusal`);
    assert.ok(result.every((item) => !referenceProof(item.value)), 'uncertain grammar held a reference-only value');
  }));
}

async function skippedByteLock(f) {
  await f.test('VB skipped-byte extents never cancel frozen occurrences', () => f.freshVault(async () => {
    let skipped = 0;
    for (const [, text] of variants()) {
      const candidates = discoverCandidates(text);
      for (const item of candidates.filter((entry) => entry.base)) {
        const extent = valueExtent(text, item, candidates);
        if (extent.text === text.slice(extent.start, extent.end) && !extent.skipped?.length && extent.modelled !== false) continue;
        skipped += 1;
        assert.ok((await findings(text)).length, 'skipped-byte extent cancelled frozen occurrence');
      }
    }
    assert.ok(skipped > 0, 'skipped-byte property covered no skipped extents');
    console.log(`VB SKIPPED_BYTE_EXTENTS=${skipped}`);
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
  for (const run of [probeLocks, containmentLock, findingLocks, differentialLock, sequentialLock, entryPointLock, grammarLock, commentLineLock, continuationLocks, provenanceLocks, roundThreeLocks, removalControlLocks, roundFiveLocks]) await run(fixture);
}
