import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { projectRootOf, readSnapshot, renderPane } from '../../../../../../plugin/hooks/hooks.js';

const projectRoot = projectRootOf(process.cwd());
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
const paths = {
  configDir,
  livenessDir: join(stateHome, 'wt-liveness'),
  suiteRoot: join(projectRoot, '.claude'),
  procRoot: '/proc',
  platform: process.platform,
};
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

const component = (name) => (props = {}) => ({ name, props });
const repairs = [];
const tree = renderPane(
  { Box: component('Box'), Text: component('Text'), Button: component('Button'), Link: component('Link') },
  snapshot, new Set(), new Map(), basename(projectRoot), true,
  {
    close: () => undefined,
    switchScope: () => undefined,
    toggle: () => undefined,
    select: () => undefined,
    closeView: () => undefined,
    bodyColumns: 120,
    onRepair: (items) => repairs.push(...items),
  },
);

let nodes = 0;
let strings = 0;
let unsafeAfter = 0;
const walk = (value) => {
  if (typeof value === 'string') {
    strings += 1;
    if (/[\x00-\x1f\x7f]/.test(value)) unsafeAfter += 1;
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && typeof value.name === 'string' && value.props) nodes += 1;
  for (const child of Object.values(value)) walk(child);
};
walk(tree);
const dirty = repairs.filter((repair) => /[\x00-\x1f\x7f]/.test(repair.before));

console.log(`nodes: ${nodes}`);
console.log(`strings: ${strings}`);
console.log(`strings with control characters before strip: ${dirty.length}`);
for (const repair of dirty) console.log(`dirty path: ${repair.path}`);
console.log(`verdict: ${unsafeAfter === 0 ? 'PASS - rendered tree contains no control characters' : `FAIL - ${unsafeAfter} control-character string(s) remain`}`);
