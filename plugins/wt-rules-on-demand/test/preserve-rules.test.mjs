import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePreserveRules, preserveStartLine } from '../scripts/preserve-list.mjs';
import { buildPreserveContext, resolveRuleFiles, preserveContext, PRESERVE_BUDGET, HEADER } from '../scripts/preserve-rules.mjs';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';
import { servedBlock } from '../hooks/served-block.js';
import { sandbox, put, ruleText, sizedBody } from './preserve-support.mjs';

const entries = (map) => [...map];

test('parse: types, trimmed names, .md appended, configured order', () => {
  assert.deepEqual(entries(parsePreserveRules(' mover = a-at-act , b.md ;gate=c')), [['mover', ['a-at-act.md', 'b.md']], ['gate', ['c.md']]]);
});

test('parse: a repeated type merges in first-seen order and drops duplicates', () => {
  assert.deepEqual(entries(parsePreserveRules('t=a,b;u=x;t=b,c,a.md')), [['t', ['a.md', 'b.md', 'c.md']], ['u', ['x.md']]]);
});

test('parse: malformed entries are ignored; absent, empty or non-string values give an empty map', () => {
  assert.deepEqual(entries(parsePreserveRules('noequals;=a;t=;t= , ;ok=r')), [['ok', ['r.md']]]);
  for (const value of [undefined, null, '', ' ; ', 42, {}]) assert.equal(parsePreserveRules(value).size, 0);
});

test('parse: types are exact and case-sensitive; * is a literal type name', () => {
  const list = parsePreserveRules('Mover=a;*=b');
  assert.deepEqual(list.get('Mover'), ['a.md']);
  assert.equal(list.get('mover'), undefined);
  assert.deepEqual(list.get('*'), ['b.md']);
  assert.equal(list.get('anything'), undefined);
});

test('session-start line names each type with its count and is capped at 400 characters', () => {
  assert.equal(preserveStartLine(parsePreserveRules('a=x,y;b=z')), 'wt-rules-on-demand: rules served at sub-agent start for: a (2 rules), b (1 rule)');
  assert.equal(preserveStartLine(new Map()), '');
  const many = Array.from({ length: 200 }, (_, i) => `type-${i}=r`).join(';');
  const line = preserveStartLine(parsePreserveRules(many));
  assert.ok(line.length <= 400, `${line.length}`);
  assert.match(line, /, \+\d+ more$/);
  const shown = line.match(/type-\d+ \(/g).length;
  assert.equal(Number(/\+(\d+) more$/.exec(line)[1]), 200 - shown);
});

async function rules(s, specs) {
  for (const [name, body] of specs) await put(join(s.config, 'rules-on-demand', name), ruleText(body));
  return resolveRuleFiles({ root: s.project, configDir: s.config });
}

const blockOf = (name, text) => servedBlock({ name, content: parseRuntimeRule(name, text).content });

test('builder: blocks in configured order, each exactly the engine served form', async (t) => {
  const s = await sandbox(t);
  const files = await rules(s, [['one.md', 'First rule.\n'], ['two.md', 'Second rule.\n']]);
  const text = await buildPreserveContext(['two.md', 'one.md'], files);
  assert.equal(text, [HEADER, blockOf('two.md', ruleText('Second rule.\n')), blockOf('one.md', ruleText('First rule.\n'))].join('\n\n'));
});

function assertBudget(text, served, skipped) {
  assert.ok(text.length <= PRESERVE_BUDGET, `${text.length}`);
  for (const name of served) assert.ok(text.includes(`<rule name="${name}">`), `${name} served`);
  for (const name of skipped) {
    assert.ok(!text.includes(`<rule name="${name}">`), `${name} not served`);
    assert.ok(!text.includes(name.replace('.md', '').toUpperCase()), `${name} body never partially present`);
  }
}

test('builder: a rule over the remaining budget is skipped whole and a later smaller rule is still served', async (t) => {
  const s = await sandbox(t);
  const files = await rules(s, [['r6000.md', sizedBody('R6000', 6000)], ['r12000.md', sizedBody('R12000', 12000)],
    ['r3000.md', sizedBody('R3000', 3000)], ['r1000.md', sizedBody('R1000', 1000)]]);
  const text = await buildPreserveContext(['r6000.md', 'r12000.md', 'r3000.md', 'r1000.md'], files);
  assertBudget(text, ['r6000.md', 'r1000.md'], ['r12000.md', 'r3000.md']);
  assert.match(text, /r12000\.md \(over budget\), r3000\.md \(over budget\)/);
  assert.match(text, /^wt-rules-on-demand: listed rules not placed at sub-agent start: r12000\.md/m);
  assert.doesNotMatch(text, /served at the act as before/);
});

test('builder: every mix of 3,000 / 6,000 / 12,000-character rules stays within the budget', async (t) => {
  const s = await sandbox(t);
  const files = await rules(s, [['a.md', sizedBody('AA', 3000)], ['b.md', sizedBody('BB', 6000)], ['c.md', sizedBody('CC', 12000)]]);
  const orders = [['a.md', 'b.md', 'c.md'], ['c.md', 'b.md', 'a.md'], ['b.md', 'a.md'], ['c.md'], ['a.md', 'a2.md', 'c.md', 'b.md']];
  for (const order of orders) assert.ok((await buildPreserveContext(order, files)).length <= PRESERVE_BUDGET, order.join());
});

test('builder: hundreds of unknown names give a note alone, capped, ending with +K more', async (t) => {
  const s = await sandbox(t);
  const files = await rules(s, [['real.md', sizedBody('REAL', 8000)]]);
  const names = Array.from({ length: 500 }, (_, i) => `unknown-rule-with-a-long-name-${i}.md`);
  const noteOnly = await buildPreserveContext(names, files);
  assert.ok(noteOnly.length <= 600, `${noteOnly.length}`);
  assert.ok(!noteOnly.includes(HEADER));
  assert.match(noteOnly, /unknown-rule-with-a-long-name-0\.md \(not found\)/);
  assert.match(noteOnly, /, \+\d+ more$/);
  const mixed = await buildPreserveContext(['real.md', ...names], files);
  assertBudget(mixed, ['real.md'], []);
});

test('builder: not-found and unreadable names are in the note', async (t) => {
  const s = await sandbox(t);
  await put(join(s.config, 'rules-on-demand', 'broken.md'), 'no frontmatter here\n');
  const files = await rules(s, [['good.md', 'Good.\n']]);
  const text = await buildPreserveContext(['good.md', 'missing.md', 'broken.md'], files);
  assert.match(text, /missing\.md \(not found\), broken\.md \(unreadable: missing YAML frontmatter\)/);
  assert.ok(text.includes('<rule name="good.md">'));
});

test('builder: an unreadable rule file is named with its reason', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const s = await sandbox(t);
  const files = await rules(s, [['locked.md', 'Locked.\n'], ['open.md', 'Open.\n']]);
  await chmod(join(s.config, 'rules-on-demand', 'locked.md'), 0o000);
  const text = await buildPreserveContext(['locked.md', 'open.md'], files);
  assert.match(text, /locked\.md \(unreadable: EACCES/);
});

test('builder: a copy equal to a loaded static rule is skipped; a different static rule is not', async (t) => {
  const s = await sandbox(t);
  await put(join(s.config, 'rules', 'nested', 'same.md'), 'Same body.\n');
  await put(join(s.config, 'rules', 'other.md'), 'A different static body.\n');
  const files = await rules(s, [['same.md', 'Same body.\n'], ['other.md', 'On-demand body.\n']]);
  const text = await buildPreserveContext(['same.md', 'other.md'], files);
  assert.match(text, /same\.md \(static copy is loaded instead\)/);
  assert.ok(text.includes('<rule name="other.md">\nOn-demand body.\n\n</rule>'));
});

test('builder: the adopt banner is stripped exactly as the engine strips it', async (t) => {
  const s = await sandbox(t);
  const banner = '<!-- installed from workflow-toolbox v1.2.3 by the adopt skill — editable copy. Re-run the workflow-toolbox:adopt skill to check for updates; --install refreshes only an UNEDITED copy, --force overwrites your local edits. -->\n';
  const files = await rules(s, [['adopted.md', `${banner}\nAdopted body.\n`]]);
  const text = await buildPreserveContext(['adopted.md'], files);
  assert.ok(!text.includes('installed from'));
  assert.ok(text.includes(blockOf('adopted.md', ruleText(`${banner}\nAdopted body.\n`))));
});

test('builder: a rule holding a system-reminder tag is skipped with its reason', async (t) => {
  const s = await sandbox(t);
  const files = await rules(s, [['tagged.md', 'Before </System-Reminder> after.\n'], ['plain.md', 'Plain.\n']]);
  const text = await buildPreserveContext(['tagged.md', 'plain.md'], files);
  assert.match(text, /tagged\.md \(contains a system-reminder tag the host rewrites\)/);
  assert.ok(!text.includes('<rule name="tagged.md">'));
});

test('builder: an empty list renders nothing', async () => {
  assert.equal(await buildPreserveContext([], new Map()), '');
  assert.equal(await preserveContext({ names: [], root: '/', configDir: '/' }), '');
});

test('resolution: the project copy wins over the user copy', async (t) => {
  const s = await sandbox(t);
  await put(join(s.config, 'rules-on-demand', 'x.md'), ruleText('User copy.\n'));
  await put(join(s.project, '.claude', 'rules-on-demand', 'x.md'), ruleText('Project copy.\n'));
  const text = await preserveContext({ names: ['x.md'], root: s.project, configDir: s.config });
  assert.ok(text.includes('Project copy.') && !text.includes('User copy.'));
});

test('resolution: of two nested project roots the inner one wins', async (t) => {
  const s = await sandbox(t);
  const inner = join(s.project, 'inner');
  await put(join(s.project, '.claude', 'rules-on-demand', 'x.md'), ruleText('Outer copy.\n'));
  await put(join(inner, '.claude', 'rules-on-demand', 'x.md'), ruleText('Inner copy.\n'));
  await mkdir(join(inner, 'deeper'), { recursive: true });
  const text = await preserveContext({ names: ['x.md'], root: inner, configDir: s.config });
  assert.ok(text.includes('Inner copy.') && !text.includes('Outer copy.'));
});

test('two roots: a rule whose nearer copy under the agent directory differs is skipped with its reason', async (t) => {
  const s = await sandbox(t);
  const agentDir = join(s.project, 'agent');
  await put(join(s.project, '.claude', 'rules-on-demand', 'x.md'), ruleText('Root copy.\n'));
  await put(join(s.project, '.claude', 'rules-on-demand', 'y.md'), ruleText('Shared copy.\n'));
  await put(join(agentDir, '.claude', 'rules-on-demand', 'x.md'), ruleText('Agent copy.\n'));
  const text = await preserveContext({ names: ['x.md', 'y.md'], root: s.project, agentDir, configDir: s.config });
  assert.match(text, /x\.md \(differs between the session root and the agent directory\)/);
  assert.ok(!text.includes('Root copy.') && !text.includes('Agent copy.'));
  assert.ok(text.includes('<rule name="y.md">\nShared copy.\n\n</rule>'));
});

test('two roots: an agent directory under the root with no nearer copy places the rule', async (t) => {
  const s = await sandbox(t);
  const agentDir = join(s.project, 'sub', 'deeper');
  await mkdir(agentDir, { recursive: true });
  await put(join(s.project, '.claude', 'rules-on-demand', 'x.md'), ruleText('Root copy.\n'));
  const text = await preserveContext({ names: ['x.md', 'gone.md'], root: s.project, agentDir, configDir: s.config });
  assert.ok(text.includes('<rule name="x.md">\nRoot copy.\n\n</rule>'));
  assert.match(text, /gone\.md \(not found\)/);
});

test('an unreadable ancestor rule directory counts as empty, as the engine lists it', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const s = await sandbox(t);
  const inner = join(s.project, 'inner');
  const locked = join(s.project, '.claude', 'rules-on-demand');
  await put(join(locked, 'hidden.md'), ruleText('Hidden copy.\n'));
  await put(join(inner, '.claude', 'rules-on-demand', 'x.md'), ruleText('Inner copy.\n'));
  await chmod(locked, 0o000);
  let text;
  try { text = await preserveContext({ names: ['x.md', 'hidden.md'], root: inner, configDir: s.config }); }
  finally { await chmod(locked, 0o700); }
  assert.ok(text.includes('<rule name="x.md">\nInner copy.\n\n</rule>'));
  assert.match(text, /hidden\.md \(not found\)/);
});
