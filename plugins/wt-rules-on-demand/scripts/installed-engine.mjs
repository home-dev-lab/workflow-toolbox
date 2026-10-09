import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';

const inside = (root, path) => {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith('../') && !child.startsWith('..\\') && !isAbsolute(child);
};

function installationRecords(registry, name) {
  if (name === 'wt-rules-on-demand@inline') return null;
  const records = registry.plugins?.[name];
  return Array.isArray(records) ? records : null;
}

const userInstallation = (record) => record?.scope === 'user' && typeof record.installPath === 'string';

// Require this profile's user installation registry and a readable engine manifest inside its cache.
export async function installedEngine(dir, names) {
  try {
    const registry = JSON.parse(await readFile(join(dir, 'plugins', 'installed_plugins.json'), 'utf8'));
    const cache = await realpath(join(dir, 'plugins', 'cache'));
    for (const name of names) {
      const records = installationRecords(registry, name);
      if (!records) continue;
      for (const record of records) {
        try {
          if (!userInstallation(record)) continue;
          // The version ENTRY must sit in this profile's cache; the entry itself may be a link to a development
          // checkout, a documented installation mode, so its parent is resolved and the entry name kept.
          const entry = join(await realpath(dirname(record.installPath)), basename(record.installPath));
          if (!inside(cache, entry) && !inside(cache, await realpath(record.installPath))) continue;
          const manifest = JSON.parse(await readFile(join(entry, '.claude-plugin', 'plugin.json'), 'utf8'));
          // A name match establishes presence only, not loader validity or serving; non-refusal remains provisional.
          if (manifest.name === 'wt-rules-on-demand') return true;
        } catch { /* One stale record must not hide other readable installations. */ }
      }
    }
  } catch { /* Unreadable, malformed or missing installation evidence is unknown. */ }
  return false;
}
