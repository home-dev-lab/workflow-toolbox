#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory } from '../paths.js';
import { frontmatter, readSpec } from './rule-lifecycle-lib.mjs';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';
import { addFollowed, removeFollowed } from './followed-projects.mjs';

const defaultEngine = fileURLToPath(new URL('./rules.mjs', import.meta.url));
// `WT_ROD_ONBOARD_ENGINE` is a test-only seam: production never sets it, and `cleanEnv` in the
// test harness strips inherited `WT_ROD_*` vars before a fixture opts back in deliberately.
const enginePath = () => process.env.WT_ROD_ONBOARD_ENGINE || defaultEngine;
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, data) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(data, null, 2)}\n`); };
const exists = async (path) => readFile(path).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
const within = (root, path) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const hash = (body) => createHash('sha256').update(body).digest('hex');
const itemDir = (out, rule) => join(out, 'items', rule.slice(0, -3).replaceAll('/', '__'));
const staticPath = (project, rule) => join(project, '.claude', 'rules', rule);
const subjectOf = (row) => row.decision === 'split' ? row.rule.replace(/\.md$/, '-at-act.md') : row.rule;
const child = (...args) => spawnSync(process.execPath, [enginePath(), ...args], { encoding: 'utf8' });
// Async counterpart used by prove()'s concurrency pool. Same argv shape and same {status,
// stdout, stderr} return shape as `child`, so `proofFor` can await either interchangeably.
const childAsync = (...args) => new Promise((settle) => {
  const proc = spawn(process.execPath, [enginePath(), ...args]);
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk; });
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  proc.on('error', (error) => settle({ status: 1, stdout, stderr: error.message }));
  proc.on('close', (status) => settle({ status, stdout, stderr }));
});
async function runPool(items, size, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (cursor < items.length) await task(items[cursor++]);
  });
  await Promise.all(workers);
}

async function files(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const result = [];
  for (const entry of entries) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(join(dir, entry.name), `${name}/`));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}

async function canonicalTarget(path) {
  let parent = resolve(path);
  const parts = [];
  while (true) {
    try { return resolve(await realpath(parent), ...parts.reverse()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = dirname(parent);
    if (next === parent) throw new Error(`cannot resolve ${path}`);
    parts.push(basename(parent));
    parent = next;
  }
}

async function propose(project, out) {
  const rules = await files(join(project, '.claude', 'rules'));
  const selected = [];
  for (const rule of rules.filter((name) => name.endsWith('.md'))) {
    const name = basename(rule);
    if (name.endsWith('-at-act.md') && await exists(join(project, '.claude', 'rules-on-demand', name))) continue;
    const source = staticPath(project, rule);
    const body = await readFile(source);
    const dir = itemDir(out, rule);
    await save(join(dir, 'item.json'), { rule, source, bytes: body.length, sha256: hash(body) });
    if (/^---(?:\r?\n|$)/.test(body.toString('utf8')) && !await exists(join(dir, 'decision.json'))) {
      await save(join(dir, 'decision.json'), { decision: 'static', reason: 'source has frontmatter' });
    }
    selected.push(rule);
  }
  await save(join(out, 'propose-manifest.json'), { project, generatedAt: new Date().toISOString(), rules: selected });
  console.log(`proposed ${selected.length} rules`);
}

async function assessed(out) {
  const manifest = await readJson(join(out, 'propose-manifest.json'));
  const rows = [];
  for (const rule of manifest.rules) {
    const dir = itemDir(out, rule);
    const row = { rule, decision: 'static', reason: 'no proposal', triggers: [], compliance: {}, proof: null };
    if (/^---(?:\r?\n|$)/.test(await readFile(staticPath(manifest.project, rule), 'utf8'))) {
      row.reason = 'source has frontmatter';
      rows.push(row);
      continue;
    }
    let decision;
    try { decision = await readJson(join(dir, 'decision.json')); } catch { rows.push(row); continue; }
    if (!['split', 'whole', 'static'].includes(decision?.decision) || (decision.decision === 'static' && (typeof decision.reason !== 'string' || !decision.reason.trim()))) { rows.push(row); continue; }
    row.decision = decision.decision;
    row.reason = decision.decision === 'static' ? decision.reason : '';
    if (decision.decision !== 'static') {
      try {
        const spec = await readSpec(join(dir, 'spec.json'));
        // readSpec checks key names only; migrate writes this frontmatter and the runtime parser then
        // refuses what readSpec let through (e.g. a windowed compliance kind without window/on-close).
        // Parse it here so prove never reports "migrate" for a rule apply would refuse.
        parseRuntimeRule(basename(rule), `${frontmatter(spec)}body\n`);
        row.triggers = spec.triggers;
        row.compliance = spec.compliance;
        if (decision.decision === 'split') {
          for (const file of ['core.md', 'at-act.md']) {
            const body = await readFile(join(dir, file), 'utf8');
            if (body.startsWith('---\n') || body.startsWith('---\r\n')) throw new Error(`${file} has frontmatter`);
          }
        }
      } catch (error) { row.decision = 'static'; row.reason = `invalid spec: ${error.message}`; }
    }
    rows.push(row);
  }
  return rows;
}

async function proofFor(project, transcripts, row, output, out, spawnFn = child) {
  await rm(output, { force: true });
  const run = await spawnFn('prove-triggers', subjectOf(row), '--project', project, '--spec', join(itemDir(out, row.rule), 'spec.json'), '--transcripts', transcripts, '--output', output);
  try {
    const proof = await readJson(output);
    row.proof = proof;
    const zero = proof.byTrigger.findIndex((entry) => !entry.matches);
    if (zero >= 0) {
      const trigger = row.triggers[zero];
      row.reason = `unproven trigger ${zero} (${trigger.kind}: ${trigger.regex ?? trigger.tool}): 0 matches in ${proof.inspected} items`;
    } else if (run.status !== 0) row.reason = `prove failed: ${(run.stderr || run.stdout).trim().split('\n')[0]}`;
  } catch { row.reason = `prove failed: ${(run.stderr || run.error?.message || 'no proof produced').trim().split('\n')[0]}`; }
  return !row.reason;
}

async function report(project, out, previous = null) {
  const data = previous ?? await readJson(join(out, 'onboard-report.json'));
  data.project = project;
  data.generatedAt = new Date().toISOString();
  data.counts = { proposed: data.rows.length, proven: data.rows.filter((row) => row.decision !== 'static' && !row.reason).length, static: data.rows.filter((row) => row.decision === 'static' || row.reason).length };
  await save(join(out, 'onboard-report.json'), data);
  const cell = (value) => String(value ?? '').replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
  const code = (value) => {
    const text = String(value ?? '').replace(/\r?\n/g, ' ');
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
    const fence = '`'.repeat(longest + 1);
    const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
    return `${fence}${padded.replaceAll('|', '\\|')}${fence}`;
  };
  const lines = [`# Onboard report`, '', `Project: ${project}`, `Transcripts: ${data.transcripts ?? '—'}`, `GeneratedAt: ${data.generatedAt}`, `Counts: proposed ${data.counts.proposed}, proven ${data.counts.proven}, static ${data.counts.static}`, '', '| rule | proof | proposed trigger | check | verdict |', '| --- | --- | --- | --- | --- |'];
  for (const row of data.rows) {
    const proof = row.proof?.byTrigger?.map((entry) => `${entry.trigger.kind} ${entry.matches}`).join(', ') || '—';
    const triggers = row.triggers.map((trigger) => `${cell(trigger.kind)} ${code(trigger.regex ?? trigger.tool)}`).join('; ') || '—';
    const check = [row.compliance.kind, row.compliance.check].filter(Boolean).join(' ') || '—';
    lines.push(`| ${cell(row.rule)} | ${cell(proof)} | ${triggers} | ${cell(check)} | ${cell(row.reason || row.decision === 'static' ? `static: ${row.reason}` : 'migrate')} |`);
  }
  await writeFile(join(out, 'onboard-report.md'), `${lines.join('\n')}\n`);
  return data;
}

async function prove(project, out, transcripts, concurrency = 2) {
  const started = Date.now();
  const rows = await assessed(out);
  const stage = join(out, 'stage');
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, '.claude'), { recursive: true });
  await cp(join(project, '.claude', 'rules'), join(stage, '.claude', 'rules'), { recursive: true, dereference: true });
  const stageRoot = await realpath(stage);
  for (const row of rows) if (row.decision === 'split') {
    const dir = itemDir(out, row.rule);
    for (const [target, body] of [[staticPath(stage, row.rule), 'core.md'], [staticPath(stage, subjectOf(row)), 'at-act.md']]) {
      if (!within(stageRoot, await canonicalTarget(target))) throw new Error(`stage target escapes stage: ${target}`);
      await writeFile(target, await readFile(join(dir, body)));
    }
  }
  // Rows are proven concurrently (up to `concurrency` children at once), but `rows` itself keeps
  // the manifest order throughout — proofFor mutates each row object in place, never reorders it.
  const pending = rows.filter((row) => row.decision !== 'static');
  await runPool(pending, concurrency, (row) => proofFor(stage, transcripts, row, join(itemDir(out, row.rule), 'proof.json'), out, childAsync));
  const data = await report(project, out, { transcripts, transcriptFiles: (await files(transcripts)).filter((name) => name.endsWith('.jsonl')).length, elapsedMs: Date.now() - started, rows });
  console.log(`proven ${data.counts.proven}, static ${data.counts.static} (${data.transcriptFiles} transcripts, ${data.elapsedMs} ms)`);
  if (rows.some((row) => row.reason && row.reason !== 'no proposal' && !row.reason.includes('frontmatter'))) process.exitCode = 1;
}

async function apply(project, out, configDir, confirm, io = { writeFile }) {
  const data = await readJson(join(out, 'onboard-report.json'));
  const candidates = data.rows.filter((row) => row.decision !== 'static' && !row.reason);
  if (!confirm) {
    for (const row of candidates) console.log(`${row.rule}: backup ${join(out, 'backup', row.rule)}; migrate ${subjectOf(row)}${row.decision === 'split' ? `; write ${staticPath(project, row.rule)} and ${staticPath(project, subjectOf(row))}` : ''}`);
    return;
  }
  const appliedPath = join(out, 'applied.json');
  const applied = await readJson(appliedPath).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  let failed = false;
  for (const row of candidates) {
    if (applied.some((entry) => entry.rule === row.rule)) continue;
    const backup = join(out, 'backup', row.rule);
    const source = staticPath(project, row.rule);
    const subject = subjectOf(row);
    const act = staticPath(project, subject);
    let changed = false;
    let migrated = false;
    try {
      const original = await readFile(source);
      const item = await readJson(join(itemDir(out, row.rule), 'item.json'));
      if (hash(original) !== item.sha256) throw new Error('source changed since propose');
      await mkdir(dirname(backup), { recursive: true });
      if (!await exists(backup)) await writeFile(backup, original, { flag: 'wx' });
      if (hash(original) !== hash(await readFile(backup))) throw new Error('source differs from existing backup');
      if (row.decision === 'split') {
        if (await exists(act)) throw new Error(`split subject already exists: ${act}`);
        const dir = itemDir(out, row.rule);
        if (hash(await readFile(join(dir, 'at-act.md'))) !== row.proof?.bodyHash) throw new Error('on-demand half changed since prove');
        changed = true;
        const temp = `${source}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await io.writeFile(temp, await readFile(join(dir, 'core.md')), { flag: 'wx' });
          await rename(temp, source);
        } finally { await rm(temp, { force: true }); }
        await writeFile(act, await readFile(join(dir, 'at-act.md')), { flag: 'wx' });
      }
      if (row.decision === 'whole' && hash(original) !== row.proof?.bodyHash) throw new Error('rule changed since prove');
      const proof = join(itemDir(out, row.rule), 'apply-proof.json');
      if (!await proofFor(project, data.transcripts, row, proof, out)) throw new Error(row.reason);
      const run = child('migrate', subject, '--project', project, '--spec', join(itemDir(out, row.rule), 'spec.json'), '--proof', proof);
      if (run.status !== 0) throw new Error((run.stderr || run.stdout).trim().split('\n')[0]);
      migrated = true;
      applied.push({ rule: row.rule, subject, decision: row.decision, backup });
      await save(appliedPath, applied);
    } catch (error) {
      failed = true;
      row.reason = `apply failed: ${error.message}`;
      if (migrated) child('revert', subject, '--project', project);
      if (changed) { await rm(act, { force: true }); await writeFile(source, await readFile(backup)); }
    }
  }
  if (applied.length) await addFollowed(configDir, project);
  await report(project, out, data);
  console.log(`applied ${applied.length}, failed ${failed ? 'at least one' : 'none'}`);
  if (failed) process.exitCode = 1;
}

async function revert(project, out, configDir) {
  const path = join(out, 'applied.json');
  const applied = await readJson(path).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const remaining = [...applied];
  let failed = false;
  for (const entry of [...applied].reverse()) {
    const demand = join(project, '.claude', 'rules-on-demand', basename(entry.subject));
    if (!await exists(demand)) {
      // A daily auto-rollback (or another process) may already have called `rules.mjs revert`
      // on this subject: the on-demand copy is gone. Finish the restoration ourselves only when
      // the static half it left behind is still there to confirm the rule truly reverted.
      if (await exists(staticPath(project, entry.subject))) {
        if (entry.decision === 'split') await rm(staticPath(project, entry.subject), { force: true });
        await mkdir(dirname(staticPath(project, entry.rule)), { recursive: true });
        await writeFile(staticPath(project, entry.rule), await readFile(entry.backup));
        remaining.splice(remaining.indexOf(entry), 1);
        await save(path, remaining);
        console.log(`already reverted: ${entry.rule}`);
      } else {
        entry.reason = `revert failed: neither ${demand} nor ${staticPath(project, entry.subject)} exists; cannot confirm the rule's state`;
        console.error(entry.reason);
        failed = true;
      }
      continue;
    }
    const run = child('revert', entry.subject, '--project', project);
    if (run.status !== 0) { console.error(run.stderr); failed = true; continue; }
    if (entry.decision === 'split') await rm(staticPath(project, entry.subject), { force: true });
    await mkdir(dirname(staticPath(project, entry.rule)), { recursive: true });
    await writeFile(staticPath(project, entry.rule), await readFile(entry.backup));
    remaining.splice(remaining.indexOf(entry), 1);
    await save(path, remaining);
  }
  if (!remaining.length) await removeFollowed(configDir, project);
  console.log(`reverted ${applied.length - remaining.length}`);
  if (failed) process.exitCode = 1;
}

try {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--confirm') { options.confirm = true; continue; }
    if (!['--project', '--out', '--config-dir', '--transcripts', '--concurrency'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw Object.assign(new Error(`invalid option ${key}`), { usage: true });
    options[key.slice(2)] = args[++i];
  }
  if (!['propose', 'prove', 'apply', 'revert', 'report'].includes(command) || !options.project || !options.out || (command === 'prove' && !options.transcripts) || (options.concurrency && (!Number.isInteger(Number(options.concurrency)) || Number(options.concurrency) < 1))) throw Object.assign(new Error('usage: onboard-project.mjs propose|prove|apply|revert|report --project <dir> --out <dir> [--config-dir <dir>] [--transcripts <dir>] [--confirm]'), { usage: true });
  const project = await realpath(options.project);
  const out = await canonicalTarget(options.out);
  if (within(project, out)) throw Object.assign(new Error('proposals directory must be outside project'), { usage: true });
  const configDir = resolve(options['config-dir'] || configDirectory(process.env));
  if (command === 'propose') await propose(project, out);
  else if (command === 'prove') await prove(project, out, resolve(options.transcripts), options.concurrency ? Number(options.concurrency) : 2);
  else if (command === 'apply') {
    // Test-only I/O fault seam: simulate a write that truncates its destination before rejecting.
    const io = process.env.WT_ROD_ONBOARD_FAIL_WRITE === '1'
      ? { writeFile: async (path) => { await writeFile(path, 'truncated'); throw new Error('injected write failure after truncation'); } }
      : { writeFile };
    await apply(project, out, configDir, options.confirm, io);
  }
  else if (command === 'revert') await revert(project, out, configDir);
  else await report(project, out);
} catch (error) { console.error(`onboard-project: ${error.message}`); process.exitCode = error.usage ? 2 : 1; }
