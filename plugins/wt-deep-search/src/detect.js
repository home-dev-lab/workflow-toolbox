function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function joinPath(parent, child, separator) {
  return `${parent.replace(/[\\/]+$/, '')}${separator}${child.replace(/^[\\/]+/, '')}`;
}

function isUsablePath(fs, path, type, mode) {
  try {
    const stat = fs.statSync(path);
    const hasExpectedType = type === 'directory' ? stat.isDirectory() : stat.isFile();
    if (!hasExpectedType) return false;
    if (mode !== null) fs.accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

export function detectProviders(env, fs, options = {}) {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const separator = isWindows ? '\\' : '/';
  const home = isNonEmpty(env.HOME)
    ? env.HOME
    : isWindows && isNonEmpty(env.USERPROFILE)
      ? env.USERPROFILE
      : isWindows && isNonEmpty(env.HOMEDRIVE) && isNonEmpty(env.HOMEPATH)
        ? joinPath(env.HOMEDRIVE, env.HOMEPATH, separator)
        : null;
  let mirror;

  if (!home) {
    mirror = {
      available: false,
      reason: isWindows
        ? 'HOME, USERPROFILE, or HOMEDRIVE and HOMEPATH are not set to non-empty values'
        : 'HOME is not set to a non-empty value',
    };
  } else {
    const mirrorPath = joinPath(home, '.claude-code-docs', separator);
    const manifestPath = joinPath(mirrorPath, 'docs_manifest.json', separator);

    if (!fs.existsSync(mirrorPath)) {
      mirror = {
        available: false,
        reason: 'Claude Code documentation mirror directory was not found',
      };
    } else if (!isUsablePath(fs, mirrorPath, 'directory', fs.constants?.R_OK ?? 4)) {
      mirror = {
        available: false,
        reason: 'Claude Code documentation mirror is not a readable directory',
      };
    } else if (!fs.existsSync(manifestPath)) {
      mirror = {
        available: false,
        reason: 'Claude Code documentation mirror manifest was not found',
      };
    } else if (!isUsablePath(fs, manifestPath, 'file', fs.constants?.R_OK ?? 4)) {
      mirror = {
        available: false,
        reason: 'Claude Code documentation mirror manifest is not a readable file',
      };
    } else {
      mirror = { available: true, path: mirrorPath };
    }
  }

  const brave = isNonEmpty(env.BRAVE_API_KEY) || isNonEmpty(env.BRAVE_SEARCH_API_KEY)
    ? { available: true }
    : {
        available: false,
        reason: 'BRAVE_API_KEY or BRAVE_SEARCH_API_KEY is not set to a non-empty value',
      };

  const exa = isNonEmpty(env.EXA_API_KEY)
    ? { available: true }
    : {
        available: false,
        reason: 'EXA_API_KEY is not set to a non-empty value',
      };

  let opencode;
  if (!isNonEmpty(env.PATH)) {
    opencode = {
      available: false,
      reason: 'PATH is not set to a non-empty value',
    };
  } else {
    const extensions = isWindows
      ? (isNonEmpty(env.PATHEXT) ? env.PATHEXT : '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
    const binaryPath = env.PATH.split(isWindows ? ';' : ':')
      .filter(Boolean)
      .flatMap((directory) => extensions.map((extension) => (
        joinPath(directory, `opencode${extension}`, separator)
      )))
      .find((candidate) => fs.existsSync(candidate)
        // Windows has no executable mode; file existence and type are the honest measurement.
        && isUsablePath(fs, candidate, 'file', isWindows ? null : (fs.constants?.X_OK ?? 1)));

    opencode = binaryPath
      ? { available: true, path: binaryPath }
      : {
          available: false,
          reason: 'opencode was not found on PATH',
        };
  }

  return { mirror, brave, exa, opencode };
}
