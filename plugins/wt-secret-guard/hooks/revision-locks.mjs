import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyOutbound } from './outbound-tools.js';
import { runReviewLocks } from './review-locks.mjs';

async function ordinaryShapeLocks(fixture) {
const { test, freshVault, receive, $, assertNotHeld, call } = fixture;
await test('L1 ordinary generic shapes are masked with their key but never held', () => freshVault(async () => {
  for (const value of ['changelog', 'sr-changelog-site', 'release-notes', 'release-candidate-build', 'fox-raven', 'qzmxvbnrpt', 'ChangeLog', '2026-10-05', '2026-10-05T16:45', 'v0.1.2', '1.2.3-rc1', '/tmp/build2/log']) {
    const text = `token: ${value}`;
    const inbound = await receive($, { text }, async (event) => event.text);
    assert.equal(inbound.includes(value), false, 'initial generic detection was not masked');
    await assertNotHeld(value);
    const result = await call('echo ordinary', text);
    assert.equal(result.text.includes(value), false, 'tool detection was not masked');
    await assertNotHeld(value);
    assert.equal((await call(`echo ${value}`, `sr-${value}-site`)).deny, undefined, 'ordinary generic shape refused Bash');
    assert.equal((await call('echo ordinary', `sr-${value}-site`)).text, `sr-${value}-site`, 'ordinary generic shape masked a later output');
  }
}));
}
async function oneCharacterLocks(fixture) {
const { test, freshVault, $, assertNotHeld, call, tokenize, mcp } = fixture;
await test('L2 one character direct and contextual captures do not lock ordinary tools', () => freshVault(async () => {
  tokenize('op-output', 'e');
  await call('echo ordinary', 'password: e');
  await assertNotHeld('e');
  await assertNotHeld('password: e');
  assert.equal((await call('date', 'date')).deny, undefined, 'one character refused date');
  assert.equal((await call('echo ordinary', 'date')).text, 'date');
  const answer = await mcp($, { tool: 'mcp__atrium__speak', text: 'the letter e' }, async (event) => event);
  assert.equal(answer.deny, undefined, 'one character refused speak');
}));
}
async function distinctiveLocks(fixture) {
const { test, freshVault, $, assertNotHeld, call, testState, hookForTool } = fixture;
await test('L3 distinctive mixed class and alternating case captures remain protected', () => freshVault(async () => {
  for (const value of ['Zq7!pL9x-Kd2#vW4', 'mQvZtLpRsNxBcDa']) {
    await call('echo ordinary', `password: ${value}`);
    const entry = [...testState().values()].find((entry) => entry.value === value);
    assert.ok(entry && !entry.ephemeral, 'exact distinctive capture was not held');
    assert.equal((await call('echo ordinary', value)).text.includes(value), false);
    assert.ok((await call(`echo ${value}`, '')).deny);
    assert.ok((await hookForTool('Write')($, { tool: 'Write', content: value }, async () => assert.fail('Write leaked'))).deny);
  }
  await call('echo ordinary', 'password: 7342');
  assert.ok([...testState().values()].some((entry) => entry.value === 'password: 7342' && !entry.ephemeral), 'short capture bytes changed');
  await call('echo ordinary', 'password: correct-horse-battery-staple');
  await assertNotHeld('correct-horse-battery-staple');
}));
}
const releaseStart = async (fixture, runtime, token, origin = { kind: 'composer' }) => {
  const { logs, prompt } = fixture;
  const before = logs.length;
  let delivered = false;
  const answer = await prompt(runtime, { text: `wt-secret-guard release ${token}`, origin }, async () => { delivered = true; return {}; });
  assert.equal(delivered, false, 'owner release prompt reached next');
  // The host enters a prompt unless the hook answers { drop } (measured: an empty answer reached the model).
  assert.equal(typeof answer?.drop, 'string', 'owner release prompt was not dropped');
  const code = logs.slice(before).join('\n').match(/confirmation code: ([a-f0-9]{6})/)?.[1];
  assert.ok(code, 'confirmation code was not shown through ui.log');
  assert.equal(JSON.stringify(answer).includes(code), false, 'confirmation code reached the prompt answer');
  return code;
};
function assertPrivateIdentifier(fixture, code) {
  const original = crypto.getRandomValues;
  let draw = parseInt(code, 16);
  crypto.getRandomValues = (bytes) => { const id = draw++; bytes.set([id >>> 16, (id >>> 8) & 255, id & 255]); return bytes; };
  try { assert.equal(fixture.tokenize('file', 'fixture-confirmation-Q7p9').includes(code), false, 'UI-only code became an emitted token id'); }
  finally { crypto.getRandomValues = original; }
}
async function releaseLocks(fixture) {
const { test, freshVault, $, assertNotHeld, call, testState, tokenize, prompt } = fixture;
await test('L4 two step owner release fully forgets and suppresses generic reholding', () => freshVault(async () => {
  const value = 'fixture-release-X7p9';
  const token = tokenize('op-output', value);
  assert.ok((await call(`echo ${value}`, '')).deny);
  const code = await releaseStart(fixture, $, token);
  assert.ok((await call(`echo ${value}`, '')).deny, 'first step released without confirmation');
  let delivered = false;
  const answer = await prompt($, { origin: { kind: 'bridge' }, text: `wt-secret-guard release ${token} ${code}` }, async () => { delivered = true; });
  assert.equal(delivered, false, 'confirmation reached next');
  assert.equal(JSON.stringify(answer).includes(code), false, 'confirmation reached an answer');
  await assertNotHeld(value);
  assert.equal([...testState().values()].some((entry) => entry.value === value), false, 'full forget retained value material');
  assert.equal((await call(`echo ${value}`, value)).text, value);
  await call('echo ordinary', `password: ${value}`);
  await assertNotHeld(value);
  assert.equal((await call(`echo ${value}`, '')).deny, undefined);
  const trusted = tokenize('file', value);
  assert.equal(testState().get(trusted).trusted, true, 'released bytes did not regain trusted protection');
}));
}
async function releaseAuthorityLocks(fixture) {
const { test, freshVault, $, call, tokenize, prompt } = fixture;
await test('L4 origin confirmation expiry and ui failure never grant release', () => freshVault(async () => {
  const value = 'fixture-negative-X7p9';
  const token = tokenize('assignment', value);
  const code = await releaseStart(fixture, $, token);
  assert.equal((await call('echo ordinary', `confirmation ${code}`)).text.includes(code), false, 'confirmation code reached a tool result');
  assertPrivateIdentifier(fixture, code);
  for (const kind of ['sdk', 'peer', 'task-notification', 'scheduled-trigger', 'peer-send-message', 'unclassified', undefined]) {
    let forwarded;
    await prompt($, { text: `wt-secret-guard release ${token} ${code}`, ...(kind ? { origin: { kind } } : {}) }, async (event) => { forwarded = event; return {}; });
    assert.ok(forwarded, 'unattested prompt was swallowed');
    assert.equal(forwarded.text.includes(code), false, 'pending confirmation code entered model context');
    assert.ok((await call(`echo ${value}`, '')).deny, 'unattested origin released');
  }
  const wrong = `${code[0] === '0' ? '1' : '0'}${code.slice(1)}`;
  for (const text of [`wt-secret-guard release ${token} ${wrong}`, `wt-secret-guard release ${token} ${code} extra`]) {
    await prompt($, { origin: { kind: 'composer' }, text }, async () => ({}));
    assert.ok((await call(`echo ${value}`, '')).deny, 'wrong or extended confirmation released');
  }
  const now = Date.now;
  try {
    Date.now = () => now() + 300_001;
    await prompt($, { origin: { kind: 'composer' }, text: `wt-secret-guard release ${token} ${code}` }, async () => ({}));
  } finally { Date.now = now; }
  assert.ok((await call(`echo ${value}`, '')).deny, 'expired confirmation released');
  const broken = { ...$, ui: { log() { throw new Error('ui unavailable'); } } };
  await prompt(broken, { origin: { kind: 'composer' }, text: `wt-secret-guard release ${token}` }, async () => assert.fail('ui failure forwarded release'));
  assert.ok((await call(`echo ${value}`, '')).deny, 'ui failure released');
}));
}
async function trustedLocks(fixture) {
const { test, freshVault, $, call, testState, tokenize, logs, prompt, setFile, rewriteReferences, referenceHostFor, hookForTool, mcp } = fixture;
await test('L4 trusted provenance is monotonic on held and promoted reference hits', () => freshVault(async () => {
  for (const value of ['fixture-trust-X7p9', 'release-candidate-build']) {
    const token = tokenize('op-output', value);
    setFile('/tmp/wt-trust-fixture', value);
    const reference = await rewriteReferences(referenceHostFor($), 'printf %s secret:file:/tmp/wt-trust-fixture');
    assert.equal(reference.invalidReference, false);
    assert.equal(testState().get(token).trusted, true, 'trusted reference did not strengthen provenance');
    tokenize('op-output', value);
    const before = logs.length;
    await prompt($, { origin: { kind: 'composer' }, text: `wt-secret-guard release ${token}` }, async () => assert.fail('trusted release reached next'));
    assert.equal(logs.slice(before).some((line) => /confirmation code:/.test(line)), false, 'trusted release offered confirmation');
    assert.ok(logs.slice(before).some((line) => line.includes(token) && /kind op-output.*trusted/.test(line)), 'trusted eligibility notice omitted safe identity or provenance');
    assert.ok((await call(`echo ${value}`, '')).deny, 'trusted value released');
    assert.equal((await call('echo ordinary', value)).text.includes(value), false);
  }
  const pin = tokenize('onepassword', '7342');
  await prompt($, { origin: { kind: 'composer' }, text: `wt-secret-guard release ${pin}` }, async () => assert.fail('trusted PIN prompt forwarded'));
  assert.ok((await hookForTool('Write')($, { tool: 'Write', content: '7342' }, async () => assert.fail('trusted PIN written'))).deny);
  assert.ok((await mcp($, { tool: 'mcp__sink__send', text: '7342' }, async () => assert.fail('trusted PIN sent'))).deny);
}));
}
async function deletionLocks(fixture) {
const { test, freshVault, $, tokenize, prompt, calls, journalHostFor } = fixture;
await test('L4 deletion republishes an empty held table and removes pending additions', () => freshVault(async () => {
  const { publish } = await import('./journal.js');
  const { testVaultSnapshot } = await import('./token-vault.js');
  const token = tokenize('assignment', 'fixture-deletion-X7p9');
  await publish(journalHostFor($));
  const code = await releaseStart(fixture, $, token);
  const before = calls.length;
  await prompt($, { origin: { kind: 'composer' }, text: `wt-secret-guard release ${token} ${code}` }, async () => ({}));
  const table = calls.slice(before).filter((call) => call.key === 'detections').at(-1)?.value;
  assert.deepEqual(table?.entries, [], 'deletion did not republish an empty table');
  assert.deepEqual(testVaultSnapshot().pending, [], 'deleted value retained a pending addition');
  const { releaseToken } = await import('./token-vault.js');
  const unpub = tokenize('assignment', 'fixture-unpublished-X7p9');
  assert.ok(testVaultSnapshot().pending.length, 'pending deletion fixture was already drained');
  assert.ok(releaseToken(unpub));
  assert.deepEqual(testVaultSnapshot().pending, [], 'deletion retained an unpublished addition');
}));
}
async function bodyLocks(fixture) {
const { test, freshVault, $, tokenize, mcp, setFile, transcriptPath, getFile } = fixture;
await test('L5 fixed Atrium body adapter masks repeats base64 and repairs storage', () => freshVault(async () => {
  const value = 'fixture-owner-X7p9';
  const token = tokenize('file', value);
  const encoded = Buffer.from(value).toString('base64');
  for (const tool of ['mcp__atrium__speak', 'mcp__plugin_atrium_atrium__speak']) {
    const event = { tool, tool_use_id: 'owner-fixture', room: 'public-room', mentions: ['reader'], text: `${value} ${value} ${encoded} ${token}` };
    setFile(transcriptPath, `${JSON.stringify({ message: { content: [{ type: 'tool_use', id: event.tool_use_id, input: event }] } })}\n`);
    let forwarded;
    const answer = await mcp($, event, async (input) => { forwarded = input; return { text: 'sent' }; });
    assert.equal(answer.deny, undefined, 'Atrium body redaction refused');
    assert.ok(forwarded, 'Atrium body was not forwarded');
    assert.equal(forwarded.text.includes(value) || forwarded.text.includes(encoded), false, 'forwarded body leaked raw or base64');
    assert.equal(forwarded.text, `${token} ${token} ${token} ${token}`);
    assert.deepEqual(forwarded.mentions, event.mentions);
    assert.equal(forwarded.room, event.room);
    assert.equal(getFile(transcriptPath).text.includes(value) || getFile(transcriptPath).text.includes(encoded), false, 'forwarded input storage was not repaired');
  }
  const discovered = 'fixture-discovered-Z8q2';
  let later;
  const fresh = await mcp($, { tool: 'mcp__atrium__speak', agentId: 'child-fixture', text: `${Buffer.from(discovered).toString('base64')}\npassword: ${discovered}\n${discovered}` }, async (event) => { later = event; return {}; });
  assert.equal(fresh.deny, undefined, 'newly discovered body value and its base64 were refused');
  assert.equal(later.text.includes(discovered) || later.text.includes(Buffer.from(discovered).toString('base64')), false, 'newly discovered body value or base64 leaked');
}));
}
async function routingLocks(fixture) {
const { test, freshVault, $, tokenize, mcp, configure } = fixture;
await test('L5 routing disabled nonadapter and residual findings fail closed', () => freshVault(async () => {
  const value = 'fixture-routing-X7p9';
  tokenize('file', value);
  for (const event of [
    { tool: 'mcp__atrium__speak', text: 'clean', room: value },
    { tool: 'mcp__atrium__speak', text: value, mentions: [value] },
    { tool: 'mcp__other__speak', text: value },
    { tool: 'mcp__atrium__speak', text: { password: 'fixture-unseen-Z8q2' } },
  ]) {
    const answer = await mcp($, event, async () => assert.fail('unclean owner event forwarded'));
    assert.ok(answer.deny, 'residual or routing finding was not refused');
  }
  configure({ ownerChannelRedaction: false });
  try { assert.ok((await mcp($, { tool: 'mcp__atrium__speak', text: value }, async () => assert.fail('disabled adapter forwarded'))).deny); }
  finally { configure(); }
}));
}
async function noticeLocks(fixture) {
const { test, freshVault, $, tokenize, mcp } = fixture;
await test('L5 forwarded repair failures warn and subagent gaps journal', () => freshVault(async () => {
  const value = 'fixture-notice-X7p9';
  tokenize('file', value);
  const localLogs = [];
   const runtime = { ...$, session: { ...$.session, id: () => 'forwarded-notice-fixture' }, ui: { log(line) { localLogs.push(line); } }, fs: { ...$.fs, async read() { throw new Error('missing'); } } };
  for (const agentId of [undefined, 'child-fixture']) {
    let forwarded = false;
    const answer = await mcp(runtime, { tool: 'mcp__atrium__speak', text: value, tool_use_id: 'missing-owner-fixture', agentId }, async () => { forwarded = true; return {}; });
    assert.equal(answer.deny, undefined, 'repair failure prevented clean forwarding');
    assert.equal(forwarded, true);
  }
   assert.ok(localLogs.some((line) => /forwarded with body redaction, but persisted input could not be repaired/.test(line)), 'no truthful repair-failure notice');
   const { journalSnapshot } = await import('./journal.js');
   assert.ok([...journalSnapshot().values()].some((text) => text.includes('"action":"storage-unrepaired"')), 'no journaled subagent storage gap');
  assert.equal(localLogs.some((line) => /refused|denied|fixture-notice-X7p9/.test(line)), false, 'forwarded notice claimed refusal or leaked');
   const token = tokenize('file', 'secret:file#abcdef');
   const event = { tool: 'mcp__atrium__speak', text: 'secret:file#abcdef' };
   const { planOwnerChannel } = await import('./owner-channel.js');
   assert.equal((await planOwnerChannel(event)).count, 1, 'held token-shaped replacement was not counted');
   let forwarded;
   await mcp(runtime, event, async (received) => { forwarded = received; return {}; });
   assert.equal(forwarded.text, token, 'held token-shaped replacement did not reach forwarded body');
}));
}
async function reclassificationLocks(fixture) {
const { test, freshVault, tokenize } = fixture;
await test('L5 owner channel reclassifies the actual rewritten event and refuses residual findings', () => freshVault(async () => {
  const { planOwnerChannel } = await import('./owner-channel.js');
  const value = 'fixture-reclassify-X7p9';
  const token = tokenize('file', value);
  const seen = [];
  const classified = async (_host, event) => {
    seen.push(event);
    return { findings: seen.length === 1 ? [] : [{ kind: 'file', value: seen.length === 2 ? value : 'residual-fixture' }] };
  };
  const planned = await planOwnerChannel({ tool: 'mcp__atrium__speak', room: 'room-fixture', text: value }, classified);
   assert.equal(seen.length, 3, 'rewritten event was not reclassified');
   assert.equal(seen[2].text, token, 'classification did not see the actual rewritten text');
  assert.equal(planned, null, 'residual finding was forwarded');
}));
}
async function promotionLocks(fixture) {
const { test, freshVault, $, call, testState, tokenize, setFile, rewriteReferences, referenceHostFor } = fixture;
await test('L6 trusted reference promotes an ephemeral value in place and holds before binding', () => freshVault(async () => {
  const value = 'release-candidate-build';
  const token = tokenize('op-output', value);
  assert.equal(testState().get(token).ephemeral, true, 'generic ordinary value was held before promotion');
  const refused = await rewriteReferences(referenceHostFor($), `printf %s ${token}`);
  assert.equal(refused.invalidReference, true, 'ephemeral token was bound');
  setFile('/tmp/wt-promote-fixture', value);
  const rewritten = await rewriteReferences(referenceHostFor($), 'printf %s secret:file:/tmp/wt-promote-fixture');
  assert.equal(rewritten.invalidReference, false, 'trusted promotion refused reference');
  assert.equal(tokenize('file', value), token, 'promotion changed token');
  assert.equal(testState().get(token).ephemeral, undefined, 'promotion did not hold');
  assert.equal(testState().get(token).trusted, true);
  assert.equal((await rewriteReferences(referenceHostFor($), `printf %s ${token}`)).invalidReference, false, 'held promoted token was refused as a generic shape');
  assert.equal((await call('echo ordinary', value)).text.includes(value), false, 'promoted bare value leaked');
  assert.ok((await call(`echo ${value}`, '')).deny, 'promoted outbound value was allowed');
}));
}
async function opaqueLocks(fixture) {
const { test } = fixture;
await test('L7 ids are opaque random across instances and never hash value material', async () => {
  const first = await import(`./token-vault.js?opaque-first-${Date.now()}`);
  const second = await import(`./token-vault.js?opaque-second-${Date.now()}`);
  const third = await import(`./token-vault.js?opaque-third-${Date.now()}`);
  const a = first.tokenize('file', 'fixture-known-X7p9');
  const b = second.tokenize('file', 'fixture-known-X7p9');
  const c = third.tokenize('file', '7342');
  for (const token of [a, b, c]) assert.match(token, /^secret:file#[a-f0-9]{6}$/);
  assert.notEqual(a, b, 'same serial and value produced deterministic token');
   assert.notEqual(b, c);
   const snapshot = first.testVaultSnapshot();
   const ids = new Set();
   for (let draw = 0; draw < 200; draw += 1) {
     first.testRestoreVault(snapshot);
     ids.add(first.tokenize('file', 'fixture-distribution-Q7p9'));
   }
   assert.ok(ids.size >= 195, '200 draws were a function of value rather than random');
  const source = readFileSync(new URL('./token-vault.js', import.meta.url), 'utf8');
  assert.equal(/shortHash|Math\.imul|sha256|createHash/.test(source), false, 'token ids still hash value material');
  assert.match(source, /getRandomValues/, 'ids do not use cryptographic randomness');
});
}
export async function runRevisionLocks(fixture) {
  await runReviewLocks(fixture);
  for (const run of [ordinaryShapeLocks, oneCharacterLocks, distinctiveLocks, releaseLocks, releaseAuthorityLocks, confirmationPrivacyLocks, trustedLocks, trustedAliasLocks, deletionLocks, bodyLocks, overlappingBodyLocks, routingLocks, noticeLocks, logFailureLocks, reclassificationLocks, promotionLocks, opaqueLocks]) await run(fixture);
}

async function logFailureLocks(fixture) {
  const { test, freshVault, $, tokenize, mcp } = fixture;
  await test('L5 UI log failure does not block already clean body forwarding', () => freshVault(async () => {
    const value = 'fixture-log-failure-Q7p9';
    tokenize('file', value);
    const runtime = { ...$, ui: { log() { throw new Error('ui unavailable'); } }, fs: { ...$.fs, async read() { throw new Error('missing'); } } };
    let forwarded;
    const answer = await mcp(runtime, { tool: 'mcp__atrium__speak', text: value }, async (event) => { forwarded = event; return {}; });
    assert.equal(answer.deny, undefined, 'UI failure refused clean forwarding');
    assert.equal(forwarded.text.includes(value), false, 'UI failure forwarded raw input');
  }));
}

async function confirmationPrivacyLocks(fixture) {
  const { test, freshVault, $, tokenize, receive, prompt, hookForTool, mcp } = fixture;
  await test('L4 UI only confirmation codes are withheld on every model facing guard channel', () => freshVault(async () => {
    const value = 'fixture-private-code-Q7p9';
    const token = tokenize('assignment', value);
    const code = await releaseStart(fixture, $, token);
    const inbound = await receive($, { text: `received ${code}` }, async (event) => event);
    assert.equal(JSON.stringify(inbound).includes(code), false, 'confirmation code reached an inbound prompt');
    const submitted = await prompt($, { text: 'ordinary', origin: { kind: 'peer' }, context: [{ [code]: code }] }, async (event) => event);
    assert.equal(JSON.stringify(submitted).includes(code), false, 'confirmation code reached a context entry');
    const result = await hookForTool('Grep')($, { tool: 'Grep', pattern: 'fixture' }, async () => ({ result: { [code]: code } }));
    assert.equal(JSON.stringify(result).includes(code), false, 'confirmation code reached a tool result key or value');
    const refused = await mcp($, { tool: 'mcp__sink__send', [code]: value }, async () => assert.fail('raw value forwarded'));
    assert.ok(refused.deny);
    assert.equal(refused.deny.includes(code), false, 'confirmation code reached refusal guidance');
  }));
}

async function trustedAliasLocks(fixture) {
  const { test, freshVault, $, tokenize, testState, prompt, logs } = fixture;
  await test('L4 trusted aliases retain provenance after a token spelling becomes held', () => freshVault(async () => {
    const value = 'fixture-alias-X7p9';
    const first = tokenize('op-output', value);
    tokenize('file', first);
    const second = tokenize('op-output', value);
    assert.notEqual(first, second, 'ambiguous token did not acquire a safe alias');
    tokenize('file', value);
    for (const token of [first, second]) assert.equal(testState().get(token).trusted, true, 'alias trusted provenance was lost');
    const before = logs.length;
    await prompt($, { origin: { kind: 'composer' }, text: `wt-secret-guard release ${second}` }, async () => assert.fail('trusted alias release forwarded'));
    assert.equal(logs.slice(before).some((line) => /confirmation code:/.test(line)), false, 'trusted alias was releasable');
  }));
}

async function overlappingBodyLocks(fixture) {
  const { test, freshVault, $, tokenize, mcp } = fixture;
  await test('L5 body scrub merges overlap and preserves issued token boundaries', () => freshVault(async () => {
    const small = 'fixture-overlap-X7p9';
    const whole = `${small}-tail`;
    tokenize('file', small);
    const token = tokenize('file', whole);
    let forwarded;
    const answer = await mcp($, { tool: 'mcp__atrium__speak', text: `${whole} ${Buffer.from(whole).toString('base64')} ${token}` }, async (event) => { forwarded = event; return {}; });
    assert.equal(answer.deny, undefined, 'overlapping body values were refused');
    assert.equal(forwarded.text, `${token} ${token} ${token}`, 'overlap or token exemption changed replacements');
    assert.deepEqual((await classifyOutbound({}, forwarded)).findings, []);
  }));
}
