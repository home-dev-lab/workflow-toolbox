// Last-responsible-moment policy: identify raw outbound values without rewriting destinations.
import { detections, optionalDetections } from './detector.js';
import { config } from './config.js';

const REFERENCE = /(?:op:\/\/[^\s"']+|secret:(?:env|file|1p):[^\s"']+|\$\{[A-Za-z_][A-Za-z0-9_]*\}|secret:[a-z-]+#[a-f0-9]{6})/i;
const PATH_FIELD = { Write: 'file_path', Edit: 'file_path', NotebookEdit: 'notebook_path' };
const SURFACE = { Bash: 'bash', Write: 'write', Edit: 'edit', NotebookEdit: 'notebook-edit' };

function findingsIn(value) {
  const options = config();
  const found = [];
  if (typeof value === 'string') found.push(...detections(value), ...optionalDetections(value, { emails: options.maskEmails, ipAddresses: options.maskIpAddresses }));
  const pending = value && typeof value === 'object' ? [value] : [];
  while (pending.length) {
    const item = pending.pop();
    for (const [key, child] of Object.entries(item)) {
      if (child && typeof child === 'object') pending.push(child);
      else if (typeof child === 'string') found.push(
        ...detections(child), ...detections(`${key}: ${child}`),
        ...optionalDetections(child, { emails: options.maskEmails, ipAddresses: options.maskIpAddresses }),
      );
    }
  }
  const unique = new Map(found.filter(({ value: detected }) => !REFERENCE.test(detected)).map((item) => [`${item.kind}:${item.value}`, item]));
  return [...unique.values()];
}

const normalized = (path) => String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const resolvedPath = (stat, fallback) => normalized(stat?.resolvedPath ?? stat?.realPath ?? stat?.path ?? fallback);

async function ownFixture($, event) {
  const field = PATH_FIELD[event.tool];
  if (!field || typeof event[field] !== 'string') return false;
  const root = await $.pluginRoot();
  if (!root) return false;
  try {
    const [rootStat, targetStat] = await Promise.all([$.fsStat(root, { resolve: true }), $.fsStat(event[field], { resolve: true })]);
    const canonicalRoot = resolvedPath(rootStat, root);
    const canonicalTarget = resolvedPath(targetStat, event[field]);
    return canonicalTarget.startsWith(`${canonicalRoot}/hooks/fixtures/`);
  } catch { return false; }
}

export async function classifyOutbound($, event) {
  const surface = event.tool?.startsWith('mcp__') ? 'mcp' : SURFACE[event.tool];
  if (!surface) return { surface: null, findings: [] };
  if (await ownFixture($, event)) return { surface, findings: [] };
  const input = Object.fromEntries(Object.entries(event).filter(([key]) => !['tool', 'tool_use_id'].includes(key)));
  return { surface, findings: findingsIn(input) };
}
