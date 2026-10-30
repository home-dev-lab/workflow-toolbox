import assert from 'node:assert/strict';
import { classifyOutbound } from './outbound-tools.js';
import { classifyOutbound as baseClassify } from './fixtures/base-outbound-tools.frozen.mjs';
import { rows, objectRows } from './fixtures/value-boundary-rows.mjs';
import { boundaryFindings } from './value-boundary.js';
import { contextualMatches } from './detector.js';
import { conditionLocks, mutantLocks, isolatedScanner } from './route-s-locks.mjs';

const findings = async (content, classify = classifyOutbound) => (await classify({}, { tool: 'Write', content })).findings;

const LOSS_IDS = new Set(['M4', 'M5', 'E1', 'E2', 'E3', 'E7', 'F9', 'N1', 'N2', 'N3', 'N4', 'C3', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P10', 'D3', 'D12', 'AF1', 'AF2', 'AF4']);
const acceptedLoss = (id) => LOSS_IDS.has(id.split(' ')[0]);

export function* variants(source = rows) {
  for (const [id, , content] of source.filter((row) => row[1] !== 'X')) {
    yield [id, content];
    for (const ending of ['\n', '\r\n', '\r']) for (const header of ['', '[s]\n']) {
      for (const indent of ['  ', '\t', '\u00a0', '\f', '\v', '\u0085', '\u001c', '\u001d', '\u001e', '\u001f', '\u2028', '\u2029']) for (const gap of ['\n', '\n# gap\n']) {
        for (const quoted of [false, true]) for (const tail of ['', ', Q7m9Ab12']) {
          const reference = quoted ? '"${VARIANT}"' : '${VARIANT}';
          yield [id, `${header}${content}${gap}${indent}${reference}${tail}`.replace(/\r?\n/g, () => ending)];
        }
      }
    }
  }
}

async function probeLocks(f) {
  for (const [id, want, content] of rows.filter((row) => row[1] !== 'X')) {
    await f.test(`VB probe ${id}`, () => f.freshVault(async () => {
      const got = (await findings(content)).length > 0;
      if (want === 'R') assert.equal(got, true, id);
      else assert.equal(got, acceptedLoss(id), `Route S acceptance changed: ${id}`);
    }));
  }
  await f.test('VB object probe group K', () => f.freshVault(async () => {
    for (const [id, want, input] of objectRows) {
      const result = await classifyOutbound({}, { tool: 'mcp__fixture__send', ...input });
      assert.equal(result.findings.length > 0, want === 'R', id);
      if (id.startsWith('AR6 ')) assert.ok(result.findings.some((item) => item.value === 'Q7m9Ab12'));
    }
  }));
}

const REVIEW_INPUTS = [
  "password: (${HOME}),\n  ;Q7m9Ab12\n",
  "password: \"${HOME}\"\n# gap\rconnection: postgres://bob:Q7m9Ab12@db/app",
  "[s]\npassword=\"${HOME}\"\n# gap\rurl=postgres://bob:Q7m9Ab12@db/app",
  "password=${HOME}\r\n",
  "password: (${HOME}),\n  ;Q7m9Ab12\n  ${OTHER}\n",
  "password: \"${HOME}\"\n# gap\rconnection: postgres://bob:Q7m9Ab12@db/app\rnote:\n  ${OTHER}\n",
  "[s]\npassword=\"${HOME}\"\n# gap\rurl=postgres://bob:Q7m9Ab12@db/app\rnote=ok\n  ${OTHER}\n",
  "[s]\npassword=\"${HOME}\"\nuser=Q7m9Ab12",
  "[s]\r\npassword=\"${HOME}\"\r\nuser=Q7m9Ab12",
  "[s]\rpassword=\"${HOME}\"\ruser=Q7m9Ab12",
  "[s]\npassword=\"${HOME}\"\r\n  ${OTHER}\n  ${NEXT}\r",
  "API_KEY=\"${HOME}\"\r${OTHER}",
];

async function reviewLocks(f) {
  for (const [index, content] of REVIEW_INPUTS.entries()) {
    await f.test(`VB Route S review ${index + 1}`, () => f.freshVault(async () => {
      const before = await findings(content, baseClassify);
      assert.equal(before.length > 0, index !== 3, 'measured frozen verdict');
      assert.equal((await findings(content)).length > 0, before.length > 0, 'Route S must retain frozen review verdict');
      if (index > 2) return;
      let forwarded = false;
      const answer = await f.hookForTool('Write')(f.$, { tool: 'Write', content }, async () => { forwarded = true; return {}; });
      assert.equal(forwarded, false, 'review credential reached Write callback');
      assert.equal(Boolean(answer.deny), true);
      assert.equal(JSON.stringify(answer).includes('Q7m9Ab12'), false);
    }));
  }
}

// Independent literal oracle: no scanner metadata, proof functions or matchers.
function independentLine(text, at) {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const end = text.indexOf('\n', at);
  const line = text.slice(start, end < 0 ? undefined : end);
  assert.equal(/[\r\u0085\u2028\u2029]/u.test(line), false, 'cancelled forbidden line ending');
  const ref = '(?:\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|secret:(?:env):[A-Za-z_][A-Za-z0-9_]*|(?:secret:(?:file|1p):|op://)[^\\s"\'`,;#()\\[\\]{}<>]+|secret:[a-z-]+#[a-f0-9]{6})';
  const value = `(?:${ref}|"${ref}"|'${ref}')`;
  const shape = new RegExp(`^(?:[A-Za-z_][\\w.-]*[ \\t]*[=:][ \\t]*${value}|"[A-Za-z_][\\w.-]*"[ \\t]*:[ \\t]*"${ref}")[,}]*$`, 'i');
  assert.match(text.slice(at, end < 0 ? undefined : end), shape, 'cancelled occurrence lacks literal Route S shape');
  const rest = end < 0 ? [] : text.slice(end + 1).split('\n');
  const next = rest.find((entry) => /[^\s\u0085\u001c-\u001f]/u.test(entry));
  if (next) assert.ok(next.match(/^[\s\u0085\u001c-\u001f]*/u)[0].length <= line.match(/^\s*/u)[0].length, 'cancelled deeper continuation');
}

async function propertyLocks(f) {
  await f.test('VB every cancelled frozen occurrence has independent literal proof', () => f.freshVault(async () => {
    const scanner = await isolatedScanner(f.boundarySource);
    let cases = 0;
    let cancelled = 0;
    for (const [, text] of propertyCases()) {
      for (const item of independentCandidates(text)) {
        scanner.selectCandidates([item]);
        const found = scanner.boundaryFindings(text);
        if (found.some((entry) => entry.kind === item.kind && entry.value === item.finding.value && entry.index === item.finding.index)) continue;
        independentLine(text, item.keyStart);
        cancelled += 1;
      }
      cases += 1;
    }
    assert.ok(cancelled > 0, 'no cancelled occurrence covered');
    console.log(`VB INDEPENDENT CASES=${cases} CANCELLED_OCCURRENCES=${cancelled}`);
  }));
  await f.test('VB genuine uncancelled base values are unchanged', () => f.freshVault(async () => {
    for (const [, text] of variants()) {
      const current = await findings(text);
      for (const item of await findings(text, baseClassify)) {
        if (!current.length) continue;
        const boundary = boundaryFindings(text);
        if (!boundary.some((entry) => entry.kind === item.kind && entry.value === item.value)) continue;
        assert.ok(current.some((entry) => entry.kind === item.kind && entry.value === item.value), 'uncancelled base finding changed');
      }
    }
  }));
}

function independentCandidates(text) {
  // Byte-identical frozen discovery spelling, independent of scanner discovery.
  const blanked = text.replace(/(?:op:\/\/[^\s"']+|secret:(?:env|file|1p):[^\s"']+|\$\{[A-Za-z_][A-Za-z0-9_]*\}|secret:[a-z-]+#[a-f0-9]{6})/gi, (value) => ' '.repeat(value.length));
  return contextualMatches(blanked).map((item) => {
    const index = blanked.indexOf(item.value);
    return { ...item, base: true, finding: { kind: item.kind, value: text.slice(index, index + item.value.length), index } };
  });
}

function* propertyCases() {
  yield* variants();
  for (const text of REVIEW_INPUTS) yield ['review', text];
  for (const ref of ['${NAME}', 'secret:' + 'env:NAME', 'secret:file:/fixture', 'secret:1p:vault/field', 'op://vault/field', 'secret:fixture#abcdef']) {
    for (const key of ['password', 'API_KEY', 'token']) for (const quote of ['', '"', "'"]) {
      for (const ending of ['', '\n', ',\n', '}\n']) yield ['literal', `${key}=${quote}${ref}${quote}${ending}`];
    }
  }
}

const REFUSAL_CONTROLS = [
  ['CRLF comment gap cannot end continuation', '[service]\r\npassword="${HOME}"\r\n# comment\r\n    Q7m9Ab12\r\n\r\n  ${VARIANT}'],
  ['credential continuation form feed', '[s]\npassword="${HOME}"\n\fQ7m9Ab12\n'],
  ['credential continuation vertical tab', '[s]\npassword="${HOME}"\n\vQ7m9Ab12\n'],
  ['credential continuation short reference', '[s]\npassword="${A}"\n  Q7m9Ab12'],
  ['raw residue values and short fallback', '[s]\npassword=${HOME}\n  x=ab\n  y=cd\n'],
  ['fail closed YAML semicolon continuation', REVIEW_INPUTS[4]],
  ['fail closed YAML mixed comment endings', REVIEW_INPUTS[5]],
  ['fail closed INI mixed comment endings', REVIEW_INPUTS[6]],
  ['fail closed mixed reference line endings', REVIEW_INPUTS[10]],
  ['fail closed shell CR line ending', REVIEW_INPUTS[11]],
  ['flip control rejects independently refused bytes', 'password="${HOME}"\ntoken=Q7m9Ab12'],
  ['unmatched opening bracket stays open', '[)\npassword: "${HOME}"\n'],
];

async function refusalLocks(f) {
  for (const code of [0x85, 0x1c, 0x1d, 0x1e, 0x1f, 0x2028, 0x2029]) {
    await refuse(f, `parser union indentation U+${code.toString(16)}`, `[s]\npassword="\${HOME}"\n${String.fromCodePoint(code)}Q7m9Ab12\n`);
  }
  for (const ending of ['\n', '\r\n', '\r']) await refuse(f, `section header ending ${JSON.stringify(ending)}`, `[s]${ending}password="\${A}"; token="\${B}"${ending}`);
  for (const [name, text] of REFUSAL_CONTROLS) await refuse(f, name, text);
}

async function refuse(f, name, text) {
  await f.test(`VB ${name}`, () => f.freshVault(async () => assert.ok((await findings(text)).length, `${name} escaped refusal`)));
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

async function heldLocks(f) {
  for (const [name, text] of [
    ['N2 tail', 'db:\n  password: "${DB_PASSWORD}"\n  user: bob\n\n  ${VARIANT}, Q7m9Ab12'],
    ['INI sibling', REVIEW_INPUTS[7]],
  ]) {
    await f.test(`VB held ${name} refuses`, () => f.freshVault(async () => {
      f.tokenize('file', 'Q7m9Ab12');
      assert.ok((await findings(text)).some((item) => item.secret === 'Q7m9Ab12'));
    }));
    await f.test(`VB detector ${name} refuses`, () => f.freshVault(async () => {
      const credential = 'ghp_' + 'A'.repeat(36);
      assert.ok((await findings(text.replace('Q7m9Ab12', () => credential))).some((item) => item.value === credential));
    }));
  }
  await f.test('VB trusted held reference is never filtered', () => f.freshVault(async () => {
    f.tokenize('file', '${HOME}');
    assert.ok((await findings('${HOME}')).some((item) => item.secret === '${HOME}'));
  }));
  await f.test('VB key-origin fallback never drops base evidence', () => f.freshVault(async () => {
    const event = { tool: 'mcp__fixture__send', 'password=': '${HOME}' };
    assert.ok((await baseClassify({}, event)).findings.length);
    assert.ok((await classifyOutbound({}, event)).findings.length);
  }));
  await f.test('VB provenance object key credential', () => f.freshVault(async () => {
    const event = { tool: 'mcp__fixture__send', 'password=Q7m9Ab12': '${HOME}' };
    const initial = (await classifyOutbound({}, event)).findings;
    assert.ok(initial.length);
    for (const item of initial) f.tokenize(item.kind, item.secret ?? item.value);
    assert.ok((await findings('Q7m9Ab12')).length, 'object-key value not held');
  }));
}

async function provenanceLocks(f) {
  for (const [name, content, later] of [
    ['refusal tokenization retains later bare protection', 'password=Q7m9Ab12; note=abcdefghijklmnop', 'Q7m9Ab12'],
    ['reference continuation residue', '[service]\npassword="${HOME}"\n    Q7m9Ab12\n', 'Q7m9Ab12'],
    ['genuine quoted comma credential', 'password="ab,cd12"', 'ab,cd12'],
    ['reference delimiter residue', 'password=secret:' + 'env:NAME;Q7m9Ab12', 'Q7m9Ab12'],
  ]) await f.test(`VB provenance ${name}`, () => f.freshVault(async () => {
    const initial = await findings(content);
    assert.ok(initial.length);
    for (const item of initial) f.tokenize(item.kind, item.secret ?? item.value);
    assert.ok((await findings(later)).length, 'later bare value was not refused');
  }));
}

export async function runValueBoundaryLocks(fixture) {
  for (const run of [reviewLocks, conditionLocks, probeLocks, refusalLocks, propertyLocks, entryPointLock, heldLocks, provenanceLocks, mutantLocks]) await run(fixture);
}
