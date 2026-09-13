import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeOpencodeSkillName, REFUSED_LANE_SKILLS } from './lane-skill-allowlist.mjs'
import { resolvePluginDataDir } from './plugin-data-dir.mjs'

const SENTINEL = 'workflow-toolbox-fence-sentinel'
const ALLOW_SENTINEL = 'workflow-toolbox-allowed-sentinel'
const PROBE_CONTRACT = 'allow-list-v2-two-half'
const MECHANISM = 'opencode-config-skills-paths'
const NORMALIZED_REFUSED_LANE_SKILLS = new Set(REFUSED_LANE_SKILLS.map(normalizeOpencodeSkillName))

// Measured 2026-09-13 with installed OpenCode 1.18.30: under --pure,
// OPENCODE_CONFIG skills.paths exposes a materialised skill while
// OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=true excludes the external Claude skill.

export function opencodeChildEnv(env = process.env) {
  const childEnv = { ...env, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true' }
  // An inherited config can add arbitrary skill paths. Launchers may add their own
  // validated OPENCODE_CONFIG after this function returns, but never inherit one silently.
  delete childEnv.OPENCODE_CONFIG
  return childEnv
}

export function opencodeSkillFenceRefusal(reason) {
  return `OPENCODE_SKILL_FENCE_UNAVAILABLE: ${reason}; update OpenCode or workflow-toolbox before launching.`
}

function lstatIfExists(pathname) {
  try { return lstatSync(pathname) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function destinationComponent(pathname) {
  const entry = lstatIfExists(pathname)
  if (entry?.isSymbolicLink()) throw new Error(`destination component is a symlink: ${pathname}`)
}

function destinationTree(pathname) {
  const entry = lstatIfExists(pathname)
  if (!entry) return
  if (entry.isSymbolicLink()) throw new Error(`destination component is a symlink: ${pathname}`)
  if (!entry.isDirectory()) return
  for (const child of readdirSync(pathname)) destinationTree(path.join(pathname, child))
}

function skillFailure(name, reason, detail) {
  return { name, reason, detail }
}

function frontmatterName(file) {
  const content = readFileSync(file, 'utf8')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1]
  if (frontmatter === undefined) return null
  const value = /^name\s*:\s*(.*?)\s*$/m.exec(frontmatter)?.[1]
  if (!value) return null
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
  return value
}

function validateSkillTree(name, source, current = source) {
  let entry
  try { entry = lstatSync(current) } catch (error) { return skillFailure(name, 'io-error', error instanceof Error ? error.message : String(error)) }
  if (entry.isSymbolicLink()) return skillFailure(name, 'source-symlink', `skill source contains a symlink: ${current}`)
  if (!entry.isDirectory()) return skillFailure(name, 'invalid-source', `skill source is not a directory: ${source}`)
  try {
    for (const child of readdirSync(current)) {
      const childPath = path.join(current, child)
      const childEntry = lstatSync(childPath)
      if (childEntry.isSymbolicLink()) return skillFailure(name, 'source-symlink', `skill source contains a symlink: ${childPath}`)
      if (child === 'SKILL.md' && current !== source) return skillFailure(name, 'nested-skill', `nested SKILL.md is not allowed: ${childPath}`)
      if (childEntry.isDirectory()) {
        const failure = validateSkillTree(name, source, childPath)
        if (failure) return failure
      }
    }
  } catch (error) { return skillFailure(name, 'io-error', error instanceof Error ? error.message : String(error)) }
  if (current !== source) return null
  const rootSkill = path.join(source, 'SKILL.md')
  if (!existsSync(rootSkill) || !lstatSync(rootSkill).isFile()) return skillFailure(name, 'missing-skill-file', `root SKILL.md is missing: ${rootSkill}`)
  let declared
  try { declared = frontmatterName(rootSkill) } catch (error) { return skillFailure(name, 'io-error', error instanceof Error ? error.message : String(error)) }
  if (declared === null) return skillFailure(name, 'malformed-frontmatter', `root SKILL.md has no frontmatter name: ${rootSkill}`)
  if (declared !== name) return skillFailure(name, 'name-mismatch', `frontmatter name ${declared} does not equal directory name ${name}`)
  return null
}

function copySkill(source, destination) {
  const entry = lstatSync(source)
  if (entry.isSymbolicLink()) throw new Error(`skill source contains a symlink: ${source}`)
  if (entry.isDirectory()) {
    destinationComponent(destination)
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    for (const child of readdirSync(source)) copySkill(path.join(source, child), path.join(destination, child))
  } else if (entry.isFile()) {
    destinationComponent(path.dirname(destination))
    destinationComponent(destination)
    mkdirSync(path.dirname(destination), { recursive: true })
    copyFileSync(source, destination, constants.COPYFILE_EXCL)
  }
}

export function materialiseAllowedSkills({ names, laneDir, env = process.env, homeDir = os.homedir() }) {
  const dir = path.join(laneDir, '.lane', 'opencode-skills')
  const configPath = path.join(laneDir, '.lane', 'opencode-skills.json')
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude')
  destinationComponent(laneDir)
  destinationComponent(path.join(laneDir, '.lane'))
  destinationTree(dir)
  destinationComponent(configPath)
  mkdirSync(path.join(laneDir, '.lane'), { recursive: true, mode: 0o700 })
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  if (lstatIfExists(configPath)) rmSync(configPath, { force: true })

  const sources = []
  const failures = []
  for (const name of names) {
    const local = path.join(laneDir, '.claude', 'skills', name)
    const source = lstatIfExists(local) ? local : path.join(claudeDir, 'skills', name)
    if (!lstatIfExists(source)) { failures.push(skillFailure(name, 'missing-source', `skill source is missing: ${name}`)); continue }
    const failure = validateSkillTree(name, source)
    if (failure) failures.push(failure)
    else sources.push({ name, source })
  }

  const staging = mkdtempSync(path.join(laneDir, '.lane', '.opencode-skills-'))
  const materialised = []
  let copyingName = null
  try {
    if (!failures.length) {
      for (const { name, source } of sources) {
        copyingName = name
        copySkill(source, path.join(staging, name))
        materialised.push(name)
      }
    }
    renameSync(staging, dir)
  } catch (error) {
    failures.push(skillFailure(copyingName ?? '<materialisation>', 'copy-error', error instanceof Error ? error.message : String(error)))
    rmSync(staging, { recursive: true, force: true })
    destinationComponent(dir)
    mkdirSync(dir, { mode: 0o700 })
    materialised.length = 0
  }
  writeFileSync(configPath, `${JSON.stringify({ skills: { paths: [dir] } }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const missing = failures.filter(({ reason }) => reason === 'missing-source').map(({ name }) => name)
  return { dir, materialised, missing, failures, mechanism: MECHANISM, configPath }
}

// `--pure` excludes external plugins, while toolbox runs currently allow them. The
// discovery command therefore deliberately omits `--pure` so its flags match the run.
export function verifyEffectiveOpencodeSkillDiscovery(bin, { cwd, env, spawnSyncFn = spawnSync, timeoutMs = 30_000 } = {}) {
  const startedAt = Date.now()
  let probe
  try {
    probe = spawnSyncFn(bin, ['debug', 'skill'], { cwd, env, encoding: 'utf8', timeout: timeoutMs })
  } catch (error) {
    return { ok: false, reason: `effective OpenCode skill discovery failed (${error instanceof Error ? error.message : String(error)})`, durationMs: Date.now() - startedAt }
  }
  const durationMs = Date.now() - startedAt
  if (probe.error || probe.status !== 0) return { ok: false, reason: `effective OpenCode skill discovery failed${probe.error ? ` (${probe.error.message})` : ` with exit ${probe.status ?? 'unknown'}`}`, durationMs }
  let skills
  try { skills = JSON.parse(String(probe.stdout || '')) } catch { return { ok: false, reason: 'effective OpenCode skill discovery returned invalid JSON', durationMs } }
  if (!Array.isArray(skills)) return { ok: false, reason: 'effective OpenCode skill discovery returned an unexpected shape', durationMs }
  const refused = skills
    .filter((skill) => typeof skill?.name === 'string' && NORMALIZED_REFUSED_LANE_SKILLS.has(normalizeOpencodeSkillName(skill.name)))
    .map((skill) => ({ name: skill.name, location: typeof skill.location === 'string' && skill.location ? skill.location : '<unknown location>' }))
  return refused.length ? { ok: false, refused, durationMs } : { ok: true, refused: [], durationMs }
}

export function effectiveSkillDiscoveryRefusal(result, prefix = 'wt-lane') {
  const detail = result.refused?.length
    ? `effective OpenCode skill discovery found ${result.refused.map(({ name, location }) => `${name} at ${location}`).join(', ')}`
    : result.reason ?? 'effective OpenCode skill discovery could not be verified'
  return `${prefix}: Refused: ${detail}; refusing to launch.`
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
  const probeEnv = {
    ...opencodeChildEnv({
    ...env,
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(fixture, 'xdg-config'),
    XDG_DATA_HOME: path.join(fixture, 'xdg-data'),
    XDG_CACHE_HOME: path.join(fixture, 'xdg-cache'),
    XDG_STATE_HOME: path.join(fixture, 'xdg-state'),
    }),
    OPENCODE_CONFIG: allowedFixture.configPath,
  }
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
