// Pure symbol classifier and I/O plans. Only hooks.js fulfills these requests.
import { normal, absolute, parentOf } from '../paths.js';
const IDENT = '[A-Za-z_$][\\w$]*';
const MODIFIER = /^(?:export|public|private|protected|internal|static|abstract|final|async|default|pub|override|open|data|sealed)\s+/;
const DECL = new RegExp('^(?:function\\*?|class|interface|type|enum|const|let|var|def|fun|val|struct|trait|impl|record|object)\\s+' + `(${IDENT})\\s*(?:[=(<:{]\\s*)?$`);
const CALL = new RegExp(`^\\.?(${IDENT})\\s*\\($`);
const BARE = new RegExp(`^(${IDENT})$`);
const NEW = new RegExp(`^new (${IDENT})\\s*\\(?$`);
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'require', 'import', 'print', 'typeof', 'super', 'this']);
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const identLike = (name) => /[a-z][A-Z]/.test(name) || SNAKE.test(name);

function extractOne(pattern) {
  let p = pattern.trim().replace(/^\^/, '').replace(/\$$/, '').replace(/\\b/g, '');
  p = p.replace(/\\s[+*]?/g, ' ').replace(/\\\(/g, '(').replace(/\s+/g, ' ').trim();
  let declaration = p;
  while (MODIFIER.test(declaration)) declaration = declaration.replace(MODIFIER, '');
  let m = DECL.exec(declaration);
  if (m) return m[1].length >= 2 && m[1] !== m[1].toUpperCase() && !m[1].endsWith('_') ? m[1] : null;
  m = NEW.exec(p);
  if (m) return (identLike(m[1]) || /^[A-Z][a-z0-9]{2,}$/.test(m[1])) && !m[1].endsWith('_') ? m[1] : null;
  m = CALL.exec(p);
  if (m) return m[1].length >= 3 && !NOT_CALLS.has(m[1]) && m[1] !== m[1].toUpperCase() && !m[1].endsWith('_') ? m[1] : null;
  m = BARE.exec(p);
  return m && identLike(m[1]) && !m[1].endsWith('_') ? m[1] : null;
}

export function extractSymbol(pattern) {
  if (typeof pattern !== 'string') return null;
  if (!pattern.includes('|')) return extractOne(pattern);
  if (/(^|[^\\])[()]/.test(pattern.replace(/\\\(/g, ''))) return null;
  const names = [];
  for (const branch of pattern.split('|')) {
    const name = extractOne(branch);
    if (!name) return null;
    if (!names.includes(name)) names.push(name);
  }
  return names.length && names.length <= 3 ? names.join('|') : null;
}

// Use slash paths internally (normal, absolute, parentOf come from paths.js).
function pathOf(base, part) {
  const text = normal(part);
  const joined = absolute(text) ? text : `${normal(base)}/${text}`;
  const prefix = /^([A-Za-z]:\/|\/\/[^/]+\/[^/]+|\/)/.exec(joined)?.[1] ?? '/';
  const stack = [];
  for (const piece of joined.slice(prefix.length).split('/')) {
    if (piece === '..') stack.pop();
    else if (piece && piece !== '.') stack.push(piece);
  }
  return prefix.replace(/\/$/, '') + '/' + stack.join('/');
}
const extension = (path) => /\.[^./]+$/.exec(normal(path))?.[0] ?? '';
// Node errors carry a code; the Function Hooks host rejects a missing file with a message ending "failed: ENOENT".
const missing = (error) => ['ENOENT', 'ENOTDIR'].includes(error?.code) || /(?:^|\bfailed: )(?:ENOENT|ENOTDIR)\b/.test(error?.message ?? '');
// A response is either { value } or { error }; errors never disappear in the shell.
function* request(op, path, options) {
  const response = yield { op, path, ...(options ? { options } : {}) };
  if (response.error) throw response.error;
  return response.value;
}
function* json(file) {
  try { return JSON.parse(yield* request('read', file)); }
  catch (error) { if (missing(error)) { return null; } throw error; }
}
function* targetKind(path) {
  try { return (yield* request('stat', path)).kind; }
  catch (error) { if (missing(error)) { return null; } throw error; }
}
function* canonical(path) {
  try { return normal((yield* request('stat', path, { resolve: true })).realPath ?? path); }
  catch (error) { if (missing(error)) { return normal(path); } throw error; }
}
const within = (child, parent) => child === parent || child.startsWith(`${parent.replace(/\/$/, '')}/`);
function* projectSettings(cwd, home) {
  let dir = cwd;
  const local = {}, shared = {}, disabled = new Set();
  for (let i = 0; i <= 6; i++) {
    for (const [settings, file] of [[local, 'settings.local.json'], [shared, 'settings.json']]) {
      const plugins = (yield* json(pathOf(dir, `.claude/${file}`)))?.enabledPlugins ?? {};
      for (const [id, value] of Object.entries(plugins)) {
        settings[id] ??= value;
        if (value === false) disabled.add(id);
      }
    }
    const parent = parentOf(dir);
    if (parent === dir || normal(dir) === normal(home)) break;
    dir = parent;
  }
  return { local, shared, disabled };
}
const TYPES = {
  ts: ['.ts', '.tsx', '.mts', '.cts'], typescript: ['.ts', '.tsx', '.mts', '.cts'],
  js: ['.js', '.jsx', '.mjs', '.cjs'], javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  py: ['.py', '.pyi'], python: ['.py', '.pyi'], java: ['.java'], kotlin: ['.kt', '.kts'],
  groovy: ['.groovy', '.gradle'], svelte: ['.svelte'], go: ['.go'], rust: ['.rs'],
  c: ['.c', '.h'], cpp: ['.cpp', '.cc', '.hpp', '.h'], cs: ['.cs'], csharp: ['.cs'],
  ruby: ['.rb'], php: ['.php'], lua: ['.lua'], swift: ['.swift'],
};
const MARKERS = {
  'tsconfig.json': TYPES.ts, 'tsconfig.base.json': TYPES.ts, 'jsconfig.json': TYPES.js,
  'pom.xml': ['.java', '.kt', '.kts', '.groovy'], 'build.gradle': ['.java', '.kt', '.kts', '.groovy'],
  'build.gradle.kts': ['.java', '.kt', '.kts', '.groovy'], 'settings.gradle': ['.java', '.kt', '.kts', '.groovy'],
  'settings.gradle.kts': ['.java', '.kt', '.kts', '.groovy'], 'pyproject.toml': TYPES.py,
  'setup.py': TYPES.py, 'setup.cfg': TYPES.py, 'svelte.config.js': ['.svelte', '.ts'],
  'go.mod': TYPES.go, 'Cargo.toml': TYPES.rust,
};
function globExtensions(glob) {
  const branches = [];
  let depth = 0, start = 0;
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '{') depth++;
    else if (glob[i] === '}') depth--;
    else if (glob[i] === ',' && depth === 0) { branches.push(glob.slice(start, i)); start = i + 1; }
    if (depth < 0) return [];
  }
  if (depth) return [];
  branches.push(glob.slice(start));
  const found = [];
  for (const branch of branches) {
    const text = branch.trim();
    const suffix = /\.(?:\{([A-Za-z0-9]+(?:,[A-Za-z0-9]+)*)\}|([A-Za-z0-9]+))$/.exec(text);
    // Only simple positive paths/stars and a terminal extension are modeled.
    if (!suffix || !/^[A-Za-z0-9_.*-]+(?:\/[A-Za-z0-9_.*-]+)*$/.test(text.slice(0, suffix.index))) return [];
    for (const ext of (suffix[1] ?? suffix[2]).split(',')) found.push(`.${ext}`);
  }
  return found;
}
function* targetExtensions(input, { cwd, home }) {
  if (typeof input.type === 'string' && input.type && !Object.hasOwn(TYPES, input.type)) return [];
  const type = typeof input.type === 'string' && input.type ? TYPES[input.type] : null;
  const glob = typeof input.glob === 'string' ? globExtensions(input.glob) : null;
  if (glob && !glob.length) return []; // A supplied but unclassifiable glob is an unknown target.
  const constraints = type && glob ? type.filter((ext) => glob.includes(ext)) : type ?? glob;
  const path = input.path ? pathOf(cwd, input.path) : cwd;
  if (input.path) {
    const kind = yield* targetKind(path);
    if (kind !== 'dir') {
      if (kind !== 'file') return [];
      const ext = extension(path);
      return constraints ? constraints.filter((item) => item === ext) : [ext];
    }
  }
  if (constraints) return constraints;
  let dir = path;
  for (let i = 0; i <= 6; i++) {
    const entries = yield* request('list', dir);
    const found = entries.filter((entry) => Object.hasOwn(MARKERS, entry.name));
    if (found.length) return found.flatMap((entry) => MARKERS[entry.name]);
    const parent = parentOf(dir);
    if (parent === dir || normal(dir) === normal(home)) break;
    dir = parent;
  }
  return [];
}

function* declaration(install, source, servers) {
  if (Array.isArray(source)) {
    for (const item of source) yield* declaration(install, item, servers);
  } else if (typeof source === 'string') {
    yield* declaration(install, yield* json(pathOf(install, source)), servers);
  } else if (source && typeof source === 'object') {
    for (const [name, server] of Object.entries(source)) servers.set(name, server);
  }
}
function* serversOf(install, entry) {
  const manifest = yield* json(pathOf(install, '.claude-plugin/plugin.json'));
  const servers = new Map();
  yield* declaration(install, yield* json(pathOf(install, '.lsp.json')), servers);
  yield* declaration(install, manifest === null ? entry?.lspServers : manifest.lspServers, servers);
  return [...servers.values()];
}
function* resolves(command, { pathEnv, windows, pathExt }) {
  if (typeof command !== 'string' || !command) return false;
  let dirs = [];
  if (absolute(normal(command))) dirs = [''];
  else if (!command.includes('/') && !command.includes('\\')) dirs = String(pathEnv ?? '').split(windows ? ';' : ':').filter((dir) => dir && absolute(normal(dir)));
  const suffixes = windows && !extension(command) ? String(pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) for (const suffix of suffixes) {
    const candidate = dir ? pathOf(dir, `${command}${suffix}`) : normal(command) + suffix;
    try { if ((yield* request('stat', candidate)).kind === 'file') return true; }
    catch (error) { if (!missing(error)) throw error; }
  }
  return false;
}

/** Choose an applicable project install over a user install, independent of installed_plugins array order. */
export function* servedExtensions({ configDir, cwd, home, pathEnv, windows = false, pathExt = '' }) {
  const enabled = (yield* json(pathOf(configDir, 'settings.json')))?.enabledPlugins ?? {};
  const installed = (yield* json(pathOf(configDir, 'plugins/installed_plugins.json')))?.plugins ?? {};
  const served = new Set();
  const canonicalCwd = yield* canonical(cwd);
  const settings = yield* projectSettings(canonicalCwd, home);
  for (const [id, installs] of Object.entries(installed)) {
    if (!Array.isArray(installs)) continue;
    const applicable = [];
    const on = settings.disabled.has(id) ? false : settings.local[id] ?? settings.shared[id] ?? enabled[id];
    for (const inst of installs) {
      if (!inst?.installPath) continue;
      if (inst.scope && inst.scope !== 'user') {
        if (!inst.projectPath || !within(canonicalCwd, yield* canonical(inst.projectPath))) continue;
        if (on === true) applicable.push({ inst, rank: 2 });
      } else {
        if (on === true) applicable.push({ inst, rank: 1 });
      }
    }
    // One install per id: project scope wins; ties keep the first entry in the registry.
    const chosen = applicable.sort((a, b) => b.rank - a.rank)[0]?.inst;
    if (!chosen) continue;
    const [name, marketplace] = id.split('@');
    const market = marketplace ? yield* json(pathOf(configDir, `plugins/marketplaces/${marketplace}/.claude-plugin/marketplace.json`)) : null;
    const entry = market?.plugins?.find((item) => item?.name === name);
    for (const server of yield* serversOf(chosen.installPath, entry)) {
      if (!server.extensionToLanguage || !(yield* resolves(server.command, { pathEnv, windows, pathExt }))) continue;
      for (const ext of Object.keys(server.extensionToLanguage)) served.add(ext);
    }
  }
  const skip = yield* json(pathOf(configDir, 'lsp-hint-skip.json'));
  if (Array.isArray(skip)) for (const ext of skip) served.delete(String(ext).startsWith('.') ? String(ext) : `.${ext}`);
  return served;
}

export function* classifyGrep(input, env, servedSet = null) {
  if (!input || input['-i'] === true) return false;
  const symbol = extractSymbol(input.pattern);
  if (!symbol) return false; // No disk or environment reads for a text search.
  const served = servedSet ?? (yield* servedExtensions(env));
  if (!served.size) return false;
  const target = yield* targetExtensions(input, env);
  const exts = target.filter((ext) => served.has(ext));
  return exts.length > 0 && (exts.some((ext) => ext === '.py' || ext === '.pyi') || !symbol.split('|').some((name) => SNAKE.test(name)));
}

export function* detectorEnvironment(event) {
  const home = (yield* request('env', 'HOME')) || (yield* request('env', 'USERPROFILE'));
  const configDir = (yield* request('env', 'CLAUDE_CONFIG_DIR')) || (home ? pathOf(home, '.claude') : null);
  if (!configDir) throw new Error('config directory unavailable');
  let cwd = event.cwd;
  if (!cwd) {
    try { cwd = (yield* request('stat', '.', { resolve: true })).realPath; }
    catch { cwd = null; }
  }
  if (!cwd || !absolute(normal(cwd))) return null;
  const pathExt = yield* request('env', 'PATHEXT');
  const os = yield* request('env', 'OS');
  const env = { configDir, cwd: yield* canonical(cwd), home,
    pathEnv: yield* request('env', 'PATH'), pathExt, windows: !!pathExt || os === 'Windows_NT' };
  return { env, key: JSON.stringify([normal(configDir), env.cwd, home, env.pathEnv, pathExt, os]) };
}

export const DETECTORS = Object.freeze({ 'lsp-symbol-grep': classifyGrep });
