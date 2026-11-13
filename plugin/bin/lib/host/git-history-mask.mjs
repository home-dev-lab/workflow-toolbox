import { spawnSync } from 'node:child_process'
import { posix as path } from 'node:path'

const BIND_FLAGS = new Set(['--bind', '--bind-try', '--ro-bind', '--ro-bind-try'])
const within = (child, parent) => child === parent || child.startsWith(`${parent}/`)

// Ask Git, rather than interpreting .git/commondir ourselves. Ambient GIT_DIR and global config
// must not redirect discovery away from the tree the reviewer was actually given.
export function gitHistoryPaths(directory, fs, git) {
  if (!directory) return []
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  const result = spawnSync(git, ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 })
  if (gitDiscoveryFailed(result, directory, fs)) return []
  const directories = result.stdout.replace(/\n$/, '').split('\n')
  if (directories.length !== 2 || directories.some((item) => !path.isAbsolute(item) || !fs.isDir(item))) throw new Error('cannot resolve repository git history: git returned invalid directories')
  const pointer = path.join(directory, '.git')
  const paths = [...directories, ...(fs.exists(pointer) ? [pointer] : [])]
  return [...new Set(paths.flatMap((item) => [item, fs.realpath(item) ?? item]))]
}

function gitDiscoveryFailed(result, directory, fs) {
  if (result.error || result.signal) throw new Error(`cannot resolve repository git history: ${result.error?.message ?? result.signal}`)
  if (result.status === 0) return false
  if (result.status === 128 && /fatal: not a git repository/.test(result.stderr) && !fs.exists(path.join(directory, '.git'))) return true
  const reason = result.stderr.trim() || `git exited ${result.status}`
  throw new Error(`cannot resolve repository git history: ${reason}`)
}

function historyDestinations(prefix, withheld, fs) {
  const targets = new Map(withheld.map((item) => [item, fs.isDir(item)]))
  for (const [index, flag] of prefix.entries()) {
    if (!BIND_FLAGS.has(flag)) continue
    const source = fs.realpath(prefix[index + 1]) ?? prefix[index + 1]
    const destination = prefix[index + 2]
    for (const hidden of withheld) {
      const target = fs.realpath(hidden) ?? hidden
      if (within(target, source)) targets.set(path.join(destination, path.relative(source, target)), fs.isDir(target))
      else if (within(source, target)) targets.set(destination, fs.isDir(source))
    }
  }
  return [...targets].filter(([item]) => ![...targets].some(([parent, directory]) => directory && parent !== item && within(item, parent)))
}

// Applied after EVERY bind, including toolchains, caller extras and remapped overlays: a later
// bind or an alternate source spelling must not reopen the object store. Read-only empty mounts
// keep even a writable outer bind from replacing the mask from inside the sandbox.
export function gitHistoryMasks(prefix, withheld, fs) {
  if (!withheld.length) return []
  return historyDestinations(prefix, withheld, fs).flatMap(([target, directory]) => directory
    ? ['--tmpfs', target, '--remount-ro', target]
    : ['--ro-bind', '/dev/null', target])
}
