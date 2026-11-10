import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

function defaultExceptionLocations() {
  const home = userInfo().homedir
  const exceptionStateDir = join(home, '.local', 'state', 'workflow-toolbox', 'signature-exceptions')
  return { ownerKeysFile: join(home, '.config', 'workflow-toolbox', 'owner-signing-keys.json'),
    exceptionStateDir, exceptionInboxDir: join(exceptionStateDir, 'inbox') }
}

export function exceptionLocations(options) {
  const defaults = defaultExceptionLocations()
  const exceptionStateDir = resolve(options.exceptionStateDir ?? defaults.exceptionStateDir)
  return { ownerKeysFile: resolve(options.ownerKeysFile ?? defaults.ownerKeysFile), exceptionStateDir, exceptionInboxDir: join(exceptionStateDir, 'inbox') }
}

export function validExceptionConfig(config) {
  return ['ownerKeysFile', 'exceptionStateDir', 'exceptionInboxDir'].every((key) =>
    typeof config?.[key] === 'string' && isAbsolute(config[key])) && config.exceptionInboxDir === join(config.exceptionStateDir, 'inbox')
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
export const localDestination = (url, baseDir) => realpathSync(resolve(baseDir, url))
const claimPath = (config, id) => join(config.exceptionStateDir, 'claims', `${id}.json`)
export const claimExists = (config, id) => existsSync(claimPath(config, id))

export function answerFiles(config, used = false) {
  const directory = used ? join(config.exceptionStateDir, 'used') : config.exceptionInboxDir
  try { return readdirSync(directory).filter((name) => name.endsWith('.json')).sort().map((name) => join(directory, name)) }
  catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export function createClaim(config, id, record) {
  const file = claimPath(config, id)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 })
  return file
}

export function archiveAnswer(config, id, source) {
  const used = join(config.exceptionStateDir, 'used')
  mkdirSync(used, { recursive: true, mode: 0o700 })
  renameSync(source, join(used, `${id}.json`))
}

export function logException(config, record) {
  mkdirSync(config.exceptionStateDir, { recursive: true, mode: 0o700 })
  appendFileSync(join(config.exceptionStateDir, 'exceptions.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 })
}

export function writeOwnerPin(file, pin) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  try { writeFileSync(file, JSON.stringify(pin, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const previous = readJson(file)
    if (previous.identity !== pin.identity || JSON.stringify(previous.keys) !== JSON.stringify(pin.keys)) throw Error('pin-differs', { cause: error })
  }
}

export function signatureCommand(program, args, options = {}) {
  return spawnSync(program, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, ...options })
}

export const signaturePolicyCommand = (program, args) => signatureCommand(program, args, { timeout: 5_000 })

export function exceptionStatus(config) {
  if (!validExceptionConfig(config)) throw Error('install-predates-exceptions')
  let recent = []
  try { recent = readFileSync(join(config.exceptionStateDir, 'exceptions.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-5) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return { config, pin: readJson(config.ownerKeysFile), recent }
}
