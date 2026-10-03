import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The newest engine health day in <profile>/plugins/store/wt-rules-on-demand_<plugin source>-<12 hex>.json: a real
// UTC calendar date among the last ACTIVITY_DAYS date keys (today included) whose entry counts at least one call, in a
// store whose plugin source is not explicitly disabled in enabledPlugins. Unreadable, malformed, impossible or
// future-dated -> no evidence, never an error.
export const ACTIVITY_DAYS = 7;
export async function recentActivity(profileDir, disabledSources, now = Date.now()) {
  const root = join(profileDir, 'plugins', 'store');
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  let best = null;
  for (const name of await readdir(root).catch(() => [])) {
    const source = name.match(/^wt-rules-on-demand_(.+)-[0-9a-f]{12}\.json$/)?.[1];
    if (!source || disabledSources.has(source)) continue;
    let store;
    try { store = JSON.parse(await readFile(join(root, name), 'utf8')); } catch { continue; }
    for (const [day, counts] of Object.entries(store?.health?.days ?? {})) {
      const at = /^\d{4}-\d\d-\d\d$/.test(day) ? Date.parse(day) : NaN;
      if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== day) continue;
      if (at > today || today - at >= ACTIVITY_DAYS * 86400000 || !(Number(counts?.calls) > 0)) continue;
      if (!best || day > best.day) best = { day, store: name };
    }
  }
  return best;
}
