// Real-data e2e for SDK pilot rows: reads THIS machine's live snapshot (the collector the /wir pane runs),
// renders the pane tree, and prints what a reader sees for every SDK pilot row. Run it from the project
// root while a wt-pilot-runner run is live:
//   node toolkit/packages/build/test/fixtures/what-is-running/sdk-run-e2e.mjs
// Exit 0 when every SDK pilot row backed by a live runner process renders its header with that row's phase,
// phase model and elapsed; 3 when no runner is live; 1 otherwise.
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { projectRootOf, readSnapshot, renderPane } from '../../../../../../plugin/hooks/hooks.js';

const projectRoot = projectRootOf(process.cwd());
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
const paths = { configDir, livenessDir: join(stateHome, 'wt-liveness'), suiteRoot: join(projectRoot, '.claude'), procRoot: '/proc', platform: process.platform };
const snapshot = await readSnapshot({
  env: { get: async () => undefined },
  process: {
    run: async ([command, ...args], options = {}) => {
      try {
        return { exitCode: 0, stdout: execFileSync(command === 'node' ? process.execPath : command, args, { encoding: 'utf8', timeout: options.timeoutMs }), stderr: '' };
      } catch (error) {
        return { exitCode: error.status ?? 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || error.message || '') };
      }
    },
  },
}, paths);

const deep = (actors) => (actors || []).flatMap((actor) => [actor, ...deep([...(actor.lanes || []), ...(actor.children || [])])]);
const pilots = [...(snapshot.rows || []), ...(snapshot.sessions || []).flatMap((session) => [...deep(session.actors), ...(session.cards || []).flatMap((card) => deep(card.actors))])]
  .filter((row, index, all) => row?.sdkLifecycle === true && all.findIndex((other) => other?.id === row.id) === index);
console.log(`collected at ${snapshot.collectedAt} · discovery ${snapshot.discovery}`);
for (const row of pilots) {
  console.log(`row card=${row.cardId} label=${row.label} kind=${row.kind} phase=${row.phase} phaseModel=${row.phaseModel} pilotModel=${row.model} elapsed=${row.elapsed} runnerPid=${row.processPid} session=${row.launcherSessionId}`);
}
const live = pilots.filter((row) => Number.isSafeInteger(row.processPid) && row.processPid > 0);
if (!live.length) { console.log('no SDK pilot row backed by a live wt-pilot-runner process'); process.exit(3); }

const component = (name) => (props = {}) => ({ name, props });
const tree = renderPane(
  { Box: component('Box'), Text: component('Text'), Button: component('Button'), Link: component('Link') },
  snapshot, new Set(), new Map(), basename(projectRoot), true,
  { close: () => undefined, switchScope: () => undefined, toggle: () => undefined, select: () => undefined, closeView: () => undefined, bodyColumns: 120, onRepair: () => undefined },
);
// Flatten each wrapping row Box into one visible line, the way the terminal lays it out.
const textOf = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (!value || typeof value !== 'object') return '';
  const children = value.props?.children;
  if (value.name === 'Box' && value.props?.flexDirection === 'row') return [].concat(children ?? []).map(textOf).filter(Boolean).join(' ');
  return [].concat(children ?? []).map(textOf).join(value.name === 'Box' ? '\n' : '');
};
const lines = textOf(tree).split('\n').map((line) => line.trimEnd()).filter(Boolean);
const known = (value) => typeof value === 'string' && value !== '' && value !== 'unknown';
let failed = false;
for (const row of live) {
  const expected = [known(row.phaseModel) ? row.phaseModel : null, known(row.elapsed) ? row.elapsed : null].filter(Boolean);
  const titleAt = lines.findIndex((line) => row.title && line.includes(row.title));
  const header = lines.findIndex((line, index) => index > titleAt && line.includes('SDK pilot') && line.includes('drives the stages below'));
  const ok = titleAt >= 0 && header >= 0 && expected.every((part) => lines[header].includes('· ' + part));
  console.log((ok ? 'PASS' : 'FAIL') + ` card ${row.cardId}: header shows ${expected.join(' + ') || 'no known model or elapsed'}`);
  if (!ok) failed = true;
  if (header >= 0) for (const line of lines.slice(Math.max(0, header - 2), header + 8)) console.log('  ' + line);
}
process.exit(failed ? 1 : 0);
