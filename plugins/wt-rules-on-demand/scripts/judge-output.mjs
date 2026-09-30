import { lstat, mkdir, mkdtemp, open, readlink, realpath } from 'node:fs/promises';
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
  const insensitive = process.platform === 'win32' || process.platform === 'darwin';
  const fold = (part) => insensitive ? part.toLowerCase() : part;
  for (const root of [rollbackStoreDirectory(configDir), rollbackArchiveDirectory(configDir)]) {
    const path = relative(fold(await physicalPath(root)), fold(output));
    if (!path || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
      throw new Error(`judge output inside rollback input directory: ${root}`);
  }
  const parts = output.split(sep).filter(Boolean).map(fold);
  for (const location of rollbackInputLocations) {
    const segments = location.segments.map(fold);
    if (parts.some((_, index) => segments.every((segment, offset) => parts[index + offset] === segment)))
      throw new Error('judge output inside rollback input directory');
    const pattern = insensitive ? new RegExp(location.namePattern.source, 'i') : location.namePattern;
    if (parts.some((part) => pattern.test(part)))
      throw new Error('judge output component matches rollback input name');
  }
}

// Examine the whole path before each hop: a link can erase a protected name
// even when neither its initial spelling nor the final destination contains it.
async function checkedParent(parent, configDir) {
  let candidate = parent;
  for (let hops = 0; hops <= 40; hops++) {
    await assertOutsideRollbackInputs(candidate, configDir);
    const root = parse(candidate).root;
    let current = root;
    let next = null;
    const parts = candidate.slice(root.length).split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      const info = await lstat(current).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) break;
      if (info.isSymbolicLink()) {
        const destination = await readlink(current);
        // Keep components such as store/../safe visible until after the check.
        const rawTarget = isAbsolute(destination) ? destination : `${dirname(current)}${sep}${destination}`;
        const rest = parts.slice(index + 1);
        await assertOutsideRollbackInputs(rest.length ? `${rawTarget}${sep}${rest.join(sep)}` : rawTarget, configDir);
        next = resolve(dirname(current), destination, ...parts.slice(index + 1));
        break;
      }
      if (!info.isDirectory()) throw new Error('judge output must be a directory');
    }
    if (!next) return;
    candidate = next;
  }
  throw new Error('judge output directory cannot resolve a symlink loop');
}

// Callers select a directory, never a file. Reject lexical aliases before normalizing
// them: /safe/link/../out still traverses link on some filesystems.
export async function newJudgeOutput(directory, name, rollbackConfigDir = configDirectory(process.env)) {
  if (directory.split(/[\\/]/).includes('..')) throw new Error('judge output directory cannot contain ..');
  const absolute = resolve(directory);
  // Resolve only the parent: the output component itself must never be a link.
  const output = await lstat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (output?.isSymbolicLink()) throw new Error('judge output directory cannot traverse a symlink');
  await assertOutsideRollbackInputs(absolute, rollbackConfigDir);
  await checkedParent(dirname(absolute), rollbackConfigDir);
  const physical = join(await physicalPath(dirname(absolute)), basename(absolute));
  await assertOutsideRollbackInputs(physical, rollbackConfigDir);
  const root = parse(physical).root;
  let current = root;
  for (const part of physical.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('judge output directory cannot traverse a symlink');
    if (info && !info.isDirectory()) throw new Error('judge output must be a directory');
    if (!info) await mkdir(current);
  }
  const owned = await mkdtemp(join(physical, 'run-'));
  return openNewJudgeFile(owned, name);
}

export async function openNewJudgeFile(owned, name) {
  const path = join(owned, name);
  const handle = await open(path, 'wx', 0o600);
  return { path, handle };
}
