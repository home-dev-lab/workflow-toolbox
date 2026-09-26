// A lane worktree's `.git`, `config.worktree` and hooks are writable by the lane. A host-side git
// command run against that worktree would EXECUTE `core.fsmonitor` and the `core.hooksPath` hooks
// the lane planted (H1). These two flags, passed before the subcommand, neutralise both without
// touching the repository. Every host git call on a lane worktree prepends them.
export const HARDENED_GIT_CONFIG = Object.freeze(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'])

export function hardenedGitArgs(args) {
  return [...HARDENED_GIT_CONFIG, ...args]
}
