import fs from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';

export const LAUNCH_LIMIT = 'Cannot read --settings or launch flags --safe-mode, --bare, --setting-sources (which may exclude user settings); other managed sources (MDM, registry, server-delivered policy) are unexamined. Verify the effective settings of each intended launch.';
export const objectSettings = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function refuse(message) { throw new Error(`${message}; ${LAUNCH_LIMIT}`); }

export function managedSettingsPath(platform = process.platform) {
  if (platform === 'linux') return '/etc/claude-code/managed-settings.json';
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  refuse(`managed-settings location unknown on platform ${platform}`);
}

async function absent(path, io) {
  try { await io.lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return true;
    refuse(`managed settings ${path}: cannot inspect (${error.code ?? error.message})`);
  }
  refuse(`managed settings ${path}: exists but cannot be read (possibly a dangling symlink)`);
}

async function readPolicy(file, io, optional = false) {
  let text;
  try { text = await io.readFile(file, 'utf8'); }
  catch (error) {
    if (optional && error.code === 'ENOENT' && await absent(file, io)) return {};
    refuse(`managed settings ${file}: cannot read (${error.code ?? error.message})`);
  }
  let settings;
  try { settings = JSON.parse(text); }
  catch { refuse(`managed settings ${file}: invalid JSON`); }
  if (!objectSettings(settings)) refuse(`managed settings ${file}: expected a settings object`);
  return settings;
}

export async function managedPolicies(options = {}) {
  // Injection is an explicit function argument; production never reads an environment override.
  const platform = options.platform ?? process.platform;
  const file = options.managedFile ?? managedSettingsPath(platform);
  const io = options.fs ?? fs;
  const paths = !options.managedFile && platform === 'win32' ? win32 : { dirname, join };
  const directory = paths.join(paths.dirname(file), 'managed-settings.d');
  const policies = [{ file, settings: await readPolicy(file, io, true) }];
  let names;
  try { names = await io.readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT' && await absent(directory, io)) names = [];
    else refuse(`managed settings ${directory}: cannot read drop-in directory (${error.code ?? error.message})`);
  }
  for (const name of names.filter((name) => name.endsWith('.json')).sort()) {
    const fragment = paths.join(directory, name);
    policies.push({ file: fragment, settings: await readPolicy(fragment, io) });
  }
  const unexamined = platform === 'darwin' ? 'MDM policy' : platform === 'win32' ? 'registry policy' : 'server-delivered policy';
  (options.warn ?? console.error)(`rules: ${unexamined} is unexamined; file-based policy is not the complete effective policy. ${LAUNCH_LIMIT}`);
  return policies;
}
