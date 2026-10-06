// What `spawnSync('bash', ['-c', cmd])` runs on this host, and whether a `printf '%s' <json> | node <script>` pipeline
// delivers its payload to a script that reads standard input with readFileSync(0). A printed re-run command of that
// shape is handed to users, and tests execute it through `bash`; this probe records the facts both depend on.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { outputPath, provenance, writeEvidence } from './probe-lib.mjs'

const destination = outputPath('posix-shell-pipe')
const scratch = `${destination}.native`
const root = mkdtempSync(join(tmpdir(), 'wt-host-shell-pipe-'))
const reader = join(root, 'reader.mjs')
writeFileSync(reader, [
  "import { readFileSync } from 'node:fs'",
  'let raw = null, readError = null',
  "try { raw = readFileSync(0, 'utf8') } catch (error) { readError = { code: error.code ?? null, message: String(error.message) } }",
  'let parsed = null',
  'try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = null }',
  'process.stdout.write(JSON.stringify({ bytes: raw === null ? null : raw.length, parsedCwd: parsed?.cwd ?? null, readError, execPath: process.execPath }))',
].join('\n'))

const quote = (word) => `'${String(word).replaceAll("'", `'"'"'`)}'`
const payload = JSON.stringify({ source: 'startup', hook_event_name: 'SessionStart', cwd: root })
const home = join(root, 'home')
const sealedEnv = {
  ...process.env,
  HOME: home,
  CLAUDE_CONFIG_DIR: join(root, 'cfg'),
  ...(platform() === 'win32' ? { USERPROFILE: home } : {}),
}

const run = (label, script, env = process.env) => {
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env, timeout: 30_000, windowsHide: true })
  return {
    label,
    script,
    exitCode: result.status,
    signal: result.signal,
    spawnError: result.error === undefined ? null : { code: result.error.code ?? null, message: String(result.error.message) },
    stdout: result.stdout ?? null,
    stderr: result.stderr ?? null,
  }
}

const identity = 'command -v bash; printf "BASH_VERSION=%s MSYSTEM=%s\\n" "$BASH_VERSION" "${MSYSTEM:-}"; uname -s; command -v node; node -v'
const pipe = `printf '%s' ${quote(payload)} | node ${quote(reader)}`
const pipeExec = `printf '%s' ${quote(payload)} | ${quote(process.execPath)} ${quote(reader)}`

const measurements = {
  identityInherited: run('bash identity, inherited environment', identity),
  identitySealed: run('bash identity, sealed HOME/USERPROFILE environment', identity, sealedEnv),
  pipeInherited: run('printf | node reader, inherited environment', pipe),
  pipeSealed: run('printf | node reader, sealed environment', pipe, sealedEnv),
  pipeExecPathSealed: run('printf | <this node> reader, sealed environment', pipeExec, sealedEnv),
  expectedCwd: root,
}
rmSync(root, { recursive: true, force: true })
const command = `node ${basename(import.meta.filename)} ${destination}`
writeEvidence(destination, {
  provenance: provenance('posix-shell-pipe', command, `${scratch}.provenance`),
  measurements,
})
