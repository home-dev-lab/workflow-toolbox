import { randomUUID as nodeRandomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export function resolveStateDirectory({ env = process.env } = {}) {
  const xdg = typeof env.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.trim()
    ? env.XDG_STATE_HOME.trim()
    : null;
  if (xdg && !isAbsolute(xdg)) throw new Error('XDG_STATE_HOME must be an absolute path');
  if (xdg) return join(xdg, 'deep-search');

  const home = typeof env.HOME === 'string' && env.HOME.trim() ? env.HOME.trim() : null;
  if (!home || !isAbsolute(home)) throw new Error('HOME must be an absolute path');
  return join(home, '.local', 'state', 'deep-search');
}

function assertHandle(handle) {
  if (typeof handle !== 'string' || !/^deep-[a-zA-Z0-9-]+$/.test(handle)) {
    throw new Error(`Unknown deep-search handle: ${String(handle)}`);
  }
}

export function createHandleStore({
  env = process.env,
  fs = nodeFs,
  now = Date.now,
  randomUUID = nodeRandomUUID,
} = {}) {
  const directory = resolveStateDirectory({ env });
  const filename = (handle) => join(directory, `${handle}.json`);

  async function write(record) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = filename(record.handle);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
    return record;
  }

  async function read(handle) {
    assertHandle(handle);
    try {
      return JSON.parse(await fs.readFile(filename(handle), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
        throw new Error(`Unknown deep-search handle: ${handle}`);
      }
      throw error;
    }
  }

  return {
    directory,
    async create(record) {
      const timestamp = now();
      return write({
        ...record,
        handle: `deep-${randomUUID()}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },
    read,
    async update(handle, patch) {
      const current = await read(handle);
      return write({ ...current, ...patch, handle, updatedAt: now() });
    },
    async list() {
      let names;
      try {
        names = await fs.readdir(directory);
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const records = await Promise.all(names
        .filter((name) => /^deep-[a-zA-Z0-9-]+\.json$/.test(name))
        .map((name) => read(name.slice(0, -5))));
      return records.sort((left, right) => right.createdAt - left.createdAt);
    },
  };
}
