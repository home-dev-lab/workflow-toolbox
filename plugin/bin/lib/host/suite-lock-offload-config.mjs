import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

const COMMAND = 'WT_SUITE_LOCK_OFFLOAD_COMMAND'
const MIN_AHEAD = 'WT_SUITE_LOCK_OFFLOAD_MIN_AHEAD'

function minimumAhead(raw) {
  if (raw === undefined) return 2
  const value = Number(raw)
  if (!/^[1-9]\d*$/.test(String(raw)) || !Number.isSafeInteger(value)) throw new Error(`${MIN_AHEAD} must be a positive integer`)
  return value
}

function checkCommand(command) {
  if (!path.isAbsolute(command)) throw new Error(`${COMMAND} must be an absolute executable path`)
  if (!statSync(command).isFile()) throw new Error(`${COMMAND} must name a file`)
  accessSync(command, constants.X_OK)
}

function launchRoot(root) {
  if (!root || !path.isAbsolute(root) || !statSync(root).isDirectory()) throw new Error('offload requires a host launch --root directory')
  return realpathSync(root)
}

function launchToken(env) {
  const token = env.WT_SUITE_LOCK_LANE_TOKEN
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('offload requires a serving lane capability from the launcher')
  return token
}

/** Invalid optional configuration disables only offload, never local acquisition. */
export function suiteOffloadConfig(root, env = process.env, platform = process.platform, warn = (text) => process.stderr.write(`${text}\n`)) {
  if (!env[COMMAND]) return null
  try {
    if (platform !== 'linux') throw new Error('offload unavailable: Linux sandbox and descriptor paths required')
    checkCommand(env[COMMAND])
    return { command: env[COMMAND], root: launchRoot(root), minAhead: minimumAhead(env[MIN_AHEAD]), laneToken: launchToken(env), env: { ...env },
      // Captured before the broker listens and the launcher exposes the lane. Never reopen this file.
      guardianSource: readFileSync(new URL('./suite-lock-offload-guardian.mjs', import.meta.url), 'utf8') }
  } catch (error) {
    warn(`workflow-toolbox: suite-lock offload disabled: ${error.message}`)
    return null
  }
}

export function offloadWorkingDirectory(config, cwd) {
  const relative = path.relative(config.root, realpathSync(path.resolve(config.root, cwd)))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('offload cwd outside host launch root')
  return relative || '.'
}
