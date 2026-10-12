// One delivery selection for commits, review indexes and prospective patches.
import path from 'node:path'
import { lifecycleDeliveryHost } from './host/lifecycle-delivery.mjs'
import { treeEntryDigests } from './gate-evidence.mjs'

export function literalGitEnvironment(env = process.env) {
  const result = { ...env }
  for (const name of ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']) delete result[name]
  result.GIT_LITERAL_PATHSPECS = '1'
  return result
}

export function pathIdentity(file) {
  try {
    const stat = lifecycleDeliveryHost.stat(file)
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

function listed(root, args, git, options = {}) {
  return git('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options, env: literalGitEnvironment(options.env) }).split('\0').filter(Boolean)
}

function excludedReason(current, original) {
  if (current === null) return 'deleted-by-run'
  return current !== original ? 'modified-by-run' : 'pre-existing'
}

function baselineVisibleAtStart(baseline) {
  return baseline.notIgnoredAtStart ?? new Set(baseline.keys())
}

function irrelevantIgnoredPath(candidates, visibleAtStart, name) {
  return !candidates.has(name) && !visibleAtStart.has(name)
}

export function inodeIdentity(identity) {
  return identity?.split(':').slice(0, 2).join(':')
}

function renamedBaselinePaths(root, baseline, candidates) {
  const owners = new Map([...baseline].map(([name, identity]) => [inodeIdentity(identity), name]))
  const exclusions = []
  for (const name of candidates) {
    if (baseline.has(name)) continue
    const identity = pathIdentity(path.join(root, name))
    if (identity === null) continue
    const original = owners.get(inodeIdentity(identity))
    if (original !== undefined) exclusions.push({ path: name, reason: `pre-existing-from ${JSON.stringify(original)}` })
  }
  return exclusions
}

export function selectDeliveryPaths(root, baseline = new Map(), git = lifecycleDeliveryHost.git) {
  const tracked = listed(root, ['ls-files', '--cached', '-z'], git)
  const untracked = listed(root, ['ls-files', '--others', '--exclude-standard', '-z'], git)
  let changed = []
  try { changed = listed(root, ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'], git) } catch (error) {
    if (!/bad revision|unknown revision|ambiguous argument/.test(String(error?.stderr))) throw error
  }
  const candidates = new Set([...tracked, ...changed, ...untracked])
  const visibleAtStart = baselineVisibleAtStart(baseline)
  const untrackedExcluded = []
  for (const [name, original] of baseline) {
    if (irrelevantIgnoredPath(candidates, visibleAtStart, name)) continue
    const current = pathIdentity(path.join(root, name))
    if (!candidates.has(name) && current === original) continue
    const reason = excludedReason(current, original)
    untrackedExcluded.push({ path: name, reason })
  }
  untrackedExcluded.push(...renamedBaselinePaths(root, baseline, candidates))
  const excluded = new Set([...baseline.keys(), ...untrackedExcluded.map((entry) => entry.path)])
  return {
    paths: [...candidates].filter((name) => !excluded.has(name)).sort(),
    untracked: untracked.filter((name) => !excluded.has(name)).sort(),
    untrackedExcluded,
  }
}

export function stageDeliverySelection(root, selection, git = lifecycleDeliveryHost.git, options = {}) {
  if (selection.paths.length === 0) return
  // Only selected paths can be force-added: baseline names and inodes have already been excluded.
  git('git', ['add', '-A', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    cwd: root, ...options, env: literalGitEnvironment(options.env),
    input: `${selection.paths.join('\0')}\0`,
  })
}

export function snapshotSelectedTree(root, index, baseline, git, maxBuffer = 64 * 1024 * 1024) {
  const selection = selectDeliveryPaths(root, baseline, git)
  const options = { cwd: root, encoding: 'utf8', maxBuffer, stdio: ['pipe', 'pipe', 'pipe'], env: { ...literalGitEnvironment(), GIT_INDEX_FILE: index } }
  try {
    lifecycleDeliveryHost.remove(index)
    git('git', ['read-tree', 'HEAD'], options)
    stageDeliverySelection(root, selection, git, options)
    const tree = git('git', ['write-tree'], options).trim()
    if (!tree) throw new Error('git write-tree returned an empty tree id')
    return tree
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || (error instanceof Error ? error.message : String(error))
    throw new Error(`review snapshot failed: ${detail}`, { cause: error })
  } finally {
    lifecycleDeliveryHost.remove(index)
    lifecycleDeliveryHost.remove(`${index}.lock`)
  }
}

export function hasSelectedChanges(root, baseline, git) {
  const entries = listed(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], git)
  const excluded = new Set([...baseline.keys(), ...selectDeliveryPaths(root, baseline, git).untrackedExcluded.map((entry) => entry.path)])
  return entries.some((entry) => entry[2] === ' ' && entry.slice(0, 2) !== '  ' && !excluded.has(entry.slice(3)))
}

export function acceptableReportStatus(root, baseline, git) {
  const entries = listed(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], git)
  const excluded = new Set([...baseline.keys(), ...selectDeliveryPaths(root, baseline, git).untrackedExcluded.map((entry) => entry.path)])
  return entries.every((entry) => entry.startsWith('?? ') && excluded.has(entry.slice(3)))
}

export function assertCleanPilotStart(root, git = lifecycleDeliveryHost.git) {
  const staged = listed(root, ['diff', '--cached', '--name-only', '-z', 'HEAD', '--'], git)
  const tracked = listed(root, ['diff', '--name-only', '-z', '--'], git)
  const paths = [...new Set([...staged, ...tracked])]
  if (paths.length === 0) return
  throw new Error(`SDK pilot preflight failed: staged or tracked modifications: ${paths.map((name) => JSON.stringify(name)).join(', ')}; commit them or move them aside, then relaunch`)
}

export function gatePathSnapshot(root) {
  return treeEntryDigests(root)
}

export function warnGatePathChanges(root, before, log) {
  const after = gatePathSnapshot(root)
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(name) === after.get(name)) continue
    lifecycleDeliveryHost.append(log, `\nWARNING gate changed path ${JSON.stringify(name)}\n`)
  }
}
