import assert from 'node:assert/strict';
import { classifyOutbound } from './outbound-tools.js';
import { classifyOutbound as baseClassify } from './fixtures/base-outbound-tools.frozen.mjs';
import { rows, objectRows } from './fixtures/value-boundary-rows.mjs';

const findings = async (content, classify = classifyOutbound) => (await classify({}, { tool: 'Write', content })).findings;
const groupOf = (id) => id.match(/^(?:AR|AF|CTL|SEED|[A-Z]|7)/)[0];

export function* variants(source = rows) {
  for (const [id, , content] of source.filter((row) => row[1] !== 'X')) {
    yield [id, content];
    for (const ending of ['\n', '\r\n', '\r']) for (const header of ['', '[s]\n']) {
      for (const indent of ['  ', '\t', '\u00a0']) for (const gap of ['\n', '\n# gap\n']) {
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
      if (id.startsWith('AR6 ')) assert.deepEqual(result, await baseClassify({}, { tool: 'mcp__fixture__send', ...input }), 'object key finding changed');
    }
  }));
}

async function containmentLock(f) {
  await f.test('VB blanked capture containment', () => f.freshVault(async () => {
    const { discoverCandidates, valueExtent } = await import('./value-boundary.js');
    let count = 0;
    for (const [, text] of variants()) {
      const candidates = discoverCandidates(text);
      for (const item of candidates.filter((candidate) => candidate.base)) {
        const extent = valueExtent(text, item, candidates);
        assert.ok(extent.start <= item.captureStart && extent.end >= item.captureEnd, 'extent lost base capture');
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
    if (!original || referenceProof(valueExtent(text, original, candidates).text)) continue;
    assert.ok(current.some((next) => next.kind === item.kind && next.value === item.value), 'uncancelled base finding changed');
  }
}

async function findingLocks(f) {
  await f.test('VB no complete reference is held', () => f.freshVault(async () => {
    const { referenceProof } = await import('./value-boundary.js');
    for (const [id, text] of variants()) for (const item of await findings(text)) {
      assert.equal(referenceProof(item.value, 'decoded'), false, `complete reference became a finding: ${id} ${JSON.stringify(item.value)}`);
    }
  }));
  await f.test('VB uncancelled base values are unchanged', () => f.freshVault(async () => {
    for (const [, text] of variants()) await preservedValues(text);
  }));
  await f.test('VB raw residue values and short fallback', () => f.freshVault(async () => {
    assert.ok((await findings('password: ${HOME}\n  Q7m9Ab12\n')).some((item) => item.value === 'Q7m9Ab12'), 'raw residue was not held separately');
    const text = '[s]\npassword=${HOME}\n  x=ab\n  y=cd\n';
    assert.ok((await findings(text)).some((item) => item.value === '${HOME}\n  x=ab\n  y=cd'), 'short residue fallback changed');
  }));
}

async function differentialLock(f) {
  await f.test('VB frozen base refusal differential', () => f.freshVault(async () => {
    let count = 0;
    const regressions = [];
    for (const [id, text] of variants()) {
      const before = await findings(text, baseClassify);
      if (before.length && !(await findings(text)).length) regressions.push(id);
      count += 1;
    }
    for (const [id, want, input] of objectRows) {
      const key = Object.keys(input)[0];
      for (const [, text] of variants([[id, want, input[key]]])) {
        const event = { tool: 'mcp__fixture__send', [key]: text };
        if ((await baseClassify({}, event)).findings.length && !(await classifyOutbound({}, event)).findings.length) regressions.push(id);
        count += 1;
      }
    }
    console.log(`VB DIFFERENTIAL=${count} BASE_REFUSED_TIP_WRITTEN=${regressions.length} IDS=${[...new Set(regressions)].join('|')}`);
    assert.equal(regressions.length, 0, 'base refused inputs became written (includes required false-positive removals)');
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

export async function runValueBoundaryLocks(fixture) {
  for (const run of [probeLocks, containmentLock, findingLocks, differentialLock, sequentialLock, entryPointLock, grammarLock, commentLineLock]) await run(fixture);
}
