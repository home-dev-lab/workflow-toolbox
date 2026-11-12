import assert from 'node:assert/strict';
import { register } from './hooks.js';
import { classifyOutbound, base64Utf8 } from './outbound-tools.js';
import { finalizeDenial } from './finalize-denial.js';
import { config, configure } from './config.js';
import { testRestoreVault, testVaultSnapshot, tokenize } from './token-vault.js';
import { detections } from './detector.js';
import { inspectionBudget, INSPECTION_TEXT, walkOutbound } from './outbound-traversal.js';
import { boundaryFindings } from './value-boundary.js';

const send = (payload) => ({ tool: 'mcp__fixture__send', payload });
const concealed = (value) => ({ type: 'CONCEALED', value });
const oversized = () => Array(1000001).fill(null);
const budgetWords = () => ['input that is too large', ' to inspect'].join('');
const missing = async () => { const error = new Error('fixture missing'); error.code = 'ENOENT'; throw error; };

function fixture() {
  const entries = [];
  const options = config();
  register((event, matcher, handler) => entries.push({ event, matcher, handler: handler ?? matcher }), options);
  const store = new Map();
  return {
    hook: entries.find((entry) => entry.event === 'tool.call' && entry.matcher?.tool instanceof RegExp).handler,
    $: {
      ui: { log: async () => {} }, fs: { read: missing, stat: missing, write: async () => {} },
      store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) },
      process: { run: async () => ({ exitCode: 0, stdout: '' }) },
      env: { get: async () => '/fixture/config' },
      session: { id: async () => 'fixture-session', cwd: async () => '/fixture/project' },
      plugin: { root: '/fixture/plugin' }, clock: { sleep: async () => {} },
    },
  };
}

async function fresh(run) {
  const before = testVaultSnapshot();
  const options = config();
  testRestoreVault({ ...before, tokens: [], values: [], tokenByValue: [], pending: [] });
  try { await run(); } finally { testRestoreVault(before); configure(options); }
}

async function refusal(payload) {
  const f = fixture();
  const answer = await f.hook(f.$, send(payload), async () => assert.fail('refused input was forwarded'));
  assert.equal(typeof answer.deny, 'string', 'missing denial');
  return answer.deny;
}

async function refusalLocks(check) {
  await check('A early budget denial hides current concealed wording', async () => {
    const value = budgetWords();
    const text = await refusal({ a: concealed(value), b: oversized() });
    assert.equal(text.includes(value), false, 'early budget denial leaked current concealed value');
  });
  await check('A incomplete inspection emits no unknown sensitive wording', async () => {
    const text = await refusal({ a: oversized(), b: concealed('wt-secret-guard') });
    assert.equal(text, '', 'incomplete inspection printed unverified fixed wording');
  });
  await check('A grammar denial hides current concealed wording', async () => {
    const value = ['owner-release', ' grammar'].join('');
    const text = await refusal({ a: concealed(value), b: 'wt-secret-guard release' });
    assert.equal(text.includes(value), false, 'grammar denial leaked current concealed value');
  });
  await check('A budget preserves prior detector and held findings', async () => {
    const value = ['FAKE', '"', 'Q7m9'].join('');
    const credential = ['gh', 'p_'].join('') + 'a'.repeat(36);
    const held = ['held', 'Q7m9Ab12'].join('');
    tokenize('file', held);
    const { findings } = await classifyOutbound({}, send({ a: concealed(value), credential, held, z: oversized() }));
    assert.ok(findings.some((item) => item.kind === 'inspection-budget'), 'missing budget finding');
    assert.ok(findings.some((item) => item.secret === value), 'budget discarded prior concealed finding');
    assert.ok(findings.some((item) => item.value === credential), 'budget discarded prior credential finding');
    assert.ok(findings.some((item) => item.secret === held), 'budget discarded prior held finding');
    assert.ok(findings.sensitiveValues.has(value), 'budget discarded prior sensitivity metadata');
    const spellings = [value, JSON.stringify(value).slice(1, -1), base64Utf8(value), credential, held];
    const answer = finalizeDenial({ deny: spellings.join(' ') }, findings);
    for (const spelling of spellings) assert.equal(answer.deny.includes(spelling), false, 'budget finalization leaked sensitive spelling');
  });
}

async function decodedLocks(check) {
  await check('B decoded concealed children exhaust inspection budget', async () => {
    const payload = JSON.stringify({ ...concealed(['Q7m9', 'Ab12'].join('')), items: oversized() });
    const { findings } = await classifyOutbound({}, send(payload));
    assert.ok(findings.some((item) => item.kind === 'inspection-budget'), 'decoded concealed children bypassed inspection budget');
    assert.ok(findings.some((item) => item.secret === ['Q7m9', 'Ab12'].join('')), 'decoded budget discarded prior concealed finding');
  });
  await check('B decoded exhaustion remains denied by registered hook', async () => {
    const payload = JSON.stringify({ ...concealed('wt-secret-guard'), items: oversized() });
    assert.equal(await refusal(payload), '', 'decoded budget denial printed unverified fixed wording');
  });
  await check('B native and decoded children share inspection budget', async () => {
    const payload = { a: Array(800000).fill(null), b: JSON.stringify({ ...concealed('FakeQ7m9'), items: Array(250000).fill(null) }) };
    const { findings } = await classifyOutbound({}, send(payload));
    assert.ok(findings.some((item) => item.kind === 'inspection-budget'), 'decoded traversal reset native inspection budget');
  });
  await check('B repeated detector passes share inspection budget', async () => {
    const payload = { a: Array(600000).fill(null), b: JSON.stringify({ ...concealed('FakeQ7m9'), items: Array(140000).fill(null) }) };
    const { findings } = await classifyOutbound({}, send(payload));
    assert.ok(findings.some((item) => item.kind === 'inspection-budget'), 'a detector pass decoded outside shared inspection budget');
  });
  await check('B serialized wide concealed input stays refused without exception', async () => {
    const payload = concealed('FakeQ7m9');
    for (let index = 0; index < 150000; index += 1) payload[`field${index}`] = null;
    const { findings } = await classifyOutbound({}, send(JSON.stringify(payload)));
    assert.ok(findings.length, 'serialized wide concealed input forwarded');
  });
}

export async function runBudgetRefusalLocks(f) {
  const check = (name, run) => f.test(`TR R2 ${name}`, () => fresh(run));
  await refusalLocks(check);
  await decodedLocks(check);
  await accountingLocks(check);
}

async function accountingLocks(check) {
  await check('B contextual boundary decoding shares inspection budget', async () => {
    const budget = { ...inspectionBudget(), nodes: 999999 };
    boundaryFindings(JSON.stringify(concealed('FakeQ7m9')), { inspectionBudget: budget });
    assert.equal(budget.exhausted, true, 'contextual boundary decoded outside shared inspection budget');
  });
  await check('B decoded nodes keys and text debit the native counters', async () => {
    const budget = inspectionBudget();
    Array.from(walkOutbound({ native: 'Fake' }, budget));
    const found = detections(JSON.stringify({ ...concealed('FakeQ7m9'), items: [null] }), '', undefined, { inspectionBudget: budget });
    assert.ok(found.some((item) => item.kind === 'op-json-concealed'));
    assert.equal(budget.nodes, 7, 'decoded nodes did not debit native counter');
    assert.equal(budget.text, 41, 'decoded keys or text did not debit native counter');
  });
  await check('B decoded value text exhausts shared text budget', async () => {
    const budget = { ...inspectionBudget(), text: INSPECTION_TEXT - 12 };
    const found = detections(JSON.stringify(concealed('FakeQ7m9')), '', undefined, { inspectionBudget: budget });
    assert.ok(found.some((item) => item.kind === 'inspection-budget'), 'decoded value text bypassed inspection budget');
  });
  await check('B decoded key text exhausts shared text budget', async () => {
    const budget = { ...inspectionBudget(), text: INSPECTION_TEXT - 40 };
    const payload = { ...concealed('FakeQ7m9'), ['k'.repeat(41)]: null };
    const found = detections(JSON.stringify(payload), '', undefined, { inspectionBudget: budget });
    assert.ok(found.some((item) => item.kind === 'inspection-budget'), 'decoded key text bypassed inspection budget');
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  let failures = 0;
  await runBudgetRefusalLocks({ test: async (name, run) => {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
  } });
  process.exitCode = failures ? 1 : 0;
}
