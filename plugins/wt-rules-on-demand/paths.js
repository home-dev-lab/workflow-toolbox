// Shared by Function Hooks and Node CLIs; deliberately no Node builtin imports.
export function ruleDirectories(project, config) {
  const clean = (value) => {
    let path = String(value);
    while (path.endsWith('/') || path.endsWith('\\')) path = path.slice(0, -1);
    return path;
  };
  return {
    project: `${clean(project)}/.claude/rules-on-demand`,
    user: `${clean(config)}/rules-on-demand`,
    projectStatic: `${clean(project)}/.claude/rules`,
    userStatic: `${clean(config)}/rules`,
  };
}

export function configDirectory(env) {
  return env.CLAUDE_CONFIG_DIR || (env.HOME || env.USERPROFILE ? `${env.HOME || env.USERPROFILE}/.claude` : null);
}

export function agentLoop(agentId) {
  return agentId || 'main';
}

// Slash-path helpers: `\` becomes `/`, and a drive root or a UNC share keeps its root on parent walks.
export const normal = (path) => {
  let value = String(path ?? '').replace(/\\/g, '/');
  while (value.endsWith('/')) value = value.slice(0, -1);
  return /^[A-Za-z]:$/.test(value) ? `${value}/` : value || '/';
};
export const absolute = (path) => /^(?:\/|[A-Za-z]:\/)/.test(path);
// A raw spelling is absolute only when rooted: `/…`, `X:\` or `X:/`, `\\server\share`. `C:`, `C:foo` and `\p` are not.
export const rawAbsolute = (path) => typeof path === 'string' && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(path);
// Join `part` onto `base` and collapse `.` and `..`, never above the drive, UNC share or `/` root.
export function joinSlash(base, part) {
  const text = normal(part);
  const root = normal(base);
  const joined = absolute(text) ? text : `${root.endsWith('/') ? root.slice(0, -1) : root}/${text}`;
  const prefix = /^([A-Za-z]:\/|\/\/[^/]+\/[^/]+|\/)/.exec(joined)?.[1] ?? '/';
  const stack = [];
  for (const piece of joined.slice(prefix.length).split('/')) {
    if (piece === '..') stack.pop();
    else if (piece && piece !== '.') stack.push(piece);
  }
  const head = prefix.replace(/\/$/, '');
  if (stack.length) return `${head}/${stack.join('/')}`;
  return prefix.startsWith('//') ? head : prefix;
}
// Node errors carry a code; the Function Hooks host rejects a missing file with a message ending "failed: ENOENT".
export const notFound = (error) => ['ENOENT', 'ENOTDIR'].includes(error?.code) || /(?:^|\bfailed: )(?:ENOENT|ENOTDIR)\b/.test(error?.message ?? '');
export const parentOf = (path) => {
  const p = normal(path);
  if (/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+)$/.test(p)) return p;
  const parent = p.slice(0, p.lastIndexOf('/')) || '/';
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
};

// Every directory from the filesystem root down to `path` itself, root first; a relative path has none.
export function ancestorsOf(path) {
  if (!rawAbsolute(path)) return [];
  let dir = normal(joinSlash('/', path));
  const chain = [dir];
  for (let parent = parentOf(dir); parent !== dir; dir = parent, parent = parentOf(dir)) chain.unshift(parent);
  return chain;
}

// Drive and UNC paths compare case-insensitively, as their filesystems usually do; POSIX paths compare exactly.
const windowsShaped = (path) => /^(?:[A-Za-z]:\/|\/\/)/.test(path);
export function sameDirectory(a, b) {
  const left = normal(a), right = normal(b);
  return windowsShaped(left) || windowsShaped(right) ? left.toLowerCase() === right.toLowerCase() : left === right;
}
const within = (path, root) => {
  const p = normal(path), r = normal(root);
  if (sameDirectory(p, r)) return true;
  const prefix = r.endsWith('/') ? r : `${r}/`;
  return windowsShaped(p) || windowsShaped(r) ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix);
};

// The directories whose `.claude/` hold project rules for a session rooted at `sessionRoot`, root first:
// every ancestor, minus the one whose `.claude` is the active config directory (its rules are user scope), and,
// for a working tree nested strictly inside its main repository, every ancestor inside that repository above
// the working tree.
export function projectRuleRoots(sessionRoot, { configDir = null, mainRepoRoot = null, worktreeRoot = null } = {}) {
  const nested = mainRepoRoot && worktreeRoot && within(worktreeRoot, mainRepoRoot) && !sameDirectory(worktreeRoot, mainRepoRoot);
  return ancestorsOf(sessionRoot).filter((dir) => {
    if (configDir && sameDirectory(`${dir === '/' ? '' : dir.replace(/\/$/, '')}/.claude`, configDir)) return false;
    if (nested && within(dir, mainRepoRoot) && !within(dir, worktreeRoot)) return false;
    return true;
  });
}

const failure = (error) => error?.code ?? /\b(E[A-Z]{2,})\b/.exec(String(error?.message ?? ''))?.[1] ?? String(error?.message ?? error).slice(0, 120);
// The linked worktree holding `sessionRoot`, read from git's own files: the nearest `.git` entry upward; a FILE whose
// `gitdir:` directory holds a `commondir` resolving to a directory named `.git` is a linked worktree, and that `.git`'s
// parent is the main checkout. A `.git` directory, a gitdir without `commondir` (a submodule), a common directory not
// named `.git` (a bare store), or no `.git` at all: null. Any other failure: { unknown: reason }, never a guess.
// A plan: it yields { op: 'stat' | 'read', path } requests and receives { value } or { error }; the caller does the I/O.
export function* worktreePlan(sessionRoot) {
  for (const dir of ancestorsOf(sessionRoot).reverse()) {
    const dotGit = joinSlash(dir, '.git');
    const entry = yield { op: 'stat', path: dotGit, options: { resolve: true } };
    if (entry.error) {
      if (notFound(entry.error)) continue;
      return { unknown: `stat ${dotGit} failed: ${failure(entry.error)}` };
    }
    if (entry.value?.kind === 'dir') return null;
    if (entry.value?.kind !== 'file') return { unknown: `${dotGit} is neither a file nor a directory` };
    const text = yield { op: 'read', path: dotGit };
    if (text.error) return { unknown: `read ${dotGit} failed: ${failure(text.error)}` };
    const target = /^gitdir:[ \t]*(\S.*?)\s*$/m.exec(String(text.value))?.[1];
    if (!target) return { unknown: `malformed ${dotGit}` };
    const gitdir = joinSlash(dir, target);
    const commondirFile = joinSlash(gitdir, 'commondir');
    const common = yield { op: 'read', path: commondirFile };
    if (common.error) {
      if (!notFound(common.error)) return { unknown: `read ${commondirFile} failed: ${failure(common.error)}` };
      const holder = yield { op: 'stat', path: gitdir };
      if (holder.error) return { unknown: notFound(holder.error) ? `gitdir ${gitdir} named by ${dotGit} is missing` : `stat ${gitdir} failed: ${failure(holder.error)}` };
      return null;
    }
    const relative = String(common.value).trim();
    if (!relative) return { unknown: `malformed ${commondirFile}` };
    const commonDir = joinSlash(gitdir, relative);
    if (commonDir.split('/').at(-1) !== '.git') return null;
    const check = yield { op: 'stat', path: commonDir };
    if (check.error || check.value?.kind !== 'dir') return { unknown: `common directory ${commonDir} named by ${commondirFile} is ${check.error ? `unreadable: ${failure(check.error)}` : 'not a directory'}` };
    return { worktreeRoot: normal(dir), mainRepoRoot: parentOf(commonDir) };
  }
  return null;
}
