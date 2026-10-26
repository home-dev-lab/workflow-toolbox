import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const ADMISSION_OPTIONS = Object.freeze({
  WT_SECOND_OPINION_ADMISSION: 'second_opinion_admission',
  WT_OPENCODE_ENVELOPE_ADMISSION: 'opencode_envelope_admission',
  WT_OPENCODE_VERIFY_ADMISSION: 'opencode_verify_admission',
})

function settingsFailure(file, variable, reason) {
  return new Error(`${variable}: cannot resolve admission from ${file}: ${reason}; repair that settings.json or set ${variable} to an absolute ES module path`)
}

function absentSettings(file, error) {
  if (error.code !== 'ENOENT') return false
  try { lstatSync(file); return false } catch (failure) {
    if (failure.code !== 'ENOENT') return false
  }
  // ENOENT can also mean that the previously resolved profile disappeared.
  try { return lstatSync(path.dirname(file)).isDirectory() } catch { return false }
}

function strictSettings(file, variable) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if (absentSettings(file, error)) return undefined
    throw settingsFailure(file, variable, error.message)
  }
}

function objectContainer(value, name, file, variable) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw settingsFailure(file, variable, `${name} must be an object`)
  return value
}

function optionValues(settings, key, file, variable) {
  objectContainer(settings, 'settings', file, variable)
  if (!Object.hasOwn(settings, 'pluginConfigs')) return []
  const configs = objectContainer(settings.pluginConfigs, 'pluginConfigs', file, variable)
  const values = []
  for (const [id, entry] of Object.entries(configs)) {
    const config = objectContainer(entry, id, file, variable)
    if (!Object.hasOwn(config, 'options')) continue
    const options = objectContainer(config.options, `${id}.options`, file, variable)
    if (id.startsWith('workflow-toolbox@') && Object.hasOwn(options, key)) values.push(options[key])
  }
  return values
}

function strictOption(settings, key, file, variable) {
  if (settings === undefined) return null
  const values = optionValues(settings, key, file, variable)
  if (values.some((value) => typeof value !== 'string')) throw settingsFailure(file, variable, `${key} must be a string`)
  if (values.some((value) => value !== values[0])) throw settingsFailure(file, variable, `conflicting ${key} values`)
  return values.length ? { path: values[0], source: 'plugin option' } : null
}

function settingsPath(env, variable) {
  // Append without lexical normalization: symlink/.. is resolved by the filesystem.
  const directory = env.CLAUDE_CONFIG_DIR || `${env.HOME || homedir()}${path.sep}.claude`
  try { return path.join(realpathSync.native(directory), 'settings.json') } catch (error) {
    // Only ENOENT for settings.json INSIDE a resolved profile proves absence.
    // A missing or undecidable profile cannot prove that no policy is configured.
    throw settingsFailure(`${directory}${path.sep}settings.json`, variable, error.message)
  }
}

// Resolve once in the launching process. Admission children receive this exact result.
export function resolveAdmissionModule(moduleVariable, env = process.env) {
  if (env[moduleVariable] !== undefined) return { path: env[moduleVariable], source: 'env' }
  const key = ADMISSION_OPTIONS[moduleVariable]
  if (!key) throw new Error(`unknown admission variable: ${moduleVariable}`)
  const file = settingsPath(env, moduleVariable)
  return strictOption(strictSettings(file, moduleVariable), key, file, moduleVariable)
}
