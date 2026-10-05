import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { assertProfiles } from '../scripts/profile-check.mjs';

const args = JSON.parse(process.argv[2]);
const values = (flag) => args.flatMap((arg, i) => arg === flag ? [args[i + 1]] : []);
const primary = values('--config-dir')[0];
const profiles = [primary, ...values('--mirror-dir')];
const stores = [];
try {
  for (const profile of profiles) {
    const store = join(profile, 'plugins', 'store');
    const backup = `${store}.matrix-backup`;
    let existed = false;
    try { await fs.rename(store, backup); existed = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    stores.push({ store, backup, existed });
    await fs.mkdir(store, { recursive: true });
    for (const source of ['local', 'inline']) await fs.writeFile(join(store, `wt-rules-on-demand_${source}-0123456789ab.json`), JSON.stringify({ health: { days: { [new Date().toISOString().slice(0, 10)]: { calls: 1 } } } }));
  }
  const outcome = async () => {
    try { await assertProfiles(primary, profiles.slice(1), values('--assume-loaded'), process.env, { warn: () => {} }); return 'ALLOW'; }
    catch { return 'REFUSE'; }
  };
  const present = await outcome();
  for (const { store } of stores) await fs.rm(store, { recursive: true, force: true });
  const absent = await outcome();
  assert.equal(present, absent, 'health presence must never change a fixture outcome');
} finally {
  for (const { store, backup, existed } of stores) {
    await fs.rm(store, { recursive: true, force: true });
    if (existed) await fs.rename(backup, store);
  }
}
