// Explicit Node test preload: redirect policy IO, never production CLI configuration.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { managedSettingsPath } from '../scripts/profile-check.mjs';

// Explicit test-only IO injection; NODE_OPTIONS alone cannot activate it.
// No credential or token is part of the configuration decision.
if (process.execArgv.includes(import.meta.url) && process.env.WT_ROD_TEST_MANAGED_SETTINGS) {
  const file = managedSettingsPath();
  const target = process.env.WT_ROD_TEST_MANAGED_SETTINGS;
  const directory = join(dirname(file), 'managed-settings.d');
  const dropIns = join(dirname(target), 'managed-settings.d');
  const redirect = (path) => {
    if (path === file) return target;
    if (path === directory) return dropIns;
    return String(path).startsWith(directory + sep) ? join(dropIns, String(path).slice(directory.length + 1)) : path;
  };
  for (const method of ['readFile', 'readdir', 'lstat']) {
    const original = fs[method];
    fs[method] = (path, ...args) => original(redirect(path), ...args);
  }
  syncBuiltinESMExports();
}
