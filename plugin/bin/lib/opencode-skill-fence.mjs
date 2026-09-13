import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolvePluginDataDir } from './plugin-data-dir.mjs'

const SENTINEL = 'workflow-toolbox-fence-sentinel'
const ALLOW_SENTINEL = 'workflow-toolbox-allowed-sentinel'
const PROBE_CONTRACT = 'allow-list-v2-two-half'
const MECHANISM = 'opencode-config-skills-paths'

// Measured 2026-09-13 with installed OpenCode 1.18.30: under --pure,
// OPENCODE_CONFIG skills.paths exposes a materialised skill while
// OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=true excludes the external Claude skill.

export function opencodeChildEnv(env = process.env) {
  return { ...env, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true' }
}

export function opencodeSkillFenceRefusal(reason) {
  return `OPENCODE_SKILL_FENCE_UNAVAILABLE: ${reason}; update OpenCode or workflow-toolbox before launching.`
}

function copySkill(source, destination) {
  const entry = lstatSync(source)
  if (entry.isSymbolicLink()) throw new Error(`skill source contains a symlink: ${source}`)
  if (entry.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const child of readdirSync(source)) copySkill(path.join(source, child), path.join(destination, child))
  } else if (entry.isFile()) {
    mkdirSync(path.dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
}

export function materialiseAllowedSkills({ names, laneDir, env = process.env, homeDir = os.homedir() }) {
  const dir = path.join(laneDir, '.lane', 'opencode-skills')
  const configPath = path.join(laneDir, '.lane', 'opencode-skills.json')
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude')
  const materialised = []
  const missing = []
  for (const name of names) {
    const local = path.join(laneDir, '.claude', 'skills', name)
    const source = existsSync(local) ? local : path.join(claudeDir, 'skills', name)
    if (!existsSync(source) || !lstatSync(source).isDirectory()) { missing.push(name); continue }
    try {
      copySkill(source, path.join(dir, name))
      if (!existsSync(path.join(dir, name, 'SKILL.md'))) throw new Error('SKILL.md is missing')
      materialised.push(name)
    } catch { missing.push(name); rmSync(path.join(dir, name), { recursive: true, force: true }) }
  }
  if (materialised.length) {
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify({ skills: { paths: [dir] } }, null, 2)}\n`)
  }
  return { dir, materialised, missing, mechanism: MECHANISM, configPath }
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
    const reason = `could not complete the OpenCode Claude-skill fence capability probe (${error instanceof Error ? error.message : String(error)})`
    return { ok: false, allowOk: false, cached: false, reason, allowReason: reason, mechanism: MECHANISM }
  }
}

function verifyOpencodeSkillFenceInternal(bin, { env = process.env, stateDir = defaultStateDir(env), spawnSyncFn = spawnSync } = {}) {
  const childEnv = opencodeChildEnv(env)
  const binary = resolvedBinary(bin, childEnv)
  if (binary === null) return { ok: true, allowOk: true, missing: true, cached: false, mechanism: MECHANISM }

  const versionResult = spawnSyncFn(binary, ['--version'], { encoding: 'utf8', env: childEnv, timeout: 30_000 })
  if (versionResult.error?.code === 'ENOENT') return { ok: true, allowOk: true, missing: true, cached: false, mechanism: MECHANISM }
  const version = versionResult.status === 0 ? String(versionResult.stdout || '').trim() : ''
  if (!version) {
    const reason = 'could not read the OpenCode version for the Claude-skill fence probe'
    return { ok: false, allowOk: false, cached: false, reason, allowReason: reason, mechanism: MECHANISM }
  }

  const key = crypto.createHash('sha256').update(`${binary}\0${version}\0${MECHANISM}\0${PROBE_CONTRACT}`).digest('hex')
  const cacheFile = path.join(stateDir, `${key}.json`)
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (cached.binary === binary && cached.version === version && typeof cached.ok === 'boolean' && typeof cached.allowOk === 'boolean') {
      return { ok: cached.ok, allowOk: cached.allowOk, cached: true, binary, version, mechanism: MECHANISM, reason: cached.reason, allowReason: cached.allowReason }
    }
  } catch { /* a miss or corrupt cache must probe */ }

  const fixture = mkdtempSync(path.join(os.tmpdir(), 'wt-opencode-skill-fence-'))
  const home = path.join(fixture, 'home')
  const worktree = path.join(fixture, 'worktree')
  const skillDir = path.join(home, '.claude', 'skills', SENTINEL)
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${SENTINEL}\ndescription: Synthetic workflow-toolbox fence capability probe\n---\n\nSentinel.\n`)
  mkdirSync(path.join(home, '.claude', 'skills', ALLOW_SENTINEL), { recursive: true })
  writeFileSync(path.join(home, '.claude', 'skills', ALLOW_SENTINEL, 'SKILL.md'), `---\nname: ${ALLOW_SENTINEL}\ndescription: Synthetic allow-list capability probe\n---\n`)
  // Re-materialise after creating the fixture source.
  const allowedFixture = materialiseAllowedSkills({ names: [ALLOW_SENTINEL], laneDir: worktree, env: {}, homeDir: home })
  const probeEnv = opencodeChildEnv({
    ...env,
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(fixture, 'xdg-config'),
    XDG_DATA_HOME: path.join(fixture, 'xdg-data'),
    XDG_CACHE_HOME: path.join(fixture, 'xdg-cache'),
    XDG_STATE_HOME: path.join(fixture, 'xdg-state'),
    OPENCODE_CONFIG: allowedFixture.configPath,
  })
  try {
    const probe = spawnSyncFn(binary, ['--pure', 'debug', 'skill'], { cwd: worktree, encoding: 'utf8', env: probeEnv, timeout: 30_000 })
    if (probe.status !== 0) {
      const reason = 'the OpenCode Claude-skill fence capability probe failed'
      return { ok: false, allowOk: false, cached: false, reason, allowReason: reason, mechanism: MECHANISM }
    }
    let skills
    try { skills = JSON.parse(String(probe.stdout || '')) } catch {
      const reason = 'the OpenCode Claude-skill fence capability probe returned invalid JSON'
      return { ok: false, allowOk: false, cached: false, reason, allowReason: reason, mechanism: MECHANISM }
    }
    const shapeOk = Array.isArray(skills)
    const ok = shapeOk && !skills.some((skill) => skill?.name === SENTINEL)
    const allowOk = shapeOk && skills.some((skill) => skill?.name === ALLOW_SENTINEL)
    const reason = !shapeOk
      ? 'the OpenCode Claude-skill fence capability probe returned an unexpected shape'
      : !ok ? 'the synthetic Claude skill is still listed under the forced fence'
        : undefined
    const allowReason = !shapeOk
      ? reason
      : !allowOk ? `the allow-list half did not expose the synthetic allowed skill via ${MECHANISM}`
        : undefined
    mkdirSync(stateDir, { recursive: true })
    const temp = `${cacheFile}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ ok, allowOk, reason, allowReason, binary, version, mechanism: MECHANISM, contract: PROBE_CONTRACT }))
    renameSync(temp, cacheFile)
    return { ok, allowOk, cached: false, binary, version, mechanism: MECHANISM, reason, allowReason }
  } finally {
    if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true })
  }
}
