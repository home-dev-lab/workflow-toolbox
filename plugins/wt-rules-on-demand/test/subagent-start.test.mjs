import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';
import { sandbox, put, ruleText, sizedBody, runHook, startScript } from './preserve-support.mjs';

const LIST = 'mover=probe-rule;gate=missing-rule';

async function listed(t) {
  const s = await sandbox(t);
  await put(join(s.config, 'rules-on-demand', 'probe-rule.md'), ruleText('Probe instruction.\n'));
  return { ...s, env: { CLAUDE_CONFIG_DIR: s.config, WT_ROD_PRESERVE_RULES: LIST } };
}

test('hook: a listed type gets one JSON object holding the served block', async (t) => {
  const s = await listed(t);
  const run = runHook({ agent_id: 'a1', agent_type: 'mover', cwd: s.project }, s.env);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.json.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.ok(run.json.hookSpecificOutput.additionalContext.includes('<rule name="probe-rule.md">\nProbe instruction.\n\n</rule>'));
  assert.equal(run.stderr, '');
});

test('hook: disabled engine, unlisted type, missing type or empty list print nothing', async (t) => {
  const s = await listed(t);
  const cases = [
    [{ agent_type: 'mover', cwd: s.project }, { CLAUDE_PLUGIN_OPTION_ENABLED: 'false' }],
    [{ agent_type: 'mover', cwd: s.project }, { CLAUDE_PLUGIN_OPTION_ENABLED: '' }],
    [{ agent_type: 'reviewer', cwd: s.project }, {}],
    [{ agent_type: 'Mover', cwd: s.project }, {}],
    [{ cwd: s.project }, {}],
    [{ agent_type: 'mover', cwd: s.project }, { WT_ROD_PRESERVE_RULES: '' }],
    ['', {}],
  ];
  for (const [input, env] of cases) {
    const run = runHook(input, { ...s.env, ...env });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '', JSON.stringify(input) + JSON.stringify(env));
    assert.equal(run.stderr, '');
  }
});

test('hook: a listed type whose rules all fail to render gets the note alone', async (t) => {
  const s = await listed(t);
  const run = runHook({ agent_type: 'gate', cwd: s.project }, s.env);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.json.hookSpecificOutput.additionalContext, /^wt-rules-on-demand: listed rules not placed at sub-agent start: missing-rule\.md \(not found\)$/);
});

test('hook: a failure prints nothing on stdout, one stderr line, and exits 0', async (t) => {
  const s = await listed(t);
  const run = runHook('{not json', s.env);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /^wt-rules-on-demand: sub-agent pre-serve failed: [^\n]+\n$/);
});

test('hook: an unlistable config directory degrades to a not-found note, as the engine lists it', async (t) => {
  const s = await listed(t);
  const file = join(s.root, 'config-is-a-file');
  await writeFile(file, 'not a directory');
  const run = runHook({ agent_type: 'mover', cwd: s.project }, { ...s.env, CLAUDE_CONFIG_DIR: file });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.match(run.json.hookSpecificOutput.additionalContext, /probe-rule\.md \(not found\)$/);
});

test('hook: a copy differing between CLAUDE_PROJECT_DIR and the agent cwd is skipped; an agreeing one is placed', async (t) => {
  const s = await listed(t);
  const sub = join(s.project, 'sub');
  const plain = join(s.project, 'plain');
  await mkdir(plain, { recursive: true });
  await put(join(s.project, '.claude', 'rules-on-demand', 'probe-rule.md'), ruleText('Project root copy.\n'));
  await put(join(sub, '.claude', 'rules-on-demand', 'probe-rule.md'), ruleText('Subdirectory copy.\n'));
  const rooted = runHook({ agent_type: 'mover', cwd: sub }, { ...s.env, CLAUDE_PROJECT_DIR: s.project }).json.hookSpecificOutput.additionalContext;
  assert.match(rooted, /probe-rule\.md \(differs between the session root and the agent directory\)/);
  assert.ok(!rooted.includes('Project root copy.') && !rooted.includes('Subdirectory copy.'));
  const agreeing = runHook({ agent_type: 'mover', cwd: plain }, { ...s.env, CLAUDE_PROJECT_DIR: s.project }).json.hookSpecificOutput.additionalContext;
  assert.ok(agreeing.includes('<rule name="probe-rule.md">\nProject root copy.\n\n</rule>'));
  const fallback = runHook({ agent_type: 'mover', cwd: sub }, s.env).json.hookSpecificOutput.additionalContext;
  assert.ok(fallback.includes('Subdirectory copy.'));
});

test('hook: the largest payload is complete JSON within the budget', async (t) => {
  const s = await listed(t);
  await put(join(s.config, 'rules-on-demand', 'big.md'), ruleText(sizedBody('BIG', 8790)));
  const names = Array.from({ length: 40 }, (_, i) => `absent-${i}`).join(',');
  const run = runHook({ agent_type: 'mover', cwd: s.project }, { ...s.env, WT_ROD_PRESERVE_RULES: `mover=big,${names}` });
  assert.equal(run.status, 0, run.stderr);
  const context = run.json.hookSpecificOutput.additionalContext;
  assert.ok(context.length >= 9000 && context.length <= 9500, `${context.length}`);
  assert.ok(context.includes('<rule name="big.md">'));
});

function start(s, env, source = 'startup') {
  return spawnSync(process.execPath, [startScript], {
    encoding: 'utf8', input: JSON.stringify({ source, cwd: s.project }),
    env: cleanEnv({ CLAUDE_CONFIG_DIR: s.config, WT_ROD_QUALITY_SPAWN: '0', CLAUDE_PLUGIN_OPTION_ENABLED: 'true', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', ...env }),
  });
}

test('session start names the pre-served types once, only with the engine enabled and a list', async (t) => {
  const s = await sandbox(t);
  await mkdir(join(s.config, 'rules'), { recursive: true });
  const line = /^wt-rules-on-demand: rules served at sub-agent start for: mover \(2 rules\), gate \(1 rule\)$/m;
  for (const source of ['startup', 'resume']) {
    const run = start(s, { WT_ROD_PRESERVE_RULES: 'mover=a,b;gate=c' }, source);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.match(/rules served at sub-agent start/g)?.length, 1, run.stdout);
    assert.match(run.stdout, line);
  }
  for (const env of [{ CLAUDE_PLUGIN_OPTION_ENABLED: 'false', WT_ROD_PRESERVE_RULES: 'mover=a' }, { WT_ROD_PRESERVE_RULES: '' }, {}]) {
    assert.doesNotMatch(start(s, env).stdout, /rules served at sub-agent start/);
  }
});
