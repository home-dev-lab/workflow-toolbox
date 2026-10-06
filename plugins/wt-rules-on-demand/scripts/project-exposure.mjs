import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { normal, sameDirectory } from '../paths.js';

const absent = (error) => ['ENOENT', 'ENOTDIR'].includes(error.code);
const physical = (path) => realpath(path).catch((error) => absent(error) ? resolve(path) : Promise.reject(error));
// Same cwd-to-slug mapping as the debugger's projectSlug; cwd is still verified because the mapping is lossy.
const slug = (root) => root.replace(/[^a-zA-Z0-9]/g, '-');
async function* lines(path) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let failure;
  input.on('error', (error) => { failure = error; reader.close(); });
  try {
    for await (const line of reader) yield line;
    if (failure) throw failure;
  }
  finally { reader.close(); input.destroy(); }
}

async function scanExposure(config, root, readLines) {
  const target = normal(await physical(root));
  const result = { latest: -Infinity, filesRead: 0, badLines: 0 };
  const visited = new Set(), cwds = new Map();
  async function observe(line) {
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); } catch { result.badLines++; return; }
    const timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(timestamp) || typeof row.cwd !== 'string') return;
    if (!cwds.has(row.cwd)) cwds.set(row.cwd, normal(await physical(row.cwd)));
    const cwd = cwds.get(row.cwd);
    if (sameDirectory(cwd, target) || sameDirectory(cwd.slice(0, target.length + 1), `${target}/`)) result.latest = Math.max(result.latest, timestamp);
  }
  async function walk(dir) {
    const real = await physical(dir);
    if (visited.has(real)) return;
    visited.add(real);
    const names = await readdir(dir).catch((error) => absent(error) ? [] : Promise.reject(error));
    for (const name of names.sort()) {
      const path = join(dir, name), info = await stat(path);
      if (info.isDirectory()) { await walk(path); continue; }
      if (!info.isFile() || !name.endsWith('.jsonl')) continue;
      result.filesRead++;
      for await (const line of readLines(path)) await observe(line);
    }
  }
  // Observe root and descendant slugs once; every record still needs a matching physical cwd.
  const prefixes = new Set([slug(resolve(root)), slug(await physical(root))]);
  const projects = join(config, 'projects');
  const names = await readdir(projects).catch((error) => absent(error) ? [] : Promise.reject(error));
  for (const name of names) if ([...prefixes].some((prefix) => name === prefix || name.startsWith(`${prefix}-`))) await walk(join(projects, name));
  return result;
}

export async function projectExposure(config, root, after, { cache = new Map(), reader = lines } = {}) {
  const key = JSON.stringify([config, root]);
  if (!cache.has(key)) cache.set(key, scanExposure(config, root, reader));
  const { latest, ...counts } = await cache.get(key);
  return { exposed: latest > Date.parse(after), ...counts };
}
