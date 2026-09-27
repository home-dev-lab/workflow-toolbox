#!/usr/bin/env node
// Per-rule compliance report over the wt-rules-on-demand plugin store.
//
// `served` comes from the store's `served` counters, which the hook bumps on every injection whatever the
// rule declares — never from verdict rows: a rule whose compliance is `none` writes no verdict row, and
// counting served from verdicts alone reported zero deliveries.
// `check` says whether the rule file declares a checkable compliance ("declared") or not ("no check
// declared": compliance `none`, no compliance block, or no rule file found). A declared
// rule that was served yet has no verdict row is flagged in `note`, never left silent.
//
//   node compliance-report.mjs [--store <file>] [--project <dir>] [--config-dir <dir>] [--json]
// Default rules dirs: <cwd>/.claude/rules-on-demand and <config dir>/rules-on-demand.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';
import { configDirectory, ruleDirectories } from '../paths.js';

const args = process.argv.slice(2);
let storePath = '';
let json = false;
let project = process.cwd();
let configOverride = '';
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--json') json = true;
  else if (args[index] === '--store') storePath = args[++index] ?? '';
  else if (args[index] === '--project') project = args[++index] ?? '';
  else if (args[index] === '--config-dir') configOverride = args[++index] ?? '';
  else {
    console.error(`unknown option: ${args[index]}`);
    process.exit(2);
  }
}
const configDir = configOverride || configDirectory(process.env);
if (!configDir) throw new Error('HOME or USERPROFILE required to locate config directory');
const locations = ruleDirectories(project, configDir);
const rulesDirs = [locations.project, locations.user];

// Same key the hook uses for its served counters (hooks.js keyOf).
const keyOf = (name) => name.replace(/[^a-z0-9._-]/gi, '_').toLowerCase();

async function defaultStorePath() {
  const root = join(configDir, 'plugins', 'store');
  const names = (await readdir(root)).filter((name) => /^wt-rules-on-demand[_-].*\.json$/.test(name));
  if (!names.length) throw new Error(`no wt-rules-on-demand store found under ${root}`);
  const candidates = await Promise.all(names.map(async (name) => ({ path: join(root, name), mtime: (await stat(join(root, name))).mtimeMs })));
  return candidates.sort((a, b) => b.mtime - a.mtime)[0].path;
}

async function declaredChecks() {
  const declared = new Map();
  for (const directory of rulesDirs) {
    let names;
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith('.md'));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const rule = parseRuntimeRule(name, await readFile(join(directory, name), 'utf8'));
        if (!declared.has(keyOf(name))) declared.set(keyOf(name), { name, checkable: Boolean(rule.compliance) });
      } catch {
        // A file the hook would skip declares nothing the hook could check.
      }
    }
  }
  return declared;
}

storePath ||= await defaultStorePath();
const source = await readFile(storePath, 'utf8');
let lines;
let servedCounters = {};
try {
  const store = JSON.parse(source);
  lines = [String(store['compliance-verdicts-jsonl'] ?? ''), ...Object.entries(store).filter(([name]) => name.startsWith('compliance-verdicts-archive-')).map(([, text]) => String(text))].join('\n');
  servedCounters = store.served && typeof store.served === 'object' ? store.served : {};
} catch {
  lines = source;
}
const declared = await declaredChecks();

const report = {};
const rowFor = (name) => {
  report[name] ??= { served: 0, check: 'no check declared', injections: 0, followed: 0, 'not followed': 0, 'not applicable': 0, 'unregistered check': 0, unknown: 0, followRate: null, reasons: {} };
  return report[name];
};
const nameOfKey = new Map();
for (const line of lines.split('\n').filter(Boolean)) {
  const row = JSON.parse(line);
  const counts = rowFor(row.rule);
  nameOfKey.set(keyOf(row.rule), row.rule);
  counts.injections += 1;
  if (Object.hasOwn(counts, row.verdict)) counts[row.verdict] += 1;
  if (row.reason) counts.reasons[row.reason] = (counts.reasons[row.reason] ?? 0) + 1;
}
for (const [key, entry] of Object.entries(servedCounters)) {
  const name = nameOfKey.get(key) ?? declared.get(key)?.name ?? key;
  rowFor(name).served = Number(entry?.count) || 0;
}
for (const [name, counts] of Object.entries(report)) {
  const applicable = counts.followed + counts['not followed'];
  counts.followRate = applicable ? counts.followed / applicable : null;
  const checkable = declared.get(keyOf(name))?.checkable ?? counts.injections > 0;
  counts.check = checkable ? 'declared' : 'no check declared';
  if (checkable && counts.served > 0 && counts.injections === 0) counts.note = 'served, but no verdict recorded';
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('rule\tserved\tcheck\tverdicts\tfollowed\tnot followed\tnot applicable\tunregistered check\tunknown\tfollow rate\tnote');
  for (const [rule, counts] of Object.entries(report).sort(([a], [b]) => a.localeCompare(b))) {
    const rate = counts.followRate === null ? 'n/a' : `${(counts.followRate * 100).toFixed(1)}%`;
    const reasons = Object.entries(counts.reasons).map(([reason, count]) => `${count}× ${reason}`).join('; ');
    const note = [counts.note, reasons].filter(Boolean).join(' | ');
    console.log(`${rule}\t${counts.served}\t${counts.check}\t${counts.injections}\t${counts.followed}\t${counts['not followed']}\t${counts['not applicable']}\t${counts['unregistered check']}\t${counts.unknown}\t${rate}\t${note}`);
  }
}
