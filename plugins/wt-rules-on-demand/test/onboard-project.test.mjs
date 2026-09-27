import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cleanEnv } from './clean-env.mjs';
import { register, resetForSelftest } from '../hooks/hooks.js';
import { addFollowed } from '../scripts/followed-projects.mjs';

const script = resolve('scripts/onboard-project.mjs');
const followed = resolve('scripts/followed-projects.mjs');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'onboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const out = join(root, 'out');
  const config = join(root, 'config');
  const transcripts = join(root, 'transcripts');
  await mkdir(join(project, '.claude', 'rules', 'nested'), { recursive: true });
  await mkdir(transcripts);
  await writeFile(join(project, '.claude', 'rules', 'nested', 'alpha.md'), 'Do the thing.\n');
  await writeFile(join(transcripts, 'session.jsonl'), [
    JSON.stringify({ type: 'user', message: { content: 'deploy now' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push origin main' } }] } }),
  ].join('\n'));
  const env = cleanEnv({ HOME: root, CLAUDE_CONFIG_DIR: config });
  const run = (command, extra = []) => spawnSync(process.execPath, [script, command, '--project', project, '--out', out, '--config-dir', config, ...extra], { encoding: 'utf8', env });
  const item = join(out, 'items', 'nested__alpha');
  const proposal = async (triggers = [{ kind: 'prompt', regex: 'deploy' }], decision = 'whole') => {
    await writeFile(join(item, 'decision.json'), JSON.stringify({ decision }));
    await writeFile(join(item, 'spec.json'), JSON.stringify({ 'on-demand': { triggers }, compliance: { kind: 'none', reason: 'manual' } }));
    if (decision === 'split') {
      await writeFile(join(item, 'core.md'), 'Do the thing.\n');
      await writeFile(join(item, 'at-act.md'), 'Act only on deploy.\n');
    }
  };
  return { root, project, out, config, transcripts, env, run, item, proposal };
}
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function snapshot(root) {
  const result = {};
  async function visit(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(dir, entry.name), `${rel}/`);
      else if (entry.isSymbolicLink()) result[rel] = `link:${await readlink(join(dir, entry.name))}`;
      else result[rel] = createHash('sha256').update(await readFile(join(dir, entry.name))).digest('hex');
    }
  }
  await visit(root);
  return result;
}
const expectOk = (result) => assert.equal(result.status, 0, result.stderr || result.stdout);

test('out inside project is refused before any write', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.project);
  const result = f.run('propose', ['--out', join(f.project, 'proposals')]);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(await snapshot(f.project), before);
});

test('out named ..proposals inside project is refused before any write', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.project);
  const result = f.run('propose', ['--out', join(f.project, '..proposals')]);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(await snapshot(f.project), before);
});

test('propose preserves relative paths and marks frontmatter static', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, '.claude', 'rules', 'front.md'), '---\nname: front\n---\n');
  expectOk(f.run('propose'));
  assert.equal((await json(join(f.item, 'item.json'))).rule, 'nested/alpha.md');
  assert.match((await json(join(f.out, 'items', 'front', 'decision.json'))).reason, /frontmatter/);
  await f.proposal();
  expectOk(f.run('propose'));
  assert.equal((await json(join(f.item, 'decision.json'))).decision, 'whole');
});

test('prove identifies zero matches, invalid specs, and missing proposals', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  assert.match((await readFile(join(f.out, 'onboard-report.md'), 'utf8')), /static: no proposal/);
  await f.proposal([{ kind: 'prompt', regex: 'deploy' }, { kind: 'prompt', regex: 'never-match' }]);
  assert.equal(f.run('prove', ['--transcripts', f.transcripts]).status, 1);
  assert.match((await readFile(join(f.out, 'onboard-report.md'), 'utf8')), /static: unproven trigger 1/);
  await f.proposal();
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  assert.match((await readFile(join(f.out, 'onboard-report.md'), 'utf8')), /migrate/);
  await writeFile(join(f.item, 'spec.json'), '{}');
  assert.equal(f.run('prove', ['--transcripts', f.transcripts]).status, 1);
  assert.match((await readFile(join(f.out, 'onboard-report.md'), 'utf8')), /static: invalid spec/);
});

test('prove refuses a spec the migrate parser would refuse (windowed compliance without window)', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  await f.proposal();
  // readSpec accepts these keys; the runtime rule parser that migrate applies requires window and on-close.
  await writeFile(join(f.item, 'spec.json'), JSON.stringify({ 'on-demand': { triggers: [{ kind: 'prompt', regex: 'deploy' }] },
    compliance: { kind: 'model', model: 'haiku', prompt: 'did it follow?' } }));
  assert.equal(f.run('prove', ['--transcripts', f.transcripts]).status, 1);
  assert.match((await readFile(join(f.out, 'onboard-report.md'), 'utf8')), /static: invalid spec: .*window/);
});

test('report table escapes pipes and has five columns', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  await f.proposal([{ kind: 'prompt', regex: 'deploy|ship' }]);
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  const lines = (await readFile(join(f.out, 'onboard-report.md'), 'utf8')).split('\n').filter((line) => line.startsWith('|'));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => (line.match(/(?<!\\)\|/g) ?? []).length === 6));
  assert.match(lines[2], /deploy\\\|ship/);
});

test('report code span round-trips backticks and pipes in trigger', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  const regex = 'deploy|ship`';
  await f.proposal([{ kind: 'prompt', regex }]);
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  const row = (await readFile(join(f.out, 'onboard-report.md'), 'utf8')).split('\n').find((line) => line.startsWith('| nested/alpha.md'));
  assert.equal((row.match(/(?<!\\)\|/g) ?? []).length, 6);
  const span = row.match(/(`{2,}) (.*?) \1/);
  assert.ok(span, 'trigger needs a CommonMark code span with a longer fence');
  assert.equal(span[2].replaceAll('\\|', '|'), regex);
});

test('dry apply does not touch project', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  await f.proposal();
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  const before = await snapshot(f.project);
  expectOk(f.run('apply'));
  assert.deepEqual(await snapshot(f.project), before);
});

test('apply and revert restore every static byte and followed registration', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  await f.proposal([{ kind: 'prompt', regex: 'deploy' }], 'split');
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  const before = await snapshot(join(f.project, '.claude', 'rules'));
  expectOk(f.run('apply', ['--confirm']));
  assert.equal((await json(join(f.config, 'rules-on-demand', 'followed-projects.json'))).length, 1);
  expectOk(f.run('revert'));
  assert.deepEqual(await snapshot(join(f.project, '.claude', 'rules')), before);
  assert.deepEqual((await readdir(join(f.project, '.claude', 'rules-on-demand'))).filter((name) => name.endsWith('.md')), []);
  assert.deepEqual(await json(join(f.config, 'rules-on-demand', 'followed-projects.json')), []);
});

test('followed registry dedupes, preserves date, refuses malformed data, leaves no temp files', async (t) => {
  const f = await fixture(t);
  const run = (action) => spawnSync(process.execPath, [followed, action, '--config-dir', f.config, '--project', f.project], { encoding: 'utf8', env: f.env });
  expectOk(run('remove'));
  expectOk(run('add'));
  const path = join(f.config, 'rules-on-demand', 'followed-projects.json');
  const first = await json(path);
  expectOk(run('add'));
  assert.deepEqual(await json(path), first);
  assert.deepEqual(await readdir(join(f.config, 'rules-on-demand')), ['followed-projects.json']);
  await writeFile(path, 'broken json');
  assert.notEqual(run('add').status, 0);
  assert.equal(await readFile(path, 'utf8'), 'broken json');
  assert.notEqual(run('list').status, 0);
  assert.match(run('list').stderr, /followed-projects\.json/);
});

test('followed registry refuses invalid entries without overwriting', async (t) => {
  const f = await fixture(t);
  const path = join(f.config, 'rules-on-demand', 'followed-projects.json');
  await mkdir(join(f.config, 'rules-on-demand'), { recursive: true });
  await writeFile(path, '[{}]\n');
  await assert.rejects(addFollowed(f.config, f.project), /followed-projects\.json.*index 0/);
  assert.equal(await readFile(path, 'utf8'), '[{}]\n');
});

test('eight parallel followed registrations retain all roots', async (t) => {
  const f = await fixture(t);
  const roots = Array.from({ length: 8 }, (_, index) => join(f.root, `p${index}`));
  await Promise.all(roots.map((root) => mkdir(root)));
  await Promise.all(roots.map((root) => addFollowed(f.config, root)));
  assert.deepEqual(new Set((await json(join(f.config, 'rules-on-demand', 'followed-projects.json'))).map((row) => row.root)), new Set(roots));
});

test('propose and prove never write within project', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.project);
  expectOk(f.run('propose'));
  await f.proposal();
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  assert.deepEqual(await snapshot(f.project), before);
});

test('prove stages symlinked rules without changing any project bytes', async (t) => {
  const f = await fixture(t);
  const rules = join(f.project, '.claude', 'rules');
  const sibling = join(f.project, '.claude', 'stored-rules');
  await rename(rules, sibling);
  await symlink(sibling, rules);
  const before = await snapshot(f.project);
  expectOk(f.run('propose'));
  await f.proposal([{ kind: 'prompt', regex: 'deploy' }], 'split');
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  assert.deepEqual(await snapshot(f.project), before);
  assert.equal((await json(join(f.out, 'onboard-report.json'))).counts.proven, 1);
});

test('failed apply re-proof restores split source and continues without registering', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  await f.proposal([{ kind: 'prompt', regex: 'deploy' }], 'split');
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  const before = await snapshot(join(f.project, '.claude', 'rules'));
  await rm(join(f.transcripts, 'session.jsonl'));
  assert.equal(f.run('apply', ['--confirm']).status, 1);
  assert.deepEqual(await snapshot(join(f.project, '.claude', 'rules')), before);
  assert.match((await readFile(join(f.out, 'onboard-report.md'), 'utf8')), /static: apply failed/);
});

test('apply preserves source bytes when a write truncates then throws', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  await f.proposal([{ kind: 'prompt', regex: 'deploy' }], 'split');
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  const source = join(f.project, '.claude', 'rules', 'nested', 'alpha.md');
  const before = await readFile(source);
  const env = { ...f.env, WT_ROD_ONBOARD_FAIL_WRITE: '1' };
  const result = spawnSync(process.execPath, [script, 'apply', '--project', f.project, '--out', f.out, '--config-dir', f.config, '--confirm'], { encoding: 'utf8', env });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(await readFile(source), before);
});

test('hook public entry ignores registry json during rule loading', async (t) => {
  const f = await fixture(t);
  expectOk(spawnSync(process.execPath, [followed, 'add', '--config-dir', f.config, '--project', f.project], { encoding: 'utf8', env: f.env }));
  resetForSelftest();
  const handlers = new Map();
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  let reads = 0;
  const $ = {
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: f.config, HOME: f.root })[name] },
    fs: {
      list: async (dir) => (await readdir(dir, { withFileTypes: true }).catch(() => [])).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file' })),
      stat: async (path) => ({ kind: 'file', realPath: path, size: (await readFile(path)).length }),
      read: async (path) => { reads++; return readFile(path, 'utf8'); },
    },
    ui: { log: async () => {} },
    store: { get: async () => null, set: async () => {} },
    session: { id: async () => 'registry-test', messages: async () => [] },
  };
  await handlers.get('tool.call')($, { tool: 'Agent', cwd: f.project }, async () => ({}));
  assert.equal(reads, 0);
});

test('revert survives a rule already reverted by an external process', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  await f.proposal([{ kind: 'prompt', regex: 'deploy' }], 'split');
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  const before = await snapshot(join(f.project, '.claude', 'rules'));
  expectOk(f.run('apply', ['--confirm']));
  const applied = await json(join(f.out, 'applied.json'));
  const entry = applied[0];
  const rulesEngine = resolve('scripts/rules.mjs');
  const rollback = spawnSync(process.execPath, [rulesEngine, 'revert', entry.subject, '--project', f.project], { encoding: 'utf8', env: f.env });
  assert.equal(rollback.status, 0, rollback.stderr);
  const result = f.run('revert');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already reverted: nested\/alpha\.md/);
  assert.deepEqual(await snapshot(join(f.project, '.claude', 'rules')), before);
  assert.deepEqual(await json(join(f.out, 'applied.json')), []);
  assert.deepEqual(await json(join(f.config, 'rules-on-demand', 'followed-projects.json')), []);
});

test('revert survives a WHOLE rule already reverted by an external process', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  await f.proposal([{ kind: 'prompt', regex: 'deploy' }], 'whole');
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  const before = await snapshot(join(f.project, '.claude', 'rules'));
  expectOk(f.run('apply', ['--confirm']));
  const applied = await json(join(f.out, 'applied.json'));
  const entry = applied[0];
  const rulesEngine = resolve('scripts/rules.mjs');
  const rollback = spawnSync(process.execPath, [rulesEngine, 'revert', entry.subject, '--project', f.project], { encoding: 'utf8', env: f.env });
  assert.equal(rollback.status, 0, rollback.stderr);
  const result = f.run('revert');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already reverted: nested\/alpha\.md/);
  assert.deepEqual(await snapshot(join(f.project, '.claude', 'rules')), before);
  assert.deepEqual(await json(join(f.out, 'applied.json')), []);
  assert.deepEqual(await json(join(f.config, 'rules-on-demand', 'followed-projects.json')), []);
});

test('revert reports a genuinely broken entry as failed when both copies are gone', async (t) => {
  const f = await fixture(t);
  expectOk(f.run('propose'));
  await f.proposal([{ kind: 'prompt', regex: 'deploy' }], 'split');
  expectOk(f.run('prove', ['--transcripts', f.transcripts]));
  expectOk(f.run('apply', ['--confirm']));
  const applied = await json(join(f.out, 'applied.json'));
  const entry = applied[0];
  const rulesEngine = resolve('scripts/rules.mjs');
  const rollback = spawnSync(process.execPath, [rulesEngine, 'revert', entry.subject, '--project', f.project], { encoding: 'utf8', env: f.env });
  assert.equal(rollback.status, 0, rollback.stderr);
  // Simulate total destruction: the restored static copy is also gone (both absent).
  await rm(join(f.project, '.claude', 'rules', entry.subject), { force: true });
  const result = f.run('revert');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot confirm the rule's state/);
  assert.deepEqual(await json(join(f.out, 'applied.json')), applied);
});

function parseEvents(text) {
  return text.trim().split('\n').filter(Boolean).map((line) => {
    const [subject, kind, time] = line.split(' ');
    return { subject, kind, time: Number(time) };
  });
}
function overlaps(events) {
  const spans = [];
  const open = new Map();
  for (const event of events) {
    if (event.kind === 'start') open.set(event.subject, event.time);
    else { spans.push([open.get(event.subject), event.time]); open.delete(event.subject); }
  }
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
    const [aStart, aEnd] = spans[i];
    const [bStart, bEnd] = spans[j];
    if (aStart < bEnd && bStart < aEnd) return true;
  }
  return false;
}

test('--concurrency actually pools prove() children, not sequential', async (t) => {
  const f = await fixture(t);
  for (let i = 1; i <= 4; i++) {
    await writeFile(join(f.project, '.claude', 'rules', `r${i}.md`), `Rule ${i}.\n`);
  }
  expectOk(f.run('propose'));
  for (let i = 1; i <= 4; i++) {
    const dir = join(f.out, 'items', `r${i}`);
    await writeFile(join(dir, 'decision.json'), JSON.stringify({ decision: 'whole' }));
    await writeFile(join(dir, 'spec.json'), JSON.stringify({ 'on-demand': { triggers: [{ kind: 'prompt', regex: 'x' }] }, compliance: { kind: 'none', reason: 'manual' } }));
  }
  // A test-only stand-in for rules.mjs, written to the fixture's own tmpdir (never a repo file,
  // so it is never picked up by node's own test-file discovery). Handles `prove-triggers` only:
  // it records its own start/end (subject-tagged) into WT_ROD_TEST_TIMING_FILE and sleeps 300 ms,
  // so this test can prove real overlap (or its absence) across the --concurrency pool.
  const fakeEngine = join(f.root, 'fake-engine.mjs');
  await writeFile(fakeEngine, [
    "import { appendFile, mkdir, writeFile } from 'node:fs/promises';",
    "import { dirname } from 'node:path';",
    'const [command, subject, ...rest] = process.argv.slice(2);',
    'const options = {};',
    'for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) options[rest[i].slice(2)] = rest[++i];',
    'const timingFile = process.env.WT_ROD_TEST_TIMING_FILE;',
    'if (command !== "prove-triggers") { console.error(`unsupported: ${command}`); process.exitCode = 1; }',
    'else (async () => {',
    '  if (timingFile) await appendFile(timingFile, `${subject} start ${Date.now()}\\n`);',
    '  await new Promise((r) => setTimeout(r, 300));',
    '  if (timingFile) await appendFile(timingFile, `${subject} end ${Date.now()}\\n`);',
    '  if (options.output) { await mkdir(dirname(options.output), { recursive: true }); await writeFile(options.output, JSON.stringify({ inspected: 1, byTrigger: [{ trigger: { kind: "prompt", regex: "x" }, matches: 1 }] })); }',
    '})();',
  ].join('\n'));
  const timingFile = join(f.root, 'timing.log');
  const runProve = (concurrency) => {
    const env = { ...f.env, WT_ROD_ONBOARD_ENGINE: fakeEngine, WT_ROD_TEST_TIMING_FILE: timingFile };
    return spawnSync(process.execPath, [script, 'prove', '--project', f.project, '--out', f.out, '--config-dir', f.config, '--transcripts', f.transcripts, '--concurrency', String(concurrency)], { encoding: 'utf8', env });
  };

  await writeFile(timingFile, '');
  expectOk(runProve(2));
  const withPool = parseEvents(await readFile(timingFile, 'utf8'));
  assert.equal(withPool.length, 8, 'expected a start+end pair per rule');
  assert.ok(overlaps(withPool), '--concurrency 2 must overlap at least one pair of runs');

  await writeFile(timingFile, '');
  expectOk(runProve(1));
  const sequential = parseEvents(await readFile(timingFile, 'utf8'));
  assert.equal(sequential.length, 8);
  assert.ok(!overlaps(sequential), '--concurrency 1 must never overlap two runs');
});
