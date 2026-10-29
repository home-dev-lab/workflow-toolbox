import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runtime from '../hooks/runtime-rule.js';
import { register, resetForSelftest } from '../hooks/hooks.js';
import { extractCases } from '../scripts/judge-extract.mjs';
import { measureRules, ruleId } from '../scripts/quality-measures.mjs';
import { instructionContent } from '../scripts/prefix-size.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const stamp = (body = 'Follow.\n', version = '1.2.3') => `<!-- installed from workflow-toolbox v${version} · content sha256:${hash(body).slice(0, 12)} head sha256:0123456789ab by the adopt skill — editable copy. Re-run the workflow-toolbox:adopt skill to check for updates; --install refreshes only an UNEDITED copy, --force overwrites your local edits. -->`;
const source = (body, trigger = "    - kind: tool\n      tool: '^Agent$'\n      unconditional: true\n      before-first-act: true") => `---\non-demand:\n  triggers:\n${trigger}\n---\n${body}`;
const content = (body) => runtime.parseRuntimeRule('sample.md', source(body)).content;

test('servedText exports the shared delivery normalization', () => {
  assert.equal(typeof runtime.servedText, 'function', 'servedText must be exported');
  assert.equal(runtime.servedText(`${stamp()}\n\nFollow.\n`), 'Follow.\n');
});

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  for (const breaks of [1, 2, 3]) test(`first-line adopt stamp removes at most two ${label} breaks (${breaks})`, () => {
    const directive = `Follow.${eol}Keep spacing.  ${eol}\nMixed ending.\r\n`;
    // Construct CRLF frontmatter separately so mixed body endings stay byte-for-byte intact.
    const header = source('').replaceAll('\n', () => eol);
    assert.equal(runtime.parseRuntimeRule('sample.md', header + stamp() + eol.repeat(breaks) + directive).content,
      eol.repeat(Math.max(0, breaks - 2)) + directive);
  });
}

const preserved = [
  ['directive comment', '<!-- Never run this without approval. -->\nAct carefully.\n'],
  ['embedded-copy markers', '<!-- embedded-copy:shared:start -->\nKeep this block.\n<!-- embedded-copy:shared:end -->\n'],
  ['fenced comments', '```html\n<!-- Never remove this example. -->\n' + stamp() + '\n```\n'],
  ['inline anchors', 'Keep one `<!-- §N -->` anchor each.\n'],
  ['later stamp', 'Directive first.\n' + stamp() + '\n\nDirective last.\n'],
  ['leading blank line', '\n' + stamp() + '\nDirective.\n'],
  ['multiline stamp', '<!-- installed from workflow-toolbox v1.2.3\ncontent sha256:0123456789ab -->\nDirective.\n'],
  ['stamp with trailing directive', stamp() + ' Never bypass approval.\n'],
  ['unstamped content', 'Directive with trailing spaces.  \n\n'],
];
for (const [label, body] of preserved) test(`adopt removal preserves ${label} byte-for-byte`, () => {
  assert.equal(content(`${stamp()}\n\n${body}`), body);
  assert.equal(content(body), body);
});

test('a stamp-only body without a terminal newline serves empty text', () => {
  assert.equal(content(stamp()), '');
});

const installerTail = ' by the adopt skill — editable copy. Re-run the workflow-toolbox:adopt skill to check for updates; --install refreshes only an UNEDITED copy, --force overwrites your local edits. -->';
for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`a stamp followed by a directive comment on the same ${label} line is preserved`, () => {
    const body = `${stamp()} <!-- Never bypass approval. -->${eol}Follow.${eol}`;
    assert.equal(runtime.servedText(body), body, 'a second comment must not extend the provenance stamp');
  });
  for (const [form, metadata] of [
    ['no fingerprint', ''],
    ['fingerprint only', ' · content sha256:8278b5c6472f'],
    ['head', ' · content sha256:8278b5c6472f head sha256:0123456789ab'],
    ['kept and spec', ' · content sha256:8278b5c6472f kept sha256:0123456789ab spec sha256:abcdef012345'],
    ['head without fingerprint', ' head sha256:0123456789ab'],
  ]) test(`installer stamp ${form} is removed with ${label}`, () => {
    const body = `<!-- installed from workflow-toolbox v1.2.3${metadata}${installerTail}${eol}${eol}Follow.${eol}`;
    assert.equal(runtime.servedText(body), `Follow.${eol}`, 'recognized installer stamps must not be served');
  });
}

test('an example provenance comment without installer grammar is preserved', () => {
  const body = '<!-- installed from workflow-toolbox vEXAMPLE content sha256:0123456789ab Never bypass approval. -->\n';
  assert.equal(runtime.servedText(body), body, 'an ordinary example comment must remain served');
});

async function judgeFixture(t, currentBody, deliveredBody) {
  const root = await mkdtemp(join(tmpdir(), 'served-text-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rules = join(root, 'rules'), transcript = join(root, 'session.jsonl');
  await mkdir(rules);
  const rule = join(rules, 'sample.md');
  await writeFile(rule, source(currentBody));
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: {} }] } },
    { type: 'attachment', attachment: { type: 'hook_additional_context', toolUseID: 'a-context', content: `<rule name="sample.md">\n${deliveredBody}\n</rule>` } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Done.' }] } },
  ];
  await writeFile(transcript, records.map((record) => JSON.stringify(record)).join('\n'));
  return { rule, extract: () => extractCases({ transcripts: [transcript], rulesDirs: [rules] }) };
}

for (const [label, current, delivered] of [
  ['old stamped delivery', 'Follow.\n', stamp() + '\n\nFollow.\n'],
  ['new unstamped delivery', stamp() + '\n\nFollow.\n', 'Follow.\n'],
  ['different stamp versions', stamp() + '\n\nFollow.  \n', stamp('Follow.\n', '1.0.0') + '\n\nFollow.\n'],
]) test(`judge ignores provenance for ${label} but detects a real body change`, async (t) => {
  const f = await judgeFixture(t, current, delivered);
  const [equal] = await f.extract();
  assert.ok(equal && equal.triggerReason !== 'historical rule body differs from served text', 'stamp-only differences must not be drift');
  assert.equal(equal.currentRuleHash, hash(source(current)), 'identity remains the full file hash');
  await writeFile(f.rule, source('Changed directive.\n'));
  const [changed] = await f.extract();
  assert.equal(changed.triggerReason, 'historical rule body differs from served text');
});

const repeatedStampBody = `${stamp()}\n\n${stamp()}\n\nFollow.\n`;
for (const [label, current, delivered, drift] of [
  ['retained stamp removed from delivery', repeatedStampBody, 'Follow.\n', true],
  ['identical historical two-stamp delivery', repeatedStampBody, repeatedStampBody, false],
  ['identical leading-blank stamp-like bodies', `\n${stamp()}\nFollow.\n`, `\n${stamp()}\nFollow.\n`, false],
  ['blank before retained stamp after provenance removal', `${stamp()}\n\n\n${stamp()}\nFollow.\n`, `\n${stamp()}\nFollow.\n`, false],
  ['changed directive after legacy stamp', `${stamp()}\n\nFollow.\n`, `${stamp()}\n\nChanged directive.\n`, true],
]) test(`judge drift: ${label}`, async (t) => {
  const f = await judgeFixture(t, current, delivered);
  const [result] = await f.extract();
  assert.ok(result, 'the delivered rule must produce a judge case');
  assert.equal(result.triggerReason === 'historical rule body differs from served text', drift,
    `drift must be ${drift} for ${label}`);
});

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) test(`static cost uses the harness comment model for a stamped ${label} rule`, () => {
  const directive = `Follow café.${eol}<!-- Keep at act, dropped statically. -->${eol}\`\`\`html${eol}<!-- fenced example -->${eol}\`\`\`${eol}`;
  const body = stamp(directive) + eol.repeat(2) + directive;
  const expected = eol.repeat(2) + `Follow café.${eol}${eol}\`\`\`html${eol}<!-- fenced example -->${eol}\`\`\`${eol}`;
  assert.equal(instructionContent(body).content, expected);
  const rule = { name: 'sample.md', scope: 'project', rulesDir: 'rules', text: source(body) };
  const id = ruleId(rule), now = Date.parse('2026-01-01T00:00:00Z');
  const measured = measureRules({ rules: [rule], now, deliveries: [],
    effective: [{ rules: [id], at: [new Date(now).toISOString()] }],
    ledger: { [id]: { bodyHash: hash(body) } }, pluginRulesDir: { [id]: directive } }).rules[id].measures;
  assert.equal(measured.cost.staticBytes, Buffer.byteLength(expected), 'static bytes must exclude the stamp using the harness model');
  assert.equal(measured.driftMigration.value, 'unchanged', 'migration hashes retain the stamp');
  assert.equal(measured.driftAdopted.value, 'current', 'adopt drift still reads the file banner');
});

test('adopt drift retains its unanchored file-banner fingerprint grammar', () => {
  const local = 'Prefix.\nFollow.\n';
  const fileBanner = `<!-- installed from workflow-toolbox vEXAMPLE content sha256:${hash(local).slice(0, 12)} -->`;
  const body = `Prefix.\n${fileBanner}\n\nFollow.\n`;
  const rule = { name: 'sample.md', scope: 'project', rulesDir: 'rules', text: source(body) };
  const id = ruleId(rule);
  assert.equal(runtime.servedText(body), body);
  const measured = measureRules({ rules: [rule], pluginRulesDir: { [id]: local } }).rules[id];
  assert.equal(measured.origin, 'plugin');
  assert.equal(measured.measures.driftAdopted.value, 'current');
});

function hookFixture(body, trigger, messages = []) {
  resetForSelftest();
  const handlers = new Map(), store = new Map(), raw = source(body, trigger);
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  const $ = {
    env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/synthetic-config' : undefined },
    fs: { list: async (dir) => dir === '/synthetic-config/rules-on-demand' ? [{ kind: 'file', name: 'sample.md' }] : [],
      read: async () => raw, stat: async (path) => ({ kind: 'file', size: raw.length, realPath: path }) },
    ui: { log: async () => {} },
    session: { id: async () => 'synthetic-session', messages: async () => messages },
    store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) },
  };
  return { event: (name, args, next) => handlers.get(name)($, { cwd: '/synthetic-project', ...args }, next) };
}

for (const [label, heldBody] of [['legacy stamped', `${stamp()}\n\nFollow.\n`], ['unstamped', 'Follow.\n']]) {
  test(`fresh registration recognizes a ${label} conversation block`, async () => {
    const messages = [{ role: 'assistant', content: `<rule name="sample.md">\n${heldBody}\n</rule>` }];
    const f = hookFixture(`${stamp()}\n\nFollow.\n`, undefined, messages);
    let calls = 0;
    const result = await f.event('tool.call', { tool: 'Agent' }, async () => { calls++; return {}; });
    assert.equal(Boolean(result.deny), false, 'an already-held rule must not be refused after restart');
    assert.equal(calls, 1, 'the matching tool must run exactly once');
  });
}

for (const [label, heldBody] of [['unrelated', 'Unrelated.\n'], ['edited legacy', `${stamp()}\n\nOld directive.\n`]]) {
  test(`fresh registration still refuses with an ${label} conversation block`, async () => {
    const messages = [{ role: 'assistant', content: `<rule name="sample.md">\n${heldBody}\n</rule>` }];
    const f = hookFixture(`${stamp()}\n\nFollow.\n`, undefined, messages);
    let calls = 0;
    const result = await f.event('tool.call', { tool: 'Agent' }, async () => { calls++; return {}; });
    assert.ok(result.deny, 'a conversation without the exact rule body must still refuse');
    assert.equal(calls, 0);
  });
}

const directive = '<!-- Never skip approval. -->\r\n<!-- embedded-copy:shared:start -->\r\nChoose a model.  \r\n<!-- embedded-copy:shared:end -->\r\n';
const block = `<rule name="sample.md">\n${directive}\n</rule>`;
test('real refusal delivers unstamped directives byte-for-byte and retry passes once', async () => {
  const f = hookFixture(stamp() + '\r\n\r\n' + directive);
  let calls = 0;
  const next = async () => { calls++; return {}; };
  const first = await f.event('tool.call', { tool: 'Agent' }, next);
  assert.ok(first.deny?.includes(block), 'deny must carry exactly the directive body without the adopt stamp');
  assert.doesNotMatch(first.deny, /installed from workflow-toolbox/);
  assert.match(first.deny, /retry the same call unchanged or corrected by the rule; this refusal happens once per rule per context/i);
  assert.equal(calls, 0);
  assert.deepEqual(await f.event('tool.call', { tool: 'Agent' }, next), {});
  assert.equal(calls, 1);
});

test('real ride-along delivers unstamped directives byte-for-byte once', async () => {
  const f = hookFixture(stamp() + '\n\n' + directive, "    - kind: tool\n      tool: '^Agent$'\n      unconditional: true");
  const next = async () => ({});
  const first = await f.event('tool.call', { tool: 'Agent' }, next);
  assert.equal(first.context?.[0], block);
  assert.deepEqual(await f.event('tool.call', { tool: 'Agent' }, next), {});
});

test('real prompt delivers unstamped directives byte-for-byte once', async () => {
  const f = hookFixture(stamp() + '\n\n' + directive, "    - kind: prompt\n      regex: 'ready'");
  const contexts = [];
  const next = async (event) => { contexts.push(event.context ?? []); return {}; };
  await f.event('prompt.submit', { text: 'ready' }, next);
  assert.equal(contexts[0][0], block);
  await f.event('prompt.submit', { text: 'ready' }, next);
  assert.deepEqual(contexts[1], []);
});

test('a stamp-shaped comment with a non-installer tail is served whole', async () => {
  const body = '<!-- installed from workflow-toolbox v1.2.3 by the adopt skill: Never bypass approval. -->\n';
  assert.equal(runtime.servedText(body), body);
  assert.equal(content(body), body);
  const reworded = `<!-- installed from workflow-toolbox v1.2.3 head sha256:0123456789ab by the adopt skill — editable copy. Never bypass approval. -->\n\nFollow.\n`;
  assert.equal(runtime.servedText(reworded), reworded);
});
