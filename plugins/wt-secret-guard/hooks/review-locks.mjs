import assert from 'node:assert/strict';
import { releaseToken, registrationRefusalReason } from './token-vault.js';
import { redactConfirmationCodes } from './owner-release.js';
import { scrub } from './scrub.js';
import { locateReplacements } from './prompt-storage.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function start(f, token) {
  const before = f.logs.length;
  await f.prompt(f.$, { origin: { kind: 'composer' }, text: `wt-secret-guard release ${token}` }, async () => assert.fail('release forwarded'));
  return f.logs.slice(before).join('\n').match(/confirmation code: ([a-f0-9]{6})/)[1];
}
async function storage(f) {
  await f.test('F1 range writer parses modified record before any write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-range-'));
    try {
      const path = join(dir, 'record.jsonl');
      const original = `${JSON.stringify({ type: 'tool_use', id: 'range-fixture', input: { text: '123456' } })}\n`;
      writeFileSync(path, original);
      const offset = original.indexOf('123456');
      const payload = { expected: Buffer.from('123456').toString('base64'), replacement: Buffer.from('"\n****').toString('base64'), prefix: '', size: Buffer.byteLength(original), recordOffset: 0, recordLength: Buffer.byteLength(original) - 1, toolUseId: 'range-fixture' };
      const result = spawnSync(process.execPath, [new URL('./prompt-storage-range.mjs', import.meta.url).pathname, path, String(offset), '6', '', 'write'], { input: JSON.stringify(payload), encoding: 'utf8' });
      assert.notEqual(result.status, 0, 'range writer accepted invalid modified JSON');
      assert.equal(readFileSync(path, 'utf8'), original, 'range writer wrote before parsing');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  await f.test('F1 storage preserves JSON lines and masks values shorter than their token', () => f.freshVault(async () => {
    const value = 'fixture-long-value-Q7p9-abcdefghijklmnopqrstuvwxyz';
    const token = f.tokenize('file', value);
    const text = `Résumé "quoted" \\ path\n${value}\n${value}\n${Buffer.from(value).toString('base64')}\nfin`;
    const event = { tool: 'mcp__atrium__speak', tool_use_id: 'review-storage', text };
    f.setFile(f.transcriptPath, `${JSON.stringify({ message: { content: [{ type: 'tool_use', id: event.tool_use_id, input: event }] } })}\n`);
    await f.mcp(f.$, event, async () => ({}));
    const stored = f.getFile(f.transcriptPath).text;
    assert.doesNotThrow(() => stored.trim().split('\n').map(JSON.parse), 'repair corrupted JSONL');
    assert.equal(stored.includes(value), false, 'repair left raw value');
    assert.equal(stored.includes(Buffer.from(value).toString('base64')), false, 'repair left base64 value');
    assert.ok(JSON.parse(stored).message.content[0].input.text.endsWith('\nfin'), 'repair padded the whole body instead of individual spans');
    const plan = locateReplacements(JSON.stringify({ display: value }), [{ raw: value, token: 'quote"slash\\é' }], 'history');
    const bytes = Buffer.from(JSON.stringify({ display: value }));
    for (const change of plan) Buffer.from(change.replacement).copy(bytes, change.offset);
    assert.doesNotThrow(() => JSON.parse(bytes.toString()), 'replacement was not JSON escaped');
    // A token longer than the stored value cannot fit: the value is overwritten with asterisks, never left raw.
    const short = locateReplacements(JSON.stringify({ display: '7342' }), [{ raw: '7342', token }], 'history');
    assert.deepEqual(short.map((change) => change.replacement), ['****'], 'short value repair left the raw value or overran its span');
  }));
}
async function floors(f) {
  await f.test('F2 AWS slash key stays held and prefixed paths discriminate path branch', () => f.freshVault(async () => {
    const value = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    await f.call('echo fixture', `AWS_SECRET_ACCESS_KEY=${value}`);
    assert.ok([...f.testState().values()].some((entry) => entry.value === value && !entry.ephemeral), 'AWS slash key was not held');
    for (const path of ['/tmp/build/log', './a/b', '~/x/y', '/tmp/build2/log']) assert.ok(registrationRefusalReason(path, 'assignment'));
    for (const path of ['/tmp/mQvZtLpRsNxBcDa/log', '/tmp/a1b2c3d4e5f6g7h8/log']) assert.equal(registrationRefusalReason(path, 'assignment'), '');
    assert.equal(registrationRefusalReason('a1/b2/c3', 'assignment'), '', 'unprefixed path was not held');
  }));
  await f.test('F3 camel and acronym words are low distinctiveness', () => f.freshVault(async () => {
    for (const value of ['refreshAccessToken', 'getUserById', 'parseHTTPResponse']) assert.equal(registrationRefusalReason(value, 'assignment'), 'low-distinctiveness', 'camel identifier was held');
    for (const value of ['mQvZtLpRsNxBcDa', 'aBcDeFgHiJ']) assert.equal(registrationRefusalReason(value, 'assignment'), '');
  }));
  await f.test('F9 templates and repeated characters are ordinary shapes', () => f.freshVault(async () => {
    for (const value of ['${{ secrets.GITHUB_TOKEN }}', '${NAME}', '{{ value }}', '<VALUE>', '********', 'xxxx']) assert.equal(registrationRefusalReason(value, 'assignment'), 'ordinary-shape', 'placeholder or repetition was held');
  }));
}
async function authority(f) {
  await f.test('F4 wrong code consumes confirmation and uppercase codes are withheld', () => f.freshVault(async () => {
    const token = f.tokenize('assignment', 'fixture-attempt-Q7p9');
    const code = await start(f, token);
    assert.equal(redactConfirmationCodes(code.toUpperCase()).includes(code.toUpperCase()), false, 'uppercase confirmation leaked');
    await f.prompt(f.$, { origin: { kind: 'composer' }, text: `wt-secret-guard release ${token} ${code === '000000' ? '111111' : '000000'}` }, async () => ({}));
    await f.prompt(f.$, { origin: { kind: 'composer' }, text: `wt-secret-guard release ${token} ${code}` }, async () => ({}));
    assert.ok(f.testState().has(token), 'second attempt released');
  }));
  await f.test('F4 outbound release grammar is refused on all tool inputs', () => f.freshVault(async () => {
    for (const tool of ['Bash', 'Write', 'Edit', 'Agent', 'Task', 'Read', 'Grep', 'Glob', 'WebFetch', 'NotebookRead', 'NotebookEdit', 'WebSearch', 'mcp__atrium__speak']) {
      const hook = tool.startsWith('mcp__') ? f.mcp : f.hookForTool(tool);
      const answer = await hook(f.$, { tool, command: 'printf wt-secret-guard release', text: 'wt-secret-guard release' }, async () => ({ text: 'executed' }));
      assert.ok(answer.deny, `release grammar executed via ${tool}`);
      assert.equal(answer.deny.includes('printf'), false);
    }
    assert.ok(f.allTools, 'release grammar lacks catchall tool hook');
    assert.ok((await f.allTools(f.$, { tool: 'CustomTool', payload: 'wt-secret-guard release' }, async () => ({}))).deny, 'custom tool release grammar executed');
  }));
}
async function privacy(f) {
  await f.test('F5 masking precedes confirmation redaction and codes retire', () => f.freshVault(async () => {
    const token = f.tokenize('assignment', 'fixture-retire-Q7p9');
    const code = await start(f, token);
    const value = `fixture-later-${code}-Q7p9`;
    const held = f.tokenize('file', value);
    assert.equal(scrub(value, '').value, held, 'confirmation redaction split held value');
    const next = await start(f, token);
    assert.equal(redactConfirmationCodes(code), code, 'replaced code remained active');
    await f.prompt(f.$, { origin: { kind: 'composer' }, text: `wt-secret-guard release ${token} ${next}` }, async () => ({}));
    assert.equal(redactConfirmationCodes(next), next, 'used code remained active');
  }));
  await f.test('F5 expired codes leave redaction set', () => f.freshVault(async () => {
    const code = await start(f, f.tokenize('assignment', 'fixture-expired-Q7p9'));
    const now = Date.now;
    try { Date.now = () => now() + 300001; assert.equal(redactConfirmationCodes(code), code, 'expired code remained active'); }
    finally { Date.now = now; }
  }));
  await f.test('F11 confirmation key collision refuses rather than dropping field', () => f.freshVault(async () => {
    const code = await start(f, f.tokenize('assignment', 'fixture-collision-Q7p9'));
    const result = await f.hookForTool('Grep')(f.$, { tool: 'Grep', pattern: 'fixture' }, async () => ({ result: { [code]: 'first', '[guard confirmation withheld]': 'second' } }));
    assert.ok(result.deny, 'confirmation key collision silently dropped field');
    const answer = await f.mcp(f.$, { tool: 'mcp__sink__send', [code]: 'first', '[guard confirmation withheld]': 'second' }, async () => ({}));
    assert.ok(answer.deny, 'confirmation key collision input executed');
  }));
}
async function cleanAndIds(f) {
  await f.test('F6 clean owner body with embedded trusted PIN goes unchanged', () => f.freshVault(async () => {
    f.tokenize('onepassword', '7342');
    const text = 'number 918273426543210';
    let sent;
    await f.mcp(f.$, { tool: 'mcp__atrium__speak', text }, async (event) => { sent = event.text; return {}; });
    assert.equal(sent, text, 'clean owner body was rewritten');
  }));
  await f.test('F7 released ids cannot be minted again', () => f.freshVault(async () => {
    const token = f.tokenize('assignment', 'fixture-tombstone-Q7p9');
    releaseToken(token);
    const original = crypto.getRandomValues;
    let draw = parseInt(token.slice(-6), 16);
    crypto.getRandomValues = (bytes) => { const id = draw++; bytes.set([id >>> 16, (id >>> 8) & 255, id & 255]); return bytes; };
    try { assert.notEqual(f.tokenize('assignment', 'fixture-new-Q7p9'), token, 'released id was reused'); }
    finally { crypto.getRandomValues = original; }
  }));
  await f.test('F8 routing precheck avoids discovering or holding body values', () => f.freshVault(async () => {
    const { planOwnerChannel } = await import('./owner-channel.js');
    const route = 'fixture-route-pre-Q7p9';
    f.tokenize('file', route);
    assert.equal(await planOwnerChannel({ tool: 'mcp__atrium__speak', room: route, text: 'password: fixture-unseen-body-Q7p9' }), null);
    assert.equal([...f.testState().values()].some((entry) => entry.value === 'fixture-unseen-body-Q7p9'), false, 'routing precheck held body');
  }));
}
export async function runReviewLocks(f) {
  for (const run of [storage, floors, authority, privacy, cleanAndIds]) await run(f);
}
