#!/usr/bin/env node
// Offline, measurement-only judgments. This script never opens the compliance store.
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extractCases } from './judge-extract.mjs';
import { configDirectory } from '../paths.js';
import { newJudgeOutput } from './judge-output.mjs';

const VERDICTS = ['followed', 'not followed', 'undecidable', 'not applicable'];
const TEMPLATE = 'Rule as served:\n{rule}\n\nExcerpt:\n{excerpt}\n\nFacts:\n{facts}\n\nEvidence limits:\n{limits}\n\nAnswer ONLY with JSON {"verdict":"followed|not followed|undecidable|not applicable","reason":"short explanation"}. followed means the applicable rule was respected; not followed means a demonstrated violation; not applicable means evidence establishes no governed act; undecidable means the excerpt or facts do not show whether it applied or was followed. Unknown facts and omitted evidence must not be inferred.';
export const PROMPT_HASH = createHash('sha256').update(TEMPLATE).digest('hex');
const readRows = async (path) => (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line, i) => {
  try { return JSON.parse(line); } catch { throw new Error(`${path}:${i + 1}: invalid JSON`); }
});
const promptFor = (item) => `Rule as served:\n${item.ruleText}\n\nExcerpt:\n${item.excerpt}\n\nFacts:\n${JSON.stringify({ ...item.facts, triggerProvenance: item.triggerReason ?? 'established' })}\n\nEvidence limits:\n${JSON.stringify({ truncated: item.truncated ?? false, droppedActs: item.droppedActs ?? 0, governedActs: item.governedActs })}\n\n${TEMPLATE.slice(TEMPLATE.indexOf('Answer ONLY'))}`;
const date = () => new Date().toISOString();
const contentHash = (item) => createHash('sha256').update(JSON.stringify([item.ruleText, item.excerpt, item.facts, item.triggerState, item.triggerReason, item.governedActs, item.truncated, item.droppedActs])).digest('hex');

// A closed allow-list: the caller's identity, model remaps, hook toggles and credentials do not cross.
function judgeEnvironment(configDir) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

function subprocess(binary, args, { cwd, env }) {
  return new Promise((fulfil, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 65536) { child.kill(); reject(new Error('judge output exceeded 64 KiB')); } });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 65536) { child.kill(); reject(new Error('judge stderr exceeded 64 KiB')); } });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? fulfil(stdout) : reject(new Error(`judge CLI exited ${code}: ${stderr.slice(0, 500)}`)));
  });
}

export async function cliRunner(prompt, model, options = {}) {
  const binary = options.binary ?? process.env.WT_ROD_JUDGE_CLI ?? 'claude';
  const cwd = await mkdtemp(join(tmpdir(), 'rod-judge-'));
  const configDir = options.judgeConfigDir ?? process.env.WT_ROD_JUDGE_CONFIG_DIR ?? cwd;
  const env = judgeEnvironment(configDir);
  try {
    // Verify the installed CLI's own help before invoking: no option is assumed supported.
    const help = await subprocess(binary, ['--help'], { cwd, env });
    const flags = ['-p', '--output-format', '--model', '--tools', '--setting-sources', '--strict-mcp-config', '--mcp-config', '--settings', '--no-session-persistence'];
    for (const flag of flags) {
      if (!new RegExp(`(^|[\\s,])${flag}(?=[\\s,]|$)`, 'm').test(help)) throw new Error(`judge CLI --help does not advertise ${flag}`);
    }
    const output = await subprocess(binary, ['-p', prompt, '--output-format', 'json', '--model', model,
      '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"hooks":{},"enabledPlugins":{},"mcpServers":{}}', '--no-session-persistence'],
    { cwd, env });
    const response = JSON.parse(output);
    const reported = response.model ?? response.model_id ?? Object.keys(response.modelUsage ?? {});
    let actualModel = reported;
    if (Array.isArray(reported)) actualModel = reported.length === 1 ? reported[0] : 'unknown (CLI reported multiple or no models)';
    return { answer: response.result, model: actualModel };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

function parseAnswer(answer) {
  try {
    let text = String(answer).trim();
    const fenced = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
    if (fenced) text = fenced[1].trim();
    // JSON.parse silently discards duplicate keys; reject them before interpreting a verdict.
    const keys = [...text.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].map((match) => JSON.parse(match[0].slice(0, match[0].lastIndexOf(':')).trim()));
    if (new Set(keys).size !== keys.length) throw new Error('duplicate response key');
    const parsed = JSON.parse(text);
    if (parsed && VERDICTS.includes(parsed.verdict) && typeof parsed.reason === 'string' &&
      Object.keys(parsed).sort().join(',') === 'reason,verdict') return { verdict: parsed.verdict, reason: parsed.reason.slice(0, 300) };
  } catch { /* Invalid model output is undecidable, never silently followed. */ }
  return { verdict: 'undecidable', reason: 'invalid judge response', rawAnswer: String(answer).slice(0, 1000) };
}

export async function judgeCases({ casesFile, out, previous, model = 'haiku', concurrency = 2, runner = cliRunner, binary, configDir, rollbackConfigDir }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('concurrency must be an integer from 1 to 16');
  const cases = await readRows(casesFile);
  const prior = previous ? await readRows(previous) : [];
  const key = (id, hash) => `${id}\0${model}\0${PROMPT_HASH}\0${hash}`;
  const seen = new Set(prior.filter((row) => row.requestedModel === model && row.promptHash === PROMPT_HASH).map((row) => key(row.caseId, row.caseHash)));
  const unique = new Set();
  const pending = cases.filter((item) => {
    const cache = key(item.caseId, contentHash(item));
    if (seen.has(cache) || unique.has(cache)) return false;
    unique.add(cache);
    return true;
  });
   const output = await newJudgeOutput(out, 'judgments.jsonl', rollbackConfigDir);
  let cursor = 0;
  // Serialized writes, parallel independent calls; completion order is explicit in each row's caseId.
  let writing = Promise.resolve();
  const worker = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
        const candidate = item.triggerState === 'known' || /^(?:historical trigger|committed history|serve timestamp unavailable)/.test(item.triggerReason ?? '');
        const applicable = Number.isInteger(item.governedActs) && item.governedActs > 0 && candidate && typeof item.excerpt === 'string' && item.excerpt.trim();
        let outcome, reported = null;
        if (!applicable) outcome = { verdict: 'undecidable', reason: item.triggerReason ?? (item.truncated && !item.excerpt?.trim() ? 'excerpt truncated to empty' : 'governed act or evidence not established'), decidedBy: 'code' };
      else {
         const response = await runner(promptFor(item), model, { binary, judgeConfigDir: configDir });
        reported = response.model ?? 'unknown (runner did not report model)';
        outcome = parseAnswer(response.answer);
      }
       const row = { caseId: item.caseId, rule: item.rule, ...outcome, model: reported, requestedModel: model, promptHash: PROMPT_HASH, caseHash: contentHash(item), timestamp: date() };
       writing = writing.then(() => output.handle.writeFile(JSON.stringify(row) + '\n'));
      await writing;
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker)); }
  finally { await output.handle.close(); }
  return { total: cases.length, judged: pending.length, skipped: cases.length - pending.length, path: output.path };
}

const rate = (numerator, denominator) => {
  if (!denominator) return '0/0 = n/a (small)';
  const small = denominator < 5 ? ' (small)' : '';
  return `${numerator}/${denominator} = ${(100 * numerator / denominator).toFixed(1)}%${small}`;
};
export async function scoreCases(judgesFile, labelFiles) {
  const judged = await readRows(judgesFile);
  const caseIds = new Set();
  for (const row of judged) {
    if (!VERDICTS.includes(row.verdict) || !row.caseId || !row.rule) throw new Error('invalid judge row');
    if (caseIds.has(row.caseId)) throw new Error(`duplicate judge case ${row.caseId}; score one model/template per file`);
    caseIds.add(row.caseId);
  }
  const labels = (await Promise.all(labelFiles.map(readRows))).flat();
  for (const label of labels) if (!VERDICTS.includes(label.label) || !label.labeller || !label.caseId) throw new Error('invalid label row');
  const grouped = new Map();
  for (const label of labels) {
    const list = grouped.get(label.caseId) ?? [];
    if (list.some((entry) => entry.labeller === label.labeller)) throw new Error(`duplicate labeller for ${label.caseId}`);
    list.push(label); grouped.set(label.caseId, list);
  }
   const rules = new Map(judged.map((row) => [row.caseId, row.rule]));
   for (const label of labels) if (label.rule) rules.set(label.caseId, label.rule);
   const groups = [['overall', judged, [...grouped.keys()]], ...[...new Set(rules.values())].sort().map((name) => [name, judged.filter((item) => item.rule === name), [...grouped.keys()].filter((id) => rules.get(id) === name)])];
   return groups.map(([name, rows, ids]) => {
     const eligible = ids.filter((id) => (grouped.get(id)?.length ?? 0) >= 2);
     const agreedIds = eligible.filter((id) => new Set(grouped.get(id).map((item) => item.label)).size === 1);
     const agree = rows.filter((row) => agreedIds.includes(row.caseId));
     const disagree = eligible.filter((id) => !agreedIds.includes(id));
      const missing = ids.filter((id) => !caseIds.has(id)).length;
    const metrics = VERDICTS.map((value) => {
      const truth = agree.filter((row) => grouped.get(row.caseId)[0].label === value);
      const predicted = agree.filter((row) => row.verdict === value);
      const correct = truth.filter((row) => row.verdict === value).length;
      return `${value}: precision ${rate(correct, predicted.length)}; recall ${rate(correct, truth.length)}`;
    });
     return `${name}: labeller agreement ${rate(agreedIds.length, eligible.length)} (${eligible.length} multiply labelled / ${rows.length} judged; ${missing} labelled cases without a judge row); disagree: ${disagree.join(', ') || 'none'}\n  ${metrics.join('\n  ')}`;
  }).join('\n');
}

async function main(argv) {
  const command = argv.shift();
  const options = { projectsDirs: [], transcripts: [], rulesDirs: [], labelFiles: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`missing value for ${flag ?? 'option'}`);
    if (flag === '--projects-dir') options.projectsDirs.push(resolve(value));
    else if (flag === '--transcript') options.transcripts.push(resolve(value));
    else if (flag === '--rules-dir') options.rulesDirs.push(resolve(value));
    else if (flag === '--labels') options.labelFiles.push(resolve(value));
      else if (['--out', '--previous', '--from-verdicts', '--cases', '--judges', '--config-dir', '--judge-config-dir', '--binary', '--model', '--rule', '--concurrency'].includes(flag)) options[flag.slice(2)] = value;
    else throw new Error(`unknown option ${flag}`);
  }
  if (command === 'extract') {
    if (!options.out || !options.projectsDirs.length && !options.transcripts.length) throw new Error('extract requires --out and --projects-dir and/or --transcript');
    const cases = await extractCases({ ...options, configDir: options['config-dir'] ?? configDirectory(process.env), ruleFilter: options.rule });
    let selected = cases;
    if (options['from-verdicts']) {
      const rows = await readRows(options['from-verdicts']); const used = new Set(); selected = [];
      for (const row of rows) {
        const at = Date.parse(row.injectedAt);
        const candidates = cases.filter((item) => item.rule === row.rule && item.sessionId === row.sessionId &&
          (row.agentId === undefined || item.agentId === row.agentId));
        const matches = candidates.filter((item) => Number.isFinite(at) && Math.abs(Date.parse(item.timestamp) - at) <= 300000)
          .sort((a, b) => Math.abs(Date.parse(a.timestamp) - at) - Math.abs(Date.parse(b.timestamp) - at));
        const match = matches.find((item) => !used.has(item.caseId));
        if (match && matches.some((item) => item.caseId !== match.caseId && !used.has(item.caseId) &&
          Math.abs(Date.parse(item.timestamp) - at) === Math.abs(Date.parse(match.timestamp) - at))) {
          console.error(`${row.rule} ${row.sessionId} ${row.injectedAt}: ambiguous serve points at same distance`);
          continue;
        }
         if (!match) {
           let reason = 'already matched';
           if (!candidates.length) reason = 'rule/session/agent absent';
           else if (!matches.length) reason = 'no serve within five minutes';
           console.error(`${row.rule ?? 'unknown'} ${row.sessionId ?? 'unknown'} ${row.injectedAt ?? 'unknown'}: no matching serve point (${reason})`);
           continue;
         }
        used.add(match.caseId); selected.push(match);
      }
    }
     const output = await newJudgeOutput(options.out, 'cases.jsonl', options['config-dir'] ?? configDirectory(process.env));
    try { await output.handle.writeFile(selected.map((row) => JSON.stringify(row)).join('\n') + (selected.length ? '\n' : '')); }
    finally { await output.handle.close(); }
    const coverage = cases.summary ? `; ${cases.summary.rawServed} raw served blocks, ${cases.summary.rawServed - cases.length} not produced as cases` : '';
    console.log(`extracted ${selected.length} cases to ${output.path}${coverage}`);
  } else if (command === 'judge') {
    if (!options.cases) throw new Error('judge requires --cases');
    const config = options['config-dir'] ?? configDirectory(process.env);
    const out = options.out ?? join(config ?? (() => { throw new Error('config directory required'); })(), 'plugins', 'data', 'wt-rules-on-demand', 'judge');
    console.log(JSON.stringify(await judgeCases({ casesFile: options.cases, out, previous: options.previous, model: options.model, concurrency: options.concurrency ? Number(options.concurrency) : undefined, binary: options.binary,
       configDir: options['judge-config-dir'] ?? process.env.WT_ROD_JUDGE_CONFIG_DIR, rollbackConfigDir: config })));
  } else if (command === 'score') {
    if (!options.judges || !options.labelFiles.length) throw new Error('score requires --judges and --labels');
    console.log(await scoreCases(options.judges, options.labelFiles));
  } else throw new Error('usage: judge-cases.mjs extract|judge|score [options]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(`judge-cases: ${error.message}`); process.exitCode = 1; }
}
