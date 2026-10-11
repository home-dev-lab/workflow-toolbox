import assert from 'node:assert/strict';
import { handleOwnerRelease, releaseGrammarRefusal } from './owner-release.js';
import { releaseToken } from './token-vault.js';
import { base64Utf8 } from './outbound-tools.js';

const adapters = ['mcp__plugin_atrium_atrium__speak', 'mcp__atrium__speak'];
const value = 'fixture-line-Q7p9-N3k8';
const line = (token) => `wt-secret-guard release ${token}`;

function pending(token) {
  const output = [];
  handleOwnerRelease({ origin: { kind: 'composer' }, text: line(token) }, (text) => output.push(text));
  return output.at(-1).match(/confirmation code: ([a-f0-9]{6})$/)[1];
}

async function denied(f, event, label) {
  let dispatched = 0;
  const hook = f.hookForTool(event.tool) ?? (event.tool.startsWith('mcp__') ? f.mcp : f.allTools);
  const answer = await hook(f.$, event, async () => { dispatched += 1; return { text: 'sent' }; });
  assert.equal(dispatched, 0, `${label}: refused input reached next`);
  assert.ok(answer?.deny, `${label}: missing refusal`);
}

async function allowed(f, tool, order, body, kind = 'assignment', redaction = true) {
  const token = f.tokenize(kind, kind === 'assignment' ? value : kind === 'fixture' ? 'fixture-trusted-Z8n4' : 'ordinary');
  const code = kind === 'assignment' ? pending(token) : null;
  const text = body(token);
  const before = f.testState();
  const dispatches = [];
  const chain = order === 'catch-first' ? [f.allTools, f.mcp] : [f.mcp, f.allTools];
  f.configure({ ownerChannelRedaction: redaction });
  try {
    const dispatch = async (event) => { dispatches.push(event); return { text: 'sent' }; };
    const run = chain.reduceRight((next, hook) => (event) => hook(f.$, event, next), dispatch);
    const answer = await run({ tool, room: 'fixture-room', text });
    assert.equal(dispatches.length, 1, 'allowed release line must dispatch exactly once');
    assert.equal(answer.deny, undefined);
    assert.ok(dispatches[0].text.includes(line(token)), 'literal release token was changed');
    assert.equal(JSON.stringify(dispatches).includes(value), false, 'raw held value forwarded');
    assert.equal(JSON.stringify(dispatches).includes(base64Utf8(value)), false, 'base64 held value forwarded');
    assert.deepEqual(f.testState(), before, 'speak changed release state');
    if (code) assert.ok(handleOwnerRelease({ origin: { kind: 'bridge' }, text: `${line(token)} ${code}` }, () => {}).released,
      'speak consumed or changed pending confirmation');
  } finally { f.configure({ ownerChannelRedaction: true }); }
}

async function allowedLocks(f) {
  for (const tool of adapters) for (const order of ['catch-first', 'mcp-first']) {
    for (const body of ['clean', 'raw', 'base64']) {
      await f.test(`release line allowed ${tool} ${order} ${body}`, () => f.freshVault(() =>
        allowed(f, tool, order, (token) => `${line(token)}${body === 'clean' ? '' : `\nDetail: ${body === 'raw' ? value : base64Utf8(value)}`}`)));
    }
  }
  for (const kind of ['fixture', 'key-value']) await f.test(`release line issued ${kind} is not release authority`, () =>
    f.freshVault(() => allowed(f, adapters[0], 'catch-first', line, kind)));
  await f.test('release line clean works with body redaction disabled', () =>
    f.freshVault(() => allowed(f, adapters[0], 'mcp-first', line, 'assignment', false)));
  await f.test('release line with surrounding prose and CRLF remains copyable', () =>
    f.freshVault(() => allowed(f, adapters[0], 'catch-first', (token) => `Please paste this line:\r\n${line(token)}\r\nThen confirm on your console.`)));
  await f.test('release line raw body refused with redaction disabled', () => f.freshVault(async () => {
    const token = f.tokenize('assignment', value);
    f.configure({ ownerChannelRedaction: false });
    try { await denied(f, { tool: adapters[0], text: `${line(token)}\n${value}` }, 'disabled'); }
    finally { f.configure({ ownerChannelRedaction: true }); }
  }));
}

async function toolLocks(f) {
  const tools = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Read', 'NotebookRead', 'WebFetch', 'WebSearch',
    'Agent', 'Task', 'Grep', 'Glob', 'speak', 'CustomTool', 'mcp__other__speak', 'mcp__atrium__history',
    'mcp__atrium__speak_extra', 'prefix_mcp__atrium__speak'];
  for (const tool of tools) await f.test(`release line forbidden tool ${tool}`, () => f.freshVault(async () => {
    const token = f.tokenize('assignment', value);
    await denied(f, { tool, text: line(token) }, tool);
    await denied(f, { tool, command: line(token), file_path: line(token) }, `${tool} other fields`);
  }));
}

function fieldCases(token, code) {
  return [
    ['routing', { room: line(token) }], ['nested value', { extra: [{ inner: line(token) }] }],
    ['grammar key', { extra: { [line(token)]: 1 } }], ['nonstring', { text: [line(token)] }],
    ['held key primitive', { extra: { [value]: 1 } }], ['held key object', { extra: [{ [value]: {} }] }],
    ['held key substring', { extra: { [`prefix-${value}-suffix`]: false } }],
    ['base64 held key', { extra: [{ [base64Utf8(value)]: false }] }],
    ['raw routing', { room: value }], ['base64 routing', { room: base64Utf8(value) }],
    ['code routing', { room: code }], ['code uppercase', { room: `prefix-${code.toUpperCase()}-suffix` }],
    ['code nested', { extra: [{ inner: code }] }], ['code key', { extra: { [code]: {} } }],
    ['code key collision', { extra: { [code]: 1, '[guard confirmation withheld]': 2 } }],
    ['code body', { text: `${line(token)}\nCode: ${code}` }],
  ];
}

async function fieldLocks(f) {
  // Names are independent of the synthetic ids minted inside each lock.
  for (const [name] of fieldCases('fixture', 'fixture')) await f.test(`release line forbidden field ${name}`, () =>
    f.freshVault(async () => {
      const token = f.tokenize('assignment', value);
      const code = pending(token);
      const [, fields] = fieldCases(token, code).find(([label]) => label === name);
      await denied(f, { tool: adapters[0], text: line(token), ...fields }, name);
      assert.ok(f.testState().has(token), 'denial released value');
      handleOwnerRelease({ origin: { kind: 'composer' }, text: `${line(token)} ${code}` }, () => {});
    }));
}

function parsingCases(token) {
  const text = line(token);
  return [
    ['two same line', `${text} ${text}`], ['two lines', `${text}\n${text}`],
    ['mixed case occurrence', `${text}\n${text.toUpperCase()}`], ['uppercase', text.toUpperCase()],
    ['extra spaces', text.replace(' release ', '  release ')], ['extended id', `${text}a`],
    ['punctuation', `${text}.`], ['trailing word', `${text} confirm`],
    ['inactive suffix', `${text} abcdef`], ['next line suffix', `${text}\nabcdef`],
    ['punctuation suffix', `${text}:abcdef`], ['next line punctuation suffix', `${text}\n(code: abcdef)`],
    ...['\t', '\r\n', '\n', '\r', '\u00a0', '\u2028', '\u2029', '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff']
      .map((separator, index) => [`separator ${index}`, text.replace(' release', `${separator}release`)]),
    ['fullwidth lookalike', text.replace('release', 'ｒｅｌｅａｓｅ')],
  ];
}

async function parsingLocks(f) {
  for (const [name] of parsingCases('fixture')) await f.test(`release line forbidden parsing ${name}`, () =>
    f.freshVault(async () => {
      const token = f.tokenize('assignment', value);
      const [, text] = parsingCases(token).find(([label]) => label === name);
      await denied(f, { tool: adapters[0], text }, name);
    }));
  for (const separator of ['\t', '\n', '\u200b']) await f.test(`release grammar decoded routing ${JSON.stringify(separator)}`, () =>
    f.freshVault(async () => {
      const token = f.tokenize('assignment', value);
      const grammar = line(token).replace(' release', `${separator}release`);
      await denied(f, { tool: adapters[0], text: line(token), extra: [{ [grammar]: grammar }] }, 'decoded routing');
      await denied(f, { tool: 'CustomTool', payload: grammar }, 'decoded unknown');
      await denied(f, { tool: adapters[0], text: 'ordinary message', extra: [{ [grammar]: 1 }] }, 'decoded key only');
    }));
}

async function stateLocks(f) {
  for (const state of ['unknown', 'ambiguous', 'released']) await f.test(`release line forbidden state ${state}`, () =>
    f.freshVault(async () => {
      let token = f.tokenize('assignment', value);
      if (state === 'ambiguous') f.tokenize('fixture', token);
      if (state === 'released') releaseToken(token);
      if (state === 'unknown') token = token.replace('assignment', 'unknown-kind');
      await denied(f, { tool: adapters[0], text: line(token) }, state);
    }));
  await f.test('release line inbound never releases or consumes confirmation', () => f.freshVault(async () => {
    const token = f.tokenize('assignment', value);
    const code = pending(token);
    const before = f.testState();
    let dispatched = 0;
    await f.receive(f.$, { origin: { kind: 'bridge' }, text: line(token) }, async () => { dispatched += 1; return {}; });
    assert.equal(dispatched, 1);
    assert.deepEqual(f.testState(), before);
    assert.ok(handleOwnerRelease({ origin: { kind: 'composer' }, text: `${line(token)} ${code}` }, () => {}).released);
  }));
  await f.test('release line shared refusal allows only literal text field', () => f.freshVault(async () => {
    const token = f.tokenize('assignment', value);
    assert.equal(releaseGrammarRefusal({ tool: adapters[0], text: line(token) }), null);
    assert.ok(releaseGrammarRefusal({ tool: adapters[0], room: line(token) }));
  }));
}

export async function runReleaseLineLocks(f) {
  for (const run of [allowedLocks, toolLocks, fieldLocks, parsingLocks, stateLocks]) await run(f);
}
