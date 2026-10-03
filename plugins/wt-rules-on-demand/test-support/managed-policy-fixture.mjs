// Explicit Node test preload: redirect policy IO, never production CLI configuration.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { managedSettingsPath } from '../scripts/profile-check.mjs';

const file = managedSettingsPath();
const target = process.env.WT_ROD_TEST_MANAGED_SETTINGS;
const directory = join(dirname(file), 'managed-settings.d');
const redirect = (path) => path === file ? target : path === directory ? join(dirname(target), 'managed-settings.d')
  : String(path).startsWith(directory + sep) ? join(dirname(target), 'managed-settings.d', String(path).slice(directory.length + 1)) : path;
for (const method of ['readFile', 'readdir', 'lstat']) {
  const original = fs[method];
  fs[method] = (path, ...args) => original(redirect(path), ...args);
}
syncBuiltinESMExports();
