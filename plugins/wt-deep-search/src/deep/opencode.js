function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

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

// ⚠ The child carries DEEP_SEARCH_WORKER=1 so that a deep-search run cannot start another one.
// Measured 2026-09-21: an agentic run pointed at the plugin's own directory read the CLI it found
// there and re-ran it, and each child did the same — seven runs in two minutes. The marker is what
// `bin/deep.mjs start` refuses on; the neutral working directory is the other half.
export function startOpencode(options, deps = {}) {
  const { prompt, dir, logPath, timeoutMs = 30 * 60_000 } = options;
  if (typeof deps.spawn !== 'function') throw new TypeError('opencode requires an injected spawner');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('opencode requires a full brief');
  if (typeof dir !== 'string' || !dir.startsWith('/')) throw new TypeError('opencode requires an absolute --dir');
  if (typeof logPath !== 'string' || !logPath.startsWith('/')) {
    throw new TypeError('opencode requires an absolute log path');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('opencode timeout must be positive');

  const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
  const log = shellQuote(logPath);
  const command = [
    `timeout ${timeoutSeconds}s opencode run --auto --dir ${shellQuote(dir)} ${shellQuote(prompt)}`,
    `< /dev/null > ${log} 2>&1`,
    '; code=$?',
    `; printf '\\nEXIT=%s\\n' "$code" >> ${log}`,
  ].join(' ');
  const child = deps.spawn('/bin/sh', ['-c', command], {
    detached: true,
    stdio: 'ignore',
    env: childEnvironment(deps.env ?? process.env),
  });
  child.unref?.();
  return { logPath, pid: child.pid };
}
