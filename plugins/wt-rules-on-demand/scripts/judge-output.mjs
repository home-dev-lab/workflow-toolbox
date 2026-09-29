import { lstat, mkdir, mkdtemp, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { configDirectory } from '../paths.js';
import { rollbackStoreDirectory, rollbackArchiveDirectory, rollbackInputLocations } from './rollback-input-paths.mjs';

async function physicalPath(path) {
  let ancestor = resolve(path);
  const missing = [];
  while (true) {
    try { return resolve(await realpath(ancestor), ...missing.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      missing.push(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

async function assertOutsideRollbackInputs(output, configDir) {
  if (!configDir) throw new Error('config directory required to protect rollback inputs');
  const target = await physicalPath(output);
  const insensitive = process.platform === 'win32' || process.platform === 'darwin';
  const fold = (part) => insensitive ? part.toLowerCase() : part;
  for (const root of [rollbackStoreDirectory(configDir), rollbackArchiveDirectory(configDir)]) {
    const path = relative(fold(await physicalPath(root)), fold(target));
    if (!path || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
      throw new Error(`judge output inside rollback input directory: ${root}`);
  }
  const parts = target.split(sep).filter(Boolean).map(fold);
  for (const location of rollbackInputLocations) {
    const segments = location.segments.map(fold);
    if (parts.some((_, index) => segments.every((segment, offset) => parts[index + offset] === segment)))
      throw new Error('judge output inside rollback input directory');
    const pattern = insensitive ? new RegExp(location.namePattern.source, 'i') : location.namePattern;
    if (parts.some((part) => pattern.test(part)))
      throw new Error('judge output component matches rollback input name');
  }
}

// Callers select a directory, never a file. Reject lexical aliases before normalizing
// them: /safe/link/../out still traverses link on some filesystems.
export async function newJudgeOutput(directory, name, rollbackConfigDir = configDirectory(process.env)) {
  if (directory.split(/[\\/]/).includes('..')) throw new Error('judge output directory cannot contain ..');
  const absolute = resolve(directory);
  await assertOutsideRollbackInputs(absolute, rollbackConfigDir);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('judge output directory cannot traverse a symlink');
    if (info && !info.isDirectory()) throw new Error('judge output must be a directory');
    if (!info) await mkdir(current);
  }
  const owned = await mkdtemp(join(absolute, 'run-'));
  return openNewJudgeFile(owned, name);
}

export async function openNewJudgeFile(owned, name) {
  const path = join(owned, name);
  const handle = await open(path, 'wx', 0o600);
  return { path, handle };
}
