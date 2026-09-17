import { SNAPSHOT_PROGRAM } from './snapshot-program.js';
import { PHASES } from './lifecycle-phases.js';
import { stripAnsiAndControl } from './text-sanitize.js';

const PANE_ID = 'wt-what-is-running';
export const COLLECTOR_TIMEOUT_MS = 8000;
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
  if (!home) try { home = await $.env.get('HOME'); } catch {}
  if (!home) try { home = await $.env.get('USERPROFILE'); } catch {}
  return {
    configDir,
    livenessDir: configured('livenessDir') || pathJoin(stateHome || pathJoin(home || sessionCwd, '.local/state'), 'wt-liveness'),
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

export async function readSnapshot($, paths, layout = WORKFLOW_TOOLBOX_LAYOUT) {
  try {
    // Test-only real-host seam: the control-character probe needs the host to render a fixed reproducing snapshot.
    let snapshotFile;
    try { snapshotFile = await $.env?.get?.('WT_WHAT_IS_RUNNING_SNAPSHOT_FILE'); } catch {}
    const result = await $.process.run(
      snapshotFile
        ? ['node', '-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", snapshotFile]
        : ['node', '-e', SNAPSHOT_PROGRAM, JSON.stringify({ ...paths, layout: paths.layout || layout })],
      { timeoutMs: COLLECTOR_TIMEOUT_MS },
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
      ? unavailableSnapshot(`collector timed out after ${COLLECTOR_TIMEOUT_MS / 1000} s`)
      : unavailableSnapshot(`collector failed (${String(error?.message || error || 'unknown error').split(/\r?\n/)[0].slice(0, 160)})`);
  }
}

function node(Component, props = {}, ...children) {
  const kept = children.flat().filter((child) => child !== null && child !== undefined);
  return Component(kept.length ? { ...props, children: kept } : props);
}

function sanitizeRenderedText(value) {
  if (typeof value === 'string') return stripAnsiAndControl(value).replace(/\[/g, '(').replace(/\]/g, ')');
  if (Array.isArray(value)) return value.map(sanitizeRenderedText);
  return value;
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
  const words = row.phaseStates?.[phase] || 'not started';
  return { glyph: { running: '●', done: '✓', skipped: '–', 'waiting for arbiter review': '◷' }[words] || '·', words };
}

function phaseLabel(phase) {
  if (phase === 'awaiting_fidelity') return 'Waiting for arbiter review';
  return PANE_PHASES.find(([id]) => id === phase)?.[1] || phase;
}

function knownDetails(row) {
  const details = [];
  const gates = Object.entries(row.gates || {}).filter(([, value]) => value && value !== 'unknown');
  const review = Object.entries(row.review || {}).filter(([, value]) => value && value !== 'unknown');
  if (gates.length) details.push(`gates | ${gates.map(([name, value]) => `${name}: ${value}`).join(' | ')}`);
  if (review.length) details.push(`review | ${review.map(([name, value]) => `${name}: ${value}`).join(' | ')}`);
  return details;
}

function renderPane(ui, snapshot, expanded, selected, currentProject, allProjects, actions) {
  const { Box, Button, Link } = ui;
  const Text = (props = {}) => ui.Text(Object.hasOwn(props, 'children')
    ? { ...props, children: sanitizeRenderedText(props.children) }
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
  const renderCardId = (row) => {
    const id = row.cardId || (/^\d{19}$/.test(String(row.id || '')) ? row.id : null);
    if (!id) return null;
    return fixed(node(Text, { bold: true }, id));
  };
  const renderCardLink = (row) => Link && isValidLinkHref(row.cardUrl)
    ? node(Box, { key: `card-link:${row.id}`, paddingLeft: 1 }, linked({ href: row.cardUrl, label: 'open card' }))
    : null;
  const renderOpenDetail = (buttonKey, label, onClose, ...content) => node(Box, { key: `open-${buttonKey}`, flexDirection: 'column', paddingLeft: 1 },
    node(Box, { key: `open-detail-header:${buttonKey}`, flexDirection: 'row', columnGap: 1 },
      fixedText({ bold: true }, label),
      control({ key: `detail-close:${buttonKey}`, plain: true, onPress: onClose }, 'Close', COLORS.close),
    ),
    ...content,
  );
  const renderExternal = (row, indent = 0, showCard = true) => {
    const cardId = renderCardId(row);
    const label = `${row.label || 'External lane'}${row.roleInferred ? ' (inferred)' : ''}`;
    const details = [
      `phases: n/a (${row.phaseAvailability || 'plain lane'})`,
      row.model && row.model !== 'unknown' ? `model ${row.model}` : null,
      row.activity && row.activity !== 'unknown' ? row.activity : null,
      row.elapsed && row.elapsed !== 'unknown' ? `elapsed ${row.elapsed}` : null,
    ].filter(Boolean).join(' · ');
    return node(Box, { key: row.id, flexDirection: 'column', paddingLeft: indent },
      node(Box, { flexDirection: 'row', columnGap: 1 },
        fixedText({ color: COLORS.external }, label),
        showCard && cardId ? fixedText({ color: COLORS.external }, '·') : null,
        showCard ? cardId : null,
        row.title ? fixedText({ color: COLORS.external }, '·') : null,
        row.title ? node(Text, { color: COLORS.external, wrap: 'wrap' }, row.title) : null,
      ),
      details || (showCard && isValidLinkHref(row.cardUrl)) ? node(Box, { flexDirection: 'column', paddingLeft: 1 },
        details ? node(Text, { dimColor: true, wrap: 'wrap' }, details) : null,
        showCard ? renderCardLink(row) : null,
      ) : null,
    );
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
      const hasEvidence = Boolean(row.inspectors?.[phase]?.summary || row.inspectors?.[phase]?.href) && !['not started', 'skipped'].includes(state.words);
      return renderStateSegment({ key: `phase-state:${row.id}:${phase}`, buttonKey, label: phaseLabelFor(row, phase), state, open: selection === phase, onPress: hasEvidence ? () => actions.select(row.id, phase) : null });
    });
    const rounds = row.criticRounds > 0
      ? `Plan ↔ Critic: ${row.runnerLogTruncated ? 'at least ' : ''}${row.criticRounds} ${row.criticRounds === 1 ? 'round' : 'rounds'}`
      : null;
    const title = row.title && row.title !== row.id ? row.title : null;
    const current = row.phase && row.phase !== 'unknown' ? phaseLabel(row.phase) : null;
    const expandedLines = isExpanded ? [
      ...knownDetails(row).map((line) => node(Text, { dimColor: true }, line)),
      row.usage ? node(Text, { dimColor: true }, `usage | ${Object.entries(row.usage).filter(([, value]) => value !== 'unknown').map(([name, value]) => `${name.replace(/[A-Z]/g, (letter) => ' ' + letter.toLowerCase())}: ${value}`).join(' | ')}`) : null,
      !row.usage && row.tokens && row.tokens !== 'unknown' && row.tokens !== 'not counted' ? node(Text, { dimColor: true }, `usage | tokens: ${row.tokens}`) : null,
      row.activity && row.activity !== 'unknown' ? node(Text, { dimColor: true }, `activity: ${row.activity}`) : null,
      row.watchdog && row.watchdog !== 'unknown' ? node(Text, { dimColor: true }, `watchdog: ${row.watchdog}`) : null,
    ] : [];
    const inspectorButtonKey = selection ? `detail-toggle:stage:${row.id}:${selection}` : null;
    const inspectorNodes = !selection ? [] : [renderOpenDetail(inspectorButtonKey, PANE_PHASES.find(([phase]) => phase === selection)?.[1] || selection, () => actions.closeView(row.id),
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
        failed ? fixedText({ color: COLORS.error, bold: true }, ` · ${row.outcome}`) : null,
      ),
      showCard ? renderCardLink(row) : null,
      showStages && phaseKnown ? node(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, paddingLeft: 1 }, fixedText({ bold: true }, stageHeading), ...phaseButtons.flatMap((segment, index) => index ? [fixedText({ dimColor: true }, '│'), segment] : [segment])) : null,
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
    const pilot = deepActors(card.actors).find((actor) => actor.sdkLifecycle === true && actor.phase && actor.phase !== 'unknown');
    const key = `timeline:${sessionId}:${card.id}`;
    const selection = selected.get(key);
    const stages = [];
    if (pilot) for (const [id] of PANE_PHASES) {
      const state = stateOf(pilot, id);
      const inspector = pilot.inspectors?.[id];
      stages.push({ id, label: phaseLabelFor(pilot, id), state, summary: inspector?.summary || (inspector?.href ? 'A report was recorded.' : null), href: inspector?.href });
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
      const hasEvidence = Boolean(stage.summary) && !['not started', 'skipped'].includes(stage.state.words) && !/^(?:Not reached\.|No summary available\.|decision: recorded|fix requested)$/i.test(stage.summary.trim());
      return renderStateSegment({ key: `stage-state:${sessionId}:${card.id}:${stage.id}`, buttonKey, label: stage.label, state: stage.state, open: selection === stage.id, onPress: hasEvidence ? () => actions.select(key, stage.id) : null });
    });
    const openStage = stages.find((stage) => stage.id === selection);
    const openButtonKey = openStage ? `detail-toggle:stage:${sessionId}:${card.id}:${openStage.id}` : null;
    return node(Box, { key, flexDirection: 'column', paddingLeft: 1 },
      node(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 }, fixedText({ bold: true }, 'Work stages:'), ...segments.flatMap((segment, index) => index ? [fixedText({ dimColor: true }, '│'), segment] : [segment])),
      !pilot && (card.devCycle?.rounds > 0 || card.devCycle?.fixRounds > 0)
        ? node(Text, { dimColor: true }, `review rounds: ${card.devCycle?.rounds || 0} · fix rounds: ${card.devCycle?.fixRounds || 0}`)
        : null,
      openStage ? renderOpenDetail(openButtonKey, openStage.label, () => actions.closeView(key), ...renderEvidence(openStage.summary), Link && isValidLinkHref(openStage.href) ? linked({ href: openStage.href, label: '[Open report]' }) : null) : null,
    );
  };
  const renderHierarchyActor = (actor, indent = 1) => node(Box, { key: `hierarchy:${actor.id}`, flexDirection: 'column' },
    actor.kind === 'pilot' ? renderPilot(actor, indent, false, false) : renderExternal(actor, indent, false),
    ...(actor.children || []).map((child) => renderHierarchyActor(child, indent + 1)),
  );
  if (Array.isArray(snapshot.sessions)) for (const session of snapshot.sessions) {
    const cards = (session.cards || []).flatMap((card, index) => [index ? node(Box, { key: `card-separator:${session.id}:${card.id}`, flexDirection: 'column' }, node(Text, {}, ''), node(Text, { dimColor: true }, '────────────────────────────────────────')) : null, node(Box, { key: `card:${session.id}:${card.id}`, flexDirection: 'column', paddingLeft: 1 },
      card.waveId ? node(Text, { bold: true }, `Wave ${card.waveId}`) : null,
      node(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 },
        fixedText({ bold: true }, 'Card'),
        fixed(node(Text, { bold: true }, card.id)),
        card.title && card.title !== card.id ? node(Text, { wrap: 'wrap' }, card.title) : null,
      ),
      renderCardLink(card),
      renderCardStages(card, session.id),
      ...(card.actors || []).map((actor) => renderHierarchyActor(actor, 1)),
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
    renderCollapsedProcesses('services', `Services (${snapshot.services?.count || 0})`, snapshot.services?.items || []);
    const oldest = snapshot.helpers?.oldest;
    renderCollapsedProcesses('idle-helpers', `Idle helpers (${snapshot.helpers?.count || 0}${oldest && oldest !== 'unknown' ? `; oldest ${oldest}` : ''})`, snapshot.helpers?.items || []);
  }
  const processAvailability = snapshot.collectors?.processes?.availability
    || { status: snapshot.processDiscovery, reason: snapshot.processPartialReason };
  if (processAvailability?.status === 'unknown') grouped.push(node(Text, { dimColor: true }, `process discovery unavailable (${processAvailability.reason || 'unavailable on this platform'})`));
  if (processAvailability?.status === 'partial') grouped.push(node(Text, { dimColor: true }, `process list partial (${processAvailability.reason || 'reason unavailable'})`));
  if (snapshot.discovery === 'partial') {
    const reasons = [];
    if (snapshot.cappedScans?.length) reasons.push(`scan cap reached: ${snapshot.cappedScans.join(', ')}`);
    if (snapshot.scanLimits?.length) reasons.push(snapshot.scanLimits.join('; '));
    if (snapshot.pathRefusals?.length) reasons.push(snapshot.pathRefusals.join('; '));
    grouped.push(node(Text, { dimColor: true }, reasons.length ? `discovery partial (${reasons.join('; ')})` : 'Discovery is partial.'));
  }
  if (hiddenCount) grouped.push(node(Text, { dimColor: true }, `${hiddenCount} ${hiddenCount === 1 ? 'item' : 'items'} hidden${unattributedCount ? ` · ${unattributedCount} unattributed` : ''}`));
  const workAvailability = snapshot.collectors?.work?.availability;
  let unavailableText = `Could not read the running work (${workAvailability?.reason || 'collector failed'}).`;
  if (workAvailability?.reason === 'reading…') unavailableText = 'Reading the running work…';
  let lines = grouped;
  if (snapshot.discovery === 'unknown') lines = [node(Text, { dimColor: true }, unavailableText)];
  else if (!grouped.length) lines = [node(Text, { dimColor: true }, 'Nothing running in the background.')];
  return node(Box, { flexDirection: 'column' },
    node(Box, { flexDirection: 'row', columnGap: 2 },
      fixedText({ bold: true }, 'What is running'),
      fixedText({ dimColor: true }, allProjects ? 'Scope: all projects' : `Scope: this project · ${currentProject}`),
      node(Box, { flexGrow: 1 }),
      control({ key: 'project-scope', plain: true, onPress: actions.switchScope }, allProjects ? 'Show this project' : 'Show all projects', allProjects ? COLORS.actionOpen : COLORS.action),
      control({ key: 'close', plain: true, onPress: actions.close }, 'Close', COLORS.close),
    ),
    ...lines,
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
  let refreshing = false;
  let processRefusalStreaks = new Map();
  let currentProject = null;
  let allProjects = false;
  const expanded = new Set();
  const selected = new Map();
  const pollMs = Number(options?.pollMs) > 0 ? Number(options.pollMs) : 2000;

  const stopPolling = (request) => {
    if (request !== undefined && request !== generation) return;
    generation += 1;
    timer?.cancel?.(); timer = null; open = false; paneObserved = false;
  };
  const refresh = async (request = generation) => {
    if (!host || !open || request !== generation || refreshing) return;
    refreshing = true;
    try {
      let nextSnapshot = await host.readSnapshot(host.paths);
      if (!open || request !== generation) return;
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
      host.invalidate();
    } finally {
      refreshing = false;
    }
  };
  const close = async () => {
    if (!host) return;
    stopPolling();
    const closing = host.close({ id: PANE_ID });
    await closing;
  };
  const startPolling = (request) => {
    timer = host.every(pollMs, async () => {
      if (!open || request !== generation) {
        stopPolling(request);
        return;
      }
      if (refreshing) return;
      if (!paneObserved) {
        stopPolling(request);
        return;
      }
      paneObserved = false;
      await refresh(request);
    });
  };
  const show = async (focus = true) => {
    if (!host) return;
    stopPolling();
    processRefusalStreaks.clear();
    const request = generation;
    open = true;
    allProjects = false;
    await host.open({ id: PANE_ID, title: 'What is running', ...(focus ? { focus: true } : {}) });
    await refresh(request);
    startPolling(request);
  };
  on('session.start', async ($, event, next) => {
    currentProject = pathBase(projectRootOf(event.cwd));
    let snapshotFile;
    try { snapshotFile = await $.env.get('WT_WHAT_IS_RUNNING_SNAPSHOT_FILE'); } catch { snapshotFile = undefined; }
    host = {
      paths: await pathsOf($, options, event.cwd),
      readSnapshot: (paths) => readSnapshot({ env: { get: async () => snapshotFile }, process: { run: (argv) => $.process.run(argv) } }, paths, layout),
      invalidate: () => $.ui.invalidate('ui.render'),
      open: (pane) => $.ui.open(pane),
      close: (pane) => $.ui.close(pane),
      every: (ms, fn) => $.clock.every(ms, fn),
    };
    try { await $.command.register({ name: 'wir', description: 'Open the What is running view' }); }
    catch { await $.ui.log('wt-what-is-running: /wir unavailable'); }
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
    if (event.requestId !== PANE_ID) return result;
    if (!open) return result;
    paneObserved = true;
    let ui;
    try { ui = await $.ui.resolve(event); } catch { return result; }
    if (!ui?.Box || !ui?.Text || !ui?.Button) return result;
    return renderPane(ui, snapshot, expanded, selected, currentProject, allProjects, {
      close,
      switchScope: () => { allProjects = !allProjects; $.ui.invalidate('ui.render'); },
      toggle: (id) => { expanded.has(id) ? expanded.delete(id) : expanded.add(id); $.ui.invalidate('ui.render'); },
      select: (id, phase) => { selected.get(id) === phase ? selected.delete(id) : selected.set(id, phase); $.ui.invalidate('ui.render'); },
      closeView: (id) => { selected.delete(id); $.ui.invalidate('ui.render'); },
    });
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
