import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertArchiveOutsideWorktree, readWorktreeRetentionMarker } from './lifecycle-report-edge.mjs'
import { hardenedGitArgs } from './host/hardened-git.mjs'
import { readSuiteLock } from './suite-lock.mjs'

const STEP_NAMES = ['preflight', 'commit', 'merge', 'archive', 'pre-remove-check', 'remove', 'ci-branch', 'push', 'dispatch']
const COMMAND_ENV = process.env

export function parseIntegrateArgs(argv) {
  const options = { dir: null, into: null, message: null, mergeSubject: null, archiveRoot: null, preRemoveCheck: null, ciBranch: null, remote: 'public', authorizeFile: null, dispatch: null, wait: false, dryRun: false, keepWorktree: false, force: false }
  const values = new Map([
    ['--dir', 'dir'], ['--into', 'into'], ['--message', 'message'], ['--merge-subject', 'mergeSubject'], ['--archive-root', 'archiveRoot'],
    ['--ci-branch', 'ciBranch'], ['--remote', 'remote'], ['--authorize-file', 'authorizeFile'], ['--dispatch', 'dispatch'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (values.has(argument)) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) return { error: `${argument} requires a value` }
      options[values.get(argument)] = value
    } else if (argument === '--pre-remove-check') {
      const command = []
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) command.push(argv[++index])
      if (command.length === 0) return { error: '--pre-remove-check requires a command' }
      options.preRemoveCheck = command
    } else if (argument === '--wait') options.wait = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--keep-worktree') options.keepWorktree = true
    else if (argument === '--force') options.force = true
    else if (argument === '--help' || argument === '-h') return { help: true }
    else return { error: `unknown integrate argument: ${argument}` }
  }
  if (!options.dir || !options.into || !options.message) return { error: 'integrate requires --dir, --into, and --message' }
  if (options.dispatch && !options.ciBranch) return { error: '--dispatch requires --ci-branch' }
  if (options.wait && !options.dispatch) return { error: '--wait requires --dispatch' }
  for (const key of ['dir', 'into', 'message', 'archiveRoot', 'authorizeFile']) if (options[key]) options[key] = path.resolve(options[key])
  return options
}

function defaultRunner(program, args, options = {}) {
  return spawnSync(program, args, { encoding: 'utf8', env: COMMAND_ENV, ...options })
}

function resultCode(result) {
  return Number.isInteger(result?.status) ? result.status : 1
}

function commandFailure(program, args, result) {
  const detail = String(result?.stderr || result?.error?.message || result?.stdout || '').trim()
  const suffix = detail ? `: ${detail}` : ''
  return `${program} ${args.join(' ')} failed${suffix}`
}

function run(runner, program, args, options = {}) {
  const result = runner(program, args, { encoding: 'utf8', env: COMMAND_ENV, ...options })
  if (resultCode(result) !== 0) throw new Error(commandFailure(program, args, result))
  return String(result.stdout ?? '')
}

function git(runner, cwd, args) {
  // Every git call here runs against a lane or integration worktree, so it is hardened (H1).
  return run(runner, 'git', hardenedGitArgs(['-C', cwd, ...args]))
}

function canonical(value) {
  return (fs.realpathSync.native ?? fs.realpathSync)(path.resolve(value))
}

function sameWorktreePath(left, right, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path
  const normalizedLeft = pathApi.normalize(left)
  const normalizedRight = pathApi.normalize(right)
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function commonGitDir(runner, worktree) {
  const value = git(runner, worktree, ['rev-parse', '--git-common-dir']).trim()
  return canonical(path.resolve(worktree, value))
}

function assertRegisteredWorktree(runner, worktree) {
  if (git(runner, worktree, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') throw new Error(`not a git worktree: ${worktree}`)
  const listed = git(runner, worktree, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))
  if (!listed.some((candidate) => {
    try { return sameWorktreePath(canonical(candidate), worktree) } catch { return false }
  })) throw new Error(`not a registered git worktree: ${worktree}`)
}

function verificationSection(report) {
  const lines = report.split(/\r?\n/)
  const heading = lines.findIndex((line) => /^## Verification\s*$/i.test(line))
  if (heading < 0) return ''
  const nextHeading = lines.findIndex((line, index) => index > heading && /^##\s/.test(line))
  return lines.slice(heading + 1, nextHeading < 0 ? undefined : nextHeading).join('\n').trim()
}

function preflight(options, runner) {
  if (!options.message || !fs.existsSync(options.message) || !fs.statSync(options.message).isFile()) throw new Error(`commit message file is missing: ${options.message ?? '(not provided)'}`)
  const message = fs.readFileSync(options.message, 'utf8')
  if (!message.trim()) throw new Error(`commit message file is empty: ${options.message}`)
  const commitSubject = message.split(/\r?\n/, 1)[0].trim()
  if (!commitSubject) throw new Error(`commit message first line is empty: ${options.message}`)
  options.dir = canonical(options.dir)
  options.into = canonical(options.into)
  assertRegisteredWorktree(runner, options.dir)
  assertRegisteredWorktree(runner, options.into)
  if (!sameWorktreePath(commonGitDir(runner, options.dir), commonGitDir(runner, options.into))) throw new Error('--dir and --into must be worktrees of the same repository')
  const integrationStatus = git(runner, options.into, ['status', '--porcelain']).trim()
  if (integrationStatus) throw new Error(`integration worktree is dirty: ${integrationStatus.split(/\r?\n/).join(', ')}`)
  const reportPath = path.join(options.dir, '.lane', 'report.md')
  if (!fs.existsSync(reportPath) || !fs.statSync(reportPath).isFile() || !fs.readFileSync(reportPath, 'utf8').trim()) throw new Error(`lane report is missing or empty: ${reportPath}`)
  const report = fs.readFileSync(reportPath, 'utf8')
  const verification = verificationSection(report)
  if (!verification) throw new Error(`lane report has no non-empty ## Verification section: ${reportPath}`)
  const marker = readWorktreeRetentionMarker(options.dir)
  if (marker) throw new Error(`worktree removal refused by retention marker for card ${marker.cardId}; use the sanctioned command wt-worktree-remove.mjs`)
  const status = git(runner, options.dir, ['status', '--porcelain']).split(/\r?\n/)
    .filter((line) => line && !line.slice(3).split(' -> ').some((name) => name === '.lane' || name.startsWith(`.lane${path.sep}`) || name.startsWith('.lane/')))
    .join('\n')
  const ahead = Number(git(runner, options.dir, ['rev-list', '--count', `${git(runner, options.into, ['rev-parse', 'HEAD']).trim()}..HEAD`]).trim())
  const saysChanges = /\b(no commit|uncommitted|dirty|changes? (?:remain|made|present))\b/i.test(verification)
  const saysClean = /\b(clean (?:tree|worktree|working tree)|working tree clean|git status[^\n]*clean)\b/i.test(verification)
  if (saysChanges && !status && ahead === 0) throw new Error('report claims changes/no commit, but the lane is clean and not ahead')
  if (saysClean && status) throw new Error('report claims a clean tree, but git status reports changes')
  options.reportPath = reportPath
  options.messageText = message
  options.commitSubject = commitSubject
  options.mergeSubject = options.mergeSubject ?? `merge: ${commitSubject}`
  options.laneBranch = git(runner, options.dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim()
  options.laneTip = git(runner, options.dir, ['rev-parse', 'HEAD']).trim()
  options.integrationHead = git(runner, options.into, ['rev-parse', 'HEAD']).trim()
  options.hasChanges = Boolean(status)
  options.ahead = ahead
  options.repoRoot = canonical(git(runner, options.into, ['rev-parse', '--show-toplevel']).trim())
  options.gitDir = commonGitDir(runner, options.into)
  options.archiveRoot = path.resolve(options.archiveRoot ?? path.join(options.repoRoot, '.claude', 'reports'))
  options.archiveDestination = path.join(options.archiveRoot, path.basename(options.dir), 'lane')
  assertArchiveOutsideWorktree({ root: options.dir, archiveRoot: options.archiveRoot, target: options.archiveDestination })
  options.authorizeFile = path.resolve(options.authorizeFile ?? path.join(options.gitDir, 'wt-push-authorized.json'))
}

function resolveConflictMarkers(content) {
  const lines = content.split(/(?<=\n)/)
  const output = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('<<<<<<< ')) { output.push(lines[index]); continue }
    index += 1
    const ours = []
    while (index < lines.length && !lines[index].startsWith('||||||| ') && !lines[index].startsWith('=======')) ours.push(lines[index++])
    if (lines[index]?.startsWith('||||||| ')) while (index < lines.length && !lines[index].startsWith('=======')) index += 1
    if (!lines[index]?.startsWith('=======')) throw new Error('malformed CHANGELOG conflict markers')
    index += 1
    const theirs = []
    while (index < lines.length && !lines[index].startsWith('>>>>>>> ')) theirs.push(lines[index++])
    if (!lines[index]?.startsWith('>>>>>>> ')) throw new Error('malformed CHANGELOG conflict markers')
    output.push(...ours, ...theirs)
  }
  return output.join('')
}

function mergeLane(options, runner) {
  const args = hardenedGitArgs(['-C', options.into, 'merge', '--no-ff', '-m', options.mergeSubject, options.laneBranch])
  const result = runner('git', args, { encoding: 'utf8', env: COMMAND_ENV })
  if (resultCode(result) === 0) return
  const conflicts = git(runner, options.into, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean)
  if (conflicts.length === 1 && conflicts[0].split(path.sep).join('/') === 'plugin/CHANGELOG.md') {
    try {
      const changelog = path.join(options.into, ...conflicts[0].split('/'))
      fs.writeFileSync(changelog, resolveConflictMarkers(fs.readFileSync(changelog, 'utf8')))
      git(runner, options.into, ['add', '--', conflicts[0]])
      git(runner, options.into, ['commit', '--no-edit'])
      return
    } catch (error) {
      try { git(runner, options.into, ['merge', '--abort']) } catch { /* retain the resolution failure */ }
      throw error
    }
  }
  try { git(runner, options.into, ['merge', '--abort']) } catch { /* preserve the original conflict refusal */ }
  throw new Error(`merge conflicts outside plugin/CHANGELOG.md: ${conflicts.length ? conflicts.join(', ') : commandFailure('git', args, result)}`)
}

function commitLane(options, runner) {
  if (!options.hasChanges && options.ahead > 0) return
  git(runner, options.dir, ['add', '-A'])
  git(runner, options.dir, ['reset', '--', '.lane'])
  git(runner, options.dir, ['commit', '-F', options.message])
}

function heldDuration(lock) {
  const startedAt = Date.parse(lock.holder?.startedAt)
  const milliseconds = Number.isFinite(startedAt) ? Date.now() - startedAt : lock.ageMs
  if (!Number.isFinite(milliseconds)) return 'unknown duration'
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

function assertIntegrationTreeNotGated(options) {
  if (options.force) return
  const lock = (options.readSuiteLock ?? readSuiteLock)()
  if (!lock.held) return
  const pid = Number.isSafeInteger(lock.holder?.pid) ? lock.holder.pid : 'unknown'
  let holderCwd
  try {
    if (typeof lock.holder?.cwd !== 'string' || !lock.holder.cwd) throw new Error('missing cwd')
    holderCwd = canonical(lock.holder.cwd)
  } catch {
    throw new Error(`suite lock holder pid ${pid} has held for ${heldDuration(lock)}, but its cwd is unreadable; refusing to merge while the target tree may be gated (pass --force to override)`)
  }
  const relative = path.relative(options.into, holderCwd)
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error(`suite lock holder pid ${pid} has held for ${heldDuration(lock)} from ${holderCwd}, inside integration tree ${options.into}; refusing to merge while it is being gated (pass --force to override)`)
  }
}

function authorizationCommitCount(options, runner) {
  const remoteBranch = `${options.remote}/${options.ciBranch}`
  const exists = runner('git', hardenedGitArgs(['-C', options.into, 'rev-parse', '--verify', '--quiet', remoteBranch]), { encoding: 'utf8', env: COMMAND_ENV })
  const base = resultCode(exists) === 0 ? remoteBranch : `${options.remote}/main`
  const existing = Number(git(runner, options.into, ['rev-list', '--count', options.integrationHead, options.laneTip, `^${base}`]).trim())
  return existing + (options.hasChanges ? 1 : 0) + 1
}

function renderDryRunPlan(options, runner, stdout, enabledSteps) {
  const plans = [
    `lane branch=${options.laneBranch} tip=${options.laneTip}; integration tree=${options.into} HEAD=${options.integrationHead}`,
    `commit subject=${options.commitSubject}`,
    `merge subject=${options.mergeSubject}`,
    `archive destination=${options.archiveDestination}`,
    `command=${options.preRemoveCheck?.join(' ') ?? '(none)'}`,
    `remove worktree=${options.keepWorktree ? 'no' : 'yes'}`,
  ]
  if (options.ciBranch) {
    plans.push(`branch=${options.ciBranch} remote=${options.remote} authorization file=${options.authorizeFile} commits=${authorizationCommitCount(options, runner)}`)
    plans.push(`remote=${options.remote} branch=${options.ciBranch}`)
    if (options.dispatch) plans.push(`workflow=${options.dispatch} wait=${options.wait ? 'yes' : 'no'}`)
  }
  for (let index = 0; index < enabledSteps.length; index += 1) stdout(`step ${index + 1} ${enabledSteps[index]}: ${plans[index]} (dry-run)`)
}

function entries(root, relative = '') {
  const directory = path.join(root, relative)
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name)
    return entry.isDirectory() ? entries(root, child) : [child]
  }).sort()
}

function fileDigest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function verifyArchive(source, destination) {
  const sourceEntries = entries(source)
  const destinationEntries = entries(destination)
  const missing = sourceEntries.filter((relative) => !destinationEntries.includes(relative))
  const unexpected = destinationEntries.filter((relative) => !sourceEntries.includes(relative))
  if (missing.length || unexpected.length) {
    const differences = [...missing.map((relative) => `missing ${relative}`), ...unexpected.map((relative) => `unexpected ${relative}`)]
    throw new Error(`archive verification failed: ${differences.join(', ')}`)
  }
  for (const relative of sourceEntries) {
    const from = path.join(source, relative); const to = path.join(destination, relative)
    if (!fs.existsSync(to)) throw new Error(`archive verification failed: missing ${relative}`)
    const sourceStat = fs.lstatSync(from); const destinationStat = fs.lstatSync(to)
    if (sourceStat.isSymbolicLink()) {
      if (!destinationStat.isSymbolicLink() || fs.readlinkSync(from) !== fs.readlinkSync(to)) throw new Error(`archive verification failed: symlink differs for ${relative}`)
    } else if (!sourceStat.isFile() || !destinationStat.isFile() || fileDigest(from) !== fileDigest(to)) throw new Error(`archive verification failed: bytes differ for ${relative}`)
  }
  return sourceEntries.length
}

function archiveLane(options, copy) {
  if (fs.existsSync(options.archiveDestination)) throw new Error(`archive destination already exists: ${options.archiveDestination}`)
  fs.mkdirSync(path.dirname(options.archiveDestination), { recursive: true })
  copy(options.reportPath ? path.dirname(options.reportPath) : path.join(options.dir, '.lane'), options.archiveDestination)
  verifyArchive(path.join(options.dir, '.lane'), options.archiveDestination)
}

function removeLane(options, runner) {
  const marker = readWorktreeRetentionMarker(options.dir)
  if (marker) throw new Error(`worktree removal refused by retention marker for card ${marker.cardId}; use the sanctioned command wt-worktree-remove.mjs`)
  if (options.keepWorktree) return
  verifyArchive(path.join(options.dir, '.lane'), options.archiveDestination)
  git(runner, options.into, ['worktree', 'remove', options.dir])
  const contained = runner('git', hardenedGitArgs(['-C', options.into, 'merge-base', '--is-ancestor', options.laneBranch, 'HEAD']), { encoding: 'utf8', env: COMMAND_ENV })
  if (resultCode(contained) === 0) git(runner, options.into, ['branch', '-d', options.laneBranch])
}

function setupCiBranch(options, runner, stdout) {
  git(runner, options.into, ['branch', '-f', options.ciBranch, 'HEAD'])
  const remoteBranch = `${options.remote}/${options.ciBranch}`
  const exists = runner('git', hardenedGitArgs(['-C', options.into, 'rev-parse', '--verify', '--quiet', remoteBranch]), { encoding: 'utf8', env: COMMAND_ENV })
  const base = resultCode(exists) === 0 ? remoteBranch : `${options.remote}/main`
  const commits = git(runner, options.into, ['rev-list', `${base}..${options.ciBranch}`]).split(/\r?\n/).filter(Boolean)
  fs.mkdirSync(path.dirname(options.authorizeFile), { recursive: true })
  fs.writeFileSync(options.authorizeFile, `${JSON.stringify({ commits })}\n`, { mode: 0o600 })
  stdout(`authorization commits=${commits.length}`)
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function jsonResult(result, description) {
  const failure = String(result?.stderr ?? '').trim() || `EXIT=${resultCode(result)}`
  if (resultCode(result) !== 0) throw new Error(`${description}: ${failure}`)
  try { return JSON.parse(String(result.stdout ?? '')) } catch { throw new Error(`${description}: invalid JSON`) }
}

function listRuns(options, runner) {
  const args = ['run', 'list', '--workflow', options.dispatch, '--branch', options.ciBranch, '--limit', '20', '--json', 'databaseId,status,conclusion,event,createdAt']
  const runs = jsonResult(runner('gh', args, { encoding: 'utf8', env: COMMAND_ENV, cwd: options.into }), 'gh run list failed')
  return Array.isArray(runs) ? runs : []
}

function viewRun(options, runner, runId) {
  return jsonResult(runner('gh', ['run', 'view', String(runId), '--json', 'databaseId,status,conclusion'], { encoding: 'utf8', env: COMMAND_ENV, cwd: options.into }), 'gh run view failed')
}

function artifactNames(runId, runner, cwd) {
  const repository = runner('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8', env: COMMAND_ENV, cwd })
  if (resultCode(repository) !== 0 || !String(repository.stdout).trim()) return []
  const result = runner('gh', ['api', `repos/${String(repository.stdout).trim()}/actions/runs/${runId}/artifacts`, '--jq', '.artifacts[].name'], { encoding: 'utf8', env: COMMAND_ENV, cwd })
  if (resultCode(result) !== 0) return []
  return String(result.stdout).split(/\r?\n/).filter((name) => /diagnostics/i.test(name))
}

function readCiRunEvidence({ runId, runner = defaultRunner, stdout = (line) => process.stdout.write(`${line}\n`), artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-lane-ci-')), cwd = process.cwd() }) {
  const jobs = runner('gh', ['run', 'view', String(runId), '--json', 'jobs'], { encoding: 'utf8', env: COMMAND_ENV, cwd })
  const parsed = jsonResult(jobs, 'gh run view jobs failed')
  for (const job of parsed.jobs ?? []) stdout(`job ${job.name}: ${job.conclusion ?? 'unknown'}`)
  let artifactRead = false
  for (const name of artifactNames(runId, runner, cwd)) {
    fs.mkdirSync(artifactDir, { recursive: true })
    const downloaded = runner('gh', ['run', 'download', String(runId), '-n', name, '-D', artifactDir], { encoding: 'utf8', env: COMMAND_ENV, cwd })
    if (resultCode(downloaded) !== 0) continue
    artifactRead = true
    stdout(`diagnostics artifact: ${name}`)
    for (const relative of entries(artifactDir)) {
      const file = path.join(artifactDir, relative)
      if (fs.lstatSync(file).isFile()) stdout(fs.readFileSync(file, 'utf8'))
    }
  }
  if (artifactRead) return 0
  const logs = runner('gh', ['run', 'view', String(runId), '--log'], { encoding: 'utf8', env: COMMAND_ENV, cwd })
  if (resultCode(logs) !== 0) throw new Error(commandFailure('gh', ['run', 'view', String(runId), '--log'], logs))
  const text = String(logs.stdout ?? '')
  stdout(text ? `log: ${Buffer.byteLength(text)} bytes\n${text}` : 'log: 0 bytes (fallback empty — not evidence of no failures)')
  return 0
}

function dispatchWorkflow(options, runner, stdout, wait) {
  const existing = new Set(listRuns(options, runner).map((run) => run.databaseId))
  run(runner, 'gh', ['workflow', 'run', options.dispatch, '--ref', options.ciBranch], { cwd: options.into })
  let current = null
  for (let attempt = 0; attempt < 60 && !current; attempt += 1) {
    const candidates = listRuns(options, runner).filter((candidate) => !existing.has(candidate.databaseId) && candidate.event === 'workflow_dispatch')
    if (candidates.length > 1) throw new Error(`could not identify the dispatched workflow run: multiple new runs appeared (${candidates.map((candidate) => candidate.databaseId).join(', ')})`)
    current = candidates[0] ?? null
    if (!current) wait(1_000)
  }
  if (!current?.databaseId) throw new Error('could not identify the dispatched workflow run: no new workflow_dispatch run appeared')
  const urlResult = runner('gh', ['run', 'view', String(current.databaseId), '--json', 'url', '--jq', '.url'], { encoding: 'utf8', env: COMMAND_ENV, cwd: options.into })
  const url = resultCode(urlResult) === 0 ? String(urlResult.stdout).trim() : '(URL unavailable)'
  stdout(`run id=${current.databaseId} url=${url}`)
  if (!options.wait) return
  for (let attempt = 0; attempt < 360 && current.status !== 'completed'; attempt += 1) { wait(10_000); current = viewRun(options, runner, current.databaseId) }
  if (current.status !== 'completed') throw new Error(`workflow run ${current.databaseId} did not complete within the polling bound`)
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-lane-ci-'))
  try { readCiRunEvidence({ runId: current.databaseId, runner, stdout, artifactDir: temporary, cwd: options.into }) } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  if (current.conclusion !== 'success') throw new Error(`workflow run ${current.databaseId} concluded ${current.conclusion ?? 'unknown'}`)
}

export async function integrateLane(input) {
  const options = { remote: 'public', wait: false, dryRun: false, keepWorktree: false, force: false, ...input }
  const runner = options.runner ?? defaultRunner
  const copy = options.copy ?? ((source, destination) => fs.cpSync(source, destination, { recursive: true, dereference: false, errorOnExist: true, force: false, preserveTimestamps: true }))
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`))
  const stderr = options.stderr ?? ((line) => process.stderr.write(`wt-lane integrate: ${line}\n`))
  const wait = options.sleep ?? sleep
  let stepCount = 6
  if (options.ciBranch) stepCount = options.dispatch ? 9 : 8
  const enabledSteps = STEP_NAMES.slice(0, stepCount)
  if (options.dryRun) {
    try {
      preflight(options, runner)
      renderDryRunPlan(options, runner, stdout, enabledSteps)
      return 0
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error))
      stdout('step 1 preflight: EXIT=1 (dry-run)')
      return 1
    }
  }
  const actions = [
    () => preflight(options, runner),
    () => commitLane(options, runner),
    () => { assertIntegrationTreeNotGated(options); mergeLane(options, runner) },
    () => archiveLane(options, copy),
    () => { if (options.preRemoveCheck) run(runner, options.preRemoveCheck[0], [...options.preRemoveCheck.slice(1), options.dir], { cwd: options.into }) },
    () => removeLane(options, runner),
    () => setupCiBranch(options, runner, stdout),
    () => { git(runner, options.into, ['push', options.remote, options.ciBranch]) },
    () => { if (options.dispatch) dispatchWorkflow(options, runner, stdout, wait) },
  ]
  for (let index = 0; index < enabledSteps.length; index += 1) {
    try {
      await actions[index]()
      stdout(`step ${index + 1} ${enabledSteps[index]}: EXIT=0`)
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error))
      stdout(`step ${index + 1} ${enabledSteps[index]}: EXIT=1`)
      return 1
    }
  }
  return 0
}
