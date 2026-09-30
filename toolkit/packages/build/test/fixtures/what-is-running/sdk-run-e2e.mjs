// Real-data e2e for SDK pilot rows: reads THIS machine's live snapshot (the collector the /wir pane runs),
// renders the pane tree, and prints what a reader sees for every SDK pilot row. Run it from the project
// root while a wt-pilot-runner run is live:
//   node toolkit/packages/build/test/fixtures/what-is-running/sdk-run-e2e.mjs
// Exit 0 when at least one live SDK pilot row renders its header, 3 when none is running, 1 otherwise.
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
if (!pilots.length) { console.log('no SDK pilot row: no wt-pilot-runner run is live'); process.exit(3); }

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
const header = lines.findIndex((line) => line.includes('SDK pilot') && line.includes('drives the stages below'));
if (header < 0) { console.log('FAIL: SDK pilot row collected but its header did not render'); process.exit(1); }
console.log('rendered:');
for (const line of lines.slice(Math.max(0, header - 2), header + 10)) console.log('  ' + line);
