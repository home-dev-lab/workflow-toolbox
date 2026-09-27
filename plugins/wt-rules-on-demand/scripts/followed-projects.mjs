#!/usr/bin/env node
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory } from '../paths.js';

const fileOf = (configDir) => join(configDir, 'rules-on-demand', 'followed-projects.json');

export async function readFollowed(configDir) {
  const path = fileOf(configDir);
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try {
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error('expected an array');
    const bad = rows.findIndex((row) => !row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.root !== 'string' || !row.root.trim()
      || typeof row.addedAt !== 'string' || typeof row.by !== 'string');
    if (bad !== -1) throw new Error(`invalid entry at index ${bad}`);
    return rows;
  } catch (error) { throw new Error(`${path}: ${error.message}`, { cause: error }); }
}

async function save(configDir, rows) {
  const path = fileOf(configDir);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(rows, null, 2)}\n`, { flag: 'wx' }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}

async function locked(configDir, update) {
  const lock = `${fileOf(configDir)}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    try { handle = await open(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 30000) {
          console.error(`stale followed-projects lock: removing ${lock}`);
          await rm(lock, { force: true });
          continue;
        }
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${lock}`);
      await new Promise((settle) => setTimeout(settle, 50));
    }
  }
  try { return await update(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}

export async function addFollowed(configDir, root) {
  const canonical = await realpath(root);
  return locked(configDir, async () => {
    const rows = await readFollowed(configDir);
    if (!rows.some((entry) => entry.root === canonical)) {
      rows.push({ root: canonical, addedAt: new Date().toISOString(), by: 'onboard-project' });
      await save(configDir, rows);
    }
    return rows;
  });
}

export async function removeFollowed(configDir, root) {
  const canonical = await realpath(root);
  return locked(configDir, async () => {
    const rows = await readFollowed(configDir);
    const remaining = rows.filter((entry) => entry.root !== canonical);
    if (remaining.length !== rows.length) await save(configDir, remaining);
    return remaining;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--config-dir', '--project'].includes(args[i]) || !args[i + 1]) throw new Error('usage: followed-projects.mjs list|add|remove [--config-dir <dir>] [--project <dir>]');
      options[args[i]] = args[i + 1];
    }
    const configDir = resolve(options['--config-dir'] || configDirectory(process.env));
    if (!['list', 'add', 'remove'].includes(action) || (action !== 'list' && !options['--project'])) throw new Error('usage: followed-projects.mjs list|add|remove [--config-dir <dir>] [--project <dir>]');
    const rows = action === 'list' ? await readFollowed(configDir) : await (action === 'add' ? addFollowed : removeFollowed)(configDir, options['--project']);
    console.log(JSON.stringify(rows, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
