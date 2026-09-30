import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { judgeCases } from '../scripts/judge-cases.mjs';

const script = fileURLToPath(new URL('../scripts/judge-cases.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'judge-portability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rules = join(root, 'rules'), transcript = join(root, 'session.jsonl'), casesFile = join(root, 'cases.jsonl');
  await mkdir(rules);
  await writeFile(join(rules, 'r.md'), '---\non-demand:\n  triggers:\n    - kind: tool\n      tool: ^Agent$\n      unconditional: true\n---\nDo it.');
  await writeFile(transcript, [
    { type: 'attachment', attachment: { type: 'hook_additional_context', toolUseID: 'a-context', content: '<rule name="r.md">Do it.</rule>' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'a', input: {} }] } }
  ].map(JSON.stringify).join('\n') + '\n');
  await writeFile(casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', governedActs: 0 }) + '\n');
  const extract = (out) => spawnSync(process.execPath, [script, 'extract', '--transcript', transcript, '--rules-dir', rules, '--config-dir', root, '--out', out], { encoding: 'utf8' });
  return { root, transcript, casesFile, extract };
}

async function refusesBeforeCreation(f, out, safe, writer) {
  if (writer === 'judge')
    await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out, rollbackConfigDir: f.root }), /rollback input/i, out);
  else {
    const extracted = f.extract(out);
    assert.equal(extracted.status, 1, `${out}: ${extracted.stderr}`);
    assert.match(extracted.stderr, /rollback input/i, out);
  }
  assert.deepEqual(await readdir(safe), [], `${writer} created output at ${out}`);
}

for (const writer of ['judge', 'extract']) for (const [label, segments] of [
  ['another config store', ['other', 'plugins', 'store']],
  ['another config archive', ['other', 'plugins', 'data', 'wt-rules-on-demand', 'quality']],
  ['rollback input filename', ['other', 'wt-rules-on-demand_existing.json']]
]) {
  test(`${writer}: a symlinked ${label} cannot hide a protected output namespace`, async (t) => {
    const f = await fixture(t);
    const safe = join(f.root, 'safe'), protectedPath = join(f.root, ...segments);
    await mkdir(safe);
    await mkdir(join(protectedPath, '..'), { recursive: true });
    await symlink(safe, protectedPath, 'dir');
    await refusesBeforeCreation(f, join(protectedPath, 'new', 'out'), safe, writer);
  });
}

for (const writer of ['judge', 'extract']) test(`${writer}: a protected namespace on an intermediate symlink hop is refused`, async (t) => {
  const f = await fixture(t);
  const safe = join(f.root, 'safe'), store = join(f.root, 'other', 'plugins', 'store');
  await mkdir(safe);
  await mkdir(join(f.root, 'other', 'plugins'), { recursive: true });
  await symlink(safe, store, 'dir');
  const hop = join(f.root, 'hop');
  await symlink(store, hop, 'dir');
  await refusesBeforeCreation(f, join(hop, 'new', 'out'), safe, writer);
});

for (const writer of ['judge', 'extract']) test(`${writer}: a protected link target is checked before its parent segment is normalized`, async (t) => {
  const f = await fixture(t);
  const safe = join(f.root, 'safe'), store = join(f.root, 'other', 'plugins', 'store');
  await mkdir(safe);
  await mkdir(join(f.root, 'other', 'plugins'), { recursive: true });
  await symlink(safe, store, 'dir');
  const hop = join(f.root, 'hop');
  await symlink(`${store}/../safe`, hop, 'dir');
  await refusesBeforeCreation(f, join(hop, 'new', 'out'), safe, writer);
});

for (const writer of ['judge', 'extract']) for (const [label, segments] of [
  ['store', ['plugins', 'store']],
  ['archive', ['plugins', 'data', 'wt-rules-on-demand', 'quality']]
]) {
  test(`${writer}: selected config ${label} symlink and independent physical alias are compared canonically`, async (t) => {
    const f = await fixture(t);
    const safe = join(f.root, 'safe'), protectedPath = join(f.root, ...segments);
    await mkdir(safe);
    await mkdir(join(protectedPath, '..'), { recursive: true });
    await symlink(safe, protectedPath, 'dir');
    const alias = join(f.root, 'alias');
    await symlink(safe, alias, 'dir');
    await refusesBeforeCreation(f, join(alias, 'new'), safe, writer);
  });
}

test('judge and extract write through a symlinked ancestor into its physical directory', async (t) => {
  const f = await fixture(t);
  const real = join(f.root, 'real'), link = join(f.root, 'link');
  await mkdir(real); await symlink(real, link, 'dir');
  const out = join(link, 'new', 'out'), physical = join(real, 'new', 'out');
  const judged = await judgeCases({ casesFile: f.casesFile, out, rollbackConfigDir: f.root });
  assert.equal(await readFile(judged.path, 'utf8').then((text) => JSON.parse(text).caseId), 'a');
  assert.equal((await readdir(physical)).length, 1);
  const extracted = f.extract(out);
  assert.equal(extracted.status, 0, extracted.stderr);
  const runs = await readdir(physical);
  assert.equal(runs.length, 2);
  assert.ok(runs.some((run) => run !== judged.path.split(/[\\/]/).at(-2) && run.startsWith('run-')));
});

test('relative ancestor links are usable and loops fail before creation', async (t) => {
  const f = await fixture(t);
  const safe = join(f.root, 'safe'), links = join(f.root, 'links');
  await mkdir(safe); await mkdir(links);
  const relativeLink = join(links, 'relative');
  await symlink('../safe', relativeLink, 'dir');
  const out = join(relativeLink, 'out');
  const judged = await judgeCases({ casesFile: f.casesFile, out, rollbackConfigDir: f.root });
  assert.ok(judged.path.startsWith(join(safe, 'out')), judged.path);
  assert.equal(f.extract(out).status, 0);
  const loop = join(f.root, 'loop');
  await symlink(loop, loop, 'dir');
  await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out: join(loop, 'out'), rollbackConfigDir: f.root }), /loop/i);
  const extracted = f.extract(join(loop, 'out'));
  assert.equal(extracted.status, 1, extracted.stderr);
  assert.match(extracted.stderr, /loop/i);
});

test('a symlinked ancestor into rollback input is refused before creating anything', async (t) => {
  const f = await fixture(t);
  const store = join(f.root, 'plugins', 'store'), link = join(f.root, 'link');
  await mkdir(store, { recursive: true });
  const input = join(store, 'wt-rules-on-demand_existing.json'), bytes = '{"sessions":{}}\n';
  await writeFile(input, bytes); await symlink(store, link, 'dir');
  const out = join(link, 'new', 'out');
  await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out, rollbackConfigDir: f.root }), /rollback input/i);
  const extracted = f.extract(out);
  assert.equal(extracted.status, 1, extracted.stderr);
  assert.match(extracted.stderr, /rollback input/i);
  await assert.rejects(() => stat(join(store, 'new')), { code: 'ENOENT' });
  assert.equal(await readFile(input, 'utf8'), bytes);
});

test('the output directory itself cannot be a symlink even to a benign directory', async (t) => {
  const f = await fixture(t);
  const real = join(f.root, 'real'), link = join(f.root, 'link');
  await mkdir(real); await symlink(real, link, 'dir');
  await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out: link, rollbackConfigDir: f.root }), /symlink/i);
  const extracted = f.extract(link);
  assert.equal(extracted.status, 1, extracted.stderr);
  assert.match(extracted.stderr, /symlink/i);
  assert.deepEqual(await readdir(real), []);
});

test('no test source constructs a disk path from a URL pathname', async () => {
  const scan = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) assert.doesNotMatch(await readFile(path, 'utf8'), /\.\s*pathname\b/, path);
    }
  };
  await scan(fileURLToPath(new URL('.', import.meta.url)));
});

test('a rollback namespace reached through a symlinked config dir is compared physically on both sides', async (t) => {
  const f = await fixture(t);
  const realConfig = join(f.root, 'real-config'), linkConfig = join(f.root, 'link-config');
  const store = join(realConfig, 'plugins', 'store');
  const archive = join(realConfig, 'plugins', 'data', 'wt-rules-on-demand', 'quality');
  await mkdir(store, { recursive: true }); await mkdir(archive, { recursive: true });
  await symlink(realConfig, linkConfig, 'dir');
  const input = join(store, 'wt-rules-on-demand_existing.json'), bytes = '{"sessions":{}}\n';
  await writeFile(input, bytes);
  const storeAlias = join(f.root, 'store-alias'), archiveAlias = join(f.root, 'archive-alias');
  await symlink(store, storeAlias, 'dir'); await symlink(archive, archiveAlias, 'dir');
  for (const [out, created] of [[join(storeAlias, 'new', 'out'), join(store, 'new')], [join(archiveAlias, 'new', 'out'), join(archive, 'new')],
    [join(linkConfig, 'plugins', 'store', 'new', 'out'), join(store, 'new')]]) {
    await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out, rollbackConfigDir: linkConfig }), /rollback input/i, out);
    const extracted = spawnSync(process.execPath, [script, 'extract', '--transcript', f.transcript, '--rules-dir', join(f.root, 'rules'), '--config-dir', linkConfig, '--out', out], { encoding: 'utf8' });
    assert.equal(extracted.status, 1, `${out}: ${extracted.stderr}`);
    assert.match(extracted.stderr, /rollback input/i, out);
    await assert.rejects(() => stat(created), { code: 'ENOENT' }, out);
  }
  assert.equal(await readFile(input, 'utf8'), bytes);
  const legitimate = join(linkConfig, 'judge-output');
  const judged = await judgeCases({ casesFile: f.casesFile, out: legitimate, rollbackConfigDir: linkConfig });
  assert.ok(judged.path.startsWith(join(realConfig, 'judge-output')), judged.path);
});
