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
export const parentOf = (path) => {
  const p = normal(path);
  if (/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+)$/.test(p)) return p;
  const parent = p.slice(0, p.lastIndexOf('/')) || '/';
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
};

// Every directory from the filesystem root down to `path` itself, root first; a relative path has none.
export function ancestorsOf(path) {
  if (typeof path !== 'string' || !path) return [];
  let dir = normal(path);
  if (!absolute(dir)) return [];
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
