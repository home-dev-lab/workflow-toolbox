import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export const verdictPath = (project) => join(project, '.claude', 'rules-on-demand-verdicts.json');
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function validateParts(parts) {
  if (!Array.isArray(parts)) throw new Error('expected an array');
  for (const [index, row] of parts.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || !['static-core', 'on-demand', 'mechanise'].includes(row.part)) throw new Error(`part ${index} has invalid part`);
    if (typeof row.what !== 'string' || !row.what.trim() || /[\r\n]/.test(row.what)) throw new Error(`part ${index} needs one-line what`);
    if (row.how !== undefined && !['hook', 'function-plugin'].includes(row.how)) throw new Error(`part ${index} has invalid how`);
    if (row.part === 'mechanise' && !row.how) throw new Error(`part ${index} needs how`);
    if (Object.keys(row).some((key) => !['part', 'what', 'how'].includes(key))) throw new Error(`part ${index} has unknown field`);
  }
}

export async function readVerdicts(project) {
  const path = verdictPath(project);
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') { return { version: 1, rules: {} }; } throw error; }
  try {
    const data = JSON.parse(text);
    if (data?.version !== 1 || !data.rules || typeof data.rules !== 'object' || Array.isArray(data.rules)) throw new Error('expected version 1 and a rules object');
    for (const [name, row] of Object.entries(data.rules)) {
      if (!name || name.startsWith('/') || name.split('/').some((part) => !part || part === '.' || part === '..') || !name.endsWith('.md')
        || !row || typeof row !== 'object' || Array.isArray(row) || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
        || !['migrated', 'static', 'rolled-back'].includes(row.state)
        || (row.reason !== undefined && typeof row.reason !== 'string')
        || (row.date !== undefined && (typeof row.date !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(row.date) || !Number.isFinite(Date.parse(row.date))))
        || (row.rate !== undefined && row.rate !== null && (typeof row.rate !== 'number' || !Number.isFinite(row.rate) || row.rate < 0 || row.rate > 1))
        || (row.followed !== undefined && (!Number.isInteger(row.followed) || row.followed < 0))
        || (row.applicable !== undefined && (!Number.isInteger(row.applicable) || row.applicable < 0))
        || (row.subject !== undefined && typeof row.subject !== 'string')
        || (row.out !== undefined && typeof row.out !== 'string')
        || (row.state === 'static' && !row.reason?.trim())
        || (row.state === 'rolled-back' && (!row.reason?.trim() || !row.date || row.rate === undefined))) throw new Error(`invalid rule ${name}`);
      if (row.parts !== undefined) {
        try { validateParts(row.parts); } catch (error) { throw new Error(`invalid rule ${name}: parts: ${error.message}`, { cause: error }); }
      }
    }
    return data;
  } catch (error) { throw new Error(`${path}: ${error.message}`, { cause: error }); }
}

// Same wx lock, stale-lock timeout and atomic rename semantics as followed-projects; kept local
// because the fixed edit fence does not permit a shared helper module without widening its scope.
export async function updateVerdicts(project, update) {
  const path = verdictPath(project);
  const lock = `${path}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    try { handle = await open(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 30000) {
          console.error(`stale verdict-record lock: removing ${lock}`);
          await rm(lock, { force: true });
          continue;
        }
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${lock}`, { cause: error });
      await new Promise((settle) => setTimeout(settle, 50));
    }
  }
  try {
    const data = await readVerdicts(project);
    if (await update(data) === false) return data;
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try { await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
    return data;
  } finally { await handle.close(); await rm(lock, { force: true }); }
}

async function ruleFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const result = [];
  for (const entry of entries) {
    if (entry.isDirectory()) result.push(...(await ruleFiles(join(dir, entry.name))).map((name) => `${entry.name}/${name}`));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(entry.name);
  }
  return result.sort();
}

export async function pendingRules(project, record) {
  record ??= await readVerdicts(project);
  const root = join(project, '.claude', 'rules');
  const pending = [];
  for (const rule of await ruleFiles(root)) {
    const digest = sha256(await readFile(join(root, rule)));
    const previous = record.rules[rule];
    if (previous?.sha256 !== digest) pending.push({ rule, sha256: digest, priorState: previous?.state ?? null, ...(previous ? { changedSince: { state: previous.state, date: previous.date } } : {}) });
  }
  return pending;
}

export async function recordRollback(project, destination, { reason, rate, pValue, followed, applicable }) {
  const root = join(project, '.claude', 'rules');
  const rule = relative(root, destination).split(sep).join('/');
  if (rule.startsWith('../') || rule === '..' || !rule.endsWith('.md')) throw new Error(`reverted rule outside static rules: ${destination}`);
  const digest = sha256(await readFile(destination));
  await updateVerdicts(project, (data) => { data.rules[rule] = { sha256: digest, state: 'rolled-back', reason, date: new Date().toISOString(), rate, pValue, followed, applicable }; });
}
