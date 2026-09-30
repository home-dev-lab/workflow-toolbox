#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';
import { checkLines } from '../hooks/act-checks.js';
import { ruleDirectories, configDirectory } from '../paths.js';
import { argumentEvidence, bounded, RULE_CAP } from '../hooks/evidence.js';
import { triggerMatches } from '../hooks/trigger-match.js';
import { toolInputVerdict, bashSegments, segmentVerdict, correlateTurn } from '../hooks/declarative-checks.js';

const RULE_BLOCK = /<rule name="([^"]+\.md)"(\s+source="[^"]*")?>/g;
export const REFUSAL = 'wt-rules-on-demand: read the rule below before this action';
const watched = /"(?:tool_use|hook_additional_context|compact_boundary|tool_result)"|"cwd"|"timestamp"/;
const exec = promisify(execFile);

// Both return null when git has no history for the rule (no repository: the ledger is the designed source there) and
// THROW when git itself failed, so the scan can say its dates are unknown instead of silently falling back.
async function gitLog(rulesDir, name, args) {
  try {
    return (await exec('git', ['-C', rulesDir, 'log', ...args, '--', name])).stdout;
  } catch (error) {
    if (/not a git repository/i.test(error.stderr ?? '')) return '';
    throw new Error(`git log ${rulesDir}/${name} failed (${error.code ?? 'error'}): ${String(error.stderr || error.message).trim().slice(0, 200)}`, { cause: error });
  }
}

export async function migrationDateOf(rulesDir, name) {
  return (await gitLog(rulesDir, name, ['--diff-filter=A', '--format=%cI'])).trim().split('\n').filter(Boolean).at(-1) ?? null;
}

export async function lastChangeOf(rulesDir, name) {
  return (await gitLog(rulesDir, name, ['-1', '--format=%cI'])).trim() || null;
}

async function firstMigration(root, name, scope) {
  const file = scope === 'user' ? join(root, 'rules-on-demand-ledger.jsonl') : join(root, '.claude', 'rules-on-demand-ledger.jsonl');
  const text = await readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '';
    throw error;
  });
  return text.split('\n').flatMap((line) => { try { const row = JSON.parse(line); return row.action === 'migrate' && row.rule === name && Number.isFinite(Date.parse(row.time)) ? [row.time] : []; } catch { return []; } }).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

async function filesIn(directory, stats) {
  stats.visited ??= new Set();
  const physical = await realpath(directory).catch(() => null);
  if (physical && stats.visited.has(physical)) return [];
  if (physical) stats.visited.add(physical);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    stats.filesFailed++;
    if (stats.errors.length < 50) stats.errors.push(`${directory}: ${error.code ?? error.message}`);
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    try {
      const info = await stat(path); // follows symlinked transcript files
      if (info.isDirectory()) files.push(...await filesIn(path, stats));
      else if (info.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    } catch (error) { stats.filesFailed++; if (stats.errors.length < 50) stats.errors.push(`${path}: ${error.code ?? error.message}`); }
  }
  return files;
}

async function loadScopes(scopes, migrationDate, lastChange, stats) {
  return Promise.all(scopes.map(async (scope) => {
    const entries = await readdir(scope.rulesDir).catch((error) => { stats.scopeErrors.push(`${scope.rulesDir}: ${error.message}`); return []; });
    const rules = [];
    for (const name of entries.filter((entry) => entry.endsWith('.md'))) {
      const path = join(scope.rulesDir, name);
      stats.coverage.rulesParsed++;
      let rule;
      try {
        const text = await readFile(path, 'utf8');
        rule = { ...parseRuntimeRule(name, text), text };
      }
      catch (error) { stats.scopeErrors.push(`${path}: ${error.message}`); continue; }
      const dated = async (read) => { try { return await read(scope.rulesDir, name); } catch (error) { stats.coverage.gitErrors.push(`${scope.scope} ${name}: ${error.message}`); return null; } };
      const gitDate = await dated(migrationDate);
       const ledgerDate = gitDate ? null : (await Promise.all((scope.ledgerRoots ?? []).map((root) => firstMigration(root, name, scope.scope)))).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      const migrated = gitDate || ledgerDate || null;
      if (['check', 'bash-command', 'tool-input', 'turn-correlation', 'unregistered'].includes(rule.compliance?.kind)) {
        stats.coverage.checkableRules++;
        if (!migrated) stats.coverage.unknownMigrationDates.push(`${scope.scope} ${name}`);
       } else stats.coverage.unmeasuredRules.push({ rule: `${scope.scope} ${name}`, reason: rule.compliance?.kind === 'next-call'
         ? 'next-call is not transcript-measured; use live store verdicts (window and detector state unavailable)' : `scanner cannot measure ${rule.compliance?.kind ?? 'none'}` });
      rules.push({ ...rule, migrated, cutoff: Date.parse(migrated ?? '') || 0, lastChange: Date.parse(await dated(lastChange) ?? '') || 0 });
    }
    return { ...scope, rules };
  }));
}

function matches(rule, use) {
  if (rule.triggers.some((trigger) => trigger.detector)) return 'unknown'; // Host machine state cannot be reconstructed.
  const input = use.input ?? {};
  return rule.triggers.some((trigger) => triggerMatches(trigger, { channel: 'tool', tool: use.name,
     command: input.command, path: input.file_path ?? input.path, input: use.argumentEvidence ?? argumentEvidence(input) }));
}

export function blocks(text) {
  return [...String(text).matchAll(RULE_BLOCK)].map((match) => {
    const end = String(text).indexOf('</rule>', match.index + match[0].length);
    return { name: match[1], fallback: !!match[2], bytes: end < 0 ? null : Buffer.byteLength(String(text).slice(match.index, end + '</rule>'.length)),
      text: end < 0 ? null : String(text).slice(match.index + match[0].length, end).trim() };
  });
}

function toolVerdict(rule, use, checked, correlated) {
  if (rule.compliance?.kind === 'bash-command') return use.name === 'Bash'
    ? bashSegments(rule.compliance, use.input?.command ?? '').map((part, segment) => ({ verdict: segmentVerdict(rule.compliance, part), detail: '', segment })) : [];
  if (rule.compliance?.kind === 'tool-input') {
    const { verdict, matchError } = toolInputVerdict(rule.compliance, { tool: use.name, input: use.input });
    return verdict ? [{ verdict, detail: matchError ?? '' }] : [];
  }
  if (rule.compliance?.kind === 'turn-correlation') return (correlated.get(rule)?.get(use.id) ?? []).map((item) => ({ verdict: item.verdict, detail: item.detail }));
  if (rule.compliance?.kind === 'unregistered') return [{ verdict: 'unregistered check', detail: rule.compliance.reason }];
  if (rule.compliance?.kind === 'check') {
    return (checked.get(use.id) ?? []).filter((act) => act.check === rule.compliance.check && ['FOLLOWED', 'VIOLATED', 'unresolved'].includes(act.verdict))
      .map((act) => {
        let verdict = 'unresolved';
        if (act.verdict === 'FOLLOWED') verdict = 'followed';
        else if (act.verdict === 'VIOLATED') verdict = 'not followed';
        return { verdict, detail: act.detail, segment: act.segment };
      });
  }
  return [];
}

// Pipeline: normalize(file) -> context events; resolve(context, scopes) -> effective rules;
// judge(events, effective rules) -> verdict rows. No stage retains raw transcript JSON.
export const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text ?? '').join('\n');
  return '';
};
export function normalize(record, line, cwd = '') {
  const at = record.timestamp ?? null;
  const base = { line, at, cwd: record.cwd ?? cwd, sessionId: record.sessionId };
  if (record.type === 'system' && record.subtype === 'compact_boundary') return [{ ...base, kind: 'compact' }];
  if (record.type === 'assistant') return (Array.isArray(record.message?.content) ? record.message.content : [])
     .filter((part) => part?.type === 'tool_use').map((part) => {
       const input = part.input && typeof part.input === 'object' ? part.input : {};
       return { ...base, kind: 'use', id: part.id, name: part.name, argumentEvidence: argumentEvidence(input),
         input: Object.fromEntries(Object.entries(input).flatMap(([key, value]) => {
           if (value === null || typeof value !== 'object') return [[key, typeof value === 'string' ? bounded(value) : value]];
           const serialized = JSON.stringify(value);
           return serialized?.length <= 1024 ? [[key, value]] : [];
         })), messageId: record.message?.id };
     });
  if (record.type === 'attachment' && record.attachment?.type === 'hook_additional_context')
    return blocks(textOf(record.attachment.content)).filter((block) => !block.fallback)
       .map((block) => ({ ...base, kind: 'delivery', name: block.name, bytes: block.bytes, provenance: { kind: 'attachment', toolUseId: (record.attachment.toolUseID ?? '').replace(/-context$/, ''), line, at } }));
  if (record.type === 'user') {
    const content = record.message?.content;
    const results = Array.isArray(content) ? content.filter((part) => part?.type === 'tool_result') : [];
    const events = [];
    const deliveries = [];
    for (const part of results) {
      const raw = textOf(part.content);
      const refusal = raw.slice(0, RULE_CAP);
      const refused = refusal.includes(REFUSAL);
      events.push({ ...base, kind: 'result', id: part.tool_use_id, isError: part.is_error === true, text: bounded(raw), ...(refused ? { refused } : {}) });
      if (refused) for (const block of blocks(refusal).filter((item) => !item.fallback))
        deliveries.push({ ...base, kind: 'delivery', name: block.name, bytes: block.bytes, provenance: { kind: 'refusal', toolUseId: part.tool_use_id, line, at } });
    }
    events.push(...deliveries);
    if (!results.length && (typeof content === 'string' || Array.isArray(content) && content.some((part) => part?.type === 'text')) && !record.isMeta && !record.isCompactSummary)
      events.push({ ...base, kind: 'turn' });
    return events;
  }
  return [];
}

export function resolveContext(context, scopes, { nonProofNames = [] } = {}) {
  const project = scopes.find((scope) => scope.scope === 'project' && scope.projectRoot === context.cwd);
  // A user scope applies when one of its config dirs (every dir sharing its physical rules dir) owns the projects dir
  // the transcript came from; a scope with no config dir, or the only one, applies to unowned transcripts too.
  const users = scopes.filter((scope) => scope.scope === 'user');
  const dirsOf = (scope) => scope.configDirs ?? (scope.configDir ? [scope.configDir] : []);
  const user = users.filter((scope) => !dirsOf(scope).length || (context.owners?.length ? dirsOf(scope).some((dir) => context.owners.includes(dir)) : users.length === 1));
  const shadow = new Set(project?.rules.map((rule) => rule.name));
  const effective = [...user.flatMap((scope) => scope.rules.filter((rule) => !shadow.has(rule.name)).map((rule) => ({ rule, scope }))),
    ...(project?.rules ?? []).map((rule) => ({ rule, scope: project }))];
  const byName = new Map(effective.map((item) => [item.rule.name, item]));
  const calls = new Map(context.events.filter((event) => event.kind === 'use').map((event) => [event.id, event]));
  const deliveries = context.events.filter((event) => event.kind === 'delivery').map((event) => ({ ...event, owner: byName.get(event.name) })).filter((event) => event.owner);
    return { effective, deliveries, calls, runtimeProofs: deliveries.filter((delivery) => !nonProofNames.includes(delivery.name)) };
}

export function judge(context, resolved, path, stats, seen, now, collection) {
  const rows = [];
  const checked = new Map();
   const correlated = new Map();
   for (const { rule } of resolved.effective) if (rule.compliance?.kind === 'turn-correlation') {
     try { correlated.set(rule, new Map(correlateTurn(rule.compliance, context.events).map((item) => [item.id, [item]]))); }
     catch (error) { stats.coverage.ruleErrors ??= []; stats.coverage.ruleErrors.push(`${rule.name}: ${error.message}`); }
   }
   for (const act of checkLines(context.events)) {
     if (act.toolUseId) checked.set(act.toolUseId, [...checked.get(act.toolUseId) ?? [], act]);
   }
   const refused = new Set(context.events.filter((event) => event.kind === 'result' && (event.refused || event.text.includes(REFUSAL))).map((event) => event.id));
   for (const call of resolved.calls.values()) {
    if (refused.has(call.id)) continue;
    const time = Date.parse(call.at ?? '');
    if (!Number.isFinite(time)) { stats.coverage.missingTimestamps++; continue; }
     if (time < now - stats.days * 86400000 || time > now) { stats.skippedOutsideWindow++; continue; }
     if (collection) {
       const actKey = call.name === 'Bash' ? `Bash:${String(call.input?.command ?? '').trim().split(/\s+/).slice(0, 2).join(' ')}` : call.name;
        const act = collection.acts[actKey] ?? { count: 0, matchedAnyRule: false, scannerCheck: false, checked: 0, governedWithoutScannerCheck: 0, unmatched: 0 };
        act.count++;
        const matching = resolved.effective.filter(({ rule }) => matches(rule, call));
        const scannerCheck = matching.some(({ rule }) => ['check', 'bash-command', 'tool-input', 'turn-correlation'].includes(rule.compliance?.kind));
        if (scannerCheck) act.checked++;
        else if (matching.length) act.governedWithoutScannerCheck++;
        else act.unmatched++;
        act.matchedAnyRule ||= matching.length > 0;
        act.scannerCheck ||= scannerCheck;
       collection.acts[actKey] = act;
     }
     for (const { rule, scope } of resolved.effective) {
       let evaluations;
       try { evaluations = toolVerdict(rule, { name: call.name, id: call.id, input: call.input }, checked, correlated); }
        catch (error) { stats.coverage.ruleErrors ??= []; stats.coverage.ruleErrors.push(`${rule.name}: ${error.message}`); continue; }
       for (const [index, evaluated] of evaluations.entries()) {
       // An act whose outcome the transcript cannot decide is counted, never a row.
       if (evaluated.verdict === 'unresolved') { const key = `${scope.scope} ${rule.name}`; stats.coverage.unresolvedActs ??= {}; stats.coverage.unresolvedActs[key] = (stats.coverage.unresolvedActs[key] ?? 0) + 1; }
       const contextKey = /(?:^|[\\/])subagents(?:[\\/]|$)/.test(path) ? path : call.sessionId ?? '';
      const key = `${scope.scope}:${scope.rulesDir}:${rule.name}:${contextKey}:${call.id ?? path + ':' + call.line}:${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const linked = (delivery) => delivery.provenance.toolUseId === call.id || resolved.calls.get(delivery.provenance.toolUseId)?.messageId === call.messageId && !!call.messageId;
      const served = resolved.deliveries.some((delivery) => delivery.owner.rule === rule && (delivery.line <= call.line || linked(delivery)));
      const active = resolved.runtimeProofs.some((delivery) => delivery.line <= call.line || linked(delivery));
      const phase = time < rule.cutoff ? 'before' : 'after';
       let verdict = 'out of scope';
       if (rule.migrated && phase === 'before') verdict = 'static baseline';
       else if (rule.migrated && context.start >= rule.cutoff && active) {
          if (served) verdict = evaluated.verdict;
           else if (rule.triggers.some((trigger) => trigger.detector)) verdict = 'trigger unknown (environment-dependent detector)';
           else verdict = time < rule.lastChange ? 'trigger miss (superseded)' : 'trigger miss';
       }
        rows.push({ rule: rule.name, scope: scope.scope, rulesDir: scope.rulesDir, migrated: rule.migrated, phase,
         checkVerdict: evaluated.verdict, triggerMatched: matches(rule, { name: call.name, input: call.input, argumentEvidence: call.argumentEvidence }), verdict, served,
          file: path, line: call.line, ...(collection ? { contextId: context.id, messageId: call.messageId } : {}), toolUseId: call.id, at: call.at, sessionId: call.sessionId, source: 'transcript',
        detail: evaluated.detail ?? '', ...(evaluated.segment !== undefined ? { segment: evaluated.segment } : {}), window: `${stats.days}d`,
        ...(!rule.migrated ? { note: 'no migration date' } : {}) });
        }
    }
  }
  return rows;
}

async function scanFile(path, scopes, rows, stats, seen, { discover, skipCwdPrefixes, explicitRoots, owners, migrationDate, lastChange, now, nonProofNames, collection }) {
  let context = { id: `${path}:0`, start: 0, cwd: '', events: [], owners }, cwd = '', valid = 0, lineNumber = 0, index = 0;
  const badBefore = stats.badLines;
  const flush = async () => {
    if (discover && cwd && !skipCwdPrefixes.some((prefix) => { const path = relative(prefix, cwd); return path === '' || path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path); }) && !scopes.some((scope) => scope.scope === 'project' && scope.projectRoot === cwd)) {
      const rulesDir = ruleDirectories(cwd, configDirectory(process.env) ?? cwd).project;
      const physical = await realpath(rulesDir).catch(() => null);
      if (physical && !scopes.some((scope) => scope.rulesDir === physical) && (await readdir(physical)).some((name) => name.endsWith('.md')))
        scopes.push(...await loadScopes([{ scope: 'project', projectRoot: cwd, rulesDir: physical, ledgerRoots: [cwd] }], migrationDate, lastChange, stats));
    }
       const errorsBefore = stats.coverage.ruleErrors?.length ?? 0;
       const resolved = resolveContext(context, scopes, { nonProofNames });
      if (collection) {
        collection.contexts++;
         collection.effective.push({ contextId: context.id, rules: resolved.effective.map(({ rule, scope }) => `${scope.scope}:${scope.rulesDir}:${rule.name}`),
           at: context.events.map((event) => event.at).filter((stamp) => Number.isFinite(Date.parse(stamp))) });
        for (const delivery of resolved.deliveries) if (Number.isFinite(Date.parse(delivery.at)) && Date.parse(delivery.at) >= now - stats.days * 86400000 && Date.parse(delivery.at) <= now) collection.deliveries.push({ rule: delivery.name, scope: delivery.owner.scope.scope,
          rulesDir: delivery.owner.scope.rulesDir, file: path, contextId: context.id, line: delivery.line, bytes: delivery.bytes,
           toolUseId: delivery.provenance.toolUseId, messageId: resolved.calls.get(delivery.provenance.toolUseId)?.messageId, at: delivery.at });
       }
       rows.push(...judge(context, resolved, path, stats, seen, now, collection));
       if (collection) for (const { rule, scope } of resolved.effective) if (stats.coverage.ruleErrors?.slice(errorsBefore).some((error) => error.startsWith(`${rule.name}:`)))
         collection.uncertainContexts.push({ ruleId: `${scope.scope}:${scope.rulesDir}:${rule.name}`, contextId: context.id });
  };
  try {
    for await (const line of createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })) {
      lineNumber++; stats.linesRead++;
      if (!watched.test(line) && !line.includes('"type":"user"')) continue;
      let record;
      try { record = JSON.parse(line); } catch { stats.badLines++; continue; }
      valid++;
       if (record.cwd) {
         cwd = record.cwd; context.cwd = cwd;
         const withinTemp = relative(tmpdir(), cwd);
          const parentPrefix = process.platform === 'win32' ? '..\\' : '../';
           const explicit = explicitRoots.has(cwd);
           const collection = !explicit && withinTemp && withinTemp !== '..' && !withinTemp.startsWith(parentPrefix) && !isAbsolute(withinTemp) ? stats.tmpProjects : stats.projects;
          collection.add(cwd);
       }
      if (!context.start && record.timestamp) context.start = Date.parse(record.timestamp) || 0;
      const events = normalize(record, lineNumber, cwd);
        if (events[0]?.kind === 'compact') { context.events.push({ kind: 'turn' }); await flush(); context = { id: `${path}:${++index}`, start: Date.parse(record.timestamp) || 0, cwd, events: [], owners }; }
      else context.events.push(...events);
    }
    // A subagent transcript ends when the subagent ends: its last turn is closed. A main-session file may still be live.
    if (/(?:^|[\\/])subagents(?:[\\/]|$)/.test(path)) context.events.push({ kind: 'turn' });
    await flush();
    if (valid) stats.filesRead++;
    // Well-formed JSONL with no transcript record (another tool's log under the projects directory) is not a transcript.
    else if (stats.badLines === badBefore) stats.skipped.push(`${path}: not a transcript`);
    else { stats.filesFailed++; if (stats.errors.length < 50) stats.errors.push(`${path}: no valid transcript records`); }
  } catch (error) { stats.filesFailed++; if (stats.errors.length < 50) stats.errors.push(`${path}: ${error.message}`); }
}

// The config dirs owning a projects dir: those whose `projects` is physically that dir. [] = owned by no user scope's
// config dir; null = unowned while two or more user scopes exist, so no user rule can be attributed (coverage gap).
async function ownersOf(dir, scopes) {
  const physical = await realpath(dir).catch(() => resolve(dir));
  const owners = [];
  for (const scope of scopes.filter((item) => item.scope === 'user')) for (const configDir of scope.configDirs ?? (scope.configDir ? [scope.configDir] : [])) {
    if (await realpath(join(configDir, 'projects')).catch(() => resolve(configDir, 'projects')) === physical) owners.push(configDir);
  }
  const attributable = scopes.filter((item) => item.scope === 'user' && (item.configDirs?.length || item.configDir)).length;
  return owners.length || attributable < 2 ? owners : null;
}

export async function scanTranscripts({ projectsDirs, scopes, days = 7, since, now = Date.now(), discoverProjects = false, skipCwdPrefixes = ['/tmp'], nonProofNames = [], collect = false, migrationDateOf: migrationDate = migrationDateOf, lastChangeOf: lastChange = lastChangeOf }) {
  if (!Number.isFinite(days) || days <= 0) throw new Error('days must be a positive number');
  if (since !== undefined && (!Number.isFinite(Date.parse(since)) || Date.parse(since) > now)) throw new Error('since must be a past ISO date');
  if (since !== undefined) days = (now - Date.parse(since)) / 86400000 || Number.EPSILON;
  const stats = { filesRead: 0, filesFailed: 0, linesRead: 0, skipped: [], skippedOutsideWindow: 0, errors: [], badLines: 0, days, projects: new Set(), tmpProjects: new Set(), scopeErrors: [],
    coverage: { rulesParsed: 0, checkableRules: 0, unmeasuredRules: [], filesRead: 0, filesFailed: 0, badLines: 0, missingTimestamps: 0, unknownMigrationDates: [], unresolvedActs: {}, gitErrors: [], missingProjectsDirs: [], unownedProjectsDirs: [] } };
  const loaded = await loadScopes(scopes, migrationDate, lastChange, stats);
   const collection = collect ? { deliveries: [], acts: {}, contexts: 0, effective: [], uncertainContexts: [] } : null;
  const explicitRoots = new Set(scopes.filter((scope) => scope.scope === 'project').map((scope) => scope.projectRoot));
  const rows = [];
  const seen = new Set();
  for (const dir of projectsDirs) {
    // A projects dir that does not exist holds no transcript to miss (a profile never used here): recorded, not failed.
    if (await stat(dir).then(() => false, (error) => error.code === 'ENOENT')) { stats.coverage.missingProjectsDirs.push(dir); continue; }
    const owners = await ownersOf(dir, loaded);
    if (owners === null) stats.coverage.unownedProjectsDirs.push(dir);
    for (const path of await filesIn(dir, stats)) {
    try {
       if ((await stat(path)).mtimeMs < now - days * 86400000) { stats.skippedOutsideWindow++; continue; }
           await scanFile(path, loaded, rows, stats, seen, { discover: discoverProjects, skipCwdPrefixes, explicitRoots, owners: owners ?? [], migrationDate, lastChange, now, nonProofNames, collection });
    } catch (error) { stats.filesFailed++; if (stats.errors.length < 50) stats.errors.push(`${path}: ${error.code ?? error.message}`); }
    }
  }
  stats.tmpProjectsSkipped = stats.tmpProjects.size;
  stats.projects = [...stats.projects];
  delete stats.tmpProjects;
  delete stats.visited;
  Object.assign(stats.coverage, { filesRead: stats.filesRead, filesFailed: stats.filesFailed, badLines: stats.badLines });
  stats.coverage.missingScopeEvidence = loaded.filter((scope) => scope.scope === 'project' && !stats.projects.includes(scope.projectRoot))
    .map((scope) => `${scope.scope} ${scope.projectRoot}: no transcript evidence`);
  const complete = stats.filesRead > 0 && stats.coverage.checkableRules > 0 && !stats.filesFailed && !stats.scopeErrors.length && !stats.coverage.unknownMigrationDates.length
     && !stats.coverage.missingScopeEvidence.length && !stats.coverage.ruleErrors?.length
    && !stats.coverage.gitErrors.length && !stats.coverage.unownedProjectsDirs.length;
    return { rows, stats, coverage: stats.coverage, complete, scopes: loaded.map(({ rules, ...scope }) => ({ ...scope,
     ...(collect ? { rules: rules.map(({ name, text, compliance, triggers, migrated, lastChange }) => ({ name, text, complianceKind: compliance?.kind ?? 'none',
       promptTrigger: triggers.some((trigger) => trigger.kind === 'prompt'), migrated, lastChange })) } : {}) })), ...(collection ?? {}) };
}

export function summarise(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.scope}:${row.rulesDir ?? ''}:${row.rule}`;
    const group = groups.get(key) ?? { rule: row.rule, scope: row.scope, migrated: row.migrated ?? null,
      before: { acts: 0, followed: 0, notFollowed: 0, rate: 'too few to judge' },
      after: { acts: 0, served: 0, followed: 0, notFollowed: 0, rate: 'too few to judge', triggerMiss: 0, triggerMissUnmatched: 0, outOfScope: 0 } };
    const column = row.phase === 'before' ? group.before : group.after;
    column.acts++;
    if (row.phase === 'before' || ['followed', 'not followed'].includes(row.verdict)) {
      if (row.checkVerdict === 'followed') column.followed++;
      if (row.checkVerdict === 'not followed') column.notFollowed++;
    }
    if (row.phase !== 'before') {
      if (row.served) column.served++;
      if (row.verdict === 'trigger miss') { column.triggerMiss++; if (row.triggerMatched === false) column.triggerMissUnmatched++; }
      if (row.verdict === 'out of scope') column.outOfScope++;
    }
    for (const item of [group.before, group.after]) {
      const applicable = item.followed + item.notFollowed;
      item.rate = applicable < 5 ? 'too few to judge' : item.followed / applicable;
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
      const options = { projectsDirs: [], configDirs: [], scopes: [], ledgerRoots: [], days: 7, summary: false, nonProofNames: process.env.WT_ROD_NON_PROOF_NAMES?.split(',').filter(Boolean) ?? [] };
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
       if (arg === '--projects-dir') options.projectsDirs.push(resolve(process.argv[++i]));
       else if (arg === '--config-dir') options.configDirs.push(resolve(process.argv[++i]));
      else if (arg === '--user-rules-dir' || arg === '--project-rules-dir' || arg === '--rules-dir') {
        const rulesDir = resolve(process.argv[++i]);
        const scope = arg === '--user-rules-dir' ? 'user' : 'project';
        options.scopes.push({ scope, rulesDir, ...(scope === 'project'
           ? { projectRoot: basename(dirname(rulesDir)) === '.claude' ? dirname(dirname(rulesDir)) : dirname(rulesDir) } : {}) });
      }
      else if (arg === '--ledger-root') options.ledgerRoots.push(resolve(process.argv[++i]));
        else if (arg === '--days') options.days = Number(process.argv[++i]);
        else if (arg === '--since') options.since = process.argv[++i];
       else if (arg === '--non-proof-name') options.nonProofNames.push(process.argv[++i]);
      else if (arg === '--out') options.out = resolve(process.argv[++i]);
      else if (arg === '--summary') options.summary = true;
      else throw new Error(`unknown option: ${arg}`);
    }
     if (!options.configDirs.length) options.configDirs = process.env.WT_ROD_CONFIG_DIRS?.split(delimiter).filter(Boolean) ?? [configDirectory(process.env)];
     if (options.configDirs.some((dir) => !dir)) throw new Error('HOME or USERPROFILE required to locate config directory');
     if (!options.projectsDirs.length) options.projectsDirs = options.configDirs.map((dir) => join(dir, 'projects'));
    for (const scope of options.scopes) scope.ledgerRoots = options.ledgerRoots;
    const result = await scanTranscripts(options);
    if (options.out) await writeFile(options.out, result.rows.map((row) => JSON.stringify(row)).join('\n') + (result.rows.length ? '\n' : ''));
    if (options.summary) {
      console.log('| rule | migrated | before n / followed / rate | after n / followed / rate | trigger miss (unmatched) | out of scope |');
      console.log('| --- | --- | --- | --- | --- | --- |');
      for (const item of summarise(result.rows)) console.log(`| ${item.scope} ${item.rule} | ${item.migrated ?? 'no migration date'} | ${item.before.acts} / ${item.before.followed} / ${item.before.rate} | ${item.after.acts} / ${item.after.followed} / ${item.after.rate} | ${item.after.triggerMiss} (${item.after.triggerMissUnmatched}) | ${item.after.outOfScope} |`);
    }
     console.log(`files read: ${result.stats.filesRead}; lines read: ${result.stats.linesRead}; skipped outside window: ${result.stats.skippedOutsideWindow}; errors: ${result.stats.errors.join('; ')}`);
    if (!result.stats.filesRead) process.exitCode = 1;
  } catch (error) { console.error(`transcript-verdicts: ${error.message}`); process.exitCode = 1; }
}
