// Audit without disclosure: persist only closed enums and identifiers while owning legacy publication.
import { sha256 } from './sha256.js';
import { knownTokens, restorePending, takePending } from './token-vault.js';

const SURFACES = new Set(['bash', 'read', 'notebook-read', 'mcp', 'write', 'edit', 'notebook-edit', 'assistant', 'attachment']);
const ACTIONS = new Set(['evaluated', 'would-block', 'refused', 'masked', 'warned', 'mention-allowed', 'policy-disabled', 'unknown-tool']);
const RULES = new Set(['guarded-path-read', 'guarded-path-mention', 'policy']);
const PATH_CLASSES = new Set(['npm-config', 'env-file', 'cloud-secret', 'aws-credentials', 'ssh-key', 'gh-hosts', 'netrc', 'shell-history', 'docker-config', 'kube-config', 'pypi-config', 'git-credentials', 'other-guarded']);
const COMMAND_CLASSES = new Set(['bash', 'read', 'notebook-read', 'metadata', 'prose', 'other']);
const DISPOSITIONS = new Set(['true-positive', 'false-positive', 'unreviewed']);
const journalText = new Map();
const seen = new Set();
const writeQueues = new Map();
let salt;

const safeIdentifier = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : undefined;
const enumValue = (set, value) => set.has(value) ? value : undefined;

async function ensureSalt($) {
  if (salt) return salt;
  const stored = await $.getSalt();
  if (typeof stored === 'string' && stored.length >= 32) { salt = stored; return salt; }
  salt = sha256(`${Date.now()}:${Math.random()}:${Math.random()}`);
  await $.setSalt(salt);
  return salt;
}

async function identity($) {
  const sessionId = safeIdentifier(await $.sessionId()) ?? 'unknown-session';
  const cwd = String(await $.sessionCwd());
  const key = await ensureSalt($);
  return { sessionId, project: sha256(`${key}:${cwd}`) };
}

export async function buildEvent($, fields) {
  const base = await identity($);
  const event = {
    version: 1,
    at: new Date().toISOString(),
    ...base,
    toolUseId: safeIdentifier(fields.toolUseId),
    surface: enumValue(SURFACES, fields.surface),
    action: enumValue(ACTIONS, fields.action),
    kinds: Array.isArray(fields.kinds) ? fields.kinds.filter((kind) => typeof kind === 'string' && /^[a-z][a-z-]{0,40}$/.test(kind)).slice(0, 20) : undefined,
    count: Number.isInteger(fields.count) && fields.count > 0 ? fields.count : 1,
    ruleId: enumValue(RULES, fields.ruleId),
    pathClass: enumValue(PATH_CLASSES, fields.pathClass),
    commandClass: enumValue(COMMAND_CLASSES, fields.commandClass),
  };
  if (!event.surface || !event.action) throw new Error('invalid journal event');
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
}

async function journalPath($, sessionId, suffix = '') {
  const home = await $.home();
  const root = home ? `${home}/.local/state/wt-secret-guard` : `${await $.configDir()}/wt-secret-guard`;
  return `${String(root).replace(/[\\/]+$/, '')}/journal/${sessionId}${suffix}.ndjson`;
}

async function enqueueWrite($, path, record) {
  const prior = writeQueues.get(path) ?? Promise.resolve();
  const write = prior.catch(() => {}).then(async () => {
    let current = journalText.get(path);
    if (current === undefined) {
      try { current = await $.fsRead(path); } catch (error) {
        if (error?.code !== 'ENOENT' && !String(error?.message).includes('ENOENT')) throw error;
        current = '';
      }
    }
    const next = `${current}${JSON.stringify(record)}\n`;
    await $.fsWrite(path, next);
    journalText.set(path, next);
  });
  writeQueues.set(path, write);
  await write;
}

export async function appendEvent($, fields) {
  try {
    const event = await buildEvent($, fields);
    const dedupe = fields.dedupeKey && `${event.sessionId}:${safeIdentifier(fields.dedupeKey)}`;
    if (dedupe && seen.has(dedupe)) return false;
    if (dedupe) seen.add(dedupe);
    const path = await journalPath($, event.sessionId);
    await enqueueWrite($, path, event);
    return true;
  } catch { await $.uiLog('wt-secret-guard: journal write failed (1 event)'); return false; }
}

export async function recordDisposition($, identifiers, disposition) {
  if (!DISPOSITIONS.has(disposition)) throw new Error('invalid disposition');
  const { sessionId, project } = await identity($);
  const record = { version: 1, at: new Date().toISOString(), sessionId, project, toolUseId: safeIdentifier(identifiers.toolUseId), disposition };
  const path = await journalPath($, sessionId, '.dispositions');
  await enqueueWrite($, path, Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)));
}

export function deriveAggregates(events, dispositions = []) {
  const evaluations = events.filter((event) => event.action === 'evaluated').length;
  const hits = events.filter((event) => event.action === 'would-block').length;
  const reviewed = dispositions.filter((item) => item.disposition !== 'unreviewed').length;
  const falsePositives = dispositions.filter((item) => item.disposition === 'false-positive').length;
  return { evaluations, hits, reviewed, falsePositives, projects: new Set(events.map((event) => event.project)).size, falsePositiveRate: hits ? falsePositives / hits : 0 };
}

export function promotionStatus(events, dispositions, now = Date.now()) {
  const totals = deriveAggregates(events, dispositions);
  const times = events.map((event) => Date.parse(event.at)).filter(Number.isFinite);
  const days = times.length ? (now - Math.min(...times)) / 86400000 : 0;
  const finalWindow = now - 14 * 86400000;
  const recentFalsePositives = dispositions.filter((item) => item.disposition === 'false-positive' && Date.parse(item.at) >= finalWindow).length;
  const governed = new Set(events.filter((event) => event.action === 'evaluated').map((event) => event.surface));
  const allGovernedTools = ['bash', 'read', 'notebook-read'].every((surface) => governed.has(surface));
  const everyHitReviewed = totals.reviewed === totals.hits;
  return {
    ...totals, days, recentFalsePositives, allGovernedTools, everyHitReviewed,
    measurable: totals.evaluations >= 200 && totals.projects >= 3 && everyHitReviewed && totals.falsePositiveRate < 0.005 && recentFalsePositives === 0 && allGovernedTools && days >= 30,
  };
}

export async function publish($) {
  const added = takePending();
  if (!added.length) return;
  try {
    const key = await ensureSalt($);
    const entries = [...knownTokens()].map(([token, entry]) => ({ token, kind: entry.kind, sha256: sha256(`${key}:${entry.value}`) }));
    await $.setDetections({ version: 1, updatedAt: new Date().toISOString(), entries });
    const stats = await $.getStats() ?? {};
    for (const entry of added) stats[entry.kind] = Number(stats[entry.kind] ?? 0) + 1;
    await $.setStats(stats);
    await $.setLastPublishedAt(new Date().toISOString());
  } catch { restorePending(added); }
}

export function journalSnapshot() { return new Map(journalText); }
