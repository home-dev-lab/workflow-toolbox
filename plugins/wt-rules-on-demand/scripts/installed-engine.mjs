import { readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

// Require this profile's user installation registry and a readable engine manifest inside its cache.
export async function installedEngine(dir, names) {
  try {
    const registry = JSON.parse(await readFile(join(dir, 'plugins', 'installed_plugins.json'), 'utf8'));
    const cache = await realpath(join(dir, 'plugins', 'cache'));
    for (const name of names) {
      if (name === 'wt-rules-on-demand@inline') continue;
      const records = registry.plugins?.[name];
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        try {
          if (record?.scope !== 'user' || typeof record.installPath !== 'string') continue;
          const path = await realpath(record.installPath);
          const child = relative(cache, path);
          if (!child || child.startsWith('..') || isAbsolute(child)) continue;
          const manifest = JSON.parse(await readFile(join(path, '.claude-plugin', 'plugin.json'), 'utf8'));
          if (manifest.name === 'wt-rules-on-demand') return true;
        } catch { /* One stale record must not hide other readable installations. */ }
      }
    }
  } catch { /* Unreadable, malformed or missing installation evidence is unknown. */ }
  return false;
}
