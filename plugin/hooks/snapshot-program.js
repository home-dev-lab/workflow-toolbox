import { classifyIdleHelper, executableName, IDLE_HELPER_SAFE_TO_STOP_SECONDS, resolvedBinary } from '../bin/lib/resolved-binary.mjs';
import { PHASES as LIFECYCLE_PHASES } from './lifecycle-phases.js';
import { stripAnsiAndControl } from './text-sanitize.js';

// These pure helpers are also embedded in the out-of-process collector below.
export function detectArtifactUrl(file, platform, env = {}, linkBase = '', suiteRoot = '') {
  const normalized = String(file).replace(/\\/g, '/');
  const encoded = normalized.split('/').map((part) => encodeURIComponent(part).replace(/%3A/gi, ':')).join('/');
  if (linkBase) {
    const root = String(suiteRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!root || (normalized !== root && !normalized.startsWith(root + '/'))) return null;
    const relative = normalized.slice(root.length).replace(/^\/+/, '');
    return String(linkBase).replace(/\/+$/, '') + '/' + relative.split('/').map(encodeURIComponent).join('/');
  }
  if (platform === 'win32') return 'file:///' + encoded.replace(/^\/+/, '');
  if (platform === 'linux' && env.WSL_DISTRO_NAME) return 'file://wsl.localhost/' + encodeURIComponent(env.WSL_DISTRO_NAME) + '/' + encoded.replace(/^\/+/, '');
  return 'file://' + (encoded.startsWith('/') ? '' : '/') + encoded;
}

export function markdownToHtml(markdown) {
  const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const inline = (value) => escape(value).split(/(`[^`]*`)/g).map((part) => {
    if (part.startsWith('`') && part.endsWith('`')) return '<code>' + part.slice(1, -1) + '</code>';
    return part.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/_([^_]+)_|\*([^*]+)\*/g, (_match, under, star) => '<em>' + (under || star) + '</em>');
  }).join('');
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => { if (paragraph.length) output.push('<p>' + inline(paragraph.join(' ')) + '</p>'); paragraph = []; };
  const flushList = () => { if (list) output.push('<' + list.type + '>' + list.items.map((item) => '<li>' + inline(item) + '</li>').join('') + '</' + list.type + '>'); list = null; };
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) { output.push('<pre><code>' + escape(code.join('\n')) + '</code></pre>'); code = null; }
      else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushParagraph(); flushList(); code = []; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const item = /^\s*(?:[-*+] |\d+[.)]\s+)(.+)$/.exec(line);
    if (heading) { flushParagraph(); flushList(); output.push('<h' + heading[1].length + '>' + inline(heading[2]) + '</h' + heading[1].length + '>'); }
    else if (item) {
      flushParagraph();
      const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list?.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push(item[1]);
    } else if (!line.trim()) { flushParagraph(); flushList(); }
    else { flushList(); paragraph.push(line.trim()); }
  }
  if (code !== null) output.push('<pre><code>' + escape(code.join('\n')) + '</code></pre>');
  flushParagraph(); flushList();
  return output.join('\n');
}

// Kept as source text because a Function Hook module may only import its own files and
// "claude-code". The collector runs through $.process.run, the module's audited door to disk.
// The program below is ONE String.raw template literal: a backtick anywhere in it, a comment included, ends
// the literal and the module stops loading (measured 2026-09-16 on a comment quoting a JSON value).
export const SNAPSHOT_PROGRAM = String.raw`
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = JSON.parse(process.argv.at(-1));
const timingStartedAt = Date.now();
const timingsMs = {};
const detectArtifactUrl = ${detectArtifactUrl.toString()};
const markdownToHtml = ${markdownToHtml.toString()};
const stripAnsiAndControl = ${stripAnsiAndControl.toString()};
const executableName = ${executableName.toString()};
const resolvedBinary = ${resolvedBinary.toString()};
const classifyIdleHelper = ${classifyIdleHelper.toString()};
const IDLE_HELPER_SAFE_TO_STOP_SECONDS = ${IDLE_HELPER_SAFE_TO_STOP_SECONDS};
const now = Date.parse(config.now || new Date().toISOString());
const UNKNOWN = 'unknown';
const PRICE_UNKNOWN = 'price unknown';
let priceTable = { models: {} };
try { priceTable = JSON.parse(fs.readFileSync(config.priceTableFile, 'utf8')); } catch {}
const LOG_TAIL_BYTES = 64 * 1024;
const REPORT_TAIL_BYTES = 128 * 1024;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const JSON_BYTES = 256 * 1024;
const BRIEF_HEAD_BYTES = 32 * 1024;
const ACTIVE_WINDOW_MIN = Number(config.activeWindowMin) > 0 ? Number(config.activeWindowMin) : 10;
const ACTIVE_WINDOW_MS = ACTIVE_WINDOW_MIN * 60 * 1000;
const MIN_SERVICE_AGE_SECONDS = 30;
const runtimePlatform = typeof config.platform === 'string' ? config.platform : process.platform;
const executablePlatform = typeof config.executablePlatform === 'string' ? config.executablePlatform : runtimePlatform;
const processEnv = config.processEnv && typeof config.processEnv === 'object' ? config.processEnv : process.env;
const cacheBase = processEnv.XDG_CACHE_HOME || (runtimePlatform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches') : runtimePlatform === 'win32' ? processEnv.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), '.cache'));
const catalogueFile = config.catalogueFile || path.join(cacheBase, 'opencode', 'models.json');
try {
  const catalogue = JSON.parse(fs.readFileSync(catalogueFile, 'utf8'));
  const verifiedAt = fs.statSync(catalogueFile).mtime.toISOString();
  for (const [provider, providerValue] of Object.entries(catalogue || {})) for (const [modelKey, modelValue] of Object.entries(providerValue?.models || {})) {
    if (modelValue?.cost) {
      const modelId = modelValue.id || modelKey;
      if (priceTable.models[modelId]?.family === provider) delete priceTable.models[modelId];
      priceTable.models[provider + '/' + modelId] = { ...modelValue.cost, family: provider, verified_at: verifiedAt };
    }
  }
} catch {}
const overrideFile = config.overrideFile || (processEnv.CLAUDE_PLUGIN_DATA ? path.join(processEnv.CLAUDE_PLUGIN_DATA, 'model-prices.override.json') : null);
try {
  const override = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
  for (const [model, price] of Object.entries(override.models || {})) priceTable.models[model] = { ...price, verified_at: price.verified_at || override.as_of || fs.statSync(overrideFile).mtime.toISOString() };
} catch {}
const layout = config.layout && typeof config.layout === 'object' ? config.layout : {};
const laneDirName = typeof layout.laneDirName === 'string' && layout.laneDirName ? layout.laneDirName : null;
const worktreesDirName = typeof layout.worktreesDirName === 'string' && layout.worktreesDirName ? layout.worktreesDirName : null;
if (!laneDirName || !worktreesDirName) throw new Error('collector layout descriptor is required');
const scripts = layout.scripts && typeof layout.scripts === 'object' ? layout.scripts : {};
const executables = layout.executables && typeof layout.executables === 'object' ? layout.executables : {};
const servicesLayout = layout.services && typeof layout.services === 'object' ? layout.services : {};
const baseBranches = Array.isArray(layout.baseBranches) ? layout.baseBranches.filter(name => typeof name === 'string' && name) : [];
const lanePath = (worktree, ...names) => path.join(worktree, laneDirName, ...names);
const executableLookupFailures = [];
const executableOf = value => {
  try {
    const resolved = resolvedBinary(String(value || ''), processEnv, {
      accessSyncFn: fs.accessSync, constants: fs.constants, platform: executablePlatform,
      realpathSyncFn: fs.realpathSync, statSyncFn: fs.statSync,
      pathApi: executablePlatform === 'win32' ? path.win32 : path,
    });
    return executableName(resolved || value, executablePlatform, processEnv.PATHEXT || processEnv.PathExt || '');
  } catch (error) {
    executableLookupFailures.push(error?.message || String(error));
    return executableName(value, executablePlatform, processEnv.PATHEXT || processEnv.PathExt || '');
  }
};
const scriptIs = (value, key) => (Array.isArray(scripts[key]) ? scripts[key] : [scripts[key]]).filter(name => typeof name === 'string').includes(path.basename(String(value || '')));
const procRoot = typeof config.procRoot === 'string' ? config.procRoot : '/proc';
const processScanAvailable = runtimePlatform === 'linux' && typeof config.procRoot === 'string';
const configuredClockTicks = Number(config.clockTicks);
let clockTicks = Number.isFinite(configuredClockTicks) && configuredClockTicks > 0 ? configuredClockTicks : null;
if (processScanAvailable && clockTicks === null) {
  try {
    const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 });
    const detected = Number(result.stdout?.trim());
    if (result.status === 0 && Number.isFinite(detected) && detected > 0) clockTicks = detected;
  } catch {}
}
const clockTicksAvailability = clockTicks === null
  ? { status: UNKNOWN, reason: 'getconf CLK_TCK unavailable' }
  : { status: 'available' };
let procUptime = null;
const PHASES = ${JSON.stringify([...LIFECYCLE_PHASES, 'awaiting_fidelity'])};
const LITE_SKIPS = new Set(['plan', 'critic', 'review', 'refutation', 'harden']);
const DIR_SCAN_CAP = Number.isSafeInteger(config.scanEntryCap) && config.scanEntryCap > 0 ? config.scanEntryCap : 1000;
const WORKTREE_DETAIL_CAP = Number.isSafeInteger(config.worktreeDetailCap) && config.worktreeDetailCap > 0 ? config.worktreeDetailCap : 48;
const cappedScans = [];
const scanLimits = [];
const unreadableScans = [];
const approximateWalkRoots = new Set();
const processReadFailures = [];
// A process that exits between the /proc listing and its record reads leaves no directory behind.
// That is the ordinary race of scanning a live machine, not a read failure: the listing was complete
// for everything that still exists, so it must not degrade process discovery to partial. A record
// whose directory still exists and cannot be read IS a failure, and stays one. processVanished counts
// pid directories found ABSENT (ENOENT) after a null record read; it cannot tell a genuine exit from
// a source that disappeared under the scan, so when every listed pid is absent the scan is reported
// as unreadable rather than as an empty machine (the scanner's own process is always listed).
let processVanished = 0;
function processGone(pid) {
  let gone = false;
  try { fs.statSync(path.join(procRoot, pid)); } catch (error) { gone = error?.code === 'ENOENT'; }
  if (gone) processVanished += 1;
  return gone;
}
const pathRefusals = [];
const suiteWorktreeInput = path.join(config.suiteRoot, worktreesDirName);
const configuredActorRoots = [suiteWorktreeInput, ...(Array.isArray(config.extraRoots) ? config.extraRoots : [])]
  .filter(root => typeof root === 'string' && path.isAbsolute(root))
  .map(root => path.resolve(root));
function canonicalDirectory(root) {
  try {
    const real = fs.realpathSync(root);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}
const actorRootEntries = configuredActorRoots.map(input => ({ input, real: canonicalDirectory(input) })).filter(entry => entry.real);
const allowedRoots = [...new Set(actorRootEntries.map(entry => entry.real))];
const suiteWorktreeRoot = canonicalDirectory(suiteWorktreeInput) || suiteWorktreeInput;
function refusal(source, reason) {
  const message = source + ' live actor ' + reason;
  if (!pathRefusals.includes(message)) pathRefusals.push(message);
}
function resolveActorPath(candidate, source, liveActor = false) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    if (liveActor) refusal(source, 'path was outside allowed roots');
    return null;
  }
  const absolute = path.resolve(candidate);
  let real;
  try { real = fs.realpathSync(absolute); } catch {
    if (liveActor) refusal(source, configuredActorRoots.some(root => under(root, absolute)) ? 'path could not be resolved within allowed roots' : 'path was outside allowed roots');
    return null;
  }
  const lexicalRoot = actorRootEntries.find(entry => under(entry.input, absolute));
  const admitted = allowedRoots.some(root => under(root, real));
  if (admitted && infoUnrestricted(real)?.isDirectory()) return real;
  if (liveActor) refusal(source, lexicalRoot ? 'symlink escaped an allowed root' : 'path was outside allowed roots');
  return null;
}
function safePath(candidate) {
  try {
    const absolute = path.resolve(candidate);
    const real = fs.realpathSync(absolute);
    const actorRoot = actorRootEntries.find(entry => under(entry.input, absolute) || under(entry.real, absolute));
    return !actorRoot || under(actorRoot.real, real) ? real : null;
  } catch { return null; }
}
function resolveActorFile(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  const real = safePath(candidate);
  return real && allowedRoots.some(root => under(root, real)) && infoUnrestricted(real)?.isFile() ? real : null;
}
function infoUnrestricted(file) { try { return fs.statSync(file); } catch { return null; } }
procUptime = processScanAvailable ? Number((head(path.join(procRoot, 'uptime'), 128) || '').trim().split(/\s+/)[0]) : null;

function listed(dir, maxEntries = DIR_SCAN_CAP, reportCap = true) {
  let handle;
  try {
    const safeDir = safePath(dir);
    if (!safeDir) return { entries: [], readable: false, capped: false };
    handle = fs.opendirSync(safeDir);
    const entries = [];
    while (entries.length < maxEntries) {
      const entry = handle.readSync();
      if (!entry) return { entries, readable: true, capped: false };
      entries.push(entry.name);
    }
    if (!handle.readSync()) return { entries, readable: true, capped: false };
    if (reportCap) cappedScans.push(dir);
    return { entries, readable: true, capped: true };
  } catch { return { entries: [], readable: false, capped: false }; }
  finally { try { handle?.closeSync(); } catch {} }
}
function list(dir) {
  const result = listed(dir);
  if (!result.readable && !unreadableScans.includes(dir)) unreadableScans.push(dir);
  return result.entries;
}
function slice(file, maxBytes, fromEnd = false, rejectOverflow = false) {
  let handle;
  try {
    const safeFile = safePath(file);
    if (!safeFile) return null;
    handle = fs.openSync(safeFile, 'r');
    const size = fs.fstatSync(handle).size;
    if (rejectOverflow && size > maxBytes) return null;
    const length = size === 0 ? maxBytes : Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(handle, buffer, 0, length, fromEnd ? Math.max(0, size - length) : 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch { return null; }
  finally { if (handle !== undefined) try { fs.closeSync(handle); } catch {} }
}
function tail(file, maxBytes = LOG_TAIL_BYTES) { return slice(file, maxBytes, true); }
function head(file, maxBytes = BRIEF_HEAD_BYTES) { return slice(file, maxBytes); }
function json(file) { const value = slice(file, JSON_BYTES, false, true); try { return value === null ? null : JSON.parse(value); } catch { return null; } }
function lifecycleTimeline(worktree) {
  const source = lanePath(worktree, 'lifecycle.json');
  const value = json(source);
  if (!value || !Array.isArray(value.phases) || value.phases.length === 0) return null;
  const validTime = item => item === null || Number.isFinite(item);
  const validRound = item => item === null || (Number.isSafeInteger(item) && item > 0);
  if (!value.phases.every(item => item && typeof item === 'object' && PHASES.includes(item.phase) && item.phase !== 'awaiting_fidelity'
    && validRound(item.round) && Number.isFinite(item.entered_at) && validTime(item.exited_at))) return null;
  const phaseHistory = value.phases.map(item => item.phase);
  if (Number.isFinite(value.ended_at) && phaseHistory.at(-1) === 'report') phaseHistory.push('awaiting_fidelity');
  const phaseRounds = {};
  for (const item of value.phases) if (item.round !== null) phaseRounds[item.phase] = item.round;
  const criticRounds = phaseRounds.critic || 0;
  return { source, phaseHistory, phaseRounds, criticRounds, phases: value.phases, lanes: Array.isArray(value.lanes) ? value.lanes : [] };
}
function info(file) { const safeFile = safePath(file); return safeFile ? infoUnrestricted(safeFile) : null; }
function linkInfo(file) { try { return safePath(file) ? fs.lstatSync(file) : null; } catch { return null; } }
function cardIds(value) { return [...new Set(String(value || '').match(/\b\d{19}\b/g) || [])]; }
function briefCard(value) {
  const title = markdownHeadings(value).find(heading => !standardPreamble(heading)) || '';
  return title.match(/^(?:Brief[^\n]*\bcard\s+|Card\s+)(\d{19})\b/i)?.[1] || null;
}
function cardMarkdownId(value) { return String(value || '').match(/^Card(?: id)?:\s*(\d{19})\b/im)?.[1] || null; }
function markdownHeadings(value) { return [...String(value || '').matchAll(/^#\s+(.+)$/gm)].map(match => match[1].trim()); }
function markdownTitle(value) { return markdownHeadings(value)[0] || null; }
function standardPreamble(value) { return /^Standing preamble for every external-lane brief\b/i.test(String(value || '').trim()); }
function externalTitle(value) { return markdownHeadings(value).find(title => !standardPreamble(title))?.replace(/^Brief\s*(?::|—)\s*/i, '') || null; }
function cleanCardTitle(value, id) {
  let title = String(value || '').trim();
  if (id) title = title.replace(new RegExp('^card\\s+' + id + '\\s*(?:,|:|—|-)\\s*', 'i'), '');
  title = title.replace(/^step\s+\d+\s*[.:,—-]?\s*/i, '');
  return title.trim() || null;
}
function laneCardReceipt(worktree, requestedId = null) {
  const names = list(lanePath(worktree)).filter(name => /^card-\d{19}\.md$/.test(name));
  const name = (requestedId && names.find(candidate => candidate === 'card-' + requestedId + '.md')) || names.sort()[0];
  if (!name) return null;
  const id = name.match(/^card-(\d{19})\.md$/)?.[1] || null;
  return id ? { id, title: cleanCardTitle(markdownTitle(head(lanePath(worktree, name))), id) } : null;
}
function envField(file, name) {
  const value = head(file, 32 * 1024);
  if (value === null) return null;
  const match = value.match(new RegExp('^' + name + '=(.*)$', 'm'));
  return match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') || null;
}
const plankaBaseUrl = String(config.plankaBaseUrl || (config.plankaConfigFile ? envField(config.plankaConfigFile, 'BASE_URL') : '') || '').trim().replace(/\/+$/, '');
function cardUrl(id) { return plankaBaseUrl && id ? plankaBaseUrl + '/cards/' + encodeURIComponent(id) : null; }
function lifecycleComplete(value) {
  if (value?.complete === true || value?.completed === true || value?.done === true) return true;
  return [value?.phase, value?.status, value?.state].some(item => /^(?:complete(?:d)?|done|closed|closure)(?:\b|[^\w])/i.test(String(item || '').trim().replace(/^[^\w]+/, '')));
}
function minutes(iso) { const at = Date.parse(iso || ''); return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60000)) : null; }
function freshTime(at) { return Number.isFinite(at) && now - at <= ACTIVE_WINDOW_MS; }
function phaseOf(value) {
  const phase = String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
  return PHASES.includes(phase) ? phase : UNKNOWN;
}
function statesOf(history, route) {
  const accepted = history.map(phaseOf).filter(phase => phase !== UNKNOWN);
  const current = accepted.at(-1);
  const visited = new Set(accepted);
  const furthest = accepted.reduce((max, phase) => Math.max(max, PHASES.indexOf(phase)), -1);
  return Object.fromEntries(PHASES.map((phase, index) => {
    if (phase === current) return [phase, 'running'];
    if (visited.has(phase) || (phase === 'discovery' && accepted.length)) return [phase, 'done'];
    if ((route === 'LITE' && LITE_SKIPS.has(phase)) || index < furthest) return [phase, 'skipped'];
    return [phase, 'not started'];
  }));
}
function bounded(lines, maxLines = 20, maxChars = 2400) {
  const kept = lines.map(line => String(line).trim()).filter(Boolean).slice(0, maxLines);
  let value = kept.join('\n');
  if (value.length > maxChars) value = value.slice(0, maxChars - 1) + '…';
  return value || 'No summary available.';
}
function planSummary(value) {
  const lines = String(value || '').split(/\r?\n/); const result = [];
  const decisionAt = lines.findIndex(line => /^###\s+Decision\s*$/i.test(line));
  if (decisionAt >= 0) for (let index = decisionAt + 1; index < lines.length && !/^#{1,3}\s/.test(lines[index]); index += 1) if (lines[index].trim()) result.push(lines[index].replace(/^\s*(?:[-*+] |\d+[.)]\s+)/, ''));
  const tasksAt = lines.findIndex(line => /^##\s+Tasks\s*$/i.test(line));
  if (tasksAt >= 0) for (let index = tasksAt + 1; index < lines.length && !/^##\s/.test(lines[index]); index += 1) {
    const item = /^\s*(?:[-*+] |\d+[.)]\s+)(.+)$/.exec(lines[index]);
    if (item) result.push((item[1].match(/^\*\*([^*]+)\*\*/)?.[1] || item[1]).trim());
  }
  return bounded(result);
}
function criticSummary(value) {
  const lines = String(value || '').split(/\r?\n/); const result = [];
  const verdict = lines.find(line => /^VERDICT:/i.test(line)); if (verdict) result.push(verdict);
  const findingsAt = lines.findIndex(line => /^FINDINGS:\s*$/i.test(line));
  if (findingsAt >= 0) for (let index = findingsAt + 1; index < lines.length; index += 1) { const item = /^\s*[-*+]\s+(.+)$/.exec(lines[index]); if (item) result.push(item[1]); }
  return bounded(result);
}
function reportSummary(value) {
  const lines = String(value || '').split(/\r?\n/); const result = [];
  const deferred = lines.find(line => /^Deferred:\s*\S/i.test(line));
  if (deferred) result.push(deferred.trim());
  const wanted = /^(?:Implemented|Remaining Risks)$/i;
  const hasWanted = lines.some(line => wanted.test(line.replace(/^##\s+/, '').trim()) && /^##\s+/.test(line));
  for (let index = 0; index < lines.length; index += 1) if (/^##\s+/.test(lines[index]) && (!hasWanted || wanted.test(lines[index].replace(/^##\s+/, '').trim()))) {
    result.push(lines[index].replace(/^##\s+/, '').trim());
    for (let next = index + 1; next < lines.length && !/^##\s+/.test(lines[next]); next += 1) if (lines[next].trim() && !/^#/.test(lines[next])) { result.push(lines[next].trim()); break; }
  }
  return bounded(result);
}
function finalExit(file) {
  const exits = [...String(file ? tail(file) : '').matchAll(/^EXIT=(\d+)$/gm)];
  if (!exits.length) return null;
  const code = Number(exits.at(-1)[1]);
  return 'run: ' + (code === 0 ? 'pass' : 'fail') + ' (EXIT=' + code + ')';
}
function reportBody(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^#{1,6}\s+/.test(line));
}
function findingsIn(value) {
  const lines = String(value || '').split(/\r?\n/);
  const findingsAt = lines.findIndex(line => /^FINDINGS:\s*$/i.test(line));
  const listed = findingsAt < 0 ? [] : lines.slice(findingsAt + 1).filter(line => /^\s*[-*+]\s+\S/.test(line));
  const headings = lines.filter(line => /^###\s+[A-Z]+-\d+\b/.test(line));
  const count = listed.length || headings.length;
  return count || UNKNOWN;
}
function phaseReportSummary(reportFile, briefFile, runFile) {
  const report = reportFile ? slice(reportFile, REPORT_TAIL_BYTES) : null;
  const brief = briefFile ? head(briefFile) : null;
  const title = markdownTitle(brief);
  if (!report) return bounded([title ? 'brief: ' + title : null, finalExit(runFile)].filter(Boolean));
  const verdict = [...String(report).matchAll(/^(?:VERDICT|(?:review\s+)?decision):\s*([^\n]+)/gim)].at(-1)?.[1]?.trim().toLowerCase() || UNKNOWN;
  const body = reportBody(report).filter(line => !/^(?:VERDICT|(?:review\s+)?decision|FINDINGS):/i.test(line)).map(line => line.replace(/^[-*+]\s+/, ''));
  const findings = findingsIn(report);
  return bounded([verdict !== UNKNOWN ? 'verdict: ' + verdict : null, findings !== UNKNOWN ? 'findings: ' + findings : null, ...body, title ? 'brief: ' + title : null].filter(Boolean));
}
function tddSummary(reportFile, runFile, briefFile) {
  const report = reportFile ? slice(reportFile, REPORT_TAIL_BYTES) : null;
  const lines = report ? reportBody(report) : [];
  if (!report) {
    const title = markdownTitle(briefFile ? head(briefFile) : null);
    if (title) lines.push('brief: ' + title);
  }
  const exit = finalExit(runFile); if (exit) lines.push(exit);
  return bounded(lines);
}
function under(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function renderArtifact(source) {
  const stat = info(source); const lane = path.dirname(source); const target = source + '.html';
  const truncated = Boolean(stat?.isFile() && stat.size > REPORT_TAIL_BYTES);
  if (config.readOnly) return { href: null, truncated };
  try {
    if (!stat?.isFile() || linkInfo(source)?.isSymbolicLink() || path.basename(lane) !== laneDirName || linkInfo(target)?.isSymbolicLink()) return { href: null, truncated };
    const suite = fs.realpathSync(config.suiteRoot);
    const realLane = fs.realpathSync(lane);
    const realSource = fs.realpathSync(source);
    const realTarget = info(target) ? fs.realpathSync(target) : path.join(realLane, path.basename(target));
    if (![realLane, realSource, realTarget].every(candidate => under(suite, candidate))) return { href: null, truncated };
    const rendered = info(target);
    const prior = rendered ? /^<!-- wt-source (\{[^\n]+\}) -->/.exec(head(target, 1024) || '') : null;
    let metadata = null;
    try { metadata = prior ? JSON.parse(prior[1]) : null; } catch {}
    if (!rendered || metadata?.mtimeMs !== stat.mtimeMs || metadata?.size !== stat.size) {
      const markdown = slice(source, REPORT_TAIL_BYTES); if (markdown === null) return { href: null, truncated };
      const title = path.basename(source);
      const marker = '<!-- wt-source ' + JSON.stringify({ mtimeMs: stat.mtimeMs, size: stat.size }) + ' -->\n';
      fs.writeFileSync(target, marker + '<!doctype html><html><head><meta charset="utf-8"><title>' + title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '</title></head><body>' + markdownToHtml(markdown) + '</body></html>');
    }
    return { href: detectArtifactUrl(target, process.platform, process.env, config.linkBase || '', config.suiteRoot), truncated };
  } catch { return { href: null, truncated }; }
}
function inspectors(worktree, route, runnerLog) {
  if (!worktree) return {};
  const lane = lanePath(worktree);
  const files = list(lane).map(name => path.join(lane, name)).filter(file => info(file)?.isFile());
  const matching = pattern => files.filter(file => pattern.test(path.basename(file))).sort((left, right) => (info(right)?.mtimeMs || 0) - (info(left)?.mtimeMs || 0) || right.localeCompare(left));
  const first = (...candidates) => candidates.flat().find(file => file && info(file)?.isFile()) || null;
  const concise = selected => bounded(selected.flatMap(file => String(slice(file, REPORT_TAIL_BYTES) || '').split(/\r?\n/)));
  const laneEvidence = phase => matching(new RegExp('^' + phase + '-(?:brief\\.md|run(?:\\.[^.]+)?\\.log|report(?:\\.[^.]+)?\\.md)$', 'i'));
  const routeReasons = Array.isArray(route?.reasons) ? route.reasons.join(', ') : 'none recorded';
  const effective = String(runnerLog || '').match(/\beffective=([^\s]+)/)?.[1] || route?.model || route?.effective || route?.models?.lane || UNKNOWN;
  const discoveryFile = path.join(lane, 'route.json');
  const critics = matching(/^critic-report(?:\.[^.]+)?\.md$/i);
  const tddBrief = first(path.join(lane, 'tdd-brief.md'));
  const tddRun = first(path.join(lane, 'tdd-run.log'), matching(/^tdd-run\.[^.]+\.log$/i));
  const tddReport = first(path.join(lane, 'tdd-report.md'), matching(/^tdd-report\.[^.]+\.md$/i));
  const phaseEvidence = phase => ({
    brief: first(path.join(lane, phase + '-brief.md'), matching(new RegExp('^' + phase + '-brief\\.[^.]+\\.md$', 'i'))),
    run: first(path.join(lane, phase + '-run.log'), matching(new RegExp('^' + phase + '-run\\.[^.]+\\.log$', 'i'))),
    report: first(path.join(lane, phase + '-report.md'), matching(new RegExp('^' + phase + '-report\\.[^.]+\\.md$', 'i'))),
  });
  const gateFiles = ['typecheck', 'lint', 'test'].map(name => ({ name, file: path.join(lane, name + '.log') })).filter(item => info(item.file)?.isFile());
  const verifySummary = gateFiles.length ? gateFiles.map(({ name, file }) => {
    const value = tail(file); const exits = [...String(value || '').matchAll(/^EXIT=(\d+)$/gm)]; const code = exits.length ? Number(exits.at(-1)[1]) : null;
    return name + ': ' + (code === null ? 'running, no exit yet' : code === 0 ? 'pass' : 'fail (' + code + ')');
  }).join('\n') : null;
  const specs = [
    ['discovery', info(discoveryFile)?.isFile() ? [discoveryFile] : [], () => bounded([route?.route && route.route !== UNKNOWN ? 'Route: ' + route.route : null, routeReasons !== UNKNOWN ? 'Reasons: ' + routeReasons : null, effective !== UNKNOWN ? 'Model: ' + effective : null].filter(Boolean))],
    ['plan', [path.join(lane, 'plan.md')].filter(file => info(file)?.isFile()), selected => planSummary(slice(selected[0], REPORT_TAIL_BYTES))],
    ['critic', critics.slice(0, 1), selected => criticSummary(slice(selected[0], REPORT_TAIL_BYTES))],
    ['tdd', [tddReport, tddRun, tddBrief].filter(Boolean), () => tddSummary(tddReport, tddRun, tddBrief)],
    ['verify', gateFiles.map(item => item.file), () => verifySummary],
    ...['review', 'refutation', 'harden'].map(phase => {
      const evidence = phaseEvidence(phase);
      const selected = [evidence.report, evidence.run, evidence.brief, ...laneEvidence(phase)].filter((file, index, all) => file && all.indexOf(file) === index);
      return [phase, selected, () => phaseReportSummary(evidence.report, evidence.brief, evidence.run)];
    }),
    ['report', [path.join(lane, 'pilot-report.md')].filter(file => info(file)?.isFile()), selected => reportSummary(slice(selected[0], REPORT_TAIL_BYTES))],
  ];
  const result = {};
  for (const [phase, selected, summarize] of specs) if (selected.length) {
    const source = first(selected); if (!source) continue;
    const rendered = renderArtifact(source);
    result[phase] = { summary: summarize(selected), source, artifact: path.basename(source), href: rendered.href, truncated: rendered.truncated };
  }
  return result;
}
function walk(root, accept, maxDepth = 5, maxEntries = 5000) {
  const found = []; const stack = [{ dir: root, depth: 0 }]; let seen = 0;
  while (stack.length && seen < maxEntries) {
    const current = stack.pop();
    const listing = listed(current.dir, Math.min(DIR_SCAN_CAP, maxEntries - seen), false);
    if (listing.capped) approximateWalkRoots.add(root);
    for (const name of listing.entries) {
      if (seen >= maxEntries) break;
      seen += 1;
      const file = path.join(current.dir, name); const link = linkInfo(file);
      if (!link || link.isSymbolicLink()) continue;
      const stat = info(file);
      if (!stat) continue;
      if (stat.isFile() && accept(file, name)) found.push(file);
      if (stat.isDirectory() && current.depth < maxDepth && !['.git', 'node_modules', 'dist', 'build'].includes(name) && !/^(?:child-)?coverage(?:[-_.].*)?$/i.test(name)) stack.push({ dir: file, depth: current.depth + 1 });
    }
  }
  if (stack.length) approximateWalkRoots.add(root);
  return found;
}
function freshestWrite(root) {
  let latest = null;
  for (const file of walk(root, () => true, 4, 4000)) {
    if (/\.md\.html$/i.test(file)) continue;
    const stat = info(file); if (stat && (latest === null || stat.mtimeMs > latest)) latest = stat.mtimeMs;
  }
  return latest;
}
function toolActivity(value) {
  const clean = line => stripAnsiAndControl(line).trim();
  const lines = String(value || '').split(/\r?\n/).map(clean).filter(Boolean);
  return lines.filter(line => /^(?:(?:→\s*)?(?:Read|Write|Edit|Patch)\b|\$\s+\S)/.test(line)).at(-1) || UNKNOWN;
}
function laneActivity(worktree, lastWrite = null) {
  const current = toolActivity(tail(lanePath(worktree, 'run.log')));
  return current !== UNKNOWN ? current : lastWrite === null ? UNKNOWN : 'last write ' + (approximateWalkRoots.has(worktree) ? 'at least ' : '') + Math.max(0, Math.round((now - lastWrite) / 60000)) + ' min ago';
}
function laneSessionId(worktree) {
  const value = worktree ? envField(lanePath(worktree, 'env.log'), 'CLAUDE_CODE_SESSION_ID') : null;
  return value && /^[A-Za-z0-9-]{4,128}$/.test(value) ? value : null;
}
function laneModel(worktree) {
  const live = processByWorktree.get(worktree)?.model;
  if (live && live !== UNKNOWN) return live;
  const runLog = tail(lanePath(worktree, 'run.log')) || '';
  const envLog = head(lanePath(worktree, 'env.log')) || '';
  const model = runLog.match(/^>\s+\S+\s+·\s+([^\s]+)\s*$/m)?.[1]
    || runLog.match(/^(?:model|requested_model|served_model)=([^\s]+)\s*$/m)?.[1]
    || envLog.match(/^(?:WT_LANE_MODEL|OPENCODE_MODEL|MODEL)=([^\s]+)\s*$/m)?.[1];
  return model && model !== UNKNOWN ? model : null;
}
function elapsedFromPidFile(worktree) {
  const stat = worktree ? info(lanePath(worktree, 'pid')) : null;
  if (!stat) return UNKNOWN;
  const value = Math.max(0, Math.round((now - stat.mtimeMs) / 60000));
  return value < 60 ? value + ' min' : Math.floor(value / 60) + ' h ' + value % 60 + ' min';
}
function formatAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return UNKNOWN;
  const value = Math.floor(seconds / 60);
  return value < 60 ? value + ' min' : Math.floor(value / 60) + ' h ' + value % 60 + ' min';
}
function processAge(pid) {
  if (!Number.isFinite(procUptime) || clockTicksAvailability.status !== 'available') return { seconds: null, text: UNKNOWN };
  const stat = head(path.join(procRoot, String(pid), 'stat'), 4096);
  const end = stat?.lastIndexOf(')');
  if (end === undefined || end < 0) return { seconds: null, text: UNKNOWN };
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  const startTicks = Number(fields[19]);
  const seconds = procUptime - startTicks / clockTicks;
  return Number.isFinite(startTicks) && startTicks >= 0 && seconds >= 0 ? { seconds, text: formatAge(seconds) } : { seconds: null, text: UNKNOWN };
}
function readSuiteLockSnapshot() {
  const root = config.suiteLockRoot;
  if (typeof root !== 'string' || !path.isAbsolute(root)) return { status: UNKNOWN };
  const lockDir = path.join(root, 'lock.d');
  try {
    if (!fs.statSync(lockDir).isDirectory()) return { status: UNKNOWN };
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'free' } : { status: UNKNOWN };
  }
  let holder;
  let handle;
  try {
    handle = fs.openSync(path.join(lockDir, 'holder.json'), 'r');
    const size = fs.fstatSync(handle).size;
    if (size > JSON_BYTES) return { status: UNKNOWN };
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(handle, buffer, 0, size, 0);
    holder = JSON.parse(buffer.subarray(0, read).toString('utf8'));
  } catch { return { status: UNKNOWN }; }
  finally { if (handle !== undefined) try { fs.closeSync(handle); } catch {} }
  if (!Number.isSafeInteger(holder?.pid) || holder.pid <= 0 || !Array.isArray(holder.argv)
    || typeof holder.cwd !== 'string' || !Number.isFinite(Date.parse(holder.startedAt))) return { status: UNKNOWN };
  let live;
  try { process.kill(holder.pid, 0); live = true; }
  catch (error) { live = error?.code === 'EPERM' ? true : error?.code === 'ESRCH' ? false : null; }
  if (live === null) return { status: UNKNOWN };
  const recorded = stripAnsiAndControl(holder.argv.map(value => String(value)).join(' '));
  const command = recorded.length > 72 ? recorded.slice(0, 69) + '...' : recorded || UNKNOWN;
  // An elapsed age, never a clock time: the pane has no reliable time zone, and a UTC clock reads wrong locally.
  return {
    status: live ? 'running' : 'stale', pid: holder.pid, command,
    startedAt: new Date(holder.startedAt).toISOString(),
    age: formatAge((Date.now() - Date.parse(holder.startedAt)) / 1000),
    worktree: stripAnsiAndControl(holder.cwd) || UNKNOWN,
  };
}
function actorElapsed(worktree, pid) {
  const live = processAge(pid).text;
  if (live !== UNKNOWN) return live;
  const fallback = elapsedFromPidFile(worktree);
  return fallback === UNKNOWN ? UNKNOWN : '~' + fallback;
}
function sdkLogFile(worktree) {
  const lane = lanePath(worktree);
  const current = path.join(lane, 'sdk-pilot.log');
  return info(current)?.isFile() ? current : path.join(lane, 'runner-stdout.log');
}
function pilotElapsed(worktree, pid) {
  const live = processAge(pid).text;
  if (live !== UNKNOWN) return live;
  const route = info(lanePath(worktree, 'route.json'));
  const runnerLog = info(sdkLogFile(worktree));
  const startedAt = route?.mtimeMs || (runnerLog?.birthtimeMs > 0 ? runnerLog.birthtimeMs : null);
  const durable = Number.isFinite(startedAt) ? formatAge((now - startedAt) / 1000) : UNKNOWN;
  return durable === UNKNOWN ? UNKNOWN : '~' + durable;
}
function gate(worktree, name) {
  const file = lanePath(worktree, name + '.log');
  const value = tail(file);
  if (value === null) return { value: UNKNOWN, source: null };
  const exits = [...value.matchAll(/^EXIT=(\d+)$/gm)];
  if (!exits.length) return { value: UNKNOWN, source: file };
  const code = Number(exits.at(-1)[1]);
  return { value: code === 0 ? 'pass' : 'fail (' + code + ')', source: file };
}
function reviews(worktree, id) {
  const files = [lanePath(worktree, 'report.md'), ...walk(path.join(worktree, '.claude', 'reports'), (_file, name) => /\.md$/i.test(name), 4, 300), ...walk(path.join(config.suiteRoot, 'reports'), (_file, name) => /\.md$/i.test(name), 3, 10_000)];
  let lenses = null; let findings = null; let decision = null; let source = null;
  for (const file of [...new Set(files)]) {
    const value = tail(file, REPORT_TAIL_BYTES); if (value === null) continue;
    const globalReport = file.startsWith(path.join(config.suiteRoot, 'reports') + path.sep);
    if (globalReport && !file.includes(id) && !value.includes(id)) continue;
    source ||= file;
    const lensValue = value.match(/lenses?\s+(?:run\s*)?:\s*([^\n]+)/i)?.[1]?.trim();
    const findingValue = value.match(/open findings?\s*:\s*(\d+|none|unknown)\b/i)?.[1]?.trim();
    const decisionValue = value.match(/(?:review\s+)?decision\s*:\s*(approved|changes requested|blocked|accepted|rejected|pass|fail)\b/i)?.[1]?.trim();
    if (!lenses && lensValue && /^[a-z0-9._, -]+$/i.test(lensValue)) lenses = lensValue;
    findings ||= findingValue || null;
    decision ||= decisionValue || null;
  }
  return { lenses: lenses || UNKNOWN, findings: findings || UNKNOWN, decision: decision || UNKNOWN, source };
}
function usage(worktree, model) {
  const sdkFile = lanePath(worktree, 'usage.json');
  const sdkUsage = json(sdkFile);
  if (sdkUsage?.totals && typeof sdkUsage.totals === 'object') {
    const totals = {
      input: sdkUsage.totals.input,
      output: sdkUsage.totals.output,
      cacheCreation: sdkUsage.totals.cache_creation,
      cacheRead: sdkUsage.totals.cache_read,
    };
    if (Object.values(totals).some(Number.isFinite)) {
      for (const key of Object.keys(totals)) if (!Number.isFinite(totals[key])) totals[key] = UNKNOWN;
      return { value: String(Object.values(totals).filter(Number.isFinite).reduce((sum, value) => sum + value, 0)), totals, source: sdkFile };
    }
  }
  if (/\bgpt\b|^gpt-/i.test(model || '')) return { value: 'not counted', totals: null, source: null };
  const files = walk(worktree, (_file, name) => name === 'usage.json', 5, 2000);
  if (!files.length) return { value: UNKNOWN, totals: null, source: null };
  let total = 0; let measured = false; let source = null;
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'number' && /^(?:input_tokens|output_tokens|tokens_input|tokens_output|tokens_reasoning)$/.test(key)) { total += item; measured = true; }
      else if (key !== 'environment' && key !== 'env') visit(item);
    }
  };
  for (const file of files) { const value = json(file); if (value !== null) source ||= file; visit(value); }
  return { value: measured ? String(total) : UNKNOWN, totals: null, source };
}
function tokenValue(value, ...names) {
  for (const name of names) if (Number.isFinite(value?.[name])) return Number(value[name]);
  return null;
}
function normalizedPriceModel(model) {
  const value = String(model || '').toLowerCase().replace(/-\d{8}$/, '');
  const inferredProvider = value.startsWith('claude-') ? 'anthropic/' : value.startsWith('gpt-') ? 'openai/' : null;
  const matches = Object.keys(priceTable.models || {}).filter(canonical => {
    const canonicalValue = canonical.toLowerCase().replace(/-\d{8}$/, '');
    if (value === canonicalValue) return true;
    const family = priceTable.models[canonical]?.family;
    if (family && value === String(family).toLowerCase() + '/' + canonicalValue) return true;
    return !value.includes('/') && (!inferredProvider || canonicalValue.startsWith(inferredProvider)) && canonicalValue.split('/').at(-1) === value;
  });
  return matches.length === 1 ? matches[0] : null;
}
function priceInfo(model, values) {
  const canonical = normalizedPriceModel(model);
  if (!canonical) return { usd: PRICE_UNKNOWN, label: PRICE_UNKNOWN };
  const base = priceTable.models[canonical];
  const context = values.input + values.cacheRead + values.cacheWrite;
  const tier = (Array.isArray(base.tiers) ? base.tiers : []).filter(item => item?.tier?.type === 'context' && context > Number(item.tier.size)).sort((a, b) => Number(b.tier.size) - Number(a.tier.size))[0];
  const price = tier ? { ...base, ...tier } : base;
  const rates = [price.input, price.cache_write || 0, price.cache_read || 0, price.output];
  if (!Number.isFinite(Number(rates[0])) || !Number.isFinite(Number(rates[3]))) return { usd: PRICE_UNKNOWN, label: PRICE_UNKNOWN };
  if (rates.every(rate => Number(rate) === 0)) return { usd: 'subscription', label: 'subscription' };
  const verified = Date.parse(base.verified_at || base.retrieved || priceTable.as_of || '');
  const label = Number.isFinite(verified) && now - verified > 60 * 24 * 60 * 60 * 1000 ? 'price not verified since ' + new Date(verified).toISOString().slice(0, 10) : canonical.startsWith('openai/') ? 'API price equivalent' : 'API price';
  return { usd: (values.input * rates[0] + values.cacheWrite * rates[1] + values.cacheRead * rates[2] + values.output * rates[3]) / 1000000, label };
}
const pricedUsage = (model, values) => priceInfo(model, values).usd;
const addUsd = (left, right) => left === PRICE_UNKNOWN || right === PRICE_UNKNOWN ? PRICE_UNKNOWN : left === 'subscription' ? (Number(right) ? right : 'subscription') : right === 'subscription' ? (Number(left) ? left : 'subscription') : left + right;
function phaseCostRows(phases) {
  const result = {};
  for (const phase of Array.isArray(phases) ? phases : []) {
    const id = phaseOf(phase?.phase);
    if (id === UNKNOWN) continue;
    if (result[id] === UNKNOWN || (Array.isArray(phase.unknown) && phase.unknown.length) || !phase.models || typeof phase.models !== 'object') {
      result[id] = UNKNOWN;
      continue;
    }
    const previous = result[id];
    const totals = previous ? { input: previous.input, output: previous.output, cacheRead: previous.cacheRead, cacheWrite: previous.cacheWrite, usd: previous.usd, priceLabel: previous.priceLabel, models: { ...previous.models } } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, models: {} };
    let measured = false; let incomplete = false;
    for (const [modelName, model] of Object.entries(phase.models)) {
      const values = {
        input: tokenValue(model, 'input', 'input_tokens', 'tokens_input'),
        output: tokenValue(model, 'output', 'output_tokens', 'tokens_output'),
        cacheRead: tokenValue(model, 'cache_read', 'cache_read_input_tokens', 'cacheRead', 'tokens_cache_read'),
        cacheWrite: tokenValue(model, 'cache_write', 'cache_creation', 'cache_creation_input_tokens', 'cacheWrite', 'tokens_cache_write'),
      };
      if (Object.values(values).some(value => value === null)) { incomplete = true; break; }
      measured = true;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) totals[key] += values[key];
      const usd = model.usd ?? pricedUsage(modelName, values);
      const priceLabel = model.price_label || priceInfo(modelName, values).label;
      const priorModel = totals.models[modelName] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) priorModel[key] += values[key];
      priorModel.usd = addUsd(priorModel.usd, usd);
      totals.models[modelName] = priorModel;
      totals.usd = addUsd(totals.usd, usd);
      if (priceLabel) totals.priceLabel = totals.priceLabel && totals.priceLabel !== priceLabel ? totals.priceLabel + '; ' + priceLabel : priceLabel;
    }
    result[id] = measured && !incomplete ? totals : UNKNOWN;
  }
  return result;
}
function summedCost(values) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, models: {} };
  let measured = false;
  for (const value of values) {
    if (!value || value === UNKNOWN) continue;
    measured = true;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) total[key] += Number(value[key]) || 0;
    total.usd = addUsd(total.usd, value.usd);
    if (value.priceLabel) total.priceLabel = total.priceLabel && total.priceLabel !== value.priceLabel ? total.priceLabel + '; ' + value.priceLabel : value.priceLabel;
  }
  return measured ? total : null;
}
function livePhaseCosts(worktree, timeline) {
  const buckets = new Map();
  const unknown = new Set();
  const run = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, models: {} };
  let runMeasured = false;
  const add = (phase, usageValue, model) => {
    const id = phaseOf(phase);
    const values = {
      input: tokenValue(usageValue, 'input', 'input_tokens', 'tokens_input'),
      output: tokenValue(usageValue, 'output', 'output_tokens', 'tokens_output'),
      cacheRead: tokenValue(usageValue, 'cache_read', 'cache_read_input_tokens', 'cacheRead', 'tokens_cache_read'),
      cacheWrite: tokenValue(usageValue, 'cache_write', 'cache_creation', 'cache_creation_input_tokens', 'cacheWrite', 'tokens_cache_write'),
    };
    if (values.input === null || values.output === null) { if (id !== UNKNOWN) unknown.add(id); return; }
    // Live SDK receipts omit zero-valued cache fields on some versions; only absent cache fields are measured zero.
    for (const key of ['cacheRead', 'cacheWrite']) if (values[key] === null) values[key] = 0;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) run[key] += values[key];
    const info = priceInfo(model, values); const usd = info.usd;
    run.usd = addUsd(run.usd, usd); run.priceLabel = info.label;
    runMeasured = true;
    const modelName = model || UNKNOWN;
    const runModel = run.models[modelName] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) runModel[key] += values[key];
    runModel.usd = addUsd(runModel.usd, usd);
    run.models[modelName] = runModel;
    if (id === UNKNOWN) return;
    const target = buckets.get(id) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, models: {} };
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) target[key] += values[key];
    target.usd = addUsd(target.usd, usd); target.priceLabel = info.label;
    const targetModel = target.models[modelName] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) targetModel[key] += values[key];
    targetModel.usd = addUsd(targetModel.usd, usd);
    target.models[modelName] = targetModel;
    buckets.set(id, target);
  };
  const usageFile = lanePath(worktree, 'usage.json');
  const liveUsage = json(usageFile);
  if (Array.isArray(liveUsage?.phases)) {
    const costs = phaseCostRows(liveUsage.phases);
    return { costs, total: summedCost(Object.values(costs)), source: usageFile };
  }
  for (const message of liveUsage?.messages || liveUsage?.turns || []) {
    const timestamp = Date.parse(message.arrived_at || message.ended_at || message.timestamp || '');
    const phase = timeline?.phases?.find(item => timestamp >= item.entered_at && timestamp <= (item.exited_at ?? Infinity));
    add(phase?.phase, message, message.model);
  }
  for (const lane of timeline?.lanes || []) {
    const file = typeof lane?.usage_file === 'string' ? lanePath(worktree, lane.usage_file) : null;
    const laneUsage = file ? json(file) : null;
    if (!laneUsage) { unknown.add(phaseOf(lane?.phase)); continue; }
    add(lane.phase, laneUsage.totals || laneUsage, laneUsage.model || lane.model);
  }
  const costs = {};
  for (const [phase, totals] of buckets) costs[phase] = unknown.has(phase) ? UNKNOWN : totals;
  for (const phase of unknown) if (phase !== UNKNOWN && !Object.hasOwn(costs, phase)) costs[phase] = UNKNOWN;
  return { costs, total: runMeasured ? run : null, source: liveUsage || timeline?.lanes?.length ? usageFile : null };
}
function phaseCosts(worktree, timeline) {
  const summary = json(lanePath(worktree, 'summary.json'));
  const archivePath = summary?.archive?.path;
  const reportsRoot = path.join(config.suiteRoot, 'reports');
  if (typeof archivePath === 'string' && path.isAbsolute(archivePath) && under(reportsRoot, archivePath)) {
    const archiveCost = path.join(archivePath, 'cost.json');
    const cost = json(archiveCost);
    if (cost) return { costs: phaseCostRows(cost.phases), total: cost.totals?.usd !== undefined ? { usd: cost.totals.usd, priceLabel: Array.isArray(cost.price_labels) ? cost.price_labels.join('; ') : undefined, priceUnknownModels: Array.isArray(cost.price_unknown_models) ? cost.price_unknown_models : [] } : summedCost(Object.values(phaseCostRows(cost.phases))), source: archiveCost, kind: 'archive cost.json' };
    if (slice(archiveCost, JSON_BYTES, false, true) !== null) return { costs: Object.fromEntries(PHASES.map(phase => [phase, UNKNOWN])), source: archiveCost, kind: 'malformed archive cost.json' };
  }
  const live = livePhaseCosts(worktree, timeline);
  return { ...live, kind: live.source ? 'live usage file' : null };
}
function phaseElapsed(timeline) {
  const result = {};
  for (const phase of timeline?.phases ?? []) if (phase.exited_at === null) result[phase.phase] = formatAge((now - phase.entered_at) / 1000);
  return result;
}

const lifecycleStartedAt = Date.now();
const lifecycle = new Map();
const lifecycleFiles = listed(path.join(config.configDir, 'plugins', 'store'));
for (const file of lifecycleFiles.entries.filter(name => /^wt-lifecycle-hooks.*\.json$/.test(name))) {
  const storeFile = path.join(config.configDir, 'plugins', 'store', file);
  if (linkInfo(storeFile)?.isSymbolicLink()) continue;
  const storeStat = info(storeFile);
  const store = json(storeFile);
  for (const [key, value] of Object.entries(store || {})) {
    const recordTime = value?.at === undefined ? storeStat?.mtimeMs : Date.parse(value.at || '');
    if (/^card\.\d{19}$/.test(key) && freshTime(recordTime) && !lifecycleComplete(value)) {
      const rawWorktree = value?.worktree || value?.cwd || null;
      const worktree = rawWorktree ? resolveActorPath(rawWorktree, 'lifecycle', true) : null;
      if (rawWorktree && !worktree) continue;
      lifecycle.set(key.slice(5), { ...value, ...(worktree ? { worktree } : {}), sourcePath: storeFile });
    }
  }
}
timingsMs.lifecycleRecords = Date.now() - lifecycleStartedAt;

const livenessStartedAt = Date.now();
const liveness = new Map();
const livenessFiles = listed(config.livenessDir);
for (const file of livenessFiles.entries.filter(name => name.endsWith('.json'))) {
  const livenessFile = path.join(config.livenessDir, file);
  if (linkInfo(livenessFile)?.isSymbolicLink()) continue;
  const value = json(livenessFile);
  if (!value || lifecycleComplete(value) || !freshTime(Date.parse(value.updatedAt || ''))) continue;
  const rawWorktree = value.worktree || value.cwd || null;
  const worktree = rawWorktree ? resolveActorPath(rawWorktree, 'liveness', true) : null;
  if (rawWorktree && !worktree) continue;
  for (const id of cardIds(value.scope)) liveness.set(id, { ...value, ...(worktree ? { worktree } : {}), sourcePath: livenessFile });
}
timingsMs.livenessRecords = Date.now() - livenessStartedAt;

const registryStartedAt = Date.now();
const spawnByCard = new Map();
const registryRoot = path.join(config.configDir, 'plugins', 'data');
const registryListing = listed(registryRoot);
const registryFiles = walk(registryRoot, (_file, name) => name.endsWith('.jsonl'), 5, 3000);
for (const file of registryFiles) {
  const records = (tail(file, JSON_BYTES) || '').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const openByName = new Map(); const openById = new Map();
  const forget = record => {
    const open = openByName.get(record.name) || openById.get(record.agentId);
    if (!open) return;
    if (open.childName) openByName.delete(open.childName);
    if (open.child) openById.delete(open.child);
  };
  for (const record of records) {
    if (record.t === 'spawn' && record.name) {
      if (record.childName) openByName.set(record.childName, record);
      if (record.child) openById.set(record.child, record);
    } else if (record.t === 'stop' || record.t === 'ack') forget(record);
  }
  for (const record of [...new Set([...openByName.values(), ...openById.values()])]) {
    for (const id of cardIds(record.purpose)) {
      const rawWorktree = record.worktree || record.cwd || null;
      const worktree = rawWorktree ? resolveActorPath(rawWorktree, 'spawn registry', true) : null;
      if (rawWorktree && !worktree) continue;
      const workers = spawnByCard.get(id) || [];
      workers.push({ name: record.childName || record.name || 'sub-agent', model: record.model || UNKNOWN, parent: record.parentName || record.parent || UNKNOWN, ...(worktree ? { worktree } : {}) });
      spawnByCard.set(id, workers);
    }
  }
}
timingsMs.spawnRegistry = Date.now() - registryStartedAt;

const processByWorktree = new Map();
const sdkRunnerByWorktree = new Map();
const laneWorkerByWorktree = new Map();
const worktreeByProcess = new Map();
const processes = new Map();
function briefFromArgs(args) {
  const briefAt = args.findIndex(arg => arg === '--brief');
  if (briefAt >= 0 && args[briefAt + 1]) return args[briefAt + 1];
  for (const arg of args) {
    const normalized = String(arg).replace(/\\/g, '/');
    const escapedLane = laneDirName.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const matched = normalized.match(new RegExp('((?:[A-Za-z]:)?/[^\\s]*/' + escapedLane + '/(?:fix-)?brief[A-Za-z0-9._-]*\\.md)\\b', 'i'));
    if (matched) return matched[1];
  }
  return null;
}
const processScanStartedAt = Date.now();
const processListing = processScanAvailable ? listed(procRoot) : { entries: [], readable: false, capped: false };
const listedPids = processScanAvailable ? processListing.entries.filter(name => /^\d+$/.test(name)) : [];
if (processScanAvailable) for (const pid of listedPids) {
  try {
    const cmdline = slice(path.join(procRoot, pid, 'cmdline'), LOG_TAIL_BYTES);
    if (cmdline === null) { if (processGone(pid)) continue; processReadFailures.push(pid + '/cmdline'); continue; }
    const args = cmdline.split('\0').filter(Boolean);
    if (!args.length) continue;
    const status = slice(path.join(procRoot, pid, 'status'), 64 * 1024);
    if (status === null) { if (processGone(pid)) continue; processReadFailures.push(pid + '/status'); continue; }
    const ppid = Number(status.match(/^PPid:\s*(\d+)/m)?.[1]);
    const processName = status.match(/^Name:\s*([^\n]+)/m)?.[1]?.trim() || '';
    processes.set(Number(pid), { pid: Number(pid), ppid: Number.isSafeInteger(ppid) ? ppid : null, args, processName });
    const executable = executableOf(args[0]);
    const runner = (executable === executables.opencode && args[1] === 'run') || (executable === executables.codex && args[1] === 'exec');
    const laneWorker = args.some(arg => scriptIs(arg, 'laneWorker')) && args.includes('--worker');
    const dirAt = args.findIndex(arg => arg === '--dir');
    const sdkRunner = args.some(arg => scriptIs(arg, 'pilotRunner')) && dirAt >= 0;
    if (!runner && !laneWorker && !sdkRunner) continue;
    const modelAt = args.findIndex(arg => arg === '--model');
    const argumentWorktree = dirAt >= 0 ? args[dirAt + 1] : args.find(arg => arg.startsWith('--dir='))?.slice(6) || null;
    let rawWorktree = argumentWorktree;
    if (!rawWorktree) try { rawWorktree = fs.realpathSync(path.join(procRoot, pid, 'cwd')); } catch {}
    if (!rawWorktree) continue;
    // The machine-wide process list normally contains runners for other projects. Ignore them
    // without degrading discovery for the configured roots.
    const worktree = resolveActorPath(rawWorktree, 'process');
    if (!worktree) continue;
    const model = modelAt >= 0 && args[modelAt + 1] ? args[modelAt + 1] : UNKNOWN;
    const brief = resolveActorFile(briefFromArgs(args));
    worktreeByProcess.set(Number(pid), worktree);
    if (sdkRunner) sdkRunnerByWorktree.set(worktree, { pid: Number(pid), model, brief });
    else {
      const previous = processByWorktree.get(worktree);
      const laneKind = executable === executables.codex ? 'codex' : executable === executables.opencode ? 'opencode' : 'plain';
      if (!previous || previous.model === UNKNOWN || model !== UNKNOWN) processByWorktree.set(worktree, { pid: Number(pid), model, brief: brief || previous?.brief || null, laneKind });
      if (laneWorker) laneWorkerByWorktree.set(worktree, { pid: Number(pid), model, brief, laneKind });
    }
  } catch {}
}
timingsMs.processScan = Date.now() - processScanStartedAt;
function sessionPidFor(pid) {
  const seen = new Set(); let current = processes.get(pid);
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (/^claude(?:$|-)/i.test(current.processName) || current.args.slice(0, 2).some(arg => /(?:^|[/\\])claude(?:$|[.-])/i.test(arg))) return current.pid;
    current = processes.get(current.ppid);
  }
  return null;
}
function ancestryDistance(pid, ancestorPid) {
  if (!pid || !ancestorPid || pid === ancestorPid) return null;
  const seen = new Set(); let current = processes.get(pid); let distance = 0;
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid); current = processes.get(current.ppid); distance += 1;
    if (current?.pid === ancestorPid) return distance;
  }
  return null;
}

function pidState(worktree) {
  if (runtimePlatform !== 'linux') return UNKNOWN;
  if (processByWorktree.has(worktree)) return 'alive';
  const pidResult = slice(lanePath(worktree, 'pid'), 64);
  if (pidResult === null) return UNKNOWN;
  const pid = Number(String(pidResult).trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) return 'dead';
  const processDir = path.join(procRoot, String(pid));
  const cmdline = slice(path.join(processDir, 'cmdline'), LOG_TAIL_BYTES);
  if (cmdline === null) return UNKNOWN;
  const args = cmdline.split('\0').filter(Boolean);
  const recognized = args.some(arg => executableOf(arg) === executables.opencode || scriptIs(arg, 'pilotRunner') || scriptIs(arg, 'laneWorker'));
  const matchedWorktree = args.some(arg => arg === worktree || arg === '--dir=' + worktree);
  return recognized && matchedWorktree ? 'alive' : 'dead';
}

const worktreeEnumerationStartedAt = Date.now();
const worktreeListing = listed(suiteWorktreeRoot);
const listedWorktrees = worktreeListing.entries.map(name => resolveActorPath(path.join(suiteWorktreeRoot, name), 'suite scan')).filter(Boolean);
const priorityWorktrees = [
  ...processByWorktree.keys(), ...sdkRunnerByWorktree.keys(), ...laneWorkerByWorktree.keys(),
].filter(worktree => under(suiteWorktreeRoot, worktree));
const worktreeCandidates = [...new Set([...priorityWorktrees, ...listedWorktrees])];
const scannedWorktrees = worktreeCandidates.slice(0, WORKTREE_DETAIL_CAP);
if (worktreeCandidates.length > scannedWorktrees.length) scanLimits.push('worktree detail cap reached: ' + scannedWorktrees.length + ' of ' + worktreeCandidates.length + ' at ' + suiteWorktreeRoot);
timingsMs.worktreeEnumeration = Date.now() - worktreeEnumerationStartedAt;
const worktreeReadsStartedAt = Date.now();
const laneByCard = new Map();
const externalLanes = [];
function roleLabel(value, inferred = false) {
  const role = String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
  const label = /^refut/.test(role) ? 'Refutation'
    : /^(?:review|security_review|audit)/.test(role) ? 'Review lane'
    : /^(?:astra|consult)/.test(role) ? 'Astra consultation'
    : /^fix/.test(role) ? 'Fix lane'
    : role === 'tdd' ? 'TDD lane'
    : ['discovery', 'plan', 'critic', 'verify', 'harden', 'report'].includes(role) ? role[0].toUpperCase() + role.slice(1) + ' lane'
    : role === 'implementation' ? 'Lane' : null;
  return label ? label + (inferred && label !== 'Lane' ? ' (inferred)' : '') : null;
}
function structuredLaneRole(worktree, launchedBrief = null) {
  const route = json(lanePath(worktree, 'route.json'));
  for (const value of [route?.laneRole, route?.role, route?.lifecycle?.phase, route?.phase]) {
    const label = roleLabel(value); if (label) return label;
  }
  const timelinePhase = lifecycleTimeline(worktree)?.phaseHistory.at(-1);
  if (roleLabel(timelinePhase)) return roleLabel(timelinePhase);
  const runnerLog = tail(sdkLogFile(worktree)) || '';
  const accepted = [...runnerLog.matchAll(/^lifecycle: accepted phase=([a-z_]+)/gm)].at(-1)?.[1];
  if (roleLabel(accepted)) return roleLabel(accepted);
  const phaseRun = list(lanePath(worktree)).map(name => ({ name, stat: info(lanePath(worktree, name)) }))
    .filter(item => item.stat?.isFile() && /^(?:discovery|plan|critic|tdd|verify|review|refutation|harden|report|implementation|fix)-run\.[^.]+\.log$/i.test(item.name))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || right.name.localeCompare(left.name))[0]?.name.match(/^([^-]+)/)?.[1];
  if (roleLabel(phaseRun)) return roleLabel(phaseRun);
  const launchedPhase = launchedBrief && path.basename(launchedBrief).match(/^(discovery|plan|critic|tdd|verify|review|refutation|harden|report|implementation|fix)-brief(?:[.-]|$)/i)?.[1];
  if (roleLabel(launchedPhase)) return roleLabel(launchedPhase);
  for (const name of ['WT_LANE_ROLE', 'LANE_ROLE']) {
    const label = roleLabel(envField(lanePath(worktree, 'env.log'), name)); if (label) return label;
  }
  return null;
}
function inferredLaneRole(title) {
  const value = String(title || '').trim();
  const explicit = /^(?:independent\s+|security\s+)?review\b/i.test(value) ? 'review'
    : /^(?:independent\s+)?refut(?:ation|e)?\b/i.test(value) ? 'refutation'
    : /^(?:astra\s+)?consult(?:ation)?\b/i.test(value) ? 'consultation' : null;
  return { label: roleLabel(explicit) || 'Lane', inferred: Boolean(explicit) };
}
function externalRole(worktree, title, launchedBrief = null) {
  const structured = structuredLaneRole(worktree, launchedBrief);
  return structured ? { label: structured, inferred: false } : inferredLaneRole(title);
}
const implementationRootsByCard = new Map();
for (const worktree of scannedWorktrees) {
  const brief = head(lanePath(worktree, 'brief.md'));
  const cardReceipt = laneCardReceipt(worktree);
  const id = cardReceipt?.id || briefCard(brief);
  const title = cardReceipt?.title || cleanCardTitle(externalTitle(brief), id);
  if (!id || externalRole(worktree, title).label !== 'Lane') continue;
  const receipt = head(lanePath(worktree, 'card.md'));
  const receiptId = cardMarkdownId(receipt) || cardIds(markdownTitle(receipt))[0] || null;
  const receiptTitle = cardReceipt?.title || (receiptId === id ? cleanCardTitle(markdownTitle(receipt), id) : null);
  const step = Number(String(markdownTitle(brief) || '').match(/\bstep\s+(\d+)\b/i)?.[1]);
  const roots = implementationRootsByCard.get(id) || [];
  roots.push({ worktree, step: Number.isSafeInteger(step) ? step : null, receiptTitle });
  implementationRootsByCard.set(id, roots);
}
for (const worktree of scannedWorktrees) {
  const runnerLogFile = sdkLogFile(worktree);
  const runnerLog = tail(runnerLogFile);
  const timeline = lifecycleTimeline(worktree);
  const admission = json(lanePath(worktree, 'admission.json'));
  if (runnerLog !== null || timeline || ['queued', 'active'].includes(admission?.state)) {
    const route = json(lanePath(worktree, 'route.json'));
    const routeCardId = route?.cardId || admission?.cardId;
    const id = /^\d{19}$/.test(String(routeCardId || ''))
      ? String(routeCardId)
      : cardMarkdownId(head(lanePath(worktree, 'card.md')));
    if (id) {
      const lastLine = String(runnerLog || '').split(/\r?\n/).filter(Boolean).at(-1) || '';
      if (/^EXIT=\d+$/.test(lastLine)) continue;
      const accepted = [...String(runnerLog || '').matchAll(/^lifecycle: accepted phase=([a-z_]+)/gm)];
      const phaseHistory = timeline?.phaseHistory || accepted.map(match => match[1]);
      const criticRounds = timeline?.criticRounds ?? [...String(runnerLog || '').matchAll(/^lifecycle: lane critic EXIT=\d+$/gm)].length;
      laneByCard.set(id, {
        worktree,
        launcherSessionId: laneSessionId(worktree),
        model: String(runnerLog || '').match(/\beffective=([^\s]+)/)?.[1] || route?.effective || route?.model || sdkRunnerByWorktree.get(worktree)?.model || UNKNOWN,
        phase: phaseHistory.at(-1) || null,
        phaseHistory,
        phaseSource: timeline ? 'lifecycle' : 'log',
        lifecycleSource: timeline?.source || null,
        phaseRounds: timeline?.phaseRounds || {},
        criticRounds,
        runnerLogTruncated: (info(runnerLogFile)?.size || 0) > LOG_TAIL_BYTES,
        outcome: 'running',
        route: /^(?:LITE|FULL)$/.test(String(route?.route)) ? route.route : null,
        title: laneCardReceipt(worktree, id)?.title || markdownTitle(head(lanePath(worktree, 'card.md'))),
        queue: admission?.state === 'queued' ? { position: admission.position, waiting: admission.waiting, load: admission.load } : null,
      });
      continue;
    }
  }
  const runLog = tail(lanePath(worktree, 'run.log'));
  const brief = head(lanePath(worktree, 'brief.md'));
  if (runLog === null || brief === null) continue;
  const cardReceipt = laneCardReceipt(worktree);
  const strictId = cardReceipt?.id || briefCard(brief);
  const provisionalTitle = cardReceipt?.title || cleanCardTitle(externalTitle(brief), strictId) || path.basename(worktree);
  const role = externalRole(worktree, provisionalTitle, processByWorktree.get(worktree)?.brief);
  const label = role.label;
  const id = strictId || (/^(?:Review lane|Refutation)/.test(label) ? cardIds(brief)[0] || null : null);
  const title = cardReceipt?.title || cleanCardTitle(externalTitle(brief), id) || path.basename(worktree);
  const exited = /^EXIT=\d+$/.test(runLog.split(/\r?\n/).filter(Boolean).at(-1) || '');
  const terminalReport = /^(?:Review lane|Refutation)/.test(label)
    ? ['report.md', label.startsWith('Review lane') ? 'review-report.md' : 'refutation-report.md'].map(file => lanePath(worktree, file)).find(file => info(file)?.isFile()) || null
    : null;
  if (exited && (!/^(?:Review lane|Refutation)/.test(label) || !terminalReport)) continue;
  externalLanes.push({ id: id || 'lane:' + worktree, cardId: id, worktree, launcherSessionId: laneSessionId(worktree), model: laneModel(worktree) || undefined, outcome: terminalReport ? 'done' : 'running', title, label, roleInferred: role.inferred, terminalReport });
}
timingsMs.worktreeLaneReads = Date.now() - worktreeReadsStartedAt;

function waveFor(lane, id) {
  const match = /^card-(\d{19})-wave-(.+)$/.exec(path.basename(lane?.worktree || ''));
  if (!match || match[1] !== id) return null;
  const cardFile = path.join(config.suiteRoot, worktreesDirName, 'wave-' + match[2], 'cards', id, 'card.md');
  return info(path.dirname(cardFile))?.isDirectory() ? { waveId: match[2], cardFile } : null;
}
function externalLane(lane, id) {
  if (!lane) return null;
  const lastWrite = freshestWrite(lane.worktree);
  const running = pidState(lane.worktree) === 'alive' || freshTime(lastWrite);
  const processPid = processByWorktree.get(lane.worktree)?.pid || null;
  return running ? { id: 'lane:' + lane.worktree, cardId: id, cardUrl: cardUrl(id), kind: 'external', label: lane.label || 'Lane', phaseAvailability: (processByWorktree.get(lane.worktree)?.laneKind || 'plain') + ' lane', parentCardId: id, title: cleanCardTitle(lane.title, id), outcome: lane.outcome || 'running', ...(lane.model ? { model: lane.model } : {}), activity: lane.terminalReport ? 'report written' : laneActivity(lane.worktree, lastWrite), elapsed: actorElapsed(lane.worktree, processPid), worktree: lane.worktree, processPid, sessionPid: sessionPidFor(processPid), launcherSessionId: lane.launcherSessionId || laneSessionId(lane.worktree) } : null;
}
function nestedLane(lane, id) {
  if (!lane || pidState(lane.worktree) !== 'alive') return null;
  const lastWrite = freshestWrite(lane.worktree);
  const runner = laneWorkerByWorktree.get(lane.worktree) || processByWorktree.get(lane.worktree);
  const processPid = runner?.pid || null;
  const isFix = Boolean(runner?.brief && /^fix-brief[^/]*\.md$/i.test(path.basename(runner.brief)));
  const brief = isFix ? head(runner.brief) : null;
  const detail = brief ? markdownTitle(brief)?.match(/\b(?:review\s+round|round|step)\s+\d+(?:\s+round\s+\d+)?\b/i)?.[0] || null : null;
  const phase = phaseOf(lane.phase);
  const phaseRole = phase === UNKNOWN ? null : (phase === 'tdd' ? 'TDD' : phase.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase())) + ' lane';
  return { id: 'lane:' + lane.worktree, cardId: id, cardUrl: cardUrl(id), kind: 'external', label: isFix ? 'Fix lane' : phaseRole || lane.label || 'Lane', phaseAvailability: (runner?.laneKind || 'plain') + ' lane', parentCardId: id, title: isFix ? detail : phaseRole ? null : cleanCardTitle(lane.title, id) || path.basename(lane.worktree), outcome: 'running', ...(runner?.model && runner.model !== UNKNOWN ? { model: runner.model } : {}), activity: laneActivity(lane.worktree, lastWrite), elapsed: actorElapsed(lane.worktree, processPid), worktree: lane.worktree, processPid, sessionPid: sessionPidFor(processPid), launcherSessionId: lane.launcherSessionId || laneSessionId(lane.worktree) };
}

const activeLifecycleIds = [...lifecycle].filter(([, value]) => value?.phase).map(([id]) => id);
const activeExternalLanes = externalLanes.map(lane => ({ lane, active: externalLane(lane, lane.cardId) })).filter(item => item.active);
const standaloneExternalCards = new Set(activeExternalLanes.map(({ lane }) => lane.cardId).filter(id => id && !laneByCard.has(id)));
const ids = new Set([...activeLifecycleIds, ...liveness.keys(), ...spawnByCard.keys(), ...laneByCard.keys()].filter(id => !standaloneExternalCards.has(id)));
const rows = [];
for (const id of ids) {
  const live = liveness.get(id); const lane = laneByCard.get(id); const workers = spawnByCard.get(id) || [];
  const record = lifecycle.get(id);
  const worktree = live?.worktree || lane?.worktree || record?.worktree || workers.find(worker => worker.worktree)?.worktree || null;
  const age = live ? minutes(live.updatedAt) : null;
  const waiting = live?.waitingOn && live.waitingOn !== 'none' ? 'waiting on: ' + live.waitingOn : null;
  const lastWrite = worktree ? freshestWrite(worktree) : null;
  const processState = worktree ? pidState(worktree) : UNKNOWN;
  if (processState !== 'alive' && !freshTime(lastWrite) && !live && !record) continue;
  const activity = waiting || (lastWrite === null ? live ? 'updated ' + age + ' min ago' : record ? 'lifecycle updated recently' : UNKNOWN : 'last write ' + (approximateWalkRoots.has(worktree) ? 'at least ' : '') + Math.max(0, Math.round((now - lastWrite) / 60000)) + ' min ago');
  const watchdog = !live || age === null ? UNKNOWN : age > ACTIVE_WINDOW_MIN ? 'alert' : 'silent';
  const wave = waveFor(lane, id);
  const title = cleanCardTitle(lane?.title || (wave ? markdownTitle(head(wave.cardFile)) : null), id) || id;
  const laneWho = lane ? 'lane (' + lane.model + ', ' + lane.worktree + ')' : null;
  const agents = workers.map(worker => (worker.parent === 'pilot' ? 'pilot' : 'sub-agent') + ' ' + worker.name + ' (' + worker.model + ')');
  const who = [laneWho, ...agents].filter(Boolean).join('; ') || UNKNOWN;
  const gateResults = worktree ? { test: gate(worktree, 'test'), typecheck: gate(worktree, 'typecheck'), lint: gate(worktree, 'lint') } : null;
  const reviewResult = worktree ? reviews(worktree, id) : { lenses: UNKNOWN, findings: UNKNOWN, decision: UNKNOWN, source: null };
  const usageResult = worktree ? usage(worktree, lane?.model || workers[0]?.model) : { value: UNKNOWN, totals: null, source: null };
  const timeline = worktree && lane ? lifecycleTimeline(worktree) : null;
  const phaseCostResult = worktree ? phaseCosts(worktree, timeline) : { costs: {}, total: null, source: null, kind: null };
  const failedOutcome = [record?.outcome, record?.status, record?.state].find(value => /^(?:error|failed|fail)/i.test(String(value || '')));
  const waitingForArbiter = lane?.phase === 'awaiting_fidelity';
  const sdkRunner = worktree ? sdkRunnerByWorktree.get(worktree) : null;
  const phaseStates = statesOf(lane?.phaseHistory?.length ? lane.phaseHistory : record?.phase ? [record.phase] : [], lane?.route);
  const frozenRoute = worktree ? json(lanePath(worktree, 'route.json')) : null;
  if (waitingForArbiter) phaseStates.awaiting_fidelity = 'waiting for arbiter review';
  const { source: reviewSource, ...review } = reviewResult;
  rows.push({
    id,
    cardId: id,
    cardUrl: cardUrl(id),
    kind: 'pilot',
    sdkLifecycle: true,
    label: 'SDK pilot',
    title,
    queue: lane?.queue || null,
    waveId: wave?.waveId || null,
    route: lane?.route || null,
    phase: phaseOf(lane?.phase || record?.phase),
    phaseSource: lane?.phaseSource || null,
    phaseStates,
    outcome: waitingForArbiter ? 'waiting for arbiter review' : lane?.outcome || failedOutcome || UNKNOWN,
    model: lane?.model || workers[0]?.model || UNKNOWN,
    models: frozenRoute?.models || {},
    phaseRounds: lane?.phaseRounds || {},
    criticRounds: lane?.criticRounds,
    runnerLogTruncated: lane?.runnerLogTruncated || false,
    who,
    activity,
    gates: gateResults ? { test: gateResults.test.value, typecheck: gateResults.typecheck.value, lint: gateResults.lint.value } : { test: UNKNOWN, typecheck: UNKNOWN, lint: UNKNOWN },
    review,
    tokens: usageResult.value,
    usage: usageResult.totals,
    phaseCosts: phaseCostResult.costs,
    phaseElapsed: phaseElapsed(timeline),
    runCost: phaseCostResult.total,
    phaseCostSource: phaseCostResult.source || UNKNOWN,
    phaseCostSourceKind: phaseCostResult.kind || UNKNOWN,
    costApproximate: approximateWalkRoots.has(worktree),
    watchdog,
    inspectors: inspectors(worktree, lane ? frozenRoute : null, lane ? tail(sdkLogFile(worktree)) : null),
    lanes: [nestedLane(lane, id)].filter(Boolean),
    worktree,
    launcherSessionId: lane?.launcherSessionId || laneSessionId(worktree),
    processPid: sdkRunner?.pid || null,
    elapsed: worktree ? pilotElapsed(worktree, sdkRunner?.pid || null) : UNKNOWN,
    sources: {
      lifecycle: lane?.lifecycleSource || record?.sourcePath || UNKNOWN,
      spawnRegistry: workers.length ? 'spawn registry' : UNKNOWN,
      laneProbe: lane ? lane.worktree : UNKNOWN,
      liveness: live?.sourcePath || UNKNOWN,
      gateLogs: gateResults && Object.values(gateResults).some(result => result.source) ? lanePath(worktree) : UNKNOWN,
      reviews: reviewSource || UNKNOWN,
      usage: usageResult.source || UNKNOWN,
      phaseCosts: phaseCostResult.source || UNKNOWN,
    },
  });
}
for (const { lane, active } of activeExternalLanes) {
  const parent = lane.cardId ? rows.find(row => row.kind === 'pilot' && row.id === lane.cardId) : null;
  if (parent && ancestryDistance(active.processPid, parent.processPid) !== null) parent.lanes.push(active);
  else rows.push({ ...active, id: lane.id, parentCardId: null, phase: UNKNOWN, sources: { laneProbe: lane.worktree } });
}
rows.sort((a, b) => a.id.localeCompare(b.id));

const processActors = [];
for (const processRecord of processes.values()) {
  const { args, pid } = processRecord;
  const executable = executableOf(args[0]);
  const isOpenCode = executable === executables.opencode && args[1] === 'run';
  const isCompanion = args.some(arg => scriptIs(arg, 'companion')) && args.includes('task');
  if (!isOpenCode && !isCompanion) continue;
  if (isOpenCode) {
    const worktree = worktreeByProcess.get(pid) || null;
    if (!worktree || !info(lanePath(worktree))?.isDirectory()) continue;
    const launchedBrief = processByWorktree.get(worktree)?.brief || null;
    const brief = head(lanePath(worktree, 'brief.md')) || (launchedBrief ? head(launchedBrief) : '') || '';
    const cardReceipt = laneCardReceipt(worktree);
    const id = cardReceipt?.id || cardIds(brief)[0] || null;
    const isFix = Boolean(launchedBrief && /^fix-brief[^/]*\.md$/i.test(path.basename(launchedBrief)));
    const detail = isFix ? markdownTitle(brief)?.match(/\b(?:review\s+round|round|step)\s+\d+(?:\s+round\s+\d+)?\b/i)?.[0] || null : null;
    const heading = isFix ? detail : cardReceipt?.title || cleanCardTitle(externalTitle(brief), id) || path.basename(worktree);
    const classified = isFix ? { label: 'Fix lane', inferred: false } : externalRole(worktree, heading, launchedBrief);
    const label = classified.label;
    const modelAt = args.findIndex(arg => arg === '--model');
    const model = modelAt >= 0 ? args[modelAt + 1] || null : laneModel(worktree);
    processActors.push({ id: 'process:' + pid, processPid: pid, worktree, cardId: id, cardUrl: cardUrl(id), kind: 'external', label, phaseAvailability: (executable === executables.codex ? 'codex' : 'opencode') + ' lane', roleInferred: classified.inferred, role: heading, title: heading, ...(model ? { model } : {}), activity: laneActivity(worktree, freshestWrite(worktree)), elapsed: actorElapsed(worktree, pid), outcome: 'running', sessionPid: sessionPidFor(pid), launcherSessionId: laneSessionId(worktree) });
  } else {
    const requestAt = args.indexOf('task');
    const request = args.slice(requestAt + 1).join(' ');
    const id = cardIds(request)[0] || null;
    const label = /refut/i.test(request) ? 'Refutation' : 'Astra consultation';
    processActors.push({ id: 'process:' + pid, processPid: pid, cardId: id, cardUrl: cardUrl(id), kind: 'external', label, role: request || label, title: request || label, model: 'Astra', activity: request || UNKNOWN, elapsed: actorElapsed(null, pid), outcome: 'running', sessionPid: sessionPidFor(pid) });
  }
}

for (const actor of processActors) {
  let represented = null;
  if (actor.worktree) for (const row of rows) {
    if (row.kind === 'external' && row.worktree === actor.worktree) { represented = row; break; }
    represented = (row.lanes || []).find(lane => lane.worktree === actor.worktree) || null;
    if (represented) break;
  }
  if (represented) Object.assign(represented, { label: actor.label, roleInferred: actor.roleInferred, role: actor.role, model: actor.model, activity: actor.activity, elapsed: actor.elapsed, processPid: actor.processPid, sessionPid: actor.sessionPid });
  else rows.push(actor);
}

function branchMerged(worktree, id) {
  if (!worktree) return { value: false, availability: { status: UNKNOWN, reason: 'worktree unavailable' } };
  try {
    const runGit = args => spawnSync('git', args, { cwd: worktree, encoding: 'utf8', timeout: 2000 });
    const branchResult = runGit(['branch', '--show-current']);
    if (branchResult.error || branchResult.status !== 0) return { value: false, availability: { status: UNKNOWN, reason: 'git branch probe unavailable' } };
    const branch = String(branchResult.stdout || '').trim();
    if (!branch || (!branch.includes(id) && !branch.includes(id.slice(0, 10)))) return { value: false, availability: { status: 'available' } };
    const statusResult = runGit(['status', '--porcelain']);
    if (statusResult.error || statusResult.status !== 0) return { value: false, availability: { status: UNKNOWN, reason: 'git status probe unavailable' } };
    if (statusResult.stdout?.trim()) return { value: false, availability: { status: 'available' } };
    const headResult = runGit(['rev-parse', 'HEAD']);
    const head = String(headResult.stdout || '').trim();
    if (headResult.error || headResult.status !== 0 || !head) return { value: false, availability: { status: UNKNOWN, reason: 'git HEAD probe unavailable' } };
    const reflogResult = runGit(['reflog', 'show', '--format=%H', branch]);
    if (reflogResult.error || reflogResult.status !== 0) return { value: false, availability: { status: UNKNOWN, reason: 'git branch history probe unavailable' } };
    const createdAt = String(reflogResult.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!createdAt || createdAt === head) return { value: false, availability: { status: 'available' } };
    const aheadResult = runGit(['rev-list', createdAt + '..' + branch]);
    if (aheadResult.error || aheadResult.status !== 0) return { value: false, availability: { status: UNKNOWN, reason: 'git branch ahead probe unavailable' } };
    if (!String(aheadResult.stdout || '').trim()) return { value: false, availability: { status: 'available' } };
    let baseMeasured = false;
    for (const base of baseBranches) {
      const baseResult = runGit(['rev-parse', base]);
      const baseHead = String(baseResult.stdout || '').trim();
      if (baseResult.error || baseResult.status !== 0 || !baseHead) continue;
      baseMeasured = true;
      if (head === baseHead) continue;
      const mergeResult = runGit(['merge-base', '--is-ancestor', head, base]);
      if (mergeResult.error || ![0, 1].includes(mergeResult.status)) return { value: false, availability: { status: UNKNOWN, reason: 'git merge-base probe unavailable' } };
      if (mergeResult.status === 0) return { value: true, availability: { status: 'available' } };
    }
    return baseMeasured ? { value: false, availability: { status: 'available' } } : { value: false, availability: { status: UNKNOWN, reason: baseBranches.length ? 'git base branch probes unavailable' : 'no base branches configured' } };
  } catch (error) { return { value: false, availability: { status: UNKNOWN, reason: 'git probe unavailable: ' + (error?.message || String(error)) } }; }
}
function actorWorktrees(actors) {
  const roots = [];
  for (const actor of actors || []) {
    if (actor.worktree) roots.push({ worktree: actor.worktree, label: actor.label, processPid: actor.processPid });
    roots.push(...actorWorktrees([...(actor.lanes || []), ...(actor.children || [])]));
  }
  return roots;
}
function deepActors(actors) {
  return (actors || []).flatMap(actor => [actor, ...deepActors([...(actor.lanes || []), ...(actor.children || [])])]);
}
function sdkImplementationState(actors) {
  const pilots = deepActors(actors).filter(actor => actor.kind === 'pilot');
  if (pilots.some(actor => ['done', 'waiting for arbiter review'].includes(actor.phaseStates?.verify)
    || ['review', 'refutation', 'harden', 'report', 'awaiting_fidelity'].some(phase => !['not started', 'skipped', undefined].includes(actor.phaseStates?.[phase])))) return 'done';
  if (pilots.some(actor => ['running', 'done'].includes(actor.phaseStates?.tdd) || actor.phaseStates?.verify === 'running')) return 'running';
  return null;
}
function evidenceRounds(files) {
  return new Set(files.map(file => {
    const round = path.basename(file).match(/(?:^|[.-])round[.-]?(\d+)(?:[.-]|$)/i)?.[1];
    return path.dirname(file) + '\0' + (round || 'single');
  })).size;
}
function cycleSummary(files, fallbackDecision = UNKNOWN) {
  const text = files.map(file => tail(file, REPORT_TAIL_BYTES) || '').join('\n');
  const headings = [...text.matchAll(/^###\s+[A-Z]+-\d+\b/gm)].length;
  const severities = [...text.matchAll(/^\s*-\s+\*{0,2}Severity:\*{0,2}\s*(blocking|non-blocking)\b/gim)];
  const tableFindings = [...text.matchAll(/^\|\s*[A-Z]+-\d+\s*\|/gm)].length;
  const findingsAt = text.search(/^FINDINGS:\s*$/im);
  const listedFindings = findingsAt < 0 ? 0 : (text.slice(findingsAt).match(/^\s*[-*+]\s+\S/gm) || []).length;
  const findings = headings || severities.length || tableFindings || listedFindings || UNKNOWN;
  const blocking = severities.length ? severities.filter(match => match[1].toLowerCase() === 'blocking').length : UNKNOWN;
  const decisions = [...text.matchAll(/^(?:review\s+|arbiter\s+)?decision:\s*([^\n]+)|^VERDICT:\s*([^\n]+)/gim)];
  const decision = decisions.at(-1)?.slice(1).find(Boolean)?.trim().toLowerCase() || fallbackDecision;
  return [findings !== UNKNOWN ? 'findings: ' + findings : null, blocking !== UNKNOWN ? 'blocking: ' + blocking : null, decision !== UNKNOWN ? 'decision: ' + decision : null].filter(Boolean).join(' · ') || 'No summary available.';
}
function devCycleForCard(id, actors) {
  const actorRoots = actorWorktrees(actors);
  const candidates = implementationRootsByCard.get(id) || [];
  const newestStep = candidates.map(item => item.step).filter(Number.isSafeInteger).sort((left, right) => right - left)[0];
  const durableRoots = candidates.filter(item => newestStep === undefined || item.step === newestStep).map(item => item.worktree);
  const visibleImplementationRoots = actorRoots.filter(item => !['Review lane', 'Refutation', 'Astra consultation', 'Fix lane'].includes(item.label)).map(item => item.worktree);
  const implementationRoots = [...new Set(durableRoots.length ? durableRoots : visibleImplementationRoots)];
  const reviewRoots = actorRoots.filter(item => item.label === 'Review lane');
  const refutationRoots = actorRoots.filter(item => ['Refutation', 'Astra consultation'].includes(item.label));
  const durableDirs = implementationRoots.map(worktree => lanePath(worktree)).filter(dir => info(dir)?.isDirectory());
  const named = accept => durableDirs.flatMap(dir => list(dir).filter(name => accept(name)).map(name => path.join(dir, name)).filter(file => info(file)?.isFile()));
  const implementationFiles = named(name => /^brief\.md$|^report(?:-round\d+)?\.md$/i.test(name));
  const implementationState = sdkImplementationState(actors);
  const implementationEvidence = implementationFiles.length ? implementationFiles : implementationState ? ['SDK pilot tdd/verify'] : [];
  const roleFiles = (roots, pattern) => roots.flatMap(({ worktree }) => list(lanePath(worktree)).filter(name => pattern.test(name)).map(name => lanePath(worktree, name)).filter(file => info(file)?.isFile()));
  const reviewReports = roleFiles(reviewRoots, /^(?:report|review-report(?:\.[^.]+)?)\.md$/i);
  const refutationReports = roleFiles(refutationRoots, /^(?:report|refutation-report(?:\.[^.]+)?)\.md$/i);
  const reviewFiles = [...new Set([...reviewReports, ...named(name => /^(?:review-brief|review|review-report|review-sol)(?:\.[^.]+)?\.md$/i.test(name))])];
  const refutationFiles = [...new Set([...refutationReports, ...named(name => /^(?:refute-request|refutation-brief|refutation-report)(?:\.[^.]+)?\.md$|^refutation(?:-astra)?(?:\.[^.]+)?\.log$/i.test(name))])];
  const reviewRunning = reviewRoots.some(item => item.processPid && processes.has(item.processPid));
  const refutationRunning = refutationRoots.some(item => item.processPid && processes.has(item.processPid));
  const reviewDone = reviewReports.length > 0 || reviewFiles.some(file => /^(?:review\s+)?decision:\s*[^\n]+|^VERDICT:\s*[^\n]+/im.test(tail(file, REPORT_TAIL_BYTES) || ''));
  const refutationDone = refutationReports.length > 0 || refutationFiles.some(file => /^(?:EXIT=0|Tally:)|Turn completed/im.test(tail(file, REPORT_TAIL_BYTES) || ''));
  const arbiterFiles = named(name => name === 'arbiter-decision.md').filter(file => /^Decision:\s*(approved|changes requested)\b/im.test(tail(file, REPORT_TAIL_BYTES) || ''));
  const allFixFiles = named(name => /^fix-brief[^/]*\.md$/i.test(name));
  const fixKeys = new Map();
  for (const file of allFixFiles) fixKeys.set(path.basename(file) + '\0' + (head(file) || ''), file);
  const fixFiles = [...fixKeys.values()];
  const reviewRoundFiles = [...new Set([...reviewReports, ...named(name => /^(?:review|review-report|review-sol)(?:[.-][^.]+)?\.md$/i.test(name))])];
  const refutationRoundFiles = [...new Set([...refutationReports, ...named(name => /^(?:refutation-report)(?:[.-][^.]+)?\.md$|^refutation(?:-astra)?(?:[.-][^.]+)?\.log$/i.test(name))])];
  const reviewRoundCount = Math.max(evidenceRounds(reviewRoundFiles), evidenceRounds(refutationRoundFiles));
  const rounds = Math.min(reviewRoundCount, fixFiles.length);
  const fixRounds = Math.max(0, fixFiles.length - rounds);
  const mergeResults = implementationRoots.map(worktree => branchMerged(worktree, id));
  const merged = mergeResults.some(result => result.value);
  const mergeUnknown = !merged && mergeResults.find(result => result.availability.status === UNKNOWN);
  const evidence = [implementationEvidence, reviewFiles.length || reviewRunning ? reviewFiles.length ? reviewFiles : ['live review process'] : [], refutationFiles.length || refutationRunning ? refutationFiles.length ? refutationFiles : ['live refutation process'] : [], arbiterFiles, fixFiles, merged ? ['git branch --merged'] : []];
  if (!evidence.some(items => items.length)) return null;
  const specs = [
    ['implementation', 'Implementation lane', implementationEvidence, implementationFiles.some(file => path.basename(file) === 'report.md') ? 'report written' : 'in progress'],
    ['review', 'Sol review', reviewFiles, reviewFiles.length ? 'recorded' : UNKNOWN],
    ['refutation', 'Astra refutation', refutationFiles, refutationFiles.length ? 'recorded' : UNKNOWN],
    ['arbiter', 'Arbiter decision', arbiterFiles, arbiterFiles.length ? 'recorded' : UNKNOWN],
    ['fix', 'Fix lane', fixFiles, fixFiles.length ? 'fix requested' : UNKNOWN],
    ['merge', 'Merge', merged ? ['git branch --merged'] : [], merged ? 'merged' : mergeUnknown ? mergeUnknown.availability.reason : 'not merged'],
  ];
  const stages = specs.map(([stageId, label, files, fallbackDecision], index) => {
    const downstream = evidence.slice(index + 1).some(items => items.length);
    const roleState = stageId === 'implementation' ? implementationState
      : stageId === 'review' ? reviewDone ? 'done' : reviewRunning ? 'running' : null
      : stageId === 'refutation' ? refutationDone ? 'done' : refutationRunning ? 'running' : null : null;
    const state = roleState || (stageId === 'merge' && mergeUnknown ? UNKNOWN : files.length ? downstream ? 'done' : stageId === 'merge' ? 'done' : 'running' : 'not started');
    let summary = stageId === 'implementation' && implementationState && !implementationFiles.length
      ? 'SDK pilot implementation is ' + state + '.'
      : cycleSummary(stageId === 'merge' ? [] : files, fallbackDecision);
    if (/^(?:No summary available\.|decision: recorded)$/i.test(summary)) {
      summary = stageId === 'review' ? 'Sol review evidence was recorded.'
        : stageId === 'refutation' ? 'Astra refutation evidence was recorded.'
        : summary;
    }
    if (stageId === 'implementation' && implementationFiles.length && /^decision: (?:report written|in progress)$/i.test(summary)) summary = state === 'done' ? 'Implementation report was recorded.' : 'Implementation is in progress.';
    if (stageId === 'fix' && fixRounds > 0 && /^decision: fix requested$/i.test(summary)) summary = fixRounds + ' fix ' + (fixRounds === 1 ? 'round was' : 'rounds were') + ' requested.';
    if (stageId === 'merge' && state === 'done') summary = 'The card branch was merged.';
    return { id: stageId, label, state, summary: state === 'not started' ? 'Not reached.' : summary };
  });
  return { stages, rounds, fixRounds };
}

const sessionMap = new Map();
const configRoot = canonicalDirectory(config.configDir);
function sessionCwd(pid, worktree, launcherSessionId) {
  if (pid) try { return fs.realpathSync(path.join(procRoot, String(pid), 'cwd')); } catch {}
  // A worktree under the suite root belongs to that project even when its runner is detached (setsid SDK pilot, lane)
  // and no Claude ancestor or launcher session id survives: otherwise the project filter hides exactly those runs.
  if (worktree && under(suiteWorktreeRoot, worktree)) return path.dirname(path.resolve(config.suiteRoot));
  return null;
}
function transcriptSlug(cwd) { return String(cwd || '').replace(/[^A-Za-z0-9-]/g, '-'); }
function latestCustomTitle(sessionId, cwd) {
  if (!configRoot || !sessionId) return null;
  const candidate = path.join(configRoot, 'projects', transcriptSlug(cwd), sessionId + '.jsonl');
  let real;
  try { real = fs.realpathSync(candidate); } catch { return null; }
  if (!under(configRoot, real) || !infoUnrestricted(real)?.isFile()) return null;
  const value = slice(real, TRANSCRIPT_TAIL_BYTES, true);
  let latest = null;
  for (const line of String(value || '').split(/\r?\n/)) {
    if (!/"type"\s*:\s*"custom-title"/.test(line)) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const rawTitle = typeof record.customTitle === 'string' ? record.customTitle.trim() : '';
    const title = rawTitle.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    if (record.type === 'custom-title' && record.sessionId === sessionId && title && rawTitle.length <= 200) latest = title;
  }
  return latest;
}
function sessionFor(pid, launcherSessionId, worktree) {
  const identity = launcherSessionId || pid || 'unknown';
  const key = 'session:' + identity;
  if (!sessionMap.has(key)) {
    const cwd = sessionCwd(pid, worktree, launcherSessionId);
    sessionMap.set(key, {
      id: key,
      pid: pid || null,
      sessionId: launcherSessionId || null,
      project: cwd ? path.basename(cwd) || null : null,
      name: latestCustomTitle(launcherSessionId, cwd),
      launcher: launcherSessionId ? 'launched by: ' + launcherSessionId.slice(0, 8) : pid ? 'Claude pid ' + pid : 'launched by: unknown',
      launcherEvidence: launcherSessionId ? laneDirName + '/env.log' : pid ? 'proc ancestry' : 'none',
      cards: [],
      actors: [],
    });
  }
  return sessionMap.get(key);
}
for (const row of rows) {
  const pid = row.sessionPid || sessionPidFor(row.processPid || processByWorktree.get(row.worktree)?.pid);
  const session = sessionFor(pid, row.launcherSessionId, row.worktree);
  row.project = session.project;
  if (!row.cardId) { session.actors.push(row); continue; }
  let card = session.cards.find(item => item.id === row.cardId);
  if (!card) { card = { id: row.cardId, cardUrl: row.cardUrl || cardUrl(row.cardId), title: row.title || row.cardId, waveId: row.waveId || null, actors: [] }; session.cards.push(card); }
  if (!card.waveId && row.waveId) card.waveId = row.waveId;
  card.actors.push({ ...row, children: row.children ? [...row.children] : row.children });
}
function cardTitleFor(id, actors) {
  const lane = laneByCard.get(id);
  const wave = waveFor(lane, id);
  const receiptTitle = cleanCardTitle(lane?.title || (wave ? markdownTitle(head(wave.cardFile)) : null), id);
  if (receiptTitle) return receiptTitle;
  const candidates = implementationRootsByCard.get(id) || [];
  const newestStep = candidates.map(item => item.step).filter(Number.isSafeInteger).sort((left, right) => right - left)[0];
  const current = candidates.filter(item => newestStep === undefined || item.step === newestStep);
  for (const candidate of current) if (candidate.receiptTitle) return candidate.receiptTitle;
  for (const candidate of current) {
    const title = cleanCardTitle(externalTitle(head(lanePath(candidate.worktree, 'brief.md'))), id);
    if (title) return title;
  }
  const all = deepActors(actors);
  const implementation = all.find(actor => actor.kind === 'pilot' || !['Review lane', 'Refutation', 'Astra consultation', 'Fix lane'].includes(actor.label));
  return cleanCardTitle(implementation?.title || implementation?.role || all.find(actor => actor.title || actor.role)?.title || all.find(actor => actor.title || actor.role)?.role, id) || id;
}
const titleActorsByCard = new Map();
for (const session of sessionMap.values()) for (const card of session.cards) titleActorsByCard.set(card.id, [...(titleActorsByCard.get(card.id) || []), ...card.actors]);
for (const session of sessionMap.values()) for (const card of session.cards) card.title = cardTitleFor(card.id, titleActorsByCard.get(card.id));
for (const session of sessionMap.values()) {
  for (const card of session.cards) {
    for (const actor of card.actors) if (actor.label === 'Lane' && (actor.title || actor.role) === card.title) { actor.title = null; actor.role = null; }
    const actors = [...card.actors]; const attached = new Set();
    for (const actor of actors.filter(item => ['Review lane', 'Refutation', 'Astra consultation'].includes(item.label))) {
      const parent = actors
        .filter(item => item !== actor && ['Pilot', 'Lane', 'Review lane'].includes(item.label))
        .map(item => ({ item, distance: ancestryDistance(actor.processPid, item.processPid) }))
        .filter(item => item.distance !== null)
        .sort((left, right) => left.distance - right.distance)[0]?.item;
      if (parent) { parent.children = [...(parent.children || []), actor]; attached.add(actor); }
    }
    card.actors = actors.filter(actor => !attached.has(actor));
  }
  session.cards.sort((a, b) => Number(Boolean(b.waveId)) - Number(Boolean(a.waveId)) || a.id.localeCompare(b.id));
}
const cycleActorsByCard = new Map();
for (const session of sessionMap.values()) for (const card of session.cards) cycleActorsByCard.set(card.id, [...(cycleActorsByCard.get(card.id) || []), ...card.actors]);
for (const session of sessionMap.values()) for (const card of session.cards) card.devCycle = devCycleForCard(card.id, cycleActorsByCard.get(card.id));
const sessions = [...sessionMap.values()].sort((a, b) => a.id.localeCompare(b.id));

const taskPids = new Set(processActors.filter(actor => ['Refutation', 'Astra consultation'].includes(actor.label)).map(actor => actor.processPid));
function relatedToTask(pid) {
  for (const taskPid of taskPids) for (const start of [taskPid, pid]) {
    let current = processes.get(start); const target = start === taskPid ? pid : taskPid; const seen = new Set();
    while (current && !seen.has(current.pid)) { if (current.ppid === target) return true; seen.add(current.pid); current = processes.get(current.ppid); }
  }
  return false;
}
const helperItems = [];
const serviceItems = [];
for (const processRecord of processes.values()) {
  const args = processRecord.args;
  const executable = executableOf(args[0]);
  let label = null; let target = null;
  const brokerScript = String(args[1] || '').replace(/\\/g, '/');
  const brokerRoot = brokerScript.endsWith('/bin/broker.js') ? path.dirname(path.dirname(args[1])) : null;
  const atriumMarker = brokerRoot ? json(path.join(brokerRoot, 'package.json'))?.name === servicesLayout.brokerPackage : false;
  const helper = classifyIdleHelper({ argv: [executable, ...args.slice(1)], ageSeconds: processAge(processRecord.pid).seconds, relatedToTask: relatedToTask(processRecord.pid), thresholdSeconds: IDLE_HELPER_SAFE_TO_STOP_SECONDS });
  if (helper.helper) { label = 'Codex app-server'; target = helperItems; }
  else if (scriptIs(args[1], 'artifactServer') && args[2] === 'serve') { label = 'Artifact server'; target = serviceItems; }
  else if (typeof executables.pythonPattern === 'string' && new RegExp(executables.pythonPattern).test(executable) && args[1] === '-m' && args[2] === 'http.server') { label = 'HTTP server'; target = serviceItems; }
  else if (executable === executables.bun && brokerScript.endsWith('/broker.js') && (servicesLayout.brokerPathPattern && new RegExp(servicesLayout.brokerPathPattern, 'i').test(brokerScript) || atriumMarker)) { label = servicesLayout.brokerLabel || 'Broker'; target = serviceItems; }
  if (target) {
    const age = processAge(processRecord.pid);
    // Concurrent session registrations can spawn competing artifact servers. A loser may vanish
    // between the cmdline and stat reads; without live stat evidence it is not a server row.
    if (label === 'Artifact server' && age.seconds === null) continue;
    if (target === serviceItems && age.seconds !== null && age.seconds < MIN_SERVICE_AGE_SECONDS) continue;
    target.push({ id: (target === helperItems ? 'helper:' : 'service:') + processRecord.pid, pid: processRecord.pid, label, age: age.text, ageSeconds: age.seconds, ...(target === helperItems ? { safeToStop: helper.safeToStop } : {}) });
  }
}
const oldestHelper = helperItems.filter(item => item.ageSeconds !== null).sort((left, right) => right.ageSeconds - left.ageSeconds)[0];
for (const item of [...helperItems, ...serviceItems]) delete item.ageSeconds;
const services = { count: serviceItems.length, items: serviceItems };
const helpers = { count: helperItems.length, oldest: helperItems.length ? oldestHelper?.age || UNKNOWN : 'none', items: helperItems };
const suiteLock = readSuiteLockSnapshot();
const discovery = ![lifecycleFiles, livenessFiles, registryListing, worktreeListing].every(source => source.readable) ? UNKNOWN : cappedScans.length || scanLimits.length || pathRefusals.length || unreadableScans.length ? 'partial' : 'available';
const allListedVanished = listedPids.length > 0 && processVanished === listedPids.length;
const processPartialReason = processScanAvailable && !processListing.readable ? 'unreadable' : processListing.capped ? 'capped' : allListedVanished ? 'unreadable' : processReadFailures.length ? 'unreadable process records' : executableLookupFailures.length ? 'executable lookup unavailable' : null;
const processDiscovery = !processScanAvailable ? UNKNOWN : processPartialReason ? 'partial' : 'available';
const processReason = !processScanAvailable ? 'unavailable on this platform' : processPartialReason;
const requiredDiscoveryRoots = [['lifecycle store', lifecycleFiles], ['liveness records', livenessFiles], ['spawn registry', registryListing], ['worktrees', worktreeListing]];
const discoveryReason = discovery === UNKNOWN ? 'unavailable: ' + requiredDiscoveryRoots.filter(([, source]) => !source.readable).map(([name]) => name).join(', ') : discovery === 'partial' ? [...new Set([...cappedScans.map(dir => 'scan cap reached: ' + dir), ...scanLimits, ...unreadableScans.map(dir => 'unreadable: ' + dir), ...pathRefusals])].join('; ') : null;
const collectors = {
  work: { value: { rows, sessions }, availability: { status: discovery, ...(discoveryReason ? { reason: discoveryReason } : {}) } },
  processes: { value: { services, helpers }, availability: { status: processDiscovery, ...(processReason ? { reason: processReason } : {}) } },
  suiteLock: { value: suiteLock, availability: { status: suiteLock.status === UNKNOWN ? UNKNOWN : 'available' } },
  clockTicks: { value: clockTicks, availability: clockTicksAvailability },
};
timingsMs.total = Date.now() - timingStartedAt;
process.stdout.write(JSON.stringify({ collectors, discovery, rows, sessions, services, helpers, suiteLock, processDiscovery, processPartialReason: processReason, processVanished, cappedScans: [...new Set(cappedScans)], scanLimits, unreadableScans: [...new Set(unreadableScans)], pathRefusals, timingsMs, collectedAt: new Date(now).toISOString() }));
`;
