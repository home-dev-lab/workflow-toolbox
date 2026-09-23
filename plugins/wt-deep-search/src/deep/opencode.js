import { appendFileSync, closeSync, openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, win32 } from 'node:path';

const TERMINATION_GRACE_MS = 1_000;

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

function signalProcessFamily(pid, signal, platform = process.platform, kill = process.kill, run = spawnSync) {
  if (platform === 'win32') {
    const force = signal === 'SIGKILL' ? ['/F'] : [];
    return run('taskkill', ['/PID', String(pid), '/T', ...force], { windowsHide: true, stdio: 'ignore' }).status === 0;
  }
  try { kill(-pid, signal); } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function processFamilyExists(pid, platform = process.platform, kill = process.kill) {
  if (platform === 'win32') return true;
  try { kill(-pid, 0); return true; } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function spawnCommand(spawn, executable, args, options, platform, env) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) return spawn(executable, args, options);
  const metacharacters = /([()\][%!^"`<>&|;, *?])/g;
  const escapeArgument = (value) => {
    let escaped = String(value).replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/g, '$1$1');
    escaped = `"${escaped}"`.replace(metacharacters, '^$1');
    return escaped.replace(metacharacters, '^$1');
  };
  const command = [String(executable).replace(metacharacters, '^$1'), ...args.map(escapeArgument)].join(' ');
  return spawn(env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

// ⚠ The child carries DEEP_SEARCH_WORKER=1 so that a deep-search run cannot start another one.
// Measured 2026-09-21: an agentic run pointed at the plugin's own directory read the CLI it found
// there and re-ran it, and each child did the same — seven runs in two minutes. The marker is what
// `bin/deep.mjs start` refuses on; the neutral working directory is the other half.
export function startOpencode(options, deps = {}) {
  const { prompt, dir, logPath, executable = 'opencode', timeoutMs = 30 * 60_000 } = options;
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
  const platform = deps.platform ?? process.platform;
  const environment = childEnvironment(deps.env ?? process.env);
  const graceMs = deps.terminationGraceMs ?? TERMINATION_GRACE_MS;
  const signalFamily = deps.signalProcessFamily ?? ((pid, signal) => signalProcessFamily(pid, signal, platform));
  const familyExists = deps.processFamilyExists ?? ((pid) => processFamilyExists(pid, platform));
  const log = open(logPath, 'w');
  let child;
  try {
    try {
      child = spawnCommand(deps.spawn, executable, ['run', '--auto', '--dir', dir, prompt], {
        detached: true,
        shell: false,
        stdio: ['ignore', log, log],
        env: environment,
      }, platform, environment);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error('opencode was not found; install opencode and ensure it is on PATH');
      }
      throw new Error(`opencode failed to start: ${error?.code ?? error?.message ?? String(error)}`, { cause: error });
    }
  } finally {
    close(log);
  }

  let finished = false;
  let timedOut = false;
  let childExited = false;
  let windowsTreeKillConfirmed = false;
  let timeout;
  let terminationWait;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    if (timeout !== undefined) cancelTimeout(timeout);
    if (terminationWait !== undefined) cancelTimeout(terminationWait);
    append(logPath, `\nEXIT=${code}\n`);
  };
  const finishTimeoutIfTerminated = () => {
    if ((platform === 'win32' && (!childExited || !windowsTreeKillConfirmed))
      || (platform !== 'win32' && familyExists(child.pid))) return false;
    append(logPath, `\nTIMEOUT=${timeoutMs}\nEXIT=124\n`);
    finished = true;
    if (terminationWait !== undefined) cancelTimeout(terminationWait);
    return true;
  };
  const waitThenEscalate = (signal) => {
    terminationWait = scheduleTimeout(() => {
      if (finishTimeoutIfTerminated()) return;
      if (signal) {
        const confirmed = signalFamily(child.pid, signal) === true;
        windowsTreeKillConfirmed ||= confirmed;
        waitThenEscalate(null);
      }
    }, graceMs);
  };
  child.once?.('exit', (code) => {
    childExited = true;
    if (!timedOut) finish(Number.isInteger(code) ? code : 1);
    else finishTimeoutIfTerminated();
  });
  child.once?.('error', (error) => {
    childExited = true;
    if (!timedOut) {
      const code = error?.code === 'ENOENT' ? 127 : 126;
      append(logPath, `\nSPAWN_ERROR=${error?.code ?? 'unknown'}`);
      finish(code);
    }
    else finishTimeoutIfTerminated();
  });
  timeout = scheduleTimeout(() => {
    if (finished) return;
    timedOut = true;
    windowsTreeKillConfirmed = signalFamily(child.pid, 'SIGTERM') === true;
    waitThenEscalate('SIGKILL');
  }, timeoutMs);
  // ⚠ Never unref the timeout or the termination wait: the worker has nothing else keeping it
  // alive (the child is unref'd), so an unref'd timer lets it exit before the run is bounded.
  child.unref?.();
  return { logPath, pid: child.pid };
}
