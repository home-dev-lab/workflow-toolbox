import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolvePluginDataDir } from './plugin-data-dir.mjs'

const SENTINEL = 'workflow-toolbox-fence-sentinel'

export function opencodeChildEnv(env = process.env) {
  return { ...env, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true' }
}

export function opencodeSkillFenceRefusal(reason) {
  return `OPENCODE_SKILL_FENCE_UNAVAILABLE: ${reason}; update OpenCode or workflow-toolbox before launching.`
}

function defaultStateDir(env) {
  const fallback = path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'workflow-toolbox')
  return path.join(resolvePluginDataDir({ env, fallback }).dir, 'opencode-skill-fence')
}

function resolvedBinary(bin, env) {
  if (bin.includes('/') || bin.includes('\\')) {
    try { return realpathSync(bin) } catch { return path.resolve(bin) }
  }
  const found = spawnSync(`command -v ${bin}`, { shell: true, encoding: 'utf8', env })
  if (found.status !== 0 || !found.stdout?.trim()) return null
  try { return realpathSync(found.stdout.trim().split('\n')[0]) } catch { return found.stdout.trim().split('\n')[0] }
}

export function verifyOpencodeSkillFence(bin, options = {}) {
  try {
    return verifyOpencodeSkillFenceInternal(bin, options)
  } catch (error) {
    return { ok: false, cached: false, reason: `could not complete the OpenCode Claude-skill fence capability probe (${error instanceof Error ? error.message : String(error)})` }
  }
}

function verifyOpencodeSkillFenceInternal(bin, { env = process.env, stateDir = defaultStateDir(env), spawnSyncFn = spawnSync } = {}) {
  const childEnv = opencodeChildEnv(env)
  const binary = resolvedBinary(bin, childEnv)
  if (binary === null) return { ok: true, missing: true, cached: false }

  const versionResult = spawnSyncFn(binary, ['--version'], { encoding: 'utf8', env: childEnv, timeout: 30_000 })
  if (versionResult.error?.code === 'ENOENT') return { ok: true, missing: true, cached: false }
  const version = versionResult.status === 0 ? String(versionResult.stdout || '').trim() : ''
  if (!version) return { ok: false, cached: false, reason: 'could not read the OpenCode version for the Claude-skill fence probe' }

  const key = crypto.createHash('sha256').update(`${binary}\0${version}`).digest('hex')
  const cacheFile = path.join(stateDir, `${key}.json`)
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (cached.binary === binary && cached.version === version && cached.ok === true) return { ok: true, cached: true, binary, version }
  } catch { /* a miss or corrupt cache must probe */ }

  const fixture = mkdtempSync(path.join(os.tmpdir(), 'wt-opencode-skill-fence-'))
  const home = path.join(fixture, 'home')
  const worktree = path.join(fixture, 'worktree')
  const skillDir = path.join(home, '.claude', 'skills', SENTINEL)
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${SENTINEL}\ndescription: Synthetic workflow-toolbox fence capability probe\n---\n\nSentinel.\n`)
  const probeEnv = opencodeChildEnv({
    ...env,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(fixture, 'xdg-config'),
    XDG_DATA_HOME: path.join(fixture, 'xdg-data'),
    XDG_CACHE_HOME: path.join(fixture, 'xdg-cache'),
    XDG_STATE_HOME: path.join(fixture, 'xdg-state'),
  })
  try {
    const probe = spawnSyncFn(binary, ['--pure', 'debug', 'skill'], { cwd: worktree, encoding: 'utf8', env: probeEnv, timeout: 30_000 })
    if (probe.status !== 0) return { ok: false, cached: false, reason: 'the OpenCode Claude-skill fence capability probe failed' }
    let skills
    try { skills = JSON.parse(String(probe.stdout || '')) } catch { return { ok: false, cached: false, reason: 'the OpenCode Claude-skill fence capability probe returned invalid JSON' } }
    if (!Array.isArray(skills) || skills.some((skill) => skill?.name === SENTINEL)) {
      return { ok: false, cached: false, reason: Array.isArray(skills) ? 'the synthetic Claude skill is still listed under the forced fence' : 'the OpenCode Claude-skill fence capability probe returned an unexpected shape' }
    }
    mkdirSync(stateDir, { recursive: true })
    const temp = `${cacheFile}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ ok: true, binary, version }))
    renameSync(temp, cacheFile)
    return { ok: true, cached: false, binary, version }
  } finally {
    if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true })
  }
}
