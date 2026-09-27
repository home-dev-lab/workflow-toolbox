import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function discoverFiles(dir, { recursive = false, suffix = '.md', dangling = [], visited = new Set() } = {}) {
  const physical = await realpath(dir).catch(() => null);
  if (physical && visited.has(physical)) return [];
  if (physical) visited.add(physical);
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    let info = entry;
    if (entry.isSymbolicLink()) {
      try { info = await stat(path); } catch { dangling.push(path); continue; }
    }
    if (info.isFile() && entry.name.endsWith(suffix)) files.push([entry.name, path]);
    else if (recursive && info.isDirectory()) files.push(...await discoverFiles(path, { recursive, suffix, dangling, visited }));
  }
  return files;
}
