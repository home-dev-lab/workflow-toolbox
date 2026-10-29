// Rules pre-served to a sub-agent at its start. Resolution picks each name's winning file the way the hooks module does
// (hooks.js load / loadWinner), and the builder renders each with the engine's own served form, so a block placed in the
// sub-agent's first context is recognised as already served (hooks.js holdServed) and never refused.
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ruleDirectories, projectRuleRoots, sameDirectory } from '../paths.js';
import { linkedWorktree } from './worktree-node.mjs';
import { discoverFiles } from './discover-files.mjs';
import { sameRule } from '../duplicate-rule.js';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';
import { RULE_CAP } from '../hooks/evidence.js';
import { servedBlock } from '../hooks/served-block.js';

// The host replaces an additionalContext over 10,000 characters by a file path and a preview; this keeps margin.
export const PRESERVE_BUDGET = 9500;
export const NOTE_RESERVE = 600;
export const REASON_CAP = 80;
export const HEADER = 'wt-rules-on-demand: rules served at sub-agent start.';
const SEPARATOR = '\n\n';
const TAG = /<\/?system-reminder/i;

async function candidateRoots(root, config) {
  const { mainRepoRoot = null, worktreeRoot = null } = await linkedWorktree(root).then((tree) => tree ?? {}, () => ({}));
  const candidates = projectRuleRoots(root, { configDir: config, mainRepoRoot, worktreeRoot });
  return candidates.length ? candidates : [root];
}

async function projectRoots(root, config) {
  const configReal = await realpath(config).catch(() => config);
  const roots = [];
  for (const dir of await candidateRoots(root, config)) {
    const real = await realpath(join(dir, '.claude')).catch(() => null);
    if (real !== null && !sameDirectory(real, configReal)) roots.push(dir);
  }
  return roots;
}

// The engine lists a directory it cannot read as empty (hooks.js list), so one unreadable directory hides only its own rules.
const listed = (dir, options) => discoverFiles(dir, options).catch(() => []);

// name -> { file, statics: [paths of static rules with that name] }; the last copy of a name wins, user first.
export async function resolveRuleFiles({ root, configDir }) {
  const config = resolve(configDir);
  const roots = await projectRoots(resolve(root), config);
  const copies = await listed(ruleDirectories(root, config).user);
  for (const dir of roots) copies.push(...await listed(ruleDirectories(dir, config).project));
  const staticDirs = [...roots.map((dir) => ruleDirectories(dir, config).projectStatic), ruleDirectories(root, config).userStatic];
  const statics = (await Promise.all(staticDirs.map((dir) => listed(dir, { recursive: true })))).flat();
  const files = new Map();
  for (const [name, file] of copies) files.set(name, { file, statics: [] });
  for (const [name, path] of statics) files.get(name)?.statics.push(path);
  return files;
}

async function readRule(file) {
  const info = await stat(file);
  if (info.size > RULE_CAP) throw new Error(`rule exceeds ${RULE_CAP} bytes`);
  return readFile(file, 'utf8');
}

// The engine reads every same-name static rule; one it cannot read makes it skip the rule (hooks.js loadWinner), so
// that failure is a reason here too, never ignored.
async function staticCopyLoaded(found, text) {
  let equal = false;
  for (const path of found.statics) if (sameRule(await readFile(path, 'utf8'), text)) equal = true;
  return equal;
}

const reasonText = (error) => String(error?.message ?? error).replace(/[\r\n]+/g, ' ');

// Same order as the engine: read, static-copy check, then parse.
async function loadRule(name, found) {
  const text = await readRule(found.file);
  if (await staticCopyLoaded(found, text)) return { reason: 'static copy is loaded instead' };
  return { rule: parseRuntimeRule(name, text) };
}

// { block } for a rule that renders, else { reason } naming why it was not served here.
export async function renderRule(name, found) {
  if (!found) return { reason: 'not found' };
  let loaded;
  try { loaded = await loadRule(name, found); } catch (error) { return { reason: `unreadable: ${reasonText(error)}` }; }
  if (loaded.reason) return loaded;
  if (TAG.test(loaded.rule.content)) return { reason: 'contains a system-reminder tag the host rewrites' };
  return { block: servedBlock({ name, content: loaded.rule.content }) };
}

const clip = (text, cap) => (text.length > cap ? `${text.slice(0, cap - 1)}…` : text);

// The note naming every listed rule not served here, at most `cap` characters; names that do not fit become `+<K> more`.
export function skipNote(skipped, cap = NOTE_RESERVE) {
  if (!skipped.length) return '';
  const head = 'wt-rules-on-demand: listed rules not placed at sub-agent start: ';
  let note = head;
  let shown = 0;
  for (const { name, reason } of skipped) {
    const clause = `${shown ? ', ' : ''}${name} (${clip(reason, REASON_CAP)})`;
    const rest = skipped.length - shown - 1;
    const tail = rest ? `, +${rest} more` : '';
    if (note.length + clause.length + tail.length > cap) break;
    note += clause;
    shown++;
  }
  if (shown === skipped.length) return note;
  const more = `${shown ? ', ' : ''}+${skipped.length - shown} more`;
  return clip(`${note}${more}`, cap);
}

function admit(state, name, rendered, room) {
  if (rendered.reason) return state.skipped.push({ name, reason: rendered.reason });
  const cost = SEPARATOR.length + rendered.block.length;
  if (state.used + cost > room) return state.skipped.push({ name, reason: 'over budget' });
  state.blocks.push(rendered.block);
  state.used += cost;
}

export const DIVERGED = 'differs between the session root and the agent directory';

// With a second resolution (the agent's own directory), a rule is placed only when both render the identical block:
// the engine may resolve from either root, and a block it does not recognise as its own would never count as served.
async function renderAgreed(name, files, agentFiles) {
  const rendered = await renderRule(name, files.get(name));
  if (!agentFiles) return rendered;
  const other = await renderRule(name, agentFiles.get(name));
  if (rendered.block !== undefined ? rendered.block === other.block : rendered.reason === other.reason) return rendered;
  return { reason: DIVERGED };
}

// The whole additionalContext for one agent type, or '' when nothing is listed. Never over PRESERVE_BUDGET.
export async function buildPreserveContext(names, files, agentFiles = null) {
  if (!names?.length) return '';
  const room = PRESERVE_BUDGET - HEADER.length - NOTE_RESERVE;
  const state = { blocks: [], skipped: [], used: 0 };
  for (const name of names) admit(state, name, await renderAgreed(name, files, agentFiles), room);
  const note = skipNote(state.skipped, NOTE_RESERVE - SEPARATOR.length);
  if (!state.blocks.length) return note;
  return [HEADER, ...state.blocks, ...(note ? [note] : [])].join(SEPARATOR);
}

// Resolution and rendering for one spawn: the rule files are read fresh at every start. The agent directory is resolved
// as a second root only when it differs from the session root.
export async function preserveContext({ names, root, agentDir = null, configDir }) {
  if (!names?.length) return '';
  const files = await resolveRuleFiles({ root, configDir });
  const second = agentDir !== null && resolve(agentDir) !== resolve(root);
  return buildPreserveContext(names, files, second ? await resolveRuleFiles({ root: agentDir, configDir }) : null);
}
