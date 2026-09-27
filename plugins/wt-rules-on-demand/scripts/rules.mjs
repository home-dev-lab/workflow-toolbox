#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { migrateRule, readSpec, revertRule, retireRule, triggersHash } from './rule-lifecycle-lib.mjs';
import { configDirectory, ruleDirectories } from '../paths.js';
import { createHash } from 'node:crypto';
import { argumentEvidence, bounded, safeRegex } from '../hooks/evidence.js';
import { triggerMatches } from '../hooks/trigger-match.js';
import { discoverFiles } from './discover-files.mjs';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';

const [command, subject, ...remaining] = process.argv.slice(2);
const rawOptions = command === 'check-rules' ? [subject, ...remaining].filter((item) => item !== undefined) : remaining;
const options = {};
const booleanOptions = new Set(['all', 'user', 'json']);
for (let index = 0; index < rawOptions.length; index += 1) {
  const key = rawOptions[index];
  if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
  const name = key.slice(2);
  const value = booleanOptions.has(name) ? true : rawOptions[++index] ?? true;
  if (['assume-loaded', 'mirror-dir', 'dir'].includes(name)) options[name] = [...(options[name] ?? []), value];
  else options[name] = value;
}
const project = resolve(String(options.project || process.cwd()));
const scope = options.user ? 'user' : 'project';
const configDir = resolve(String(options['config-dir'] || configDirectory(process.env) || (() => { throw new Error('HOME or USERPROFILE required'); })()));
const lifecycleRoot = scope === 'user' ? configDir : project;
const mirrorDirs = (options['mirror-dir'] ?? []).flatMap((value) => String(value).split(',')).filter(Boolean).map((path) => resolve(path));

function usage() {
  console.error('       rules.mjs check-rules --dir <rules-on-demand dir> [--dir <dir> ...] [--json]');
  console.error('usage: rules.mjs prove-triggers <rule.md> --transcripts <dir> --spec <file> [--project <dir> | --user [--config-dir <dir>]] [--output <file>]');
  console.error('       rules.mjs migrate <rule.md | wt/rule.md> (--project <dir> | --user [--config-dir <dir>] [--mirror-dir <dir>]) --spec <file> (--proof <file> | --no-proof <reason>)');
  console.error('       rules.mjs revert (<rule.md> | --all) (--project <dir> | --user [--config-dir <dir>] [--mirror-dir <dir>])');
  console.error('       rules.mjs retire <rule.md | wt/rule.md> --reason "<text>" (--project <dir> | --user [--config-dir <dir>])');
  process.exit(2);
}

async function checkRules() {
  if (!options.dir?.length) usage();
  const rows = [];
  for (const dir of options.dir) {
    for (const name of (await readdir(resolve(String(dir)))).filter((item) => item.endsWith('.md'))) {
      const file = join(resolve(String(dir)), name);
      try {
        const rule = parseRuntimeRule(name, await readFile(file, 'utf8'));
        rows.push({ file, status: rule.compliance?.kind === 'unregistered' ? 'degraded' : 'ok', ...(rule.compliance?.reason && rule.compliance.kind === 'unregistered' ? { reason: rule.compliance.reason } : {}) });
      } catch (error) { rows.push({ file, status: 'skipped', reason: error.message }); }
    }
  }
  if (options.json) console.log(JSON.stringify(rows, null, 2));
  else for (const row of rows) {
    const reason = row.reason ? `\t${row.reason}` : '';
    console.log(`${row.status}\t${row.file}${reason}`);
  }
  if (rows.some((row) => row.status === 'skipped')) process.exitCode = 1;
}

const textOfPrompt = (row) => {
  if (row?.type !== 'user') return '';
  const content = row.message?.content;
  if (Array.isArray(content)) return content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join(' ');
  return typeof content === 'string' ? content : '';
};

function candidates(row) {
  const found = [];
  const prompt = textOfPrompt(row);
  if (prompt) found.push({ channel: 'prompt', text: prompt });
  for (const block of Array.isArray(row?.message?.content) ? row.message.content : []) {
    if (block?.type !== 'tool_use') continue;
    const input = block.input && typeof block.input === 'object' ? block.input : {};
    // `input` = the JSON of the call's arguments, the subject the engine tests an `input-regex` against.
    found.push({ channel: 'tool', tool: block.name ?? '', text: bounded(input.command), command: bounded(input.command), path: bounded(input.path ?? input.file_path), input: argumentEvidence(input) });
  }
  return found;
}

const matches = (trigger, item) => {
  const compiled = { kind: trigger.kind, regex: safeRegex('spec', trigger.regex ?? '', trigger.flags ?? ''),
    tool: safeRegex('spec', trigger.tool ?? ''), input: trigger['input-regex'] ? safeRegex('spec', trigger['input-regex'], trigger.flags ?? '') : null,
    onMention: String(trigger.mentions) === 'true' };
  return triggerMatches(compiled, item);
};

async function prove() {
  if (!subject || !options.spec || !options.transcripts) usage();
  const spec = await readSpec(resolve(String(options.spec)));
  const byTrigger = spec.triggers.map((trigger) => ({ trigger, matches: 0 }));
  const examples = [];
  let inspected = 0;
  const skippedLinks = [];
  for (const [, file] of await discoverFiles(resolve(String(options.transcripts)), { recursive: true, suffix: '.jsonl', dangling: skippedLinks })) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      for (const item of candidates(row)) {
        inspected += 1;
        for (let index = 0; index < spec.triggers.length; index += 1) {
          if (!matches(spec.triggers[index], item)) continue;
          byTrigger[index].matches += 1;
          if (examples.length < 5) examples.push({ file: basename(file), line: lineNumber, channel: item.channel, tool: item.tool || null, sample: (item.text || item.path || item.input || '').slice(0, 160) });
        }
      }
    }
  }
  const report = {
    rule: basename(subject), scope, scopeRoot: lifecycleRoot, bodyHash: createHash('sha256').update(await readFile(resolve(lifecycleRoot, scope === 'user' ? 'rules' : join('.claude', 'rules'), subject))).digest('hex'), triggersHash: triggersHash(spec.triggers), inspected,
    matches: byTrigger.reduce((sum, row) => sum + row.matches, 0), byTrigger, examples,
    skipped: skippedLinks.length, skippedFiles: skippedLinks.map((path) => basename(path)),
    generatedAt: new Date().toISOString(),
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) { await mkdir(dirname(resolve(String(options.output))), { recursive: true }); await writeFile(resolve(String(options.output)), rendered); }
  process.stdout.write(rendered);
  // A dangling symlink is never silent: it is counted above AND named on stderr, visible even
  // to a caller that only reads the exit code and stdout summary line, not the full JSON.
  for (const path of skippedLinks) console.error(`rules: skipped dangling symlink ${path}`);
  if (!report.matches) process.exitCode = 1;
}

async function migrate() {
  if (!subject || (!options.project && !options.user) || !options.spec) usage();
  const spec = await readSpec(resolve(String(options.spec)));
  const hash = triggersHash(spec.triggers);
  const bodyHash = createHash('sha256').update(await readFile(resolve(lifecycleRoot, scope === 'user' ? 'rules' : join('.claude', 'rules'), subject))).digest('hex');
  if (scope === 'user') await assertProfiles();
  let proof;
  if (options.proof) {
    proof = JSON.parse(await readFile(resolve(String(options.proof)), 'utf8'));
    if (proof.rule !== basename(subject) || proof.triggersHash !== hash || proof.bodyHash !== bodyHash || proof.scopeRoot !== lifecycleRoot) throw new Error('proof does not match this rule body, scope root and trigger spec');
    const zero = spec.triggers.map((trigger, i) => proof.byTrigger?.[i]?.matches ? null : `${i} (${trigger.kind}: ${trigger.tool ?? trigger.regex})`).filter((item) => item !== null);
    if (zero.length) throw new Error(`proof has zero matches for triggers: ${zero.join(', ')}`);
    proof = { proof: { matches: proof.matches, transcriptsInspected: proof.inspected, generatedAt: proof.generatedAt } };
  } else if (typeof options['no-proof'] === 'string' && options['no-proof'].trim()) {
    proof = { noProofReason: options['no-proof'].trim(), unproven: true };
  } else {
    throw new Error('proof is required; pass --proof <report.json> or --no-proof "<reason>"');
  }
  const result = await migrateRule(lifecycleRoot, subject, spec, { ...proof, assumedLoaded: (options['assume-loaded'] ?? []).map((dir) => resolve(String(dir))) }, { scope, mirrorDirs });
  console.log(`migrated ${result.name} to ${result.destination}`);
}

async function assertProfiles() {
  const assumed = (options['assume-loaded'] ?? []).flatMap((value) => String(value).split(',')).filter(Boolean).map((dir) => resolve(dir));
  for (const dir of [configDir, ...mirrorDirs]) {
    if (assumed.includes(dir)) continue;
    let settings;
    try { settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')); }
    catch { throw new Error(`profile ${dir}: settings.json missing or invalid; use --assume-loaded ${dir} only with explicit verification`); }
    if (!Object.entries(settings.enabledPlugins ?? {}).some(([name, active]) => name.startsWith('wt-rules-on-demand@') && active === true)) throw new Error(`profile ${dir}: plugin not enabled`);
    if (settings.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS !== '1' && process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS !== '1') throw new Error(`profile ${dir}: Function Hooks not enabled`);
  }
}

async function revert() {
   const all = subject === '--all' || options.all;
  if ((!options.project && !options.user) || (!subject && !all)) usage();
  const demandDir = ruleDirectories(lifecycleRoot, lifecycleRoot)[scope === 'user' ? 'user' : 'project'];
  const names = all
    ? (await readdir(demandDir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter((name) => name.endsWith('.md'))
    : [subject];
  let changed = 0;
  for (const name of names) if ((await revertRule(lifecycleRoot, name, 'manual', { scope, mirrorDirs })).changed) changed += 1;
  console.log(`reverted ${changed} rule${changed === 1 ? '' : 's'}`);
}

async function retire() {
  if (!subject || !options.reason || (!options.project && !options.user)) usage();
  console.log(`retired to ${await retireRule(lifecycleRoot, subject, String(options.reason), { scope, mirrorDirs })}`);
}

try {
  if (command === 'check-rules') await checkRules();
  else if (command === 'prove-triggers') await prove();
  else if (command === 'migrate') await migrate();
  else if (command === 'revert') await revert();
  else if (command === 'retire') await retire();
  else usage();
} catch (error) {
  console.error(`rules: ${error.message}`);
  process.exitCode = 1;
}
