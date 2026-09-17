import { execFileSync } from 'node:child_process';
import { readSnapshot } from '../../../../../../plugin/hooks/hooks.js';

const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
const pathJoin = (root, child) => String(root).replace(/[\\/]+$/, '') + (String(root).includes('\\') ? '\\' : '/') + child;
const paths = {
  configDir: process.env.CLAUDE_CONFIG_DIR || pathJoin(home, '.claude'),
  livenessDir: process.env.WT_LIVENESS_DIR || pathJoin(process.env.XDG_STATE_HOME || pathJoin(home, '.local/state'), 'wt-liveness'),
  suiteRoot: process.env.WT_SUITE_ROOT || pathJoin(process.cwd(), '.claude'),
  procRoot: '/proc',
  activeWindowMin: 10,
  readOnly: true,
};

const snapshot = await readSnapshot({
  process: {
    run: async (argv) => ({ exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' }), stderr: '' }),
  },
}, paths);

if (!['available', 'partial'].includes(snapshot.discovery)) {
  console.error('snapshot discovery unknown');
  process.exitCode = 1;
} else {
  if (snapshot.discovery === 'partial') {
    const reasons = [];
    if (snapshot.cappedScans?.length) reasons.push(`scan cap reached: ${snapshot.cappedScans.join(', ')}`);
    if (snapshot.scanLimits?.length) reasons.push(snapshot.scanLimits.join('; '));
    if (snapshot.pathRefusals?.length) reasons.push(snapshot.pathRefusals.join('; '));
    console.log(`Discovery: partial (${reasons.join('; ') || 'unknown reason'})`);
  }
  const currentProject = process.argv[2]?.trim();
  if (currentProject) {
    const sessions = snapshot.sessions || [];
    const projectOf = (session) => typeof session.project === 'string' && session.project.trim() && session.project !== 'unknown' ? session.project.trim() : null;
    const workCount = (session) => (session.cards?.length || 0) + (session.actors?.length || 0);
    const visible = sessions.filter((session) => projectOf(session)?.toLowerCase() === currentProject.toLowerCase());
    const hidden = sessions.filter((session) => !visible.includes(session));
    const hiddenCount = hidden.reduce((count, session) => count + workCount(session), 0);
    const unattributedCount = hidden.filter((session) => !projectOf(session)).reduce((count, session) => count + workCount(session), 0);
    const projects = [...new Set(sessions.map(projectOf).filter(Boolean))].sort();
    console.log(`Scope: this project · ${currentProject}`);
    console.log(`${hiddenCount} ${hiddenCount === 1 ? 'item' : 'items'} hidden${unattributedCount ? ` · ${unattributedCount} unattributed` : ''}`);
    console.log(`Toggle: all projects · ${projects.join(', ') || 'none'}${unattributedCount ? ' · includes unattributed' : ''}`);
    console.log(`Toggle: this project · ${currentProject}`);
    snapshot.sessions = visible;
  }
  const phaseNames = { discovery: 'Discovery', plan: 'Plan', critic: 'Critic', tdd: 'TDD', verify: 'Verify', review: 'Independent review', refutation: 'Independent refutation', harden: 'Harden', report: 'Report' };
  const cycleNames = { implementation: 'Implementation', review: 'Sol review', refutation: 'Astra refutation', arbiter: 'Decision', fix: 'Fix', merge: 'Merge' };
  const evidenceLines = (summary) => {
    const lines = String(summary || '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim().replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').replace(/\*\*|__|`/g, '').trim()).filter((line) => line && !/^[A-Za-z][A-Za-z ]*:$/.test(line));
    return [...lines.slice(0, 7), ...(lines.length > 7 ? [`… ${lines.length - 7} more lines`] : [])];
  };
  const printActor = (actor, indent) => {
    const description = actor.role || actor.title;
    const details = [actor.model && actor.model !== 'unknown' ? `model ${actor.model}` : null, actor.activity && actor.activity !== 'unknown' ? actor.activity : null, actor.elapsed && actor.elapsed !== 'unknown' ? `elapsed ${actor.elapsed}` : null].filter(Boolean).join(' · ');
    console.log(`${indent}${actor.label || actor.kind || 'Actor'}${description ? ` · ${description}` : ''}${details ? ` · ${details}` : ''}`);
    for (const child of [...(actor.lanes || []), ...(actor.children || [])]) printActor(child, indent + '  ');
  };
  const deepActors = (actors) => (actors || []).flatMap((actor) => [actor, ...deepActors([...(actor.lanes || []), ...(actor.children || [])])]);
  const workStages = (card) => {
    const pilot = deepActors(card.actors).find((actor) => actor.sdkLifecycle === true && actor.phase && actor.phase !== 'unknown');
    const stages = pilot ? Object.entries(phaseNames).map(([id, label]) => ({ label: ['review', 'refutation'].includes(id) && pilot.models?.[id] ? `${label} (${pilot.models[id]})` : label, state: pilot.phaseStates?.[id] || 'not started' })) : [];
    if (pilot?.phaseStates?.awaiting_fidelity && pilot.phaseStates.awaiting_fidelity !== 'not started') stages.push({ label: 'Fidelity', state: pilot.phaseStates.awaiting_fidelity });
    for (const stage of pilot ? [] : card.devCycle?.stages || []) {
      stages.push({ label: cycleNames[stage.id] || stage.label, state: stage.state });
    }
    return stages;
  };
  for (const session of snapshot.sessions || []) {
    const project = session.project && session.project !== 'unknown' ? session.project.trim() : null;
    const name = typeof session.name === 'string' ? session.name.trim() : null;
    const identity = name && (!project || name.toLowerCase() !== project.toLowerCase()) ? name : session.sessionId?.slice(0, 8) || null;
    console.log(project || identity ? ['Session', project, identity].filter(Boolean).join(' · ') : 'Session');
    for (const card of session.cards || []) {
      console.log(`  Card ${card.id}${card.title && card.title !== card.id ? ` · ${card.title}` : ''}`);
      if (card.cardUrl) console.log(`    open card · ${card.cardUrl}`);
      const stages = workStages(card);
      if (stages.length) {
        console.log(`    Work stages: ${stages.map((stage) => `${stage.label}: ${stage.state}`).join(' -> ')}`);
        if (!deepActors(card.actors).some((actor) => actor.sdkLifecycle === true) && (card.devCycle?.rounds > 0 || card.devCycle?.fixRounds > 0)) console.log(`    review rounds: ${card.devCycle?.rounds || 0} · fix rounds: ${card.devCycle?.fixRounds || 0}`);
      }
      for (const actor of card.actors || []) printActor(actor, '    ');
      for (const actor of card.actors || []) if (actor.kind === 'pilot' && actor.phase && actor.phase !== 'unknown' && actor.inspectors?.[actor.phase]?.summary) {
        const evidence = actor.inspectors?.[actor.phase];
        const state = actor.phaseStates?.[actor.phase];
        console.log(`      Open detail · ${phaseNames[actor.phase] || actor.phase}`);
        const lines = evidenceLines(evidence?.summary || (state === 'running' ? 'Running, no output yet.' : state === 'waiting for arbiter review' ? 'Waiting for arbiter review.' : 'Not reached.'));
        console.log(`      Evidence · ${lines[0] || 'No output recorded.'}`);
        for (const line of lines.slice(1)) console.log(`                 ${line}`);
      }
    }
    for (const actor of session.actors || []) printActor(actor, '  ');
  }
  console.log(`Services: ${snapshot.services?.count || 0}`);
  for (const service of snapshot.services?.items || []) console.log(`  ${service.label} pid ${service.pid} · ${service.age}`);
  const oldest = snapshot.helpers?.oldest;
  console.log(`Idle helpers: ${snapshot.helpers?.count || 0}${oldest && oldest !== 'unknown' ? ` (oldest ${oldest})` : ''}`);
  for (const helper of snapshot.helpers?.items || []) console.log(`  ${helper.label} pid ${helper.pid} · ${helper.age}`);
}
