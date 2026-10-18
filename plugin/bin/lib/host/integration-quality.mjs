import { accessSync, constants, existsSync, readFileSync, mkdtempSync, rmSync, lstatSync, readdirSync, symlinkSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { hardenedGitArgs } from './hardened-git.mjs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { spawnNeedsShell } from '../suite-lock.mjs'
import { resolvedBinary } from '../resolved-binary.mjs'

const certificationControlFile = (file) => /(^|\/)(package\.json|\.npmrc|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock)$/iu.test(file)

// Resolve the required entry on the target BEFORE the candidate can change it.
function integrationQualityDirectory(root) {
  for (const directory of [path.join(root, 'toolkit'), root]) {
    const manifest = path.join(directory, 'package.json')
    if (!existsSync(manifest)) continue
    const { scripts } = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof scripts?.quality === 'string' && scripts.quality.trim()) return directory
  }
  throw new Error('integration quality missing: add scripts.quality to the target package.json before integrating')
}
export function prepareCertification(root, runner, base) {
  const directory = integrationQualityDirectory(root)
  const temp = mkdtempSync(path.join(tmpdir(), 'wt-certification-'))
  const checkout = path.join(temp, 'target')
  const certification = { root, temp, checkout, directory: path.join(checkout, path.relative(root, directory)), nonce: randomUUID() }
  try {
    certificationGit(root, runner, ['worktree', 'add', '--detach', checkout, base])
    certification.registered = true
    linkInstalledDependencies(root, checkout)
    integrationQualityDirectory(checkout)
    return certification
  } catch (error) { cleanupCertification({ certification }); throw error }
}
function certificationGit(root, runner, args) {
  const result = runner('git', hardenedGitArgs(['-C', root, ...args]),
    { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 28, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } })
  if (result.status !== 0 || result.error) throw new Error(`certification git failed: ${result.stderr ?? result.error}`)
  return String(result.stdout ?? '')
}
function linkInstalledDependencies(source, destination) {
  for (const entry of readdirSync(destination, { withFileTypes: true })) {
    if (entry.isDirectory()) linkInstalledDependencies(path.join(source, entry.name), path.join(destination, entry.name))
  }
  if (!existsSync(source)) return
  for (const entry of readdirSync(source)) {
    if (!/^node_modules$/iu.test(entry)) continue
    const installed = path.join(source, entry), target = path.join(destination, entry)
    if (existsSync(target)) throw new Error('certification refuses tracked node_modules; remove installed dependencies from git')
    symlinkSync(realpathSync(installed), target, 'junction')
  }
}
const inputLinkKey = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
function certificationLinks(root, runner) {
  const links = new Map()
  const entries = certificationGit(root, runner, ['ls-files', '--stage', '-z']).split('\0')
  for (const entry of entries) {
    if (!entry.startsWith('120000 ')) continue
    const file = entry.slice(entry.indexOf('\t') + 1)
    links.set(inputLinkKey(path.join(root, file)), entry.split(' ', 2)[1])
  }
  return links
}
function resolveInputLink(root, file, links, runner) {
  const seen = new Set()
  let current = file
  for (;;) {
    const actual = links.has(inputLinkKey(current)) ? current : realpathSync(current)
    const key = inputLinkKey(actual), blob = links.get(key)
    if (!blob) return actual
    if (seen.has(key)) return null
    seen.add(key)
    const target = certificationGit(root, runner, ['cat-file', 'blob', blob])
    current = path.resolve(path.dirname(actual), target)
  }
}
function assertCertificationInputs(root, changed, runner) {
  const links = certificationLinks(root, runner)
  for (const file of changed.filter(Boolean)) {
    if (/(^|\/)node_modules(\/|$)/iu.test(file)) throw new Error('certification refuses installed dependency changes: remove tracked node_modules changes and install target dependencies before integrating')
    const codeOrConfig = /\.(mjs|cjs|jsx?|tsx?|mts|cts)$/iu.test(file) || certificationControlFile(file)
    const link = links.has(inputLinkKey(path.join(root, file))) || lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isSymbolicLink()
    if (link && (codeOrConfig || extensionlessNodeLink(root, file, links, runner))) throw new Error(`certification refuses candidate symlink ${file}: replace it with a regular file before integrating`)
  }
}
function extensionlessNodeLink(root, file, links, runner) {
  if (path.extname(file)) return false
  try {
    const target = resolveInputLink(root, path.join(root, file), links, runner)
    return target !== null && lstatSync(target).isFile() && /^#![^\r\n]*(?:\/|\s)node(?:\s|$)/.test(readFileSync(target, 'utf8').split(/\r?\n/, 1)[0])
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
export function certifyIntegration(options, runner, base) {
  const certification = options.certification
  const changed = certificationGit(options.into, runner, ['diff', '--name-only', '-z', base, '--']).split('\0')
  assertCertificationInputs(options.into, changed, runner)
  const result = runner('pnpm', ['run', 'quality'], { cwd: certification.directory,
    encoding: 'utf8', maxBuffer: 1 << 28, shell: spawnNeedsShell('pnpm'),
      env: { ...process.env, WT_QUALITY_CHANGED: undefined, WT_QUALITY_BASE: base,
        WT_CERTIFICATION_INPUT_ROOT: options.into, WT_CERTIFICATION_NONCE: certification.nonce,
        NODE_OPTIONS: undefined, pnpm_config_verify_deps_before_run: 'false' } })
  const detail = String(result.stdout ?? '') + String(result.stderr ?? result.error?.message ?? '')
  if (result.status === 0 && !result.error) {
    if (!String(result.stdout).split(/\r?\n/).includes(`WT_OWNER_CHECKED=${certification.nonce}`)) throw new Error('target owner-checker execution proof missing; add quality:changed to scripts.quality and rerun wt-lane integrate')
    return
  }
  const retry = ['--dir', options.dir, '--into', options.into, '--message', options.message].map((value) => JSON.stringify(value)).join(' ')
  throw new Error(`integration quality refused; fix the reported inputs and rerun wt-lane integrate ${retry}\n${detail}`)
}
export function cleanupCertification(options) {
  if (!options.certification) return
  const { root, checkout, temp, registered } = options.certification
  // Remove dependency junctions before Git, including on Windows where open handles
  // can delay directory removal. Never recurse into installed dependencies.
  unlinkDependencies(checkout)
  if (registered) removeCheckout(root, checkout)
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
function removeCheckout(root, checkout) {
  const git = certificationGitExecutable()
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync(git, hardenedGitArgs(['-C', root, 'worktree', 'remove', '--force', checkout]), { encoding: 'utf8', stdio: 'pipe', timeout: 120000 })
      return
    } catch (error) {
      if (attempt === 4) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}
function unlinkDependencies(directory) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (/^node_modules$/iu.test(entry.name)) rmSync(file, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 })
    else if (entry.isDirectory()) unlinkDependencies(file)
  }
}
export function certifiedIndexDifference(options) {
  const index = path.join(options.certification.temp, 'index')
  const git = certificationGitExecutable()
  const execute = (args) => execFileSync(git, hardenedGitArgs(['-C', options.into, ...args]),
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, GIT_INDEX_FILE: index, GIT_NO_LAZY_FETCH: '1' }, maxBuffer: 1 << 28 })
  const tree = certificationGit(options.into, (_program, args, config) => {
    try { return { status: 0, stdout: execFileSync(git, args, config) } }
    catch (error) { return { status: error.status, stderr: error.stderr } }
  }, ['write-tree']).trim()
  execute(['read-tree', tree])
  return execute(['diff', '--name-only', '-z'])
}
function certificationGitExecutable() {
  const git = resolvedBinary('git', process.env, { accessSyncFn: accessSync, constants,
    platform: process.platform, realpathSyncFn: realpathSync, statSyncFn: statSync, pathApi: path })
  if (!git) throw new Error('certification git unavailable: install git and add it to PATH before integrating')
  return git
}
