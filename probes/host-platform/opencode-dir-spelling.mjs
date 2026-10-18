import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { outputPath, provenance, runToFile, writeEvidence } from './probe-lib.mjs'

const destination = outputPath('opencode-dir-spelling')
const root = mkdtempSync(join(tmpdir(), 'wt-opencode-dir-probe-'))
const entry = process.env.WT_OPENCODE_PROBE_ENTRY
const command = entry ? process.execPath : process.env.WT_OPENCODE_PROBE_BIN ?? 'opencode'
const prefix = entry ? [resolve(entry)] : []

function isolatedEnv(index) {
  const home = join(root, `home-${index}`)
  const env = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP']) {
    env[name] = join(home, name.toLowerCase()); mkdirSync(env[name], { recursive: true })
  }
  env.OPENCODE_TEST_HOME = env.HOME
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'true'
  return env
}

function storeRows(env) {
  const file = join(env.XDG_DATA_HOME, 'opencode', 'opencode.db')
  if (!existsSync(file)) return { file, rows: [], reason: 'isolated OpenCode store was not created' }
  const db = new DatabaseSync(file, { readOnly: true })
  try { return { file, rows: db.prepare('SELECT id,directory,time_created,time_updated FROM session ORDER BY time_created').all() } } finally { db.close() }
}

function directoryLogs(env, raw) {
  const logDir = join(env.XDG_DATA_HOME, 'opencode', 'log')
  const logs = existsSync(logDir) ? readdirSync(logDir).filter((name) => name.endsWith('.log')).map((name) => readFileSync(join(logDir, name), 'utf8')) : []
  return [raw, ...logs].flatMap((text) => text.split(/\r?\n/).filter((line) => line.includes('directory=')))
}

function measure(given, index) {
  const env = isolatedEnv(index)
  const result = runToFile(command, [...prefix, 'run', '--auto', '--dir', given, '--model', 'openai/gpt-5', 'Reply with OK.'], join(root, `run-${index}.log`), { cwd: root, env, timeout: 60_000, killSignal: 'SIGKILL' })
  let store
  try { store = storeRows(env) } catch (error) { store = { rows: [], reason: String(error.message) } }
  return { given, jsRealpath: pathReading(given, realpathSync), nativeRealpath: pathReading(given, realpathSync.native), exitCode: result.exitCode, signal: result.signal, error: result.error, store, directoryLines: directoryLogs(env, result.raw), output: result.raw }
}

function pathReading(given, realpath) {
  try { return { value: realpath(given), error: null } } catch (error) { return { value: null, error: String(error.message) } }
}

function shortSpelling(target) {
  if (platform() !== 'win32') return { given: target, reason: 'Windows short-name measurement is not applicable on this OS' }
  const result = runToFile('cmd.exe', ['/d', '/s', '/c', `for %I in ("${target}") do @echo %~sI`], join(root, 'short.log'))
  return { given: result.exitCode === 0 && result.raw.trim() ? result.raw.trim() : target, commandResult: result, reason: 'An identical spelling means no 8.3 alias was available.' }
}

try {
  const target = join(root, 'real', 'leaf'); mkdirSync(target, { recursive: true })
  const alias = join(root, 'alias'); symlinkSync(target, alias, platform() === 'win32' ? 'junction' : 'dir')
  const short = shortSpelling(target)
  const version = runToFile(command, [...prefix, '--version'], join(root, 'version.log'), { env: isolatedEnv('version') })
  const inputs = [target, realpathSync.native(target), alias, `${alias}${sep}..${sep}leaf`]
  if (platform() === 'win32') inputs.push(short.given)
  const evidence = {
    provenance: provenance('opencode-dir-spelling', `node ${basename(import.meta.filename)} ${destination}`, join(root, 'provenance')),
    version, shortSpelling: short, cases: inputs.map(measure),
    classification: 'Each invocation has fresh HOME, USERPROFILE, APPDATA, LOCALAPPDATA and XDG directories, no inherited credentials, closed stdin and a timeout. An explicit credential-requiring model avoids the free-model default. Exit 1 is expected without provider credentials; session rows and directory= log lines are the measurement.',
  }
  writeEvidence(destination, evidence)
  if (evidence.cases.some((item) => item.error || !item.store.rows.length)) process.exitCode = 1
} finally { rmSync(root, { recursive: true, force: true }) }
