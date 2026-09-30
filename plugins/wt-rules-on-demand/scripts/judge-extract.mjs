import { createHash } from 'node:crypto';
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { blocks, REFUSAL, textOf } from './transcript-verdicts.mjs';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';
import { triggerMatches } from '../hooks/trigger-match.js';

export const ITEM_CHARS = 1200;
export const EXCERPT_CHARS = 12000;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const git = promisify(execFile);
const readOptional = async (path) => readFile(path, 'utf8').catch((error) => {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
  throw error;
});

export async function transcriptFiles(paths) {
  const files = [];
  const visited = new Set();
  const seenFiles = new Set();
  async function visit(path) {
    const info = await stat(path);
    if (info.isFile()) {
      const physical = await realpath(path);
      if (path.endsWith('.jsonl') && !seenFiles.has(physical)) { files.push(physical); seenFiles.add(physical); }
      return;
    }
    if (!info.isDirectory()) return;
    const physical = await realpath(path);
    if (visited.has(physical)) return;
    visited.add(physical);
    for (const entry of await readdir(path, { withFileTypes: true })) await visit(join(path, entry.name));
  }
  for (const path of paths) await visit(path);
  return files.sort();
}

function promptText(record) {
  if (record.type !== 'user' || record.isMeta || record.isCompactSummary) return null;
  const content = record.message?.content;
  if (Array.isArray(content) && content.some((part) => part.type === 'tool_result')) return null;
  return textOf(content);
}

function served(record, line, cwd) {
  let parts = [];
  if (record.type === 'attachment' && record.attachment?.type === 'hook_additional_context')
    parts = [{ content: record.attachment.content, tool_use_id: (record.attachment.toolUseID ?? '').replace(/-context$/, '') }];
  else if (record.type === 'user' && Array.isArray(record.message?.content))
    parts = record.message.content.filter((part) => part?.type === 'tool_result' && textOf(part.content).includes(REFUSAL));
  return parts.flatMap((part) => blocks(textOf(part.content)).filter((block) => !block.fallback && block.text !== null)
    .map((block, blockIndex) => ({ line, blockIndex, name: block.name, text: block.text, toolUseId: part.tool_use_id ?? '',
      at: record.timestamp ?? null, cwd, agentId: record.agentId ?? 'main', source: record.type })));
}

// Commit history supplies a candidate trigger; it cannot prove the active dirty-tree version.
async function historicalRule(rule, delivery) {
  if (!delivery.at || !Number.isFinite(Date.parse(delivery.at))) return { reason: 'serve timestamp unavailable for historical trigger' };
  try {
    const { stdout } = await git('git', ['-C', dirname(rule.path), 'log', '-1', `--until=${delivery.at}`, '--format=%H', '--', basename(rule.path)]);
    const commit = stdout.trim();
    if (!commit) return { reason: 'historical trigger unavailable (no rule version before serve)' };
    const { stdout: prefix } = await git('git', ['-C', dirname(rule.path), 'rev-parse', '--show-prefix']);
    const { stdout: source } = await git('git', ['-C', dirname(rule.path), 'show', `${commit}:${prefix.trim()}${basename(rule.path)}`]);
    return { definition: parseRuntimeRule(basename(rule.path), source), source: `git ${commit}` };
  } catch { return { reason: 'historical trigger unavailable (rule directory has no readable git history)' }; }
}

async function currentRule(name, cwd, options) {
  const dirs = [...(options.rulesDirs ?? []), ...(cwd ? [join(cwd, '.claude', 'rules-on-demand')] : []),
    ...(options.configDir ? [join(options.configDir, 'rules-on-demand')] : [])];
  for (const dir of dirs) {
    const path = join(dir, name);
    const source = await readOptional(path);
    if (source !== null) return { ...parseRuntimeRule(name, source), hash: digest(source), path };
  }
  throw new Error(`${name}: current trigger definition not found (tried ${dirs.join(', ')})`);
}

function matches(rule, record, channel, errors) {
  const input = channel === 'prompt' ? { channel, text: promptText(record) } :
    { channel, tool: record.use.name, command: record.use.input?.command,
      path: record.use.input?.file_path ?? record.use.input?.path, input: record.use.input };
  let matched = false;
  for (const trigger of rule.triggers) {
    if (trigger.detector) { errors.push('detector requires host state'); continue; }
    try {
      const value = triggerMatches(trigger, input, (error) => errors.push(`trigger evaluation error: ${error.error}`));
      matched ||= value;
    } catch (error) { errors.push(`trigger evaluation error: ${error.message}`); }
  }
  return matched;
}

function represented(record, index, selectedCalls, selectedResults) {
  const content = record.message?.content;
  const text = record.type === 'assistant' || record.type === 'user' ? textOf(content) : '';
  if (record.type === 'system' && record.subtype === 'compact_boundary') return `line ${index + 1} [compaction boundary: rule may no longer be in context]`;
  const limit = (value) => value.length > ITEM_CHARS ? `${value.slice(0, ITEM_CHARS)} … [item truncated]` : value;
  const parts = text ? [`[${record.type} text] ${limit(text)}`] : [];
  for (const use of selectedCalls ?? []) parts.push(`[tool call ${use.name} ${use.id}] ${limit(JSON.stringify(use.input))}`);
  for (const result of selectedResults ?? []) parts.push(`[tool result ${result.tool_use_id}] ${limit(textOf(result.content))}`);
  const description = parts.join(' ') || `[${record.type}]`;
  return `line ${index + 1} ${description}`;
}

function excerpt(records, serve, end, acts, scopeStart) {
  const selected = new Set();
  const calls = new Map(), results = new Map();
  const add = (i) => { if (i >= 0 && i < end) selected.add(i); };
  for (let i = serve.line - 1; i < end; i++) if (records[i]?.subtype === 'compact_boundary') add(i);
  for (const act of acts) {
    add(act.index);
    if (act.use) calls.set(act.index, [...calls.get(act.index) ?? [], act.use]);
    for (let i = act.index - 1; i >= Math.max(0, scopeStart - 1); i--) {
      if (promptText(records[i]) !== null) { add(i); break; }
    }
    for (let i = act.index - 1; i >= Math.max(0, scopeStart - 1); i--) {
      if (records[i].type === 'assistant' && textOf(records[i].message?.content)) { add(i); break; }
    }
     if (act.id) for (let i = act.index; i < end; i++) {
      const found = records[i].results?.find((item) => item.tool_use_id === act.id);
      if (found) { add(i); results.set(i, [...results.get(i) ?? [], found]); break; }
    }
    for (const answerIndex of act.answerIndices ?? []) add(answerIndex);
  }
  let output = '', previous = 0, truncated = false;
  const kept = new Set();
  for (const index of [...selected].sort((a, b) => a - b)) {
    const gap = previous ? index - previous - 1 : 0;
    const raw = represented(records[index], index, calls.get(index), results.get(index));
    const piece = (gap > 0 ? `… ${gap} lines omitted …\n` : '') + raw + '\n';
    if (output.length + piece.length > EXCERPT_CHARS) {
      truncated = true;
      if (!output) { output = piece.slice(0, EXCERPT_CHARS); kept.add(index); }
      break;
    }
    output += piece;
    kept.add(index);
    truncated ||= raw.includes('[item truncated]');
    previous = index;
  }
   const dropped = acts.filter((act) => !kept.has(act.index) || act.id && !output.includes(`[tool call ${act.use.name} ${act.id}]`)).length;
  return { excerpt: output, truncated, droppedActs: dropped };
}

async function agentFacts(acts, cwd, options) {
  const installed = await readOptional(join(options.configDir ?? '', 'plugins', 'installed_plugins.json'));
  const plugins = installed ? Object.values(JSON.parse(installed).plugins ?? {}).flat().map((item) => item.installPath).filter(Boolean) : [];
  const roots = [...(cwd ? [join(cwd, '.claude', 'agents')] : []), ...(options.configDir ? [join(options.configDir, 'agents')] : []),
    ...plugins.flatMap((path) => [join(path, 'agents'), join(path, 'plugin', 'agents')])];
  return Promise.all(acts.filter((act) => act.use).map(async (act) => {
    const type = act.use.input?.subagent_type ?? act.use.input?.agent_type ?? act.use.input?.type;
    const pathsTried = type && !/[\\/]/.test(type) ? roots.map((root) => join(root, `${type}.md`)) : [];
    for (const path of pathsTried) {
      const source = await readOptional(path);
       if (source === null) {
         continue;
       }
       const normalized = source.replaceAll('\r\n', '\n');
       const front = normalized.startsWith('---\n') ? normalized.slice(4).split('\n---')[0] : '';
       const lines = front.split(/\r?\n/);
       const index = lines.findIndex((line) => line.startsWith('tools:'));
       const declaration = index >= 0 ? lines[index].slice(6).trim() : undefined;
       let tools;
        const bare = (value) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
        if (declaration === '') {
          const following = [];
          for (const line of lines.slice(index + 1)) {
            if (!line.trim()) continue;
            if (!line.startsWith('  - ')) break;
            following.push(line.slice(4).trim());
          }
          if (following.length && following.every(bare)) tools = following;
        } else if (declaration?.startsWith('[') && declaration.endsWith(']')) {
          const entries = declaration.slice(1, -1).split(',').map((value) => value.trim());
          if (entries.length && entries.every(bare)) tools = entries;
        } else if (declaration) {
          const entries = declaration.split(',').map((value) => value.trim());
          if (entries.every(bare)) tools = entries;
        }
       return { type, tools: tools ?? 'unknown', source: path, ...(tools ? {} : { reason: 'tools declaration absent or unrecognised' }) };
    }
    return { type: type ?? 'unknown', tools: 'unknown', pathsTried };
  }));
}

async function factsFor(name, acts, records, cwd, options) {
  if (name === 'executor-delegation-briefs-read-only.md') return { agents: await agentFacts(acts, cwd, options) };
  if (name !== 'executor-delegation-briefs-worktree.md') return {};
  const text = records.map((record) => JSON.stringify(record)).join('\n');
   const creationCommands = records.flatMap((record) => record.uses ?? []).map((use) => use.input?.command).filter((command) => typeof command === 'string' && /\bgit\s+worktree\s+add\b/.test(command));
   return { worktreePathsNamed: [...new Set(text.split(/[\s"']+/).filter((word) => word.includes('worktrees/') || word.includes('worktrees\\')))],
    worktreeCreationCommands: creationCommands.map((command) => command.slice(0, ITEM_CHARS)),
    delegates: acts.filter((act) => act.id).map((act) => ({ toolUseId: act.id,
       resultSeen: records.some((record) => record.results?.some((result) => result.tool_use_id === act.id)),
       endSeen: records.some((record) => record.results?.some((result) => result.tool_use_id === act.id && /(?:status\s*:\s*completed|delegate\s+(?:ended|completed))/i.test(textOf(result.content)))) ? true : 'unknown' })),
    liveGitState: 'unknown' };
}

export async function extractCases(options) {
  const cases = [];
  let rawServed = 0;
  const paths = await transcriptFiles([...(options.projectsDirs ?? []), ...(options.transcripts ?? [])]);
  for (const path of paths) {
    const raw = (await readFile(path, 'utf8')).split(/\r?\n/);
    if (raw.at(-1) === '') raw.pop();
    const records = raw.map((line) => { try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : { malformed: true }; } catch { return { malformed: true }; } });
    let cwd = '';
    const deliveries = [];
    for (const [index, record] of records.entries()) {
      cwd = record.cwd ?? cwd;
      if (record.type === 'assistant') record.uses = (Array.isArray(record.message?.content) ? record.message.content : []).filter((item) => item.type === 'tool_use');
      if (record.type === 'user') record.results = (Array.isArray(record.message?.content) ? record.message.content : []).filter((item) => item.type === 'tool_result');
      for (const delivery of served(record, index + 1, cwd)) {
        if (options.ruleFilter && !delivery.name.includes(options.ruleFilter)) continue;
        rawServed++;
        // Only adjacent echoes of the same refusal can be collapsed without guessing.
        const prior = deliveries.at(-1);
        if (delivery.source === 'attachment' && prior?.source === 'user' && prior.name === delivery.name && prior.text === delivery.text &&
          prior.line === delivery.line - 1 && (!delivery.toolUseId || delivery.toolUseId === prior.toolUseId)) continue;
        deliveries.push(delivery);
      }
    }
    for (const delivery of deliveries) {
      try { delivery.rule = await currentRule(delivery.name, delivery.cwd, options); }
      catch { delivery.rule = { content: '', triggers: [], hash: null }; delivery.missingRule = true; }
      delivery.history = delivery.missingRule ? { reason: 'current rule definition not found' } : await historicalRule(delivery.rule, delivery);
      delivery.evaluated = delivery.history.definition ?? delivery.rule;
      const callIndex = delivery.toolUseId ? records.findIndex((record, index) => index < delivery.line && record.uses?.some((use) => use.id === delivery.toolUseId)) : -1;
      if (callIndex >= 0) delivery.scopeStart = callIndex;
      else {
        const promptIndex = records.findLastIndex((record, index) => index < delivery.line - 1 && promptText(record) !== null);
        delivery.scopeStart = promptIndex >= 0 && delivery.evaluated.triggers.some((trigger) => trigger.kind === 'prompt') ? promptIndex : delivery.line - 1;
      }
    }
    for (const delivery of deliveries) {
      const { rule, history, evaluated } = delivery;
      const next = deliveries.find((item) => item.name === delivery.name && item.line > delivery.line);
      const end = next ? Math.max(scopeBoundary(next, delivery), delivery.scopeStart + 1) : records.length;
      // A hook result/attachment is written after the call which caused it; that call belongs to this serve.
      const scopeStart = delivery.scopeStart;
      const acts = [];
      const errors = [];
       for (let i = scopeStart; i < end; i++) {
        const record = records[i];
        for (const use of record.uses ?? []) if (matches(evaluated, { ...record, use }, 'tool', errors)) acts.push({ index: i, id: use.id, use });
        if (promptText(record) !== null && matches(evaluated, record, 'prompt', errors)) {
          const answerIndices = [];
           for (let j = i + 1; j < end && promptText(records[j]) === null; j++)
             if (records[j].type === 'assistant' && textOf(records[j].message?.content)) answerIndices.push(j);
          if (answerIndices.length) acts.push({ index: i, answerIndices });
        }
      }
       const context = excerpt(records, delivery, end, acts, scopeStart);
      const facts = await factsFor(delivery.name, acts, records.slice(scopeStart, end), delivery.cwd, options);
      const drift = evaluated.content.trim() !== delivery.text;
       const ambiguous = deliveries.some((other) => other !== delivery && other.name === delivery.name &&
         (other.line === delivery.line || other.scopeStart === delivery.scopeStart));
       const missingResult = acts.some((act) => act.id && !records.slice(act.index, end).some((record) => record.results?.some((result) => result.tool_use_id === act.id)) &&
         records.slice(end).some((record) => record.results?.some((result) => result.tool_use_id === act.id)));
       const malformed = records.slice(scopeStart, end).some((record) => record.malformed);
       const triggerReason = uncertainty({ ambiguous, missingResult, malformed, delivery, errors, context, drift, history });
       cases.push({ caseId: digest(`${path}\0${delivery.line}\0${delivery.blockIndex}\0${delivery.name}\0${delivery.toolUseId}`), rule: delivery.name, ruleText: delivery.text,
        currentRuleHash: rule.hash, triggerSource: history.source ?? 'unavailable', transcriptPath: path, serveLine: delivery.line, timestamp: delivery.at,
        sessionId: records.find((record) => record.sessionId)?.sessionId ?? basename(path, '.jsonl'), agentId: delivery.agentId === 'main' && path.split(/[\\/]/).includes('subagents') ? basename(path, '.jsonl') : delivery.agentId,
        excerpt: context.excerpt, facts, truncated: context.truncated, droppedActs: context.droppedActs,
        governedActs: acts.length, ...(triggerReason ? { triggerState: 'unknown', triggerReason } : { triggerState: 'known' }) });
    }
  }
  cases.summary = { rawServed };
  return cases;
}

function scopeBoundary(next, delivery) {
  return next.scopeStart === delivery.scopeStart ? next.line - 1 : next.scopeStart;
}

function uncertainty({ ambiguous, missingResult, malformed, delivery, errors, context, drift, history }) {
  if (ambiguous) return 'ambiguous overlapping serves of same rule';
  if (missingResult) return 'result beyond call scope';
  if (malformed) return 'malformed transcript record inside scope';
  if (delivery.missingRule) return 'current rule definition not found';
  if (errors.length) return errors[0];
  if (!context.excerpt.trim()) return 'excerpt empty or truncated to empty';
  if (drift) return 'historical rule body differs from served text';
  if (!delivery.toolUseId && delivery.source === 'attachment') return 'id-less attachment owner ambiguous';
  if (history.reason) return history.reason;
  return 'committed history does not establish active trigger';
}
