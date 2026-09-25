import { appendFileSync, closeSync, openSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, resolve, win32 } from 'node:path';

const TERMINATION_GRACE_MS = 1_000;
// anthropic is deliberately absent from PROVIDER_CREDENTIALS with an explicit [] entry below, and
// NEVER_PASS_CREDENTIALS is stripped out of every candidate name list, whatever the source (an
// explicit model, a registry fixture, or the environment-provider fallback): the deep-search child
// must never receive the owner's own Anthropic session credential.
const PROVIDER_CREDENTIALS = { anthropic: [], openai: ['OPENAI_API_KEY'], google: ['GOOGLE_GENERATIVE_AI_API_KEY'] };
const PROVIDER_EXTRAS = { azure: ['AZURE_RESOURCE_NAME'], 'azure-cognitive-services': ['AZURE_COGNITIVE_SERVICES_RESOURCE_NAME'] };
const NEVER_PASS_CREDENTIALS = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const warnedProviders = new Set();

const OPENCODE_ENVIRONMENT = [
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'COLORTERM', 'SHELL', 'SystemRoot', 'COMSPEC', 'PATHEXT',
];

// The provider a known credential name is assigned to in PROVIDER_CREDENTIALS, case-insensitive.
// Used so a registry (models.json) entry for provider X can never authorize a credential the
// known map assigns to a DIFFERENT provider Y (e.g. an azure entry listing OPENAI_API_KEY).
function knownCredentialOwner(name) {
  const upper = name.toUpperCase();
  for (const [owner, credentials] of Object.entries(PROVIDER_CREDENTIALS)) {
    if (credentials.some((credential) => credential.toUpperCase() === upper)) return owner;
  }
  return null;
}

function providerEnvironmentNames(model, source, warn) {
  const provider = String(model ?? '').split('/', 1)[0].toLowerCase();
  if (!provider || !String(model).includes('/')) return [];
  // Case-insensitive: a registry (or fallback) name that matches a deny-listed credential by
  // letter case alone must never reach the child, on any platform.
  const withoutCredentials = (names) => names.filter((name) => !NEVER_PASS_CREDENTIALS.has(name.toUpperCase()));
  if (Object.hasOwn(PROVIDER_CREDENTIALS, provider)) return withoutCredentials(PROVIDER_CREDENTIALS[provider]);
  const roots = [source.XDG_CACHE_HOME, source.HOME && `${source.HOME}/.cache`, source.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    try {
      const names = JSON.parse(readFileSync(`${root}/opencode/models.json`, 'utf8'))?.[provider]?.env;
      if (Array.isArray(names)) {
        return withoutCredentials(names.filter((name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
          .filter((name) => { const owner = knownCredentialOwner(name); return owner === null || owner === provider; });
      }
    } catch {}
  }
  const names = withoutCredentials([`${provider.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_')}_API_KEY`, ...(PROVIDER_EXTRAS[provider] ?? [])]);
  if (!warnedProviders.has(provider)) {
    warnedProviders.add(provider);
    warn(`wt-deep-search: OpenCode provider definitions unavailable for ${provider}; using fallback environment names ${names.join(', ')}`);
  }
  return names;
}

function childEnvironment(source, model, warn) {
  const env = {};
  for (const name of [...OPENCODE_ENVIRONMENT, ...providerEnvironmentNames(model, source, warn)]) {
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
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

export function resolveWindowsCommandShim(executable, read = readFileSync, nodeExecutable = process.execPath) {
  const source = read(executable, 'utf8');
  const invocation = source.split(/\r?\n/).find((line) => /%\*/.test(line) && /(?:%~dp0|%dp0%)/i.test(line));
  const candidates = [...String(invocation ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const script = candidates.find((value) => /^(?:%~dp0|%dp0%)/i.test(value));
  if (!script) throw new Error('opencode command shim is not a supported npm Node shim');
  const relative = script.replace(/^%~dp0/i, '').replace(/^%dp0%[\\/]?/i, '');
  const scriptPath = /^[A-Za-z]:[\\/]/.test(executable)
    ? win32.resolve(win32.dirname(executable), relative)
    : resolve(dirname(executable), relative.replaceAll('\\', '/'));
  return { executable: nodeExecutable, args: [scriptPath] };
}

function spawnCommand(spawn, executable, args, options, platform, resolveCommandShim) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) return spawn(executable, args, options);
  const resolved = resolveCommandShim(executable);
  return spawn(resolved.executable, [...resolved.args, ...args], options);
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
  const sourceEnvironment = deps.env ?? process.env;
  const model = options.model ?? sourceEnvironment.OPENCODE_MODEL;
  // Released behaviour: with no explicit model and no OPENCODE_MODEL, no provider is inferred
  // from the environment (round 5 added inference here, and round 7 removed it — Astra MED: it
  // invented providers from unrelated *_API_KEY-shaped names and overlooked multi-variable
  // credentials such as AWS's pair. This is a deliberate reversal to the release, not a
  // regression.)
  const environment = childEnvironment(sourceEnvironment, model, deps.warn ?? console.error);
  const resolveCommandShim = deps.resolveCommandShim ?? resolveWindowsCommandShim;
  const graceMs = deps.terminationGraceMs ?? TERMINATION_GRACE_MS;
  const signalFamily = deps.signalProcessFamily ?? ((pid, signal) => signalProcessFamily(pid, signal, platform));
  const familyExists = deps.processFamilyExists ?? ((pid) => processFamilyExists(pid, platform, deps.kill));
  const log = open(logPath, 'w');
  let child;
  try {
    try {
      child = spawnCommand(deps.spawn, executable, ['run', '--auto', '--dir', dir, ...(model ? ['--model', model] : []), prompt], {
        detached: true,
        shell: false,
        stdio: ['ignore', log, log],
        env: environment,
      }, platform, resolveCommandShim);
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
    if (finished) return;
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
