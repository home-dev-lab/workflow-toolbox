import { PHASES } from './lifecycle-phases.js';
import { SNAPSHOT_PROGRAM } from './snapshot-program.js';
import { stripAnsiAndControl } from './text-sanitize.js';

const PANE_ID = 'wt-what-is-running';
let paneSequence = 0;
function nextPaneId() {
  paneSequence += 1;
  return `${PANE_ID}-${Date.now().toString(36)}-${paneSequence.toString(36)}`;
}
export const COLLECTOR_TIMEOUT_MS = 30_000;
export const PLUGIN_VERSION = '0.184.0';
export const SLOW_RENDER_THRESHOLD_MS = 50;
export const MISSED_RENDERS_BEFORE_STOP = 3;
export const RENDER_JOURNAL_MAX_BYTES = 64 * 1024;
// The hooks module runs without Node globals, so the platform is read from the URL itself:
// a file URL on Windows carries a drive letter (/C:/...) or a UNC host, never on POSIX.
export function fileUrlPath(url, platform) {
  const pathname = decodeURIComponent(url.pathname);
  const windows = platform ? platform === 'win32' : (/^\/[A-Za-z]:/.test(pathname) || Boolean(url.hostname));
  if (!windows) return pathname;
  const windowsPath = pathname.replaceAll('/', '\\');
  return url.hostname ? `\\\\${url.hostname}${windowsPath}` : windowsPath.replace(/^\\(?=[A-Za-z]:)/, '');
}
const RENDER_JOURNAL_PROGRAM = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [file, line, maxText] = process.argv.slice(1);
const max = Number(maxText);
fs.mkdirSync(path.dirname(file), { recursive: true });
let lines = [];
try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
lines.push(line);
while (lines.length > 1 && Buffer.byteLength(lines.join('\n') + '\n') > max) lines.shift();
let output = lines.join('\n') + '\n';
if (Buffer.byteLength(output) > max) output = line.slice(0, Math.max(0, max - 1)) + '\n';
fs.writeFileSync(file, output);
`;
export const WORKFLOW_TOOLBOX_LAYOUT = Object.freeze({
  laneDirName: '.lane',
  worktreesDirName: 'worktrees',
  scripts: {
    laneWorker: ['wt-lane.mjs', 'wt-lane'],
    pilotRunner: ['wt-pilot-runner.mjs', 'wt-pilot-runner'],
    companion: 'codex-companion.mjs',
    artifactServer: 'wt-artifact-server.mjs',
  },
  executables: { opencode: 'opencode', codex: 'codex', bun: 'bun', pythonPattern: '^python(?:\\d+(?:\\.\\d+)*)?$' },
  services: { brokerPackage: 'atrium', brokerPathPattern: '(?:^|/)atrium(?:/|$)', brokerLabel: 'Atrium broker' },
  baseBranches: ['main', 'develop'],
});
function unavailableSnapshot(reason) {
  return {
    collectors: {
      work: { value: { rows: [], sessions: [] }, availability: { status: 'unknown', reason } },
      processes: { value: { services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'unknown', items: [] } }, availability: { status: 'unknown', reason } },
    },
    discovery: 'unknown', rows: [], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'unknown', items: [] }, collectedAt: 'unknown',
  };
}
const UNKNOWN_SNAPSHOT = unavailableSnapshot('reading…');
const COLORS = {
  // Button and Link text colour cannot be set in the host, and button text renders light: every button background
  // must be DARK for contrast (owner is colour blind, 2026-09-14 #2286 — whiteBright under light text was unreadable).
  // Link text renders blue: its background must be LIGHT.
  action: 'black', actionOpen: 'gray', close: 'black', link: 'whiteBright',
  external: 'cyanBright', error: 'redBright',
};

function pathBase(value) {
  return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || null;
}

function pathJoin(root, name) {
  const value = String(root || '').replace(/[\\/]+$/, '');
  return value + (value.includes('\\') && !value.includes('/') ? '\\' : '/') + name;
}

// A session whose working directory sits in its project's `.claude` tree (the directory itself, a worktree or a
// plugin under it) belongs to the project that owns that `.claude`, never to a project named `.claude`.
export function projectRootOf(cwd) {
  const value = String(cwd || '').replace(/[\\/]+$/, '');
  const match = /^(.*?)[\\/]\.claude(?:[\\/].*)?$/.exec(value);
  return match && match[1] ? match[1] : value;
}

async function pathsOf($, options, sessionCwd) {
  sessionCwd = projectRootOf(sessionCwd);
  const configured = (name) => typeof options?.[name] === 'string' && options[name].trim() ? options[name].trim() : null;
  let configDir = configured('configDir');
  let home;
  if (!configDir) {
    try { configDir = await $.env.get('CLAUDE_CONFIG_DIR'); } catch {}
    if (!configDir) try { home = await $.env.get('HOME'); } catch {}
    if (!home) try { home = await $.env.get('USERPROFILE'); } catch {}
    configDir = configDir || pathJoin(home || sessionCwd, '.claude');
  }
  let stateHome;
  try { stateHome = await $.env.get('XDG_STATE_HOME'); } catch {}
  let suiteLockRoot;
  try { suiteLockRoot = await $.env.get('WT_SUITE_LOCK_DIR'); } catch {}
  if (!home) try { home = await $.env.get('HOME'); } catch {}
  if (!home) try { home = await $.env.get('USERPROFILE'); } catch {}
  const stateRoot = stateHome || pathJoin(home || sessionCwd, '.local/state');
  return {
    configDir,
    stateRoot,
    livenessDir: configured('livenessDir') || pathJoin(stateRoot, 'wt-liveness'),
    suiteLockRoot: suiteLockRoot || pathJoin(stateRoot, 'wt-suite-lock'),
    suiteRoot: configured('suiteRoot') || pathJoin(sessionCwd, '.claude'),
    extraRoots: (Array.isArray(options?.extraRoots) ? options.extraRoots : String(options?.extraRoots ?? '').split(/[,\n]/)).map((root) => (typeof root === 'string' ? root.trim() : '')).filter(Boolean),
    linkBase: typeof options?.linkBase === 'string' ? options.linkBase : '',
    plankaBaseUrl: typeof options?.plankaBaseUrl === 'string' ? options.plankaBaseUrl : '',
    plankaConfigFile: configured('plankaConfigFile') || '',
    procRoot: typeof options?.procRoot === 'string' ? options.procRoot : '/proc',
    now: typeof options?.now === 'string' ? options.now : undefined,
    activeWindowMin: Number(options?.activeWindowMin) > 0 ? Number(options.activeWindowMin) : 10,
  };
}

export async function readSnapshot($, paths, layout = WORKFLOW_TOOLBOX_LAYOUT, timeoutMs = COLLECTOR_TIMEOUT_MS) {
  try {
    // Test-only real-host seam: the control-character probe needs the host to render a fixed reproducing snapshot.
    let snapshotFile;
    try { snapshotFile = await $.env?.get?.('WT_WHAT_IS_RUNNING_SNAPSHOT_FILE'); } catch {}
    const collectorBootstrap = SNAPSHOT_PROGRAM.length > 0
      ? "import(process.argv[1]).then(({ SNAPSHOT_PROGRAM }) => Function('require', SNAPSHOT_PROGRAM)(require))"
      : '';
    const result = await $.process.run(
      snapshotFile
        ? ['node', '-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", snapshotFile]
        : ['node', '-e', collectorBootstrap, new URL('./snapshot-program.js', import.meta.url).href, JSON.stringify({ ...paths, priceTableFile: fileUrlPath(new URL('../pricing/model-prices.json', import.meta.url)), layout: paths.layout || layout })],
      { timeoutMs },
    );
    if (result?.exitCode !== 0) {
      const stderr = typeof result?.stderr === 'string' ? result.stderr.split(/\r?\n/).find((line) => line.trim())?.trim() : null;
      return unavailableSnapshot(`collector failed (exit code ${result?.exitCode ?? 'unknown'}; ${(stderr || 'no stderr').slice(0, 160)})`);
    }
    if (typeof result.stdout !== 'string') return unavailableSnapshot('collector failed (stdout unavailable)');
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { return unavailableSnapshot('collector failed (invalid JSON output)'); }
    return Array.isArray(parsed?.rows) && ['available', 'partial', 'unknown'].includes(parsed.discovery)
      ? parsed
      : unavailableSnapshot('collector failed (invalid snapshot output)');
  } catch (error) {
    const detail = [error?.name, error?.code, error?.message].filter(Boolean).join(' ');
    return /timeout|timed?\s*out|ETIMEDOUT/i.test(detail)
      ? unavailableSnapshot(`collector timed out after ${timeoutMs / 1000} s: ${String(error?.message || error || 'timeout').split(/\r?\n/)[0].slice(0, 240)}`)
      : unavailableSnapshot(`collector failed (${String(error?.message || error || 'unknown error').split(/\r?\n/)[0].slice(0, 160)})`);
  }
}

function node(Component, props = {}, ...children) {
  const kept = children.flat().filter((child) => child !== null && child !== undefined);
  return Component(kept.length ? { ...props, children: kept } : props);
}

function sanitizeRenderedText(value, repairs, path = '$') {
  if (typeof value === 'string') {
    const stripped = stripAnsiAndControl(value);
    if (repairs && stripped !== value) repairs.push({ path, before: value, after: stripped });
    return stripped.replace(/\[/g, '(').replace(/\]/g, ')');
  }
  if (Array.isArray(value)) return value.map((item, index) => sanitizeRenderedText(item, repairs, `${path}[${index}]`));
  return value;
}

export function sanitizePaneTree(value, path = '$', repairs = []) {
  if (typeof value === 'string') {
    const sanitized = stripAnsiAndControl(value);
    if (sanitized !== value) repairs.push({ path, before: value, after: sanitized });
    return sanitized;
  }
  if (Array.isArray(value)) return value.map((item, index) => sanitizePaneTree(item, `${path}[${index}]`, repairs));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizePaneTree(item, `${path}.${key}`, repairs)]));
}

export function isValidLinkHref(href) {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2048 || !/^[\x21-\x7e]+$/.test(href) || href.includes('@')) return false;
  try {
    const url = new URL(href);
    const allowedScheme = url.protocol === 'https:'
      || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
    return allowedScheme && !url.username && !url.password && url.href === href;
  } catch {
    return false;
  }
}

const PHASE_LABELS = Object.freeze({
  discovery: 'Discovery', plan: 'Plan', critic: 'Critic', tdd: 'TDD', verify: 'Verify',
  review: 'Independent review', refutation: 'Independent refutation', harden: 'Harden', report: 'Report',
});
export const PANE_PHASES = Object.freeze(PHASES.map((phase) => Object.freeze([phase, PHASE_LABELS[phase]])));

function phaseLabelFor(row, phase) {
  const label = PHASE_LABELS[phase] || phase;
  const model = phase === 'review' ? row.models?.review : phase === 'refutation' ? row.models?.refutation : null;
  return model && model !== 'unknown' ? `${label} (${model})` : label;
}

function stateOf(row, phase) {
  if (phase === row.phase && /^(?:error|failed|fail)/i.test(String(row.outcome || ''))) return { glyph: '✗', words: 'ERROR' };
  const words = row.phaseStates?.[phase] || 'not started';
  return { glyph: { running: '●', done: '✓', skipped: '–', 'waiting for arbiter review': '◷' }[words] || '·', words };
}

function phaseLabel(phase) {
  if (phase === 'awaiting_fidelity') return 'Waiting for arbiter review';
  return PANE_PHASES.find(([id]) => id === phase)?.[1] || phase;
}

function formatCount(value) {
  return Number.isFinite(value) ? Math.trunc(value).toLocaleString('en-US').replace(/,/g, ' ') : 'unknown';
}

function knownDetails(row) {
  const details = [];
  const gates = Object.entries(row.gates || {}).filter(([, value]) => value && value !== 'unknown');
  const review = Object.entries(row.review || {}).filter(([, value]) => value && value !== 'unknown');
  if (gates.length) details.push(`gates | ${gates.map(([name, value]) => `${name}: ${value}`).join(' | ')}`);
  if (review.length) details.push(`review | ${review.map(([name, value]) => `${name}: ${value}`).join(' | ')}`);
  return details;
}

export function renderPane(ui, snapshot, expanded, selected, currentProject, allProjects, actions) {
  const { Box, Button, Link } = ui;
  const repairs = [];
  let textIndex = 0;
  const Text = (props = {}) => ui.Text(Object.hasOwn(props, 'children')
    ? { ...props, children: sanitizeRenderedText(props.children, repairs, `$.Text[${textIndex++}].props.children`) }
    : props);
  const buttonLabel = (label) => `[${label}]`;
  const fixed = (...children) => node(Box, { flexShrink: 0 }, ...children);
  const fixedText = (props, text) => node(Box, { flexShrink: 0 }, node(Text, props, text));
  const control = (props, label, color = COLORS.action) => node(Box, { key: `control:${props.key}`, flexShrink: 0, backgroundColor: color },
    node(Button, { ...props, hover: { color: 'black', backgroundColor: 'whiteBright', bold: true } }, buttonLabel(label)));
  const linked = (props, color = COLORS.link) => node(Box, { flexShrink: 0, backgroundColor: color }, node(Link, props));
  const projectOf = (item) => typeof item?.project === 'string' && item.project.trim() && item.project !== 'unknown' ? item.project.trim() : null;
  const sameProject = (item) => projectOf(item)?.toLowerCase() === currentProject.toLowerCase();
  const workCount = (session) => (session.cards?.length || 0) + (session.actors?.length || 0);
  const candidates = Array.isArray(snapshot.sessions) ? snapshot.sessions : snapshot.rows || [];
  const hidden = allProjects ? [] : candidates.filter((item) => !sameProject(item));
  const hiddenCount = Array.isArray(snapshot.sessions) ? hidden.reduce((count, session) => count + workCount(session), 0) : hidden.length;
  const unattributedCount = Array.isArray(snapshot.sessions)
    ? hidden.filter((session) => !projectOf(session)).reduce((count, session) => count + workCount(session), 0)
    : hidden.filter((row) => !projectOf(row)).length;
  if (!allProjects) snapshot = Array.isArray(snapshot.sessions)
    ? { ...snapshot, sessions: snapshot.sessions.filter(sameProject) }
    : { ...snapshot, rows: (snapshot.rows || []).filter(sameProject) };
  const ageSeconds = (timestamp) => {
    const parsed = Date.parse(timestamp || '');
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.floor(((Number(actions.now) || Date.now()) - parsed) / 1000));
  };
  const snapshotAge = ageSeconds(snapshot.collectedAt);
  let ageText = 'update time not reported';
  if (snapshotAge !== null) {
    const elapsed = snapshotAge < 60 ? `${snapshotAge} s` : `${Math.floor(snapshotAge / 60)} min`;
    ageText = `updated ${elapsed} ago`;
  }
  const renderEvidence = (summary) => {
    const lines = String(summary || '').replace(/\r\n?/g, '\n').split('\n').map((raw) => {
      const heading = /^#{1,6}\s+(.+)$/.exec(raw.trim());
      const text = (heading?.[1] || raw.trim()).replace(/^[-*]\s+/, '').replace(/\*\*|__|`/g, '').trim();
      return text && !/^[A-Za-z][A-Za-z ]*:$/.test(text) ? { text, heading: Boolean(heading) } : null;
    }).filter(Boolean);
    // Bounded in lines AND characters: a line is a paragraph that wraps, so seven long findings still fill the screen.
    const shown = [];
    let budget = 900;
    for (const line of lines.slice(0, 7)) {
      if (budget <= 0) break;
      const text = line.text.length > Math.min(240, budget) ? `${line.text.slice(0, Math.min(240, budget) - 1).trimEnd()}…` : line.text;
      budget -= text.length;
      shown.push(node(Text, { wrap: 'wrap', ...(line.heading ? { bold: true } : {}) }, text));
    }
    if (lines.length > shown.length) shown.push(node(Text, { dimColor: true }, `… ${lines.length - shown.length} more lines`));
    return shown;
  };
  const renderStateSegment = ({ key, buttonKey, label, state, open = false, onPress = null }) => {
    const style = state.words === 'running' ? { bold: true } : {};
    return node(Box, { key, flexDirection: 'row', columnGap: 1 },
      onPress
        ? control({ key: buttonKey, plain: true, onPress }, `${open ? '▼' : '▶'} ${label} ${state.glyph}`, open ? COLORS.actionOpen : COLORS.action)
        : fixedText(style, `${label} ${state.glyph}`),
      fixedText(style, state.words),
    );
  };
  const formatUsd = (value, label) => {
    if (Number.isFinite(value)) return `$${value.toFixed(2)}` + (label ? ` (${label})` : '');
    if (typeof value === 'string') return value;
    return 'price unknown';
  };
  const formatModelUsage = (model, value) => {
    const cacheWrite = /^openai\//i.test(model) ? '' : ` · cache write ${formatCount(value.cacheWrite)}`;
    return `${model} · input ${formatCount(value.input)}${cacheWrite} · cache read ${formatCount(value.cacheRead)} · output ${formatCount(value.output)} · ${formatUsd(value.usd, value.priceLabel)}`;
  };
  const phaseCostDetail = (row, phase) => {
    const cost = row.phaseCosts?.[phase];
    if (!cost) return [];
    if (cost === 'unknown') {
      const running = stateOf(row, phase).words === 'running';
      const elapsed = running && row.phaseElapsed?.[phase] ? ` · elapsed ${row.phaseElapsed[phase]}` : '';
      const status = running ? 'waiting for the lane to finish' : 'not reported by this provider';
      return [node(Box, { key: `phase-cost-detail:${row.id}:${phase}` }, node(Text, {}, `cost: ${status}${elapsed}`))];
    }
    const models = Object.entries(cost.models || {}).map(([model, value]) => node(Text, { key: `phase-model:${row.id}:${phase}:${model}`, wrap: 'wrap' }, formatModelUsage(model, value)));
    return [
      ...(models.length ? models : [node(Box, { key: `phase-cost-detail:${row.id}:${phase}` }, node(Text, { wrap: 'wrap' }, `input ${formatCount(cost.input)} · cache write ${formatCount(cost.cacheWrite)} · cache read ${formatCount(cost.cacheRead)} · output ${formatCount(cost.output)} · ${formatUsd(cost.usd, cost.priceLabel)}`))]),
      node(Box, { key: `phase-cost-source:${row.id}:${phase}` }, node(Text, { dimColor: true }, `cost source: ${row.phaseCostSourceKind && row.phaseCostSourceKind !== 'unknown' ? row.phaseCostSourceKind : 'not reported'}`)),
    ];
  };
  const runningCostStatus = (row) => row.phaseCosts?.[row.phase] === 'unknown' && row.phaseElapsed?.[row.phase]
    ? node(Box, { key: `running-cost:${row.id}`, paddingLeft: 1 }, node(Text, { dimColor: true }, `cost: waiting for the lane to finish · elapsed ${row.phaseElapsed[row.phase]}`))
    : null;
  const runCostStatus = (row, detailed = false) => {
    if (!row.runCost) return null;
    const approximate = row.costApproximate ? ' · cost approximate' : '';
    const missingPrices = (row.runCost.priceUnknownModels?.length
      ? row.runCost.priceUnknownModels
      : Object.entries(row.runCost.models || {}).filter(([, value]) => value.usd === 'price unknown').map(([model]) => model));
    const missingPriceText = missingPrices.length ? ` · missing price for: ${missingPrices.join(', ')}` : '';
    const modelLines = detailed
      ? Object.entries(row.runCost.models || {}).map(([model, value]) => node(Text, { key: `run-model:${row.id}:${model}`, wrap: 'wrap' }, formatModelUsage(model, value)))
      : [];
    return node(Box, { key: `run-cost:${row.id}`, flexDirection: 'column', paddingLeft: 1 },
      node(Text, { dimColor: true, wrap: 'wrap' }, `run total so far: ${formatUsd(row.runCost.usd, row.runCost.priceLabel)}${missingPriceText}${approximate}`),
      ...modelLines,
    );
  };
  const compactPhaseCost = (cost, phase, key) => {
    if (!(Number(actions.bodyColumns) >= 120) || cost === undefined) return null;
    return node(Box, { key: `phase-cost:${key}:${phase}`, flexShrink: 0 }, node(Text, { dimColor: true }, cost === 'unknown' ? '· cost pending' : `· ${formatUsd(cost.usd, cost.priceLabel)}`));
  };
  const renderCardId = (row) => {
    const id = row.cardId || (/^\d{19}$/.test(String(row.id || '')) ? row.id : null);
    if (!id) return null;
    return fixed(node(Text, { bold: true }, `Card ${id}`));
  };
  const renderCardLink = (row) => {
    if (isValidLinkHref(row.cardUrl)) return node(Box, { key: `card-link:${row.id}`, paddingLeft: 1 }, Link
      ? linked({ href: row.cardUrl, label: 'open card' })
      : node(Text, { underline: true, wrap: 'wrap' }, `open card: ${row.cardUrl}`));
    if (!row.cardUrl && (row.cardId || /^\d{19}$/.test(String(row.id || '')))) {
      return node(Box, { key: `card-link:${row.id}`, paddingLeft: 1 }, node(Text, { dimColor: true, wrap: 'wrap' }, 'open card unavailable: Planka browser URL is not configured'));
    }
    return row.cardUrl ? node(Box, { key: `card-link:${row.id}`, paddingLeft: 1 }, node(Text, { dimColor: true }, 'open card unavailable: card URL is invalid')) : null;
  };
  const renderOpenDetail = (buttonKey, label, onClose, ...content) => node(Box, { key: `open-${buttonKey}`, flexDirection: 'column', paddingLeft: 1 },
    node(Box, { key: `open-detail-header:${buttonKey}`, flexDirection: 'row', columnGap: 1 },
      fixedText({ bold: true }, label),
      control({ key: `detail-close:${buttonKey}`, plain: true, onPress: onClose }, 'Close', COLORS.close),
    ),
    ...content,
  );
  const renderExternal = (row, indent = 0, showCard = true) => {
    const cardId = renderCardId(row);
    const baseLabel = row.label && row.label !== 'Lane' ? row.label : pathBase(row.worktree) || 'External lane';
    const label = `${baseLabel}${row.roleInferred ? ' (inferred)' : ''}`;
    const isExpanded = expanded.has(row.id);
    const buttonKey = `detail-toggle:row:${row.id}`;
    let outcomeLabel = '● running';
    if (/^(?:error|failed|fail)/i.test(String(row.outcome || ''))) outcomeLabel = '✗ ERROR';
    else if (row.outcome === 'done') outcomeLabel = '✓ done';
    const owner = row.launcherSessionId ? `session ${String(row.launcherSessionId).slice(0, 8)}` : 'session';
    const details = [
      `phases: n/a (${row.phaseAvailability || 'plain lane'})`,
      row.model && row.model !== 'unknown' ? `model ${row.model}` : null,
      row.activity && row.activity !== 'unknown' ? row.activity : null,
      row.elapsed && row.elapsed !== 'unknown' ? `elapsed ${row.elapsed}` : null,
    ].filter(Boolean).join(' · ');
    return node(Box, { key: row.id, flexDirection: 'column', paddingLeft: indent },
      node(Box, { flexDirection: 'row', columnGap: 1 },
        control({ key: buttonKey, plain: true, onPress: () => actions.toggle(row.id) }, `${isExpanded ? '▼' : '▶'} ${label}`, isExpanded ? COLORS.actionOpen : COLORS.action),
        showCard && cardId ? fixedText({ color: COLORS.external }, '·') : null,
        showCard ? cardId : null,
        fixedText({ color: COLORS.external, bold: row.outcome === 'running' }, `· ${outcomeLabel}`),
        row.elapsed && row.elapsed !== 'unknown' ? fixedText({ dimColor: true }, `· ${row.elapsed}`) : null,
      ),
      row.title && row.title !== label ? node(Text, { color: COLORS.external, wrap: 'wrap' }, row.title) : null,
      isExpanded && (details || row.title || (showCard && (cardId || row.cardUrl))) ? renderOpenDetail(buttonKey, `${label} details`, () => actions.toggle(row.id),
        node(Text, { dimColor: true }, `owner: ${owner}`),
        details ? node(Text, { dimColor: true, wrap: 'wrap' }, details) : null,
        showCard ? renderCardLink(row) : null,
      ) : null,
    );
  };
  const queueStatus = (queue) => {
    const prefix = `queued · position ${queue.position || '?'}`;
    if (queue.waiting?.kind === 'load') return `${prefix} · waiting for load ${queue.waiting.load} / ${queue.waiting.cores}`;
    if (queue.waiting?.kind === 'slot') return `${prefix} · waiting for a free slot ${queue.waiting.active}/${queue.waiting.limit}`;
    return `${prefix} · waiting for earlier runs`;
  };
  const renderPilot = (row, indent, showCard = true, showStages = true) => {
    const isExpanded = expanded.has(row.id);
    const selection = selected.get(row.id);
    const inspector = selection ? row.inspectors?.[selection.toLowerCase()] : null;
    const phaseKnown = row.phase && row.phase !== 'unknown';
    const visiblePhases = phaseKnown ? PANE_PHASES : [];
    const stageHeading = row.phaseSource === 'log' ? 'Work stages (from log):' : 'Work stages:';
    const phaseButtons = visiblePhases.map(([phase, label]) => {
      const state = stateOf(row, phase);
      const buttonKey = `detail-toggle:stage:${row.id}:${phase}`;
      const hasEvidence = (Boolean(row.inspectors?.[phase]?.summary || row.inspectors?.[phase]?.href) || Object.hasOwn(row.phaseCosts || {}, phase)) && !['not started', 'skipped'].includes(state.words);
      return renderStateSegment({ key: `phase-state:${row.id}:${phase}`, buttonKey, label: phaseLabelFor(row, phase), state, open: selection === phase, onPress: hasEvidence ? () => actions.select(row.id, phase) : null });
    });
    const rounds = row.criticRounds > 0
      ? `Plan ↔ Critic: ${row.runnerLogTruncated ? 'at least ' : ''}${row.criticRounds} ${row.criticRounds === 1 ? 'round' : 'rounds'}`
      : null;
    const title = row.title && row.title !== row.id ? row.title : null;
    const current = row.phase && row.phase !== 'unknown' ? phaseLabel(row.phase) : null;
    const queue = row.queue ? queueStatus(row.queue) : null;
    const expandedLines = isExpanded ? [
      ...knownDetails(row).map((line) => node(Text, { dimColor: true }, line)),
      row.usage ? node(Text, { dimColor: true }, `usage | ${Object.entries(row.usage).filter(([, value]) => value !== 'unknown').map(([name, value]) => `${name.replace(/[A-Z]/g, (letter) => ' ' + letter.toLowerCase())}: ${value}`).join(' | ')}`) : null,
      !row.usage && row.tokens && row.tokens !== 'unknown' && row.tokens !== 'not counted' ? node(Text, { dimColor: true }, `usage | tokens: ${row.tokens}`) : null,
      row.activity && row.activity !== 'unknown' ? node(Text, { dimColor: true }, `activity: ${row.activity}`) : null,
      row.watchdog && row.watchdog !== 'unknown' ? node(Text, { dimColor: true }, `watchdog: ${row.watchdog}`) : null,
    ] : [];
    const inspectorButtonKey = selection ? `detail-toggle:stage:${row.id}:${selection}` : null;
    const inspectorNodes = !selection ? [] : [renderOpenDetail(inspectorButtonKey, PANE_PHASES.find(([phase]) => phase === selection)?.[1] || selection, () => actions.closeView(row.id),
      ...phaseCostDetail(row, selection),
      ...renderEvidence(inspector?.summary || (inspector?.href ? 'A report was recorded.' : '')),
      Link && isValidLinkHref(inspector?.href) ? linked({ href: inspector.href, label: '[Open report]' }) : null,
    )];
    const lanes = (row.lanes || []).map((lane) => renderExternal(lane, 1, false));
    const failed = /^(?:error|failed|fail)/i.test(String(row.outcome || ''));
    return node(Box, { key: `pilot:${row.id}`, flexDirection: 'column', paddingLeft: indent },
      node(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 },
        control({ key: `detail-toggle:row:${row.id}`, plain: true, onPress: () => actions.toggle(row.id) }, `${isExpanded ? '▼' : '▶'} ${row.label || 'Pilot'}`, isExpanded ? COLORS.actionOpen : COLORS.action),
        showCard ? renderCardId(row) : null,
        title ? node(Text, { wrap: 'wrap' }, `· ${title}`) : null,
        current ? fixedText({}, `· ${current}`) : null,
        queue ? fixedText({ dimColor: true }, `· ${queue}`) : null,
        failed ? fixedText({ color: COLORS.error, bold: true }, ` · ${row.outcome}`) : null,
      ),
      showCard ? renderCardLink(row) : null,
      showStages && phaseKnown ? node(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, paddingLeft: 1 }, fixedText({ bold: true }, stageHeading), ...phaseButtons.flatMap((segment, index) => index ? [fixedText({ dimColor: true }, '│'), segment] : [segment])) : null,
      runCostStatus(row),
      runningCostStatus(row),
      rounds ? node(Box, { paddingLeft: 1 }, node(Text, { dimColor: true }, rounds)) : null,
      ...(showStages ? inspectorNodes : []),
      isExpanded ? renderOpenDetail(`detail-toggle:row:${row.id}`, `${row.label || 'Pilot'} details`, () => actions.toggle(row.id), ...expandedLines) : null,
      ...lanes,
    );
  };
  const grouped = [];
  const deepActors = (actors) => (actors || []).flatMap((actor) => [actor, ...deepActors([...(actor.lanes || []), ...(actor.children || [])])]);
  const renderCardStages = (card, sessionId) => {
    // `sdkLifecycle` is the deciding field: lifecycle phases replace, rather than extend, the legacy dev cycle.
    const pilot = deepActors(card.actors).find((actor) => actor.sdkLifecycle === true && ((actor.phase && actor.phase !== 'unknown') || actor.queue));
    const key = `timeline:${sessionId}:${card.id}`;
    const selection = selected.get(key);
    if (pilot?.queue) return node(Box, { key, paddingLeft: 1 }, fixedText({ dimColor: true }, queueStatus(pilot.queue)));
    if (pilot) {
      const isExpanded = expanded.has(pilot.id);
      const stages = PANE_PHASES.map(([id]) => ({ id, label: phaseLabelFor(pilot, id), state: stateOf(pilot, id), cost: pilot.phaseCosts?.[id], inspector: pilot.inspectors?.[id] }));
      if (pilot.phaseStates?.awaiting_fidelity && pilot.phaseStates.awaiting_fidelity !== 'not started') stages.push({ id: 'awaiting_fidelity', label: 'Fidelity', state: stateOf(pilot, 'awaiting_fidelity'), cost: pilot.phaseCosts?.awaiting_fidelity, inspector: pilot.inspectors?.awaiting_fidelity });
      const shown = isExpanded ? stages : stages.filter((stage) => !['skipped', 'not started'].includes(stage.state.words));
      const skipped = stages.filter((stage) => stage.state.words === 'skipped');
      const next = stages.filter((stage) => stage.state.words === 'not started');
      const failed = /^(?:error|failed|fail)/i.test(String(pilot.outcome || ''));
      const stageRows = shown.map((stage, index) => {
        const buttonKey = `detail-toggle:stage:${sessionId}:${card.id}:${stage.id}`;
        const hasEvidence = (Boolean(stage.inspector?.summary || stage.inspector?.href) || stage.cost !== undefined) && !['not started', 'skipped'].includes(stage.state.words);
        const isLast = index === shown.length - 1 && !next.length && !skipped.length;
        const reportFallback = stage.inspector?.href ? 'A report was recorded.' : '';
        const report = stage.inspector?.summary || reportFallback;
        const openDetail = selection === stage.id
          ? renderOpenDetail(buttonKey, stage.label, () => actions.closeView(key), ...phaseCostDetail(pilot, stage.id), ...renderEvidence(report), Link && isValidLinkHref(stage.inspector?.href) ? linked({ href: stage.inspector.href, label: '[Open report]' }) : null)
          : null;
        return node(Box, { key: `spine-stage:${key}:${stage.id}`, flexDirection: 'column', paddingLeft: 1 },
          node(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 },
            fixedText({ dimColor: true }, isLast ? '└' : '├'),
            renderStateSegment({ key: `stage-state:${sessionId}:${card.id}:${stage.id}`, buttonKey, label: stage.label, state: stage.state, open: selection === stage.id, onPress: hasEvidence ? () => actions.select(key, stage.id) : null }),
            pilot.phaseElapsed?.[stage.id] ? fixedText({ dimColor: true }, `· ${pilot.phaseElapsed[stage.id]}`) : null,
            stage.cost && stage.cost !== 'unknown' ? fixedText({ dimColor: true }, `· ${formatUsd(stage.cost.usd, stage.cost.priceLabel)}`) : null,
          ),
          openDetail,
          failed && stage.id === pilot.phase ? node(Text, { color: COLORS.error, bold: true }, `owner: pilot runner · ${pilot.outcome}`) : null,
        );
      });
      const nextNames = next.map((stage) => stage.label).join(', ') || 'none';
      const skippedSummary = skipped.length ? ` · skipped: ${skipped.length}` : '';
      const collapsedSummary = !isExpanded && (next.length || skipped.length)
        ? node(Text, { dimColor: true }, ` ├ next: ${nextNames}${skippedSummary}`)
        : null;
      let roundSummary = null;
      if (isExpanded && pilot.criticRounds > 0) {
        const lowerBound = pilot.runnerLogTruncated ? 'at least ' : '';
        const unit = pilot.criticRounds === 1 ? 'round' : 'rounds';
        roundSummary = node(Text, { dimColor: true }, `Plan ↔ Critic: ${lowerBound}${pilot.criticRounds} ${unit}`);
      }
      const pilotLabel = pilot.label || 'SDK pilot';
      return node(Box, { key, flexDirection: 'column' },
        node(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 },
          control({ key: `detail-toggle:row:${pilot.id}`, plain: true, onPress: () => actions.toggle(pilot.id) }, `${isExpanded ? '▼' : '▶'} ${pilotLabel}`, isExpanded ? COLORS.actionOpen : COLORS.action),
          fixedText({ bold: true }, 'drives the stages below'),
          isExpanded && pilot.route ? fixedText({ dimColor: true }, `· route ${pilot.route}`) : null,
        ),
        ...stageRows,
        collapsedSummary,
        runCostStatus(pilot, isExpanded),
        runningCostStatus(pilot),
        roundSummary,
        isExpanded ? renderOpenDetail(`detail-toggle:row:${pilot.id}`, `${pilotLabel} details`, () => actions.toggle(pilot.id),
          ...knownDetails(pilot).map((line) => node(Text, { dimColor: true }, line)),
          renderCardLink(card),
        ) : null,
        ...(pilot.lanes || []).map((lane) => renderExternal(lane, 1, false)),
      );
    }
    const stages = [];
    if (pilot) for (const [id] of PANE_PHASES) {
      const state = stateOf(pilot, id);
      const inspector = pilot.inspectors?.[id];
      stages.push({ id, label: phaseLabelFor(pilot, id), state, summary: inspector?.summary || (inspector?.href ? 'A report was recorded.' : null), href: inspector?.href, cost: pilot.phaseCosts?.[id] });
    }
    if (pilot?.phaseStates?.awaiting_fidelity && pilot.phaseStates.awaiting_fidelity !== 'not started') {
      stages.push({ id: 'awaiting_fidelity', label: 'Fidelity', state: stateOf(pilot, 'awaiting_fidelity'), summary: null, href: null });
    }
    const cycleLabels = { implementation: 'Implementation', review: 'Sol review', refutation: 'Astra refutation', arbiter: 'Decision', fix: 'Fix', merge: 'Merge' };
    for (const stage of pilot ? [] : card.devCycle?.stages || []) {
      const fixRounds = card.devCycle?.fixRounds || 0;
      const summary = stage.id === 'fix' && fixRounds > 0
        ? `${fixRounds} fix ${fixRounds === 1 ? 'round was' : 'rounds were'} requested.`
        : stage.summary;
      stages.push({ id: `card-${stage.id}`, label: cycleLabels[stage.id] || stage.label, state: { glyph: { running: '●', done: '✓', skipped: '–' }[stage.state] || '·', words: stage.state }, summary });
    }
    if (!stages.length) return null;
    const segments = stages.map((stage) => {
      const buttonKey = `detail-toggle:stage:${sessionId}:${card.id}:${stage.id}`;
      const hasEvidence = (Boolean(stage.summary) || stage.cost !== undefined) && !['not started', 'skipped'].includes(stage.state.words) && (!stage.summary || !/^(?:Not reached\.|No summary available\.|decision: recorded|fix requested)$/i.test(stage.summary.trim()));
      return node(Box, { key: `stage-with-cost:${sessionId}:${card.id}:${stage.id}`, flexDirection: 'row', columnGap: 1 },
        renderStateSegment({ key: `stage-state:${sessionId}:${card.id}:${stage.id}`, buttonKey, label: stage.label, state: stage.state, open: selection === stage.id, onPress: hasEvidence ? () => actions.select(key, stage.id) : null }),
        pilot ? compactPhaseCost(stage.cost, stage.id, `${sessionId}:${card.id}`) : null,
      );
    });
    const openStage = stages.find((stage) => stage.id === selection);
    const openButtonKey = openStage ? `detail-toggle:stage:${sessionId}:${card.id}:${openStage.id}` : null;
    return node(Box, { key, flexDirection: 'column', paddingLeft: 1 },
      node(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 }, fixedText({ bold: true }, 'Work stages:'), ...segments.flatMap((segment, index) => index ? [fixedText({ dimColor: true }, '│'), segment] : [segment])),
      pilot ? runCostStatus(pilot) : null,
      pilot ? runningCostStatus(pilot) : null,
      !pilot && (card.devCycle?.rounds > 0 || card.devCycle?.fixRounds > 0)
        ? node(Text, { dimColor: true }, `review rounds: ${card.devCycle?.rounds || 0} · fix rounds: ${card.devCycle?.fixRounds || 0}`)
        : null,
      openStage ? renderOpenDetail(openButtonKey, openStage.label, () => actions.closeView(key), ...(pilot ? phaseCostDetail(pilot, openStage.id) : []), ...renderEvidence(openStage.summary), Link && isValidLinkHref(openStage.href) ? linked({ href: openStage.href, label: '[Open report]' }) : null) : null,
    );
  };
  const renderHierarchyActor = (actor, indent = 1) => node(Box, { key: `hierarchy:${actor.id}`, flexDirection: 'column' },
    actor.kind === 'pilot' ? renderPilot(actor, indent, false, false) : renderExternal(actor, indent, false),
    ...(actor.children || []).map((child) => renderHierarchyActor(child, indent + 1)),
  );
  if (Array.isArray(snapshot.sessions)) for (const session of snapshot.sessions) {
    const cards = (session.cards || []).flatMap((card, index) => [index ? node(Box, { key: `card-separator:${session.id}:${card.id}`, flexDirection: 'column' }, node(Text, {}, ''), node(Text, { dimColor: true }, '────────────────────────────────────────')) : null, node(Box, { key: `card:${session.id}:${card.id}`, flexDirection: 'column', paddingLeft: 1 },
      card.waveId ? node(Text, { bold: true }, `Wave ${card.waveId}`) : null,
      card.title && card.title !== card.id ? node(Text, { bold: true, wrap: 'wrap' }, card.title) : node(Text, { bold: true }, `Card ${card.id}`),
      !(card.actors || []).some((actor) => actor.sdkLifecycle === true) ? renderCardLink(card) : null,
      renderCardStages(card, session.id),
      ...(card.actors || []).filter((actor) => actor.sdkLifecycle !== true).map((actor) => renderHierarchyActor(actor, 1)),
    )]).filter(Boolean);
    const project = session.project && session.project !== 'unknown' ? session.project.trim() : null;
    const name = typeof session.name === 'string' ? session.name.trim() : null;
    const identity = name && (!project || name.toLowerCase() !== project.toLowerCase()) ? name : session.sessionId?.slice(0, 8) || null;
    const sessionLabel = project || identity ? ['Session', project, identity].filter(Boolean).join(' · ') : 'Session';
    grouped.push(node(Box, { key: session.id, flexDirection: 'column' },
      node(Box, { key: `session-rule:${session.id}`, flexDirection: 'column' }, node(Text, {}, ''), node(Text, { dimColor: true }, '════════════════════════════════════════')),
      node(Box, { key: `session-header:${session.id}` }, fixedText({ bold: true, wrap: 'wrap' }, sessionLabel)),
      ...cards,
      ...(session.actors || []).map((actor) => renderHierarchyActor(actor, 1)),
    ));
  }
  if (!Array.isArray(snapshot.sessions)) {
    const waveIds = [...new Set(snapshot.rows.map((row) => row.waveId).filter(Boolean))].sort();
    for (const waveId of waveIds) grouped.push(node(Box, { key: `wave:${waveId}`, flexDirection: 'column' },
      node(Text, { bold: true }, `Wave ${waveId}`),
      ...snapshot.rows.filter((row) => row.waveId === waveId).map((row) => renderPilot(row, 1)),
    ));
    grouped.push(...snapshot.rows.filter((row) => !row.waveId).map((row) => row.kind === 'external' ? renderExternal(row) : renderPilot(row, 0)));
  }
  const allActors = Array.isArray(snapshot.sessions)
    ? snapshot.sessions.flatMap((session) => [...(session.actors || []), ...(session.cards || []).flatMap((card) => deepActors(card.actors))])
    : snapshot.rows || [];
  const pilotErrors = allActors.filter((actor) => actor.kind === 'pilot' && /^(?:error|failed|fail)/i.test(String(actor.outcome || ''))).length;
  const laneErrors = allActors.filter((actor) => actor.kind === 'external' && /^(?:error|failed|fail)/i.test(String(actor.outcome || ''))).length;
  if (pilotErrors || laneErrors) {
    const errorCount = pilotErrors + laneErrors;
    const owners = [];
    if (pilotErrors) owners.push(`${pilotErrors} for the pilot runner`);
    if (laneErrors) owners.push(`${laneErrors} for the session`);
    grouped.unshift(node(Text, { color: COLORS.error, bold: true }, `⚠ ${errorCount} error${errorCount === 1 ? '' : 's'} · ${owners.join(' · ')}`));
  }
  const suiteLock = snapshot.suiteLock;
  // The pane is read narrow: show the worktree's own name (what follows `/worktrees/`), not the full path.
  const suiteWhere = (cwd) => {
    const text = String(cwd ?? '').replaceAll('\\', '/');
    const marker = text.lastIndexOf('/worktrees/');
    return marker >= 0 ? text.slice(marker + '/worktrees/'.length) : text.split('/').filter(Boolean).slice(-2).join('/');
  };
  if (suiteLock?.status === 'running') grouped.unshift(node(Text, { bold: true, wrap: 'wrap' }, `Test suite · ${suiteLock.command} · running ${suiteLock.age} · ${suiteWhere(suiteLock.worktree)}`));
  else if (suiteLock?.status === 'stale') grouped.unshift(node(Text, { dimColor: true, wrap: 'wrap' }, `Test suite lock stale · ${suiteLock.command} · started ${suiteLock.age} ago · ${suiteWhere(suiteLock.worktree)}`));
  else if (suiteLock?.status === 'unknown') grouped.unshift(node(Text, { dimColor: true }, 'Test suite lock · status could not be determined'));
  const renderCollapsedProcesses = (key, label, items) => {
    const buttonKey = `detail-toggle:row:${key}`;
    const isExpanded = expanded.has(key);
    const detailLines = items.slice(0, 7).map((item) => node(Text, { dimColor: true, wrap: 'wrap' }, `${item.label}${item.age && item.age !== 'unknown' ? ` · ${item.age}` : ''}`));
    if (items.length > 7) detailLines.push(node(Text, { dimColor: true }, `… ${items.length - 7} more lines`));
    grouped.push(node(Box, { key, flexDirection: 'column' },
      // One row per section: the label once, its meaning beside it (owner #2226: the name was printed twice).
      node(Box, { flexDirection: 'row', columnGap: 1 },
        items.length ? control({ key: buttonKey, plain: true, onPress: () => actions.toggle(key) }, `${isExpanded ? '▼' : '▶'} ${label}`, isExpanded ? COLORS.actionOpen : COLORS.action) : fixedText({}, label),
        node(Text, { dimColor: true, wrap: 'wrap' }, key === 'services'
          ? '· long-lived servers (links, Atrium)'
          : '· Codex servers left after Astra calls, safe to stop'),
      ),
      isExpanded ? renderOpenDetail(buttonKey, label, () => actions.toggle(key), ...detailLines) : null,
    ));
  };
  if (grouped.length || snapshot.services?.count || snapshot.helpers?.count) {
    if (snapshot.services?.count) renderCollapsedProcesses('services', `Services (${snapshot.services.count})`, snapshot.services?.items || []);
    const oldest = snapshot.helpers?.oldest;
    if (snapshot.helpers?.count) renderCollapsedProcesses('idle-helpers', `Idle helpers (${snapshot.helpers.count}${oldest && oldest !== 'unknown' ? `; oldest ${oldest}` : ''})`, snapshot.helpers?.items || []);
  }
  const processAvailability = snapshot.collectors?.processes?.availability
    || { status: snapshot.processDiscovery, reason: snapshot.processPartialReason };
  if (processAvailability?.status === 'unknown') grouped.push(node(Text, { dimColor: true }, `The plugin could not list background processes (${processAvailability.reason || 'unavailable on this platform'})`));
  if (processAvailability?.status === 'partial') grouped.push(node(Text, { dimColor: true }, `process list partial (${processAvailability.reason || 'reason unavailable'})`));
  if (snapshot.discovery === 'partial') {
    const reasons = [snapshot.collectors?.work?.availability?.reason || 'reason unavailable'];
    const key = 'discovery-detail';
    const isExpanded = expanded.has(key);
    grouped.push(node(Box, { key, flexDirection: 'column' },
      control({ key: `detail-toggle:row:${key}`, plain: true, onPress: () => actions.toggle(key) }, `${isExpanded ? '▼' : '▶'} why`, isExpanded ? COLORS.actionOpen : COLORS.action),
      node(Text, { dimColor: true }, 'Some running work could not be listed'),
      isExpanded ? renderOpenDetail(`detail-toggle:row:${key}`, 'Why some work is missing', () => actions.toggle(key), ...reasons.map((reason) => node(Text, { dimColor: true, wrap: 'wrap' }, reason))) : null,
    ));
  }
  if (snapshot.refreshFailure) {
    const key = 'collector-failure';
    const isExpanded = expanded.has(key);
    grouped.unshift(node(Box, { key, flexDirection: 'column' },
      node(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 },
        control({ key: `detail-toggle:row:${key}`, plain: true, onPress: () => actions.toggle(key) }, `${isExpanded ? '▼' : '▶'} details`, isExpanded ? COLORS.actionOpen : COLORS.action),
        node(Text, { dimColor: true }, `${ageText} · last refresh failed, retrying · workflow-toolbox plugin owns the retry`),
      ),
      isExpanded ? renderOpenDetail(`detail-toggle:row:${key}`, 'Collector failure', () => actions.toggle(key), node(Text, { wrap: 'wrap' }, snapshot.refreshFailure.detail), node(Text, { dimColor: true, wrap: 'wrap' }, `journal: ${snapshot.refreshFailure.journalPath}`)) : null,
    ));
  }
  if (hiddenCount) grouped.push(node(Text, { dimColor: true }, `${hiddenCount} ${hiddenCount === 1 ? 'item' : 'items'} hidden${unattributedCount ? ` · ${unattributedCount} unattributed` : ''}`));
  const workAvailability = snapshot.collectors?.work?.availability;
  let unavailableText = 'The workflow-toolbox plugin could not read the running work; it will retry.';
  if (workAvailability?.reason === 'reading…') unavailableText = 'Reading the running work…';
  let lines = grouped;
  if (snapshot.discovery === 'unknown') {
    const detail = workAvailability?.reason || 'collector failed';
    const key = 'collector-failure';
    const isExpanded = expanded.has(key);
    const journal = snapshot.refreshFailure?.journalPath;
    const journalLine = journal ? node(Text, { dimColor: true }, `journal: ${journal}`) : null;
    const details = isExpanded
      ? renderOpenDetail(`detail-toggle:row:${key}`, 'Collector failure', () => actions.toggle(key), node(Text, { wrap: 'wrap' }, detail), journalLine)
      : null;
    lines = [node(Box, { key, flexDirection: 'column' },
      node(Box, { flexDirection: 'row', columnGap: 1 },
        node(Text, { dimColor: true }, unavailableText),
        control({ key: `detail-toggle:row:${key}`, plain: true, onPress: () => actions.toggle(key) }, `${isExpanded ? '▼' : '▶'} details`, isExpanded ? COLORS.actionOpen : COLORS.action),
      ),
      details,
    )];
  }
  else if (!grouped.length) lines = [node(Text, { dimColor: true }, 'Nothing running in the background.')];
  const narrow = Number(actions.bodyColumns) < 72;
  let scope = allProjects ? 'Scope: all projects' : `Scope: this project · ${currentProject}`;
  if (narrow) scope = allProjects ? '· all' : `· ${currentProject}`;
  const tree = node(Box, { flexDirection: 'column' },
    node(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: narrow ? 1 : 2 },
      fixedText({ bold: true }, 'What is running'),
      fixedText({ dimColor: true }, scope),
      node(Box, { flexGrow: 1 }),
      control({ key: 'project-scope', plain: true, onPress: actions.switchScope }, allProjects ? 'Show this project' : 'Show all projects', allProjects ? COLORS.actionOpen : COLORS.action),
      control({ key: 'close', plain: true, onPress: actions.close }, 'Close', COLORS.close),
    ),
    snapshot.discovery !== 'unknown' ? node(Text, { dimColor: true }, ageText) : null,
    ...lines,
  );
  const sanitized = sanitizePaneTree(tree, '$', repairs);
  if (repairs.length) actions.onRepair?.(repairs);
  return sanitized;
}

function renderFailurePane(ui, close, error) {
  const detail = stripAnsiAndControl(String(error?.message || error || 'unknown error')).slice(0, 160);
  return node(ui.Box, { flexDirection: 'column' },
    node(ui.Text, { bold: true }, 'What is running'),
    node(ui.Text, { color: COLORS.error, wrap: 'wrap' }, `The display failed: ${detail}`),
    node(ui.Box, { key: 'control:close', flexShrink: 0, backgroundColor: COLORS.close },
      node(ui.Button, { key: 'close', plain: true, hover: { color: 'black', backgroundColor: 'whiteBright', bold: true }, onPress: close }, '[Close]')),
  );
}

/** @type {import('claude-code').Register} */
export const registerWithLayout = (on, options, layout) => {
  let host = null;
  let open = false;
  let timer = null;
  let snapshot = UNKNOWN_SNAPSHOT;
  let generation = 0;
  let paneObserved = false;
  let missedRenders = 0;
  let closedOnPurpose = false;
  let openedHere = false;
  let paneId = null;
  let pendingPaneId = null;
  let refreshing = false;
  let lastGoodSnapshot = null;
  let ticksToSkip = 0;
  let processRefusalStreaks = new Map();
  let currentProject = null;
  let allProjects = false;
  const expanded = new Set();
  const selected = new Map();
  const pollMs = Number(options?.pollMs) > 0 ? Number(options.pollMs) : 2000;
  const collectorTimeoutMs = Number(options?.collectorTimeoutMs) >= 1000 ? Number(options.collectorTimeoutMs) : COLLECTOR_TIMEOUT_MS;
  const slowRenderMs = Number(options?.slowRenderMs) >= 0 ? Number(options.slowRenderMs) : SLOW_RENDER_THRESHOLD_MS;

  const recordRenderEvent = (kind, detail, viewport) => {
    if (!host) return;
    const event = JSON.stringify({
      timestamp: new Date().toISOString(),
      kind,
      detail: stripAnsiAndControl(String(detail || '')).slice(0, 240),
      viewport: { columns: viewport?.bodyColumns ?? null, rows: viewport?.bodyRows ?? null },
    });
    // Diagnostics must never become another render failure. The subprocess keeps all file access outside the hook sandbox.
    void host.appendJournal(event).catch(() => {});
  };

  const stopPolling = (request) => {
    if (request !== undefined && request !== generation) return;
    generation += 1;
    timer?.cancel?.(); timer = null; open = false; paneObserved = false;
  };
  const refresh = async (request = generation) => {
    if (!host || !open || request !== generation || refreshing) return;
    refreshing = true;
    const startedAt = Date.now();
    try {
      let nextSnapshot = await host.readSnapshot(host.paths);
      if (!open || request !== generation) return;
      if (nextSnapshot.discovery === 'unknown') {
        const detail = nextSnapshot.collectors?.work?.availability?.reason || 'collector failed';
        const refreshFailure = { detail, journalPath: host.collectorJournalPath, failedAt: new Date().toISOString() };
        const event = JSON.stringify({ timestamp: refreshFailure.failedAt, kind: 'collector-failure', detail, pluginVersion: PLUGIN_VERSION });
        void host.appendCollectorJournal(event).catch(() => {});
        snapshot = lastGoodSnapshot ? { ...lastGoodSnapshot, refreshFailure } : { ...nextSnapshot, refreshFailure };
        host.invalidate();
        return;
      }
      const refusals = Array.isArray(nextSnapshot.pathRefusals) ? nextSnapshot.pathRefusals : [];
      const nextStreaks = new Map();
      const visibleRefusals = refusals.filter((reason) => {
        if (!reason.startsWith('process live actor ')) return true;
        const count = (processRefusalStreaks.get(reason) || 0) + 1;
        nextStreaks.set(reason, count);
        return count >= 2;
      });
      processRefusalStreaks = nextStreaks;
      if (visibleRefusals.length !== refusals.length) {
        const onlyDebouncedRefusalsMadePartial = nextSnapshot.discovery === 'partial'
          && visibleRefusals.length === 0 && refusals.length > 0 && !nextSnapshot.cappedScans?.length;
        nextSnapshot = { ...nextSnapshot, pathRefusals: visibleRefusals, ...(onlyDebouncedRefusalsMadePartial ? { discovery: 'available' } : {}) };
      }
      snapshot = nextSnapshot;
      lastGoodSnapshot = nextSnapshot;
      host.invalidate();
    } finally {
      const duration = Date.now() - startedAt;
      ticksToSkip = Math.max(ticksToSkip, Math.ceil(duration / pollMs) - 1);
      refreshing = false;
    }
  };
  const close = async () => {
    if (!host) return;
    closedOnPurpose = true;
    stopPolling();
    const closing = host.close({ id: paneId || PANE_ID });
    await closing;
  };
  const startPolling = (request) => {
    timer = host.every(pollMs, async () => {
      if (!open || request !== generation) {
        stopPolling(request);
        return;
      }
      if (refreshing) return;
      if (ticksToSkip > 0) { ticksToSkip -= 1; return; }
      // No render since the last tick is how a pane closed by the host's own cross is noticed. One miss is not
      // that: a tick can land between the end of a collection and the render it asked for.
      if (!paneObserved) {
        missedRenders += 1;
        if (missedRenders >= MISSED_RENDERS_BEFORE_STOP) {
          stopPolling(request);
          return;
        }
      } else missedRenders = 0;
      paneObserved = false;
      await refresh(request);
    });
  };
  // The host renders only a pane that is on screen. A render of ours while polling is stopped, without a
  // deliberate close, means the no-render detector was wrong: come back instead of leaving an empty frame.
  const rearm = () => {
    const request = generation;
    open = true;
    missedRenders = 0;
    startPolling(request);
    void refresh(request).catch(() => {});
  };
  const show = async (focus = true) => {
    if (!host) return;
    stopPolling();
    processRefusalStreaks.clear();
    closedOnPurpose = false;
    openedHere = true;
    missedRenders = 0;
    const request = generation;
    open = true;
    allProjects = false;
    paneId = nextPaneId();
    await host.open({ id: paneId, title: 'What is running', ...(focus ? { focus: true } : {}) });
    await refresh(request);
    startPolling(request);
  };
  on('session.start', async ($, event, next) => {
    currentProject = pathBase(projectRootOf(event.cwd));
    let snapshotFile;
    try { snapshotFile = await $.env.get('WT_WHAT_IS_RUNNING_SNAPSHOT_FILE'); } catch { snapshotFile = undefined; }
    const paths = await pathsOf($, options, event.cwd);
    host = {
      paths,
      readSnapshot: (paths) => readSnapshot({ env: { get: async () => snapshotFile }, process: { run: (argv, init) => $.process.run(argv, init) } }, paths, layout, collectorTimeoutMs),
      invalidate: () => $.ui.invalidate('ui.render'),
      open: (pane) => $.ui.open(pane),
      close: (pane) => $.ui.close(pane),
      every: (ms, fn) => $.clock.every(ms, fn),
      appendJournal: (line) => $.process.run(['node', '-e', RENDER_JOURNAL_PROGRAM, pathJoin(pathJoin(paths.configDir, 'plugins/data'), 'wt-what-is-running-render.jsonl'), line, String(RENDER_JOURNAL_MAX_BYTES)]),
      collectorJournalPath: pathJoin(pathJoin(paths.stateRoot, 'workflow-toolbox'), 'what-is-running-errors.jsonl'),
      appendCollectorJournal: (line) => $.process.run(['node', '-e', RENDER_JOURNAL_PROGRAM, pathJoin(pathJoin(paths.stateRoot, 'workflow-toolbox'), 'what-is-running-errors.jsonl'), line, String(RENDER_JOURNAL_MAX_BYTES)]),
    };
    try { await $.command.register({ name: 'wir', description: 'Open the What is running view' }); }
    catch { await $.ui.log('wt-what-is-running: /wir unavailable'); }
    if (pendingPaneId) {
      paneId = pendingPaneId;
      pendingPaneId = null;
      openedHere = true;
      recordRenderEvent('restored-after-reload', "the host rendered this registration's tagged pane before session.start", null);
      rearm();
      host.invalidate();
    }
    return next(event);
  });

  // /wir is this plugin's own command: nothing downstream serves it, so the hook answers itself.
  // Calling next() here returns the engine's "no command.run hook answered it".
  on('command.run', { command: 'wir' }, async () => {
    await show();
    return { text: 'What is running: opened.' };
  });

  on('ui.render', { component: 'Pane' }, async ($, event, next) => {
    const result = await next(event);
    const taggedPane = typeof event.requestId === 'string' && event.requestId.startsWith(`${PANE_ID}-`);
    // The fixed id remains an in-process alias for host/test compatibility. Only a tagged id proves to a fresh
    // registration that this session already had our pane; no shared store or ui.open call is involved.
    if (event.requestId !== paneId && !(openedHere && event.requestId === PANE_ID) && !(taggedPane && !openedHere)) return result;
    if (!open) {
      if (!host && taggedPane) {
        pendingPaneId = event.requestId;
        return result;
      }
      // Only the registration that opened this pane may bring it back: another session never adopts it.
      if (!host || closedOnPurpose) return result;
      if (!openedHere) {
        paneId = event.requestId;
        openedHere = true;
        recordRenderEvent('restored-after-reload', "the host rendered this registration's tagged pane", event.props);
      } else recordRenderEvent('rearmed', 'the host rendered the pane after the no-render detector had stopped it', event.props);
      rearm();
    }
    paneObserved = true;
    let ui;
    try { ui = await $.ui.resolve(event); } catch { return result; }
    if (!ui?.Box || !ui?.Text || !ui?.Button) return result;
    const startedAt = Date.now();
    try {
      const tree = renderPane(ui, snapshot, expanded, selected, currentProject, allProjects, {
        close,
        switchScope: () => { allProjects = !allProjects; $.ui.invalidate('ui.render'); },
        toggle: (id) => { expanded.has(id) ? expanded.delete(id) : expanded.add(id); $.ui.invalidate('ui.render'); },
        select: (id, phase) => { selected.get(id) === phase ? selected.delete(id) : selected.set(id, phase); $.ui.invalidate('ui.render'); },
        closeView: (id) => { selected.delete(id); $.ui.invalidate('ui.render'); },
        bodyColumns: event.props?.bodyColumns,
        onRepair: (repairs) => recordRenderEvent('repaired-tree', `${repairs.length} string(s); first ${repairs[0].path}`, event.props),
      });
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > slowRenderMs) recordRenderEvent('slow-render', `${elapsedMs} ms (threshold ${slowRenderMs} ms)`, event.props);
      return tree;
    } catch (error) {
      recordRenderEvent('render-throw', error?.message || error || 'unknown error', event.props);
      return renderFailurePane(ui, close, error);
    }
  });

  on('ui.render', { component: 'PromptHint' }, async ($, event, next) => {
    const result = await next(event);
    let ui;
    try { ui = await $.ui.resolve(event); } catch { return result; }
    if (!ui?.Box || !ui?.Button) return result;
    return node(ui.Box, { flexDirection: 'row' }, result,
      node(ui.Box, { key: 'control:wt-wir-open', backgroundColor: COLORS.action }, node(ui.Button, { key: 'wt-wir-open', plain: true, hover: { color: 'black', backgroundColor: 'whiteBright', bold: true }, onPress: () => { void show(); } }, '[what is running]')));
  });
};

/** @type {import('claude-code').Register} */
export const register = (on, options) => registerWithLayout(on, options, WORKFLOW_TOOLBOX_LAYOUT);
