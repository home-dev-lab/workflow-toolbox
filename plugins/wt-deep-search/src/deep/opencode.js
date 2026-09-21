import { appendFileSync, closeSync, openSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';

const OPENCODE_ENVIRONMENT = [
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'COLORTERM', 'SHELL', 'SystemRoot', 'COMSPEC', 'PATHEXT',
];

function childEnvironment(source) {
  const env = {};
  for (const name of OPENCODE_ENVIRONMENT) {
    if (typeof source[name] === 'string') env[name] = source[name];
  }
  return { ...env, DEEP_SEARCH_WORKER: '1' };
}

function absolutePath(value) {
  return typeof value === 'string' && (isAbsolute(value) || win32.isAbsolute(value));
}

// ⚠ The child carries DEEP_SEARCH_WORKER=1 so that a deep-search run cannot start another one.
// Measured 2026-09-21: an agentic run pointed at the plugin's own directory read the CLI it found
// there and re-ran it, and each child did the same — seven runs in two minutes. The marker is what
// `bin/deep.mjs start` refuses on; the neutral working directory is the other half.
export function startOpencode(options, deps = {}) {
  const { prompt, dir, logPath, timeoutMs = 30 * 60_000 } = options;
  if (typeof deps.spawn !== 'function') throw new TypeError('opencode requires an injected spawner');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('opencode requires a full brief');
  if (!absolutePath(dir)) throw new TypeError('opencode requires an absolute --dir');
  if (!absolutePath(logPath)) {
    throw new TypeError('opencode requires an absolute log path');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('opencode timeout must be positive');

  const open = deps.openSync ?? openSync;
  const close = deps.closeSync ?? closeSync;
  const append = deps.appendFileSync ?? appendFileSync;
  const scheduleTimeout = deps.setTimeout ?? setTimeout;
  const cancelTimeout = deps.clearTimeout ?? clearTimeout;
  const log = open(logPath, 'w');
  let child;
  try {
    child = deps.spawn('opencode', ['run', '--auto', '--dir', dir, prompt], {
      detached: true,
      shell: false,
      stdio: ['ignore', log, log],
      env: childEnvironment(deps.env ?? process.env),
    });
  } finally {
    close(log);
  }

  let finished = false;
  let timeout;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    if (timeout !== undefined) cancelTimeout(timeout);
    append(logPath, `\nEXIT=${code}\n`);
  };
  child.once?.('exit', (code) => finish(Number.isInteger(code) ? code : 1));
  child.once?.('error', () => finish(127));
  timeout = scheduleTimeout(() => {
    if (finished) return;
    finished = true;
    append(logPath, `\nTIMEOUT=${timeoutMs}\nEXIT=124\n`);
    child.kill();
  }, timeoutMs);
  child.unref?.();
  return { logPath, pid: child.pid };
}
