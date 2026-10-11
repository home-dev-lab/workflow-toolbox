import assert from 'node:assert/strict';
import { handleOwnerRelease, releaseGrammarRefusal } from './owner-release.js';
import { releaseToken, testVaultSnapshot, testRestoreVault } from './token-vault.js';
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
  for (const [order, chain] of [['catch-first', [f.allTools, f.mcp]], ['mcp-first', [f.mcp, f.allTools]]]) {
    let dispatched = 0;
    const dispatch = async () => { dispatched += 1; return { text: 'sent' }; };
    const run = chain.reduceRight((next, hook) => (input) => hook(f.$, input, next), dispatch);
    const answer = await run(event);
    assert.equal(dispatched, 0, `${label} ${order}: refused input reached next`);
    assert.ok(answer?.deny, `${label} ${order}: missing refusal`);
    if (label.startsWith('active code')) assert.equal(answer.deny.includes('234567'), false, 'refusal disclosed active code');
  }
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
    for (const body of ['clean']) {
      await f.test(`release line allowed ${tool} ${order} ${body}`, () => f.freshVault(() =>
        allowed(f, tool, order, (token) => `${line(token)}${body === 'clean' ? '' : `\nDetail: ${body === 'raw' ? value : base64Utf8(value)}`}`)));
    }
  }
  for (const kind of ['fixture', 'key-value']) await f.test(`release line issued ${kind} is not release authority`, () =>
    f.freshVault(async () => {
      await allowed(f, adapters[0], 'catch-first', line, kind);
      const token = f.tokenize(kind, kind === 'fixture' ? 'fixture-trusted-Z8n4' : 'ordinary');
      const output = [];
      handleOwnerRelease({ origin: { kind: 'composer' }, text: line(token) }, (text) => output.push(text));
      const code = output.at(-1).match(/confirmation code: ([a-f0-9]{6})$/)?.[1] ?? '123456';
      const answer = handleOwnerRelease({ origin: { kind: 'composer' }, text: `${line(token)} ${code}` }, () => {});
      assert.ok(!answer.released && f.testState().has(token), `${kind} token released by full composer confirmation`);
    }));
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
    ['raw body', { text: `${line(token)}\n${value}` }],
    ['base64 body', { text: `${line(token)}\n${base64Utf8(value)}` }],
    ['raw agentId', { agentId: value }], ['base64 tool_use_id', { tool_use_id: base64Utf8(value) }],
    ['raw tool_use_id', { tool_use_id: value }], ['base64 agentId', { agentId: base64Utf8(value) }],
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
    ['confirmation wording', `${text}\nconfirmation code: abcdef`],
    ['invisible suffix', `${text}\n\u200babcdef`],
    ['later line suffix', `${text}\nPlease confirm\nabcdef`],
    ['preceding code', `abcdef\n${text}`],
    ...['\t', '\r\n', '\n', '\r', '\u00a0', '\u2028', '\u2029', '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff']
      .map((separator, index) => [`separator ${index}`, text.replace(' release', `${separator}release`)]),
    ['fullwidth lookalike', text.replace('release', 'ｒｅｌｅａｓｅ')],
    ['NEL', text.replace(' release', '\u0085release')],
    ['format inside name', text.replace('guard', 'gu\u200bard')],
    ['format inside release', text.replace('release', 'rele\u200base')],
  ];
}

async function parsingLocks(f) {
  for (const [name] of parsingCases('fixture')) await f.test(`release line forbidden parsing ${name}`, () =>
    f.freshVault(async () => {
      const token = f.tokenize('assignment', value);
      const [, text] = parsingCases(token).find(([label]) => label === name);
      await denied(f, { tool: adapters[0], text }, name);
    }));
  for (const separator of ['\t', '\n', '\u200b', '\u0085']) await f.test(`release grammar decoded routing ${JSON.stringify(separator)}`, () =>
    f.freshVault(async () => {
      const token = f.tokenize('assignment', value);
      const grammar = line(token).replace(' release', `${separator}release`);
      await denied(f, { tool: adapters[0], text: line(token), extra: [{ [grammar]: grammar }] }, 'decoded routing');
      await denied(f, { tool: 'CustomTool', payload: grammar }, 'decoded unknown');
      await denied(f, { tool: adapters[0], text: 'ordinary message', extra: [{ [grammar]: 1 }] }, 'decoded key only');
    }));
  for (const word of ['guard', 'release']) await f.test(`release grammar format inside ${word} on other tools`, () =>
    f.freshVault(async () => {
      const token = f.tokenize('assignment', value);
      const grammar = line(token).replace(word, `${word.slice(0, 2)}\u200b${word.slice(2)}`);
      await denied(f, { tool: 'CustomTool', payload: grammar }, `format inside ${word}`);
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
    await f.receive(f.$, { origin: { kind: 'bridge' }, text: `${line(token)} ${code}` }, async (event) => {
      dispatched += 1;
      assert.equal(event.text.includes(code), false, 'inbound active confirmation code reached next');
      assert.ok(event.text.includes('[guard confirmation withheld]'), 'inbound confirmation lacks redaction');
      return {};
    });
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
  for (const run of [allowedLocks, toolLocks, fieldLocks, parsingLocks, stateLocks, scalarLocks, shortLocks]) await run(f);
  await roundTwoLocks(f);
}

function numericPending(token) {
  const original = crypto.getRandomValues;
  let draw = 0x234567;
  crypto.getRandomValues = (bytes) => { const id = draw++; bytes.set([id >>> 16, (id >>> 8) & 255, id & 255]); return bytes; };
  try { return pending(token); } finally { crypto.getRandomValues = original; }
}

async function activeCodeLocks(f) {
  const tools = [...adapters, 'CustomTool', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'Read', 'NotebookRead',
    'WebFetch', 'WebSearch', 'Agent', 'Task', 'Grep', 'Glob', 'mcp__other__speak'];
  for (const tool of tools) for (const field of ['text', 'number', 'payload', 'key', 'bigint']) {
    await f.test(`active code without grammar ${tool} ${field}`, () => f.freshVault(async () => {
      const token = f.tokenize('assignment', value);
      const code = numericPending(token);
      try {
        assert.equal(code, '234567', 'synthetic active code fixture');
        const fields = field === 'number' ? { text: 'ordinary message', extra: { code: Number(code) } }
          : field === 'key' ? { extra: { [`x${code}y`]: false } }
          : field === 'bigint' ? { extra: { code: BigInt(code) } } : { [field]: code };
        await denied(f, { tool, ...fields }, `active code ${field}`);
      } finally { handleOwnerRelease({ origin: { kind: 'composer' }, text: `${line(token)} ${code}` }, () => {}); }
    }));
  }
}

async function unchangedAllowed(f, event, label) {
  for (const chain of [[f.allTools, f.mcp], [f.mcp, f.allTools]]) {
    let count = 0;
    const run = chain.reduceRight((next, hook) => (input) => hook(f.$, input, next), async (input) => {
      count += 1;
      assert.deepEqual(input, event, `${label}: allowed event changed`);
      return {};
    });
    const answer = await run(event);
    assert.equal(count, 1, `${label}: clean event refused`);
    assert.equal(answer.deny, undefined);
  }
}

async function tokenSpanLocks(f) {
  for (const held of ['7342', 'mcp__']) await f.test(`release line issued spelling exemption ${held}`, () =>
    f.freshVault(async () => {
      f.tokenize('fixture', held);
      const original = crypto.getRandomValues;
      crypto.getRandomValues = (bytes) => { bytes.set([0x73, 0x42, 0xab]); return bytes; };
      let token;
      try { token = f.tokenize('assignment', value); } finally { crypto.getRandomValues = original; }
      assert.ok(token.endsWith('#7342ab'), 'synthetic issued token fixture');
      for (const tool of adapters) {
        await unchangedAllowed(f, { tool, text: line(token) }, `issued spelling ${held}`);
        await denied(f, { tool, text: line(token), extra: { raw: `x${held}y` } }, `outside token ${held}`);
      }
    }));
}

async function roundTwoLocks(f) {
  await activeCodeLocks(f);
  await tokenSpanLocks(f);
  for (const char of ['\u034f', '\u115f', '\u17b4', '\ufe0f', '\u{e0100}']) {
    await f.test(`release grammar default ignorable ${char.codePointAt(0).toString(16)}`, () => f.freshVault(async () => {
      const token = f.tokenize('assignment', value);
      await denied(f, { tool: 'CustomTool', payload: line(token).replace(' release', `${char}release`) }, 'default ignorable grammar');
    }));
    await f.test(`release hex default ignorable ${char.codePointAt(0).toString(16)}`, () => f.freshVault(async () => {
      const token = f.tokenize('assignment', value);
      await denied(f, { tool: adapters[0], text: `${line(token)}\na${char}bcdef` }, 'default ignorable hex');
    }));
  }
  await f.test('release line format inside six-hex word', () => f.freshVault(async () => {
    const token = f.tokenize('assignment', value);
    await denied(f, { tool: adapters[0], text: `${line(token)}\na\u200bbcdef` }, 'format inside hex');
  }));
  await f.test('release line ephemeral value beside clean line allowed', () => f.freshVault(async () => {
    f.tokenize('key-value', 'ordinary');
    const token = f.tokenize('assignment', value);
    await unchangedAllowed(f, { tool: adapters[0], text: `${line(token)}\nordinary`, extra: { ordinary: true } }, 'ephemeral value');
  }));
  await f.test('release line nested envelope refused', () => f.freshVault(async () => {
    const token = f.tokenize('assignment', value);
    for (const tool of adapters) await denied(f, { tool, input: { text: line(token) } }, 'nested envelope');
  }));
}

async function scalarLocks(f) {
  for (const type of ['number', 'bigint', 'boolean']) await f.test(`release line scalar held ${type}`, () =>
    f.freshVault(async () => {
      const scalar = type === 'boolean' ? false : type === 'bigint' ? 123456789n : 123456789;
      const held = f.tokenize('fixture', String(scalar));
      if (type === 'boolean') {
        // Registration excludes common words; model a previously held scalar spelling.
        const snapshot = testVaultSnapshot();
        delete snapshot.tokens.get(held).ephemeral;
        snapshot.values.add(String(scalar));
        testRestoreVault(snapshot);
      }
      const token = f.tokenize('assignment', value);
      await denied(f, { tool: adapters[0], text: line(token), extra: [{ pin: scalar }] }, `scalar held ${type}`);
    }));
  await f.test('release line numeric active confirmation', () => f.freshVault(async () => {
    const token = f.tokenize('assignment', value);
    const original = crypto.getRandomValues;
    let draw = 0x123456;
    crypto.getRandomValues = (bytes) => { const id = draw++; bytes.set([id >>> 16, (id >>> 8) & 255, id & 255]); return bytes; };
    let code;
    try { code = pending(token); } finally { crypto.getRandomValues = original; }
    try {
      assert.match(code, /^\d{6}$/, 'numeric code fixture must have six decimal digits');
      await denied(f, { tool: adapters[0], text: line(token), extra: { code: Number(code) } }, 'numeric active confirmation');
    } finally { handleOwnerRelease({ origin: { kind: 'composer' }, text: `${line(token)} ${code}` }, () => {}); }
  }));
}

async function shortLocks(f) {
  await f.test('release line six-hex token kind is not exempt', () => f.freshVault(async () => {
    const token = f.tokenize('abcdef', value);
    await denied(f, { tool: adapters[0], text: line(token) }, 'six-hex token kind');
  }));
  for (const field of ['text', 'agentId', 'tool_use_id', 'key']) await f.test(`release line short held substring ${field}`, () =>
    f.freshVault(async () => {
      f.tokenize('fixture', '7342');
      const token = f.tokenize('assignment', value);
      const fields = field === 'key' ? { extra: { x7342y: false } } : { [field]: field === 'text' ? `${line(token)}\nx7342y` : 'x7342y' };
      await denied(f, { tool: adapters[0], text: line(token), ...fields }, `short held substring ${field}`);
    }));
}
