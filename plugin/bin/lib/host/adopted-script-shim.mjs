import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** One resolver, serialized into adopted launchers so they have no neighbouring dependencies.
 * The first present candidate decides, even when unusable. Same-rank registry entries
 * retain registry order; project/local rank above user. Target checks verify existence,
 * not loadability: direct Node execution fails identically on a broken module or follows
 * a symlinked target. An absent adopted copy means not adopted, not drift. */
function canonical(value) { try { return path.isAbsolute(value) ? fs.realpathSync(value) : null } catch { return null } }
function readJson(value) { try { return JSON.parse(fs.readFileSync(value, 'utf8')) } catch { return null } }
function regular(value) { try { return fs.statSync(value).isFile() } catch { return false } }
function withinProject(owner, here) {
  if (!here || !owner) return false
  const relative = path.relative(owner, here)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function applicableEntry(entry, project) {
  if (entry?.scope === 'user') return true
  if (entry?.scope !== 'project' && entry?.scope !== 'local') return false
  const here = canonical(project)
  const owner = typeof entry.projectPath === 'string' && canonical(entry.projectPath)
  return withinProject(owner, here)
}
function registryEntries(plugins, project) {
  return plugins && typeof plugins === 'object' ? Object.entries(plugins).flatMap(([key, values]) => {
    if (!key.startsWith('workflow-toolbox@')) return []
    return (Array.isArray(values) ? values : [values]).filter((entry) => applicableEntry(entry, project))
  }) : []
}
function resolveCandidate(candidate, file) {
  const refuse = (reason) => ({ root: null, target: null, lookup: `candidate ${String(candidate)}: ${reason}; bin/${file}` })
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return refuse('plugin root must be an absolute path')
  const root = canonical(candidate)
  if (!root) return refuse('plugin root cannot be resolved')
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'))
  if (manifest?.name !== 'workflow-toolbox') return refuse('workflow-toolbox manifest missing or invalid')
  const target = path.join(root, 'bin', file)
  return regular(target) ? { root, target, lookup: null } : {
    root, target: null,
    lookup: `installed workflow-toolbox v${manifest.version ?? 'unknown'} at ${root}: canonical target is not a regular file: ${target}; bin/${file}`,
  }
}
function configDirectory(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude')
}
export function resolveAdoptedScript(file, env = process.env, cwd = process.cwd()) {
  const config = configDirectory(env)
  const registry = path.join(config, 'plugins', 'installed_plugins.json')
  const project = env.CLAUDE_PROJECT_DIR || cwd
  const parsed = readJson(registry)
  const plugins = parsed?.plugins ?? parsed
  const entries = registryEntries(plugins, project)
  entries.sort((a, b) => Number(b.scope === 'project' || b.scope === 'local') - Number(a.scope === 'project' || a.scope === 'local'))
  const candidate = env.WT_PLUGIN_ROOT !== undefined ? env.WT_PLUGIN_ROOT
    : entries.length ? entries[0].installPath : env.CLAUDE_PLUGIN_ROOT
  if (candidate !== undefined || entries.length) return resolveCandidate(candidate, file)
  return { root: null, target: null,
    lookup: `WT_PLUGIN_ROOT, ${registry} (applicable workflow-toolbox@* entries), CLAUDE_PLUGIN_ROOT; bin/${file}` }
}

function failAdoptedScript(file, message) {
    const line = `${file}: ${message}`.replace(/[\r\n]/g, ' ') + '\n'
    try { fs.writeSync(1, line) } catch { /* the other descriptor must still be attempted */ }
    try { fs.writeSync(2, line) } catch { /* diagnostic failure must not prevent exit 2 */ }
    process.exit(2)
}
function requireExecutable(executable, fail) {
  try {
    if (!fs.statSync(executable).isFile()) fail(`Node executable not found: ${executable}`)
    fs.accessSync(executable, fs.constants.X_OK)
  }
  catch { fail(`Node executable not found: ${executable}`) }
}
function runAdoptedScript(file) {
  const resolved = resolveAdoptedScript(file)
  const fail = (message) => failAdoptedScript(file, message)
  if (!resolved.target) {
    if (!resolved.root && (process.argv[2] === '--help' || process.argv[2] === '-h')) {
      try { fs.writeSync(1, `${file}: launcher for the installed workflow-toolbox plugin; plugin not found.\n`) } catch { /* rootless help is best effort */ }
      return
    }
    fail(`${resolved.root ? 'installed workflow-toolbox script unavailable' : 'installed workflow-toolbox plugin not found'}; looked up ${resolved.lookup}`)
  }
  // A failed execve aborts Node: check the running interpreter's file and execute access.
  // Replacement between this check and exec remains a race; Node offers no safe JS catch.
  const executable = process.execPath
  requireExecutable(executable, fail)
  const args = [...process.execArgv, resolved.target, ...process.argv.slice(2)]
  if (process.platform !== 'win32' && typeof process.execve === 'function') {
    process.execve(executable, [executable, ...args], process.env)
    return
  }
  spawnAdoptedScript(executable, args, resolved, fail)
}
function spawnAdoptedScript(executable, args, resolved, fail) {
  const child = spawn(executable, args, { stdio: 'inherit' })
  let unreaped = true
  const handlers = new Map(['SIGTERM', 'SIGINT', 'SIGHUP'].map((signal) => {
    const handler = () => { if (unreaped) child.kill(signal) }
    process.on(signal, handler)
    return [signal, handler]
  }))
  const removeHandlers = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler) }
  child.once('error', (error) => { unreaped = false; removeHandlers(); fail(`could not start ${resolved.target}: ${error.message}`) })
  child.once('exit', () => { unreaped = false })
  child.once('close', (code, signal) => {
    removeHandlers()
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 2
  })
}

export function renderScriptShim(file) {
  const functions = [canonical, readJson, regular, withinProject, applicableEntry, registryEntries,
    resolveCandidate, configDirectory, resolveAdoptedScript, failAdoptedScript, requireExecutable, runAdoptedScript, spawnAdoptedScript]
  return `#!/usr/bin/env node\n// Thin launcher: the first present plugin candidate decides; equal scope ranks keep registry order.\n// Target checks verify existence, not module loadability; Node follows target symlinks as in direct execution.\n// Re-execution preserves execArgv but repeats NODE_OPTIONS preloads and normalizes argv0, as other launchers do.\n// POSIX execve keeps the pid where available; spawn is for Windows or Node without execve (before 23.11).\n// Fallback signals are best effort, not POSIX-equivalent; force-killing a wrapper can orphan its child.\n// Interpreter preflight cannot close the replace-between-check-and-exec race.\nimport fs from 'node:fs'\nimport os from 'node:os'\nimport path from 'node:path'\nimport { spawn } from 'node:child_process'\n\n${functions.map((fn) => fn.toString()).join('\n\n')}\n\nrunAdoptedScript(${JSON.stringify(file)})\n`
}
