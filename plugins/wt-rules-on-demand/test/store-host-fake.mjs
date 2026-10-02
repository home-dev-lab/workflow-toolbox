// A host-faithful plugin store and a real-filesystem `$` for hook tests that must see the store limit and the archives.
// The host contract (`$.store.set`): "Rejects ... a store over 4 MiB of JSON text in all"; measured on the real store
// as the length of the compact JSON text of the WHOLE store object, with the message shape below.
import { mkdir, readFile, readdir, rm, stat, lstat, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register, resetForSelftest } from '../hooks/hooks.js';
import { measureInputs } from '../scripts/quality-check.mjs';

export const HOST_STORE_LIMIT = 4_194_304;
export const HOST_FILE_LIMIT = 4 * 1024 * 1024;
const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export function hostStore(initial = {}, { limit = HOST_STORE_LIMIT, refuse = () => null } = {}) {
  const map = new Map(Object.entries(initial));
  let refusals = 0;
  const textOf = (entries) => JSON.stringify(Object.fromEntries(entries));
  const api = {
    get: async (key) => copy(map.get(key)),
    set: async (key, value) => {
      const refusal = refuse(key, value);
      if (refusal) throw new Error(refusal);
      const next = new Map(map);
      next.set(key, copy(value));
      const size = textOf(next).length;
      if (size > limit) refusals++;
      if (size > limit) throw new Error(`the store would be ${size} characters, over the ${limit} limit`);
      map.set(key, copy(value));
    },
    delete: async (key) => { map.delete(key); },
    keys: async () => [...map.keys()],
  };
  return { map, api, size: () => textOf(map).length, snapshot: () => Object.fromEntries(map), refusals: () => refusals };
}

// The Function Hooks `$.fs` surface over the real filesystem: what an archive write leaves is what a reader reads.
export const realFs = {
  read: async (path) => readFile(path, 'utf8'),
  // The host contract (index.d.ts, `$.fs`): "A read or write over 4 MiB rejects".
  write: async (path, text) => {
    if (Buffer.byteLength(String(text)) > HOST_FILE_LIMIT) throw new Error(`write of ${Buffer.byteLength(String(text))} bytes is over 4 MiB`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  },
  remove: async (path) => rm(path, { force: false }),
  exists: async (path) => lstat(path).then(() => true, () => false),
  list: async (path) => Promise.all((await readdir(path, { withFileTypes: true })).map(async (entry) => {
    const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other';
    return { name: entry.name, kind, isLink: entry.isSymbolicLink(), size: kind === 'file' ? (await stat(join(path, entry.name))).size : 0 };
  })),
  stat: async (path, options) => {
    const info = await stat(path);
    return { kind: info.isFile() ? 'file' : info.isDirectory() ? 'dir' : 'other', size: info.size, mtimeMs: info.mtimeMs,
      isLink: (await lstat(path)).isSymbolicLink(), ...(options?.resolve ? { realPath: await realpath(path) } : {}) };
  },
};

export const bashRule = `---\non-demand:\n  triggers:\n    - kind: 'bash'\n      regex: 'git push'\n  compliance:\n    kind: 'bash-command'\n    window: '2'\n    on-close: 'not applicable'\n    act-regex: 'git push'\n    require-regex: 'origin'\n---\nCheck destination.\n`;

// A trigger clock that jumps past the regex call budget's 2 s deadline on every read: the budget is exhausted at its
// first check, before any scanning. Tests that only need an exhausted-budget trigger error get one in microseconds
// instead of running the 64M-step scan (~0.4 s per call) to reach the same error.
export const exhaustedBudgetClock = () => { let t = 0; return () => (t += 5000); };

// One registered hook over a real config dir and project, with the given store. `triggerClock` is passed to register as
// the regex budget's clock (default: the real Date.now).
export async function hookFixture(root, store, { sessionId = 'sample-session', fs = realFs, hooks = { register, resetForSelftest }, triggerClock } = {}) {
  const config = join(root, 'config'), project = join(root, 'project');
  await mkdir(join(config, 'rules-on-demand'), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(config, 'rules-on-demand', 'sample.md'), bashRule);
  await writeFile(join(config, 'rules-on-demand-ledger.jsonl'), `${JSON.stringify({ action: 'migrate', rule: 'sample.md', time: '2020-01-01T00:00:00.000Z' })}\n`);
  hooks.resetForSelftest();
  const handlers = new Map();
  hooks.register((event, handler) => handlers.set(event, handler), { enabled: true }, triggerClock);
  const logs = [];
  const $ = {
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: config, HOME: root })[name] },
    fs,
    ui: { log: async (line) => { logs.push(line); } },
    store: store.api,
    session: { id: async () => sessionId, messages: async () => [], root: async () => project },
    model: { classify: async () => 'followed' },
  };
  const call = (event, next = async () => ({})) => handlers.get('tool.call')($, { tool: 'Bash', cwd: project, ...event }, next);
  const identity = `user:${await realpath(join(config, 'rules-on-demand'))}:sample.md`;
  return { $, handlers, logs, call, config, project, identity, quality: join(config, 'plugins', 'data', 'wt-rules-on-demand', 'quality') };
}

// A store shaped like the measured one (verdicts ~2.43M of JSON text, one session of ~1.75M whose main context carries
// 830 deliveries and ~560 agent contexts of 3-20k each, served ~7k, health ~1.2k), padded so the whole store is EXACTLY
// at the limit. Rows carry padded evidence and agent contexts padded trigger errors: the byte shape is the measured
// one with fewer rows, so the readers' own row-join cost stays small.
export function atLimitStore(identity, { sessionId = 'sample-session', limit = HOST_STORE_LIMIT, verdictChars = 2_430_000, sessionChars = 1_750_000, evidenceChars = 2_000, segs = false } = {}) {
  const at = (n) => new Date(Date.parse('2026-09-30T00:00:00.000Z') + n * 1000).toISOString();
  const delivery = (n) => ({ rule: 'sample.md', ruleIdentity: identity, at: at(n), deliveryId: `oldtok-${n}`, deliverySeq: n, servingSeq: n });
  const lines = [];
  let verdictLength = 2;
  for (let n = 1; verdictLength < verdictChars; n++) {
    const line = JSON.stringify({ rule: 'sample.md', ruleIdentity: identity, trigger: 'tool.call:Bash', verdict: n % 4 ? 'followed' : 'not followed',
      evidence: `Bash: git push ${'e'.repeat(evidenceChars)}`, sessionId, agentId: null, injectedAt: at(n), decidedAt: at(n), verdictId: `oldtok-${n}`, actSeq: n, deliveryId: `oldtok-${n}`, deliverySeq: n, servingSeq: n });
    lines.push(line);
    verdictLength += JSON.stringify(`${line}\n`).length - 2;
  }
  const main = { served: { 'sample.md': 830 }, suppressedCap: {}, governedActs: [{ rule: 'sample.md', ruleIdentity: identity, at: at(1), last: at(830), count: 830 }],
    complianceInjected: Array.from({ length: 830 }, (_, i) => delivery(i + 1)), servedIdentity: { [identity]: 830 }, lastClose: { token: 'oldtok', seq: 900, at: at(900) } };
  const contexts = { 0: main };
  let next = 100_000;
  let sessionLength = JSON.stringify(contexts).length;
  for (let agent = 0; sessionLength < sessionChars; agent++) {
    const count = 2 + (agent % 2);
    const pad = 2_000 + (agent % 9) * 250;
    contexts[`agent:a${agent}`] = { served: { 'sample.md': count }, suppressedCap: {}, governedActs: [{ rule: 'sample.md', ruleIdentity: identity, at: at(next), last: at(next + count), count }],
      complianceInjected: Array.from({ length: count }, () => delivery(next++)), servedIdentity: { [identity]: count },
      triggerErrors: [{ rule: 'sample.md', kind: 'tool', error: 't'.repeat(pad), at: at(next), channel: 'tool.call' }], ...(segs ? { seg: `seg-a${agent}` } : {}) };
    sessionLength += JSON.stringify(`agent:a${agent}`).length + JSON.stringify(contexts[`agent:a${agent}`]).length + 2;
  }
  const served = { 'sample.md': { count: 5000, last: at(5000), byChannel: { 'tool.call': 5000 } } };
  for (let i = 0; JSON.stringify(served).length < 6_800; i++) served[`other-rule-${i}.md`] = { count: i + 1, last: at(i), byChannel: { 'tool.call': i + 1 } };
  const health = { days: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`2026-09-${String(i + 10).padStart(2, '0')}`, { calls: 100, errors: 0, totalMs: 900, maxMs: 40, slow: 0 }])), lastErrors: [] };
  const store = { 'compliance-verdicts-jsonl': `${lines.join('\n')}\n`, sessions: { [sessionId]: { first: at(0), last: at(next), contexts } }, served, health };
  const missing = limit - JSON.stringify(store).length;
  if (missing < 0) throw new Error(`synthetic store already over the limit by ${-missing}`);
  // Pad the last verdict line's evidence: one ASCII character of evidence is one character of JSON text.
  const last = JSON.parse(lines.at(-1));
  lines[lines.length - 1] = JSON.stringify({ ...last, evidence: `${last.evidence}${'x'.repeat(missing)}` });
  store['compliance-verdicts-jsonl'] = `${lines.join('\n')}\n`;
  if (JSON.stringify(store).length !== limit) throw new Error('synthetic store is not exactly at the limit');
  return store;
}

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

// What the readers SEE: compliance-report (served counter, verdict rows), serve-verdict-reconcile (deliveries joined),
// rollback-check (applicable and followed verdicts of the rule), each run as a process over the dumped store plus
// whatever archives sit in the config dir's quality directory.
export async function readerTotals(f, storeObject) {
  const storePath = join(f.config, 'plugins', 'store', 'wt-rules-on-demand_test.json');
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(storeObject));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: f.config, HOME: dirname(f.config), CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '' };
  const run = (name, args) => {
    const result = spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8', env, cwd: f.project, maxBuffer: 1 << 28 });
    if (result.status !== 0) throw new Error(`${name} exited ${result.status}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  // No --store: every reader takes the config dir's newest store and that config dir's archives, as the daily job does.
  const reports = run('compliance-report.mjs', ['--config-dir', f.config, '--rules-dir', join(f.config, 'rules-on-demand'), '--json']);
  const report = reports['sample.md'] ?? {};
  const reconcile = run('serve-verdict-reconcile.mjs', ['--config-dir', f.config, '--json']);
  const rollback = run('rollback-check.mjs', ['--user', '--config-dir', f.config, '--dry-run', '--json'])[0] ?? {};
  const inputs = await measureInputs([f.config], [], join(f.config, 'measures'));
  const triggerErrors = Object.values(inputs.store.sessions).reduce((sum, session) => sum + Object.values(session.contexts ?? {}).reduce((n, ctx) => n + (ctx.triggerErrors?.length ?? 0), 0), 0);
  const total = (field) => Object.values(reports).reduce((sum, row) => sum + (Number(row?.[field]) || 0), 0);
  return { served: report.served ?? 0, verdictRows: report.injections ?? 0, deliveries: reconcile.result.serves, joinedRows: reconcile.result.rows,
    applicable: rollback.applicable ?? 0, followed: rollback.followed ?? 0, servedTotal: total('served'), copies: total('copies'), triggerErrors };
}

// The session units of one parsed store archive, in either format: 1 (`value` = sessions object) or 2 (`value` = units).
export function archivedUnits(archive) {
  if (archive?.key !== 'sessions') return [];
  if (Array.isArray(archive.value)) return archive.value.map((unit) => ({ sessionId: unit.sessionId, key: unit.key ?? null, context: unit.context ?? null }));
  return Object.entries(archive.value ?? {}).flatMap(([sessionId, session]) => {
    const contexts = Object.entries(session.contexts ?? {});
    return contexts.length ? contexts.map(([key, context]) => ({ sessionId, key, context })) : [{ sessionId, key: null, context: null }];
  });
}
export async function readArchives(directory) {
  const names = (await readdir(directory).catch(() => [])).filter((name) => /^rod-store-archive-\d+-\d+\.json$/.test(name));
  return Promise.all(names.map(async (name) => ({ name, ...JSON.parse(await readFile(join(directory, name), 'utf8')) })));
}
// The deliveries a shrink result holds, kept or evicted, whatever the evicted format.
export function shrinkDeliveries(segment) {
  const contexts = Array.isArray(segment) ? segment.map((unit) => unit.context).filter(Boolean)
    : Object.values(segment ?? {}).flatMap((session) => Object.values(session.contexts ?? {}));
  return contexts.flatMap((ctx) => (ctx.complianceInjected ?? []).map((item) => item.deliveryId));
}
