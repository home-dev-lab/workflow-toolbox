import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { classifyOutbound, describeFindings, base64Utf8, reduceFindings } from './outbound-tools.js';
import { tokenize, testState, testVaultSnapshot, testRestoreVault } from './token-vault.js';
import { config, configure } from './config.js';
import { planOwnerChannel } from './owner-channel.js';
import { rows, objectRows } from './fixtures/value-boundary-rows.mjs';
import { runBudgetRefusalLocks } from './budget-refusal-locks.mjs';

const send = (payload) => ({ tool: 'mcp__fixture__send', payload });
const secret = () => ['Q7m9', 'Ab12'].join('');
const credential = () => ['gh', 'p_'].join('') + 'a'.repeat(36);
const concealed = (value = secret()) => ({ type: 'CONCEALED', value });
const findings = async (payload) => (await classifyOutbound({}, send(payload))).findings;
const freshVault = async (run) => {
  const before = testVaultSnapshot();
  const options = config();
  testRestoreVault({ ...before, tokens: [], values: [], tokenByValue: [], pending: [] });
  try { return await run(); } finally { testRestoreVault(before); configure(options); }
};
function held(value) {
  const token = tokenize('file', value);
  assert.equal(testState().get(token)?.ephemeral, undefined, 'fixture is not genuinely held');
  assert.equal(testState().get(token)?.value, value);
  return token;
}
const diagnostic = async (payload) => describeFindings(send(payload), await findings(payload)).join('; ');
const redaction = () => import('./diagnostic-redaction.js');

async function structuralLocks(check) {
  await check('C1 serialized child never prints credential key', async () => {
    const value = secret();
    const text = await diagnostic({ [value]: JSON.stringify(concealed(value)) });
    assert.equal(text.includes(value), false, 'description leaked current credential');
    assert.match(text, /op-json-concealed/);
  });
  await check('C2 native concealed projection detects object', async () => {
    const found = await findings(concealed());
    assert.ok(found.some((item) => item.secret === secret()), 'native concealed value forwarded');
    assert.deepEqual(found.find((item) => item.kind === 'op-json-concealed').path, ['payload']);
  });
  await check('C3 held numeric child is refused with string fields', async () => {
    const value = ['734', '219'].join(''); held(value);
    const item = (await findings(734219)).find((entry) => entry.secret === value);
    assert.ok(item, 'held JSON number forwarded');
    assert.equal(typeof item.value, 'string');
    assert.equal(item.value, value);
    assert.match(describeFindings({}, [item]).join(''), /replace it with secret:file#/);
  });
  await check('C5 joined dotted path cannot reconstruct held value', async () => {
    const value = ['Zq81Lm', 'Pwx3Rt'].join('.'); held(value);
    const text = await diagnostic({ Zq81Lm: { Pwx3Rt: credential() } });
    assert.equal(text.includes(value), false, 'joined path leaked held value');
  });
  await check('C6 reference-shaped key retains raw detector evidence', async () => {
    const value = credential();
    const found = await findings({ [`op://v/${value}`]: 'x' });
    assert.ok(found.length, 'reference-shaped key evidence lost');
    assert.equal(describeFindings({}, found).join('').includes(value), false);
  });
  await check('C7 held key with benign child is refused', async () => {
    const value = secret(); held(value);
    assert.ok((await findings({ [value]: 'benign' })).length, 'held key forwarded');
  });
}

async function hookLocks(check, f) {
  if (!f) return;
  await check('C8 complete raw refusal masks fixed wording', async () => {
    const value = ['Remove the raw value', ' from the outbound content.'].join(''); held(value);
    const answer = await f.hookForTool('Write')(f.$, { tool: 'Write', content: credential() }, async () => assert.fail('forwarded'));
    assert.equal(typeof answer.deny, 'string');
    assert.equal(answer.deny.includes(value), false, 'complete refusal leaked fixed wording');
  });
  await check('A1 grammar refusal passes through finalize', async () => {
    const value = ['owner-release', ' grammar'].join(''); held(value);
    const answer = await f.hookForTool('Write')(f.$, { tool: 'Write', content: ['wt-secret-guard', ' release'].join('') }, async () => assert.fail('forwarded'));
    assert.equal(answer.deny.includes(value), false, 'grammar refusal leaked held wording');
  });
  await check('A1 Bash execution refusal passes through finalize', async () => {
    const value = ['Supported forms', ' are'].join(''); held(value);
    const answer = await f.hookForTool('Bash')(f.$, { tool: 'Bash', command: 'echo op://too-short' }, async () => assert.fail('forwarded'));
    assert.equal(typeof answer.deny, 'string');
    assert.equal(answer.deny.includes(value), false, 'Bash refusal leaked held wording');
  });
  await ownerRouteLock(check, f);
}

async function ownerRouteLock(check, f) {
  await check('A6 owner channel full route preserves frozen refusals', async () => {
    const { classifyOutbound: base } = await import('./fixtures/develop-outbound-tools.frozen.mjs');
    const initial = testVaultSnapshot();
    for (const payload of [credential(), concealed(), { password: secret() }, { [secret()]: 'benign' }, 734219]) {
      const event = { tool: 'mcp__atrium__speak', text: 'message', route: payload };
      testRestoreVault(initial); held(secret()); held('734219');
      const oldPlan = await planOwnerChannel(event, base);
      const oldRefuses = !oldPlan && (await base({}, event)).findings.length > 0;
      testRestoreVault(initial); held(secret()); held('734219');
      const nextPlan = await planOwnerChannel(event);
      if (oldRefuses) assert.equal(nextPlan, null);
      let forwarded = false;
      const answer = await f.mcp(f.$, event, async () => { forwarded = true; return {}; });
      assert.equal(forwarded, false, 'structural routing secret forwarded');
      assert.equal(typeof answer.deny, 'string');
    }
  });
}

async function encodingLocks(check) {
  const value = ['FAKE', '"', '/', 'Q7m9'].join('');
  const variants = {
    percent: Array.from(value, (c) => `%${c.charCodeAt(0).toString(16)}`).join(''),
    unicode: Array.from(value, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
    json: JSON.stringify(value).slice(1, -1),
    base64: base64Utf8(value), dotted: 'left.right', reference: `op://v/${value}`,
  };
  for (const [name, key] of Object.entries(variants)) {
    await check(`A3 ${name} key is not printed`, async () => {
      const text = await diagnostic({ [key]: JSON.stringify(concealed(value)) });
      assert.equal(text.includes(key), false, 'nonplain key was printed');
      assert.match(text, /<key>/);
    });
  }
  await check('A3 plain benign key remains useful', async () => {
    assert.match(await diagnostic({ account_name: credential() }), /payload.account_name/);
  });
  await check('A3 plain-key policy does not depend on detector or vault re-derivation', async () => {
    const text = describeFindings({}, [{ kind: 'file', value: secret(), path: ['payload', '%41%42'] }]).join('');
    assert.equal(text.includes('%41%42'), false);
    assert.match(text, /<key>/);
  });
  await check('A3 current ephemeral secret encodings are redacted', async () => {
    const { redactDiagnostic } = await redaction();
    const raw = ['Q', '7'].join('');
    const encoded = base64Utf8(raw);
    const unpadded = encoded.split('=')[0];
    const url = unpadded.replace(/\+/g, '-').replace(/\//g, '_');
    for (const spelling of [encoded, unpadded, url]) {
      assert.equal(redactDiagnostic(`(${spelling})`, [{ value: raw, secret: raw }]).includes(spelling), false);
    }
  });
}

async function redactionLocks(check) {
  await check('A2 post-check catches marker reconstruction', async () => {
    const { redactDiagnostic } = await redaction();
    const value = ['X<redacted>', 'Y'].join(''); held(value);
    const text = redactDiagnostic('XQ7m9Ab12Y', [{ value: secret(), secret: secret() }]);
    assert.equal(text.includes(value), false, 'marker rebuilt a held value');
    assert.match(text, /refused/);
  });
  await check('A2 unsafe fallback becomes empty denial text', async () => {
    const { redactDiagnostic, DIAGNOSTIC_FALLBACK } = await redaction();
    held(DIAGNOSTIC_FALLBACK);
    const text = redactDiagnostic('<redacted>', [{ value: '<redacted>', secret: '<redacted>' }]);
    assert.equal(text, '', 'fallback itself leaked sensitive text');
  });
  await check('A4 short offset collision is span local', async () => {
    const { redactDiagnostic } = await redaction(); held('1047');
    const text = redactDiagnostic('github-classic detector: payload at 1047, 40 chars - replace it with guidance', []);
    assert.equal(text.includes('1047'), false);
    assert.match(text, /github-classic detector: payload at <redacted>, 40 chars - replace it with guidance/);
    assert.equal(redactDiagnostic('PIN1047X', []), 'PIN1047X');
  });
  await check('A4 one-character concealed secret masks only standalone occurrences', async () => {
    const found = await findings(concealed('a'));
    assert.ok(found.length, 'one-character concealed value forwarded');
    const { redactDiagnostic } = await redaction();
    assert.equal(redactDiagnostic('a payload chars', found), '<redacted> payload chars');
  });
  await check('A6 sensitive spellings survive presentation deduplication', async () => {
    const { redactDiagnostic } = await redaction();
    const found = await findings({ a: JSON.stringify(concealed('FAKE"Q7m9')), b: JSON.stringify(concealed('FAKE\\Q7m9')) });
    const text = redactDiagnostic('FAKE"Q7m9 FAKE\\Q7m9', found);
    assert.equal(text.includes('FAKE"Q7m9'), false);
    assert.equal(text.includes('FAKE\\Q7m9'), false);
    // The classifier records every raw secret before presentation deduplication...
    assert.equal(found.sensitiveValues?.has('FAKE"Q7m9'), true, 'raw secret missing from pre-deduplication set');
    assert.equal(found.sensitiveValues?.has('FAKE\\Q7m9'), true, 'raw secret missing from pre-deduplication set');
    // ...and redaction honours a recorded secret that no surviving finding carries (a deduplicated one).
    const dropped = ['Zq81', 'Lm', 'Pw', 'x3'].join('');
    const survivors = Object.defineProperty([], 'sensitiveValues', { value: new Set([dropped]) });
    assert.equal(redactDiagnostic(`at ${dropped} end`, survivors).includes(dropped), false, 'deduplicated secret printed');
  });
  await check('A6 reduction keeps a discarded finding secret in sensitiveValues', async () => {
    const { redactDiagnostic } = await redaction();
    const kept = ['Kp', '4r', 'Vt', '9q'].join(''); const lost = ['Nw', '2h', 'Js', '6d'].join('');
    const reduced = reduceFindings([
      { kind: 'op-json-concealed', value: 'SHARED-PRESENTATION', secret: kept },
      { kind: 'op-json-concealed', value: 'SHARED-PRESENTATION', secret: lost },
    ]);
    assert.equal(reduced.length, 1, 'fixture must collide on kind:value');
    for (const secret of [kept, lost]) {
      assert.equal(reduced.sensitiveValues.has(secret), true, 'a colliding secret is missing from sensitiveValues');
      assert.equal(redactDiagnostic(`at ${secret} end`, reduced).includes(secret), false, 'a colliding secret printed');
    }
  });
}

const NUMBERS = [
  ['0000', 0, true], ['-0000', -0, true], ['+7342', 7342, false],
  ['007342.00', 7342, true], [' 7342 ', 7342, false], ['1e+21', 1e21, true],
  ['5e-324', 5e-324, true], ['1e-400', 0, false],
  [['1.0000000000', '000000001'].join(''), 1, false],
  ['1E+21', 1e21, true], ['.5000', .5, true], ['7342.', 7342, true],
  ['-0.000e+9', -0, true], ['1e' + '9'.repeat(80000), 1, false],
  ['1' + '0'.repeat(240000) + '1', 0, false],
];
async function numericLocks(check) {
  for (const [index, [value, number, want]] of NUMBERS.entries()) {
    await check(`A7 exact decimal case ${index + 1}`, async () => {
      held(value);
      const found = await findings(number);
      assert.equal(found.some((item) => item.secret === value), want, `exact decimal case ${index + 1}`);
      for (const item of found) assert.equal(typeof item.value, 'string');
    });
  }
  await check('A7 decimal work is linear for long interior zeros', async () => {
    const { decimalWork, numericEquals } = await import('./decimal-equality.js');
    const value = '1' + '0'.repeat(240000) + '1';
    decimalWork.reset();
    assert.equal(numericEquals(value, 0), false);
    assert.ok(decimalWork.steps <= value.length * 8 + 100, 'decimal work exceeded linear bound');
  });
}

async function isolatedCase(name) {
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--case', name], { encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined, `isolated ${name} watchdog: ${child.error?.message}`);
  assert.equal(child.status, 0, `isolated ${name}: ${child.stderr || child.stdout}`);
}
async function boundsLocks(check) {
  for (const name of ['deep', 'wide', 'serialized-wide', 'matches', 'boundary-matches', 'grammar-deep', 'budget-nodes', 'budget-text']) {
    await check(`C4 A5 isolated ${name}`, () => isolatedCase(name));
  }
  await check('A5 descriptions cap finding count and path depth', async () => {
    const raw = Array.from({ length: 30 }, (_, index) => ({ kind: 'file', value: `fake${index}`, path: Array.from({ length: 30 }, (_, n) => `k${n}`) }));
    const text = describeFindings({}, raw).join('; ');
    assert.match(text, /and 10 more/);
    assert.equal(text.includes('k0.'), false);
    assert.match(text, /\.\.\./);
    assert.ok(text.length < 5000);
  });
  await check('A5 redaction operation count stays linear in sensitive bytes and diagnostic work', async () => {
    const { redactDiagnostic, diagnosticWork } = await redaction();
    const { finalizeDenial } = await import('./finalize-denial.js');
    const raw = Array.from({ length: 150000 }, (_, index) => ({ value: `FakeQ7m9-${index}`, secret: `FakeQ7m9-${index}` }));
    diagnosticWork.reset();
    const text = redactDiagnostic('refused FakeQ7m9-17 at payload', raw);
    assert.equal(text.includes('FakeQ7m9-17'), false);
    const denial = finalizeDenial({ deny: 'refused FakeQ7m9-17 at payload' }, raw);
    assert.equal(denial.deny.includes('FakeQ7m9-17'), false);
    assert.ok(diagnosticWork.steps < 150000 * 4000, 'redaction exceeded stated linear operation bound');
  });
}

async function contractLocks(check) {
  await check('A6 array element retains base index key context', async () => {
    const { walkOutbound } = await import('./outbound-traversal.js');
    const units = [...walkOutbound({ x: ['plain'] })];
    assert.ok(units.some((unit) => unit.kind === 'value' && unit.key === '0'));
    assert.equal(units.some((unit) => unit.kind === 'key' && unit.text === '0'), false);
  });
  await check('A6 optional and direct boundary detections remain', async () => {
    configure({ maskEmails: true, maskIpAddresses: true });
    const text = ['fake.person', '@example.test'].join('');
    assert.ok((await findings(text)).some((item) => item.kind === 'email'));
    assert.ok((await findings('password=Q7m9Ab12')).length);
    assert.ok((await findings(credential())).length);
  });
  await differentialLock(check);
}
async function differentialLock(check) {
  await check('I7 develop refusal differential corpus and structural variants', async () => {
    const { classifyOutbound: base } = await import('./fixtures/develop-outbound-tools.frozen.mjs');
    const corpus = JSON.parse(readFileSync(new URL('./fixtures/secret-guard-corpus.json', import.meta.url), 'utf8'));
    const texts = [...rows.map((row) => row[2]), ...corpus.detections.map((row) => row.text)];
    let count = 0;
    for (const text of texts) {
      for (const payload of [text, { password: text }, [text], { [text]: 'benign' }]) {
        const event = send(payload);
        const before = await base({}, event);
        if (before.findings.length) assert.ok((await classifyOutbound({}, event)).findings.length, 'develop refusal became forwarding');
        count += 1;
      }
    }
    for (const [, , payload] of objectRows) {
      const before = await base({}, send(payload));
      if (before.findings.length) assert.ok((await findings(payload)).length);
      count += 1;
    }
    console.log(`TRAVERSAL DIFFERENTIAL CASES=${count}`);
  });
}

export async function runTraversalLocks(f) {
  const check = (name, run) => f.test(`TR ${name}`, () => freshVault(run));
  await structuralLocks(check);
  await encodingLocks(check);
  await redactionLocks(check);
  await numericLocks(check);
  await boundsLocks(check);
  await contractLocks(check);
  await hookLocks(check, f.$ ? f : null);
  await runBudgetRefusalLocks(f);
}

async function childCase(name) {
  if (name === 'grammar-deep') {
    const { releaseGrammarRefusal } = await import('./owner-release.js');
    assert.equal(releaseGrammarRefusal(send(JSON.parse('{"x":'.repeat(10000) + 'null' + '}'.repeat(10000)))), null);
    return;
  }
  if (name === 'budget-nodes' || name === 'budget-text') {
    const payload = name === 'budget-nodes' ? Array(1000001).fill(null) : 'x'.repeat(64 * 1024 * 1024 + 1);
    assert.ok((await findings(payload)).some((item) => item.kind === 'inspection-budget'), 'inspection budget failed open');
    return;
  }
  if (name === 'matches') {
    assert.ok((await findings((credential() + ' ').repeat(150000))).length);
    return;
  }
  if (name === 'boundary-matches') {
    const { boundaryFindings } = await import('./value-boundary.js');
    assert.ok(boundaryFindings('<secret>' + 'Fake1234 '.repeat(150000) + '</secret>').length);
    return;
  }
  let payload = concealed();
  if (name === 'deep') payload.nested = JSON.parse('{"x":'.repeat(10000) + 'null' + '}'.repeat(10000));
  else for (let index = 0; index < 150000; index += 1) payload[`x${index}`] = null;
  if (name === 'serialized-wide') payload = JSON.stringify(payload);
  assert.ok((await findings(payload)).some((item) => item.kind === 'op-json-concealed'), 'large concealed input not refused');
}

if (process.argv[2] === '--case') await childCase(process.argv[3]);
else if (process.argv[1] === new URL(import.meta.url).pathname) {
  let failures = 0;
  await runTraversalLocks({ test: async (name, run) => {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
  } });
  process.exitCode = failures ? 1 : 0;
}
