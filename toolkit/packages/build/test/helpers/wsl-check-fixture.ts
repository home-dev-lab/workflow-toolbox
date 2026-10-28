import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// The resolver uses its existing run/platform/wsl/exists seams. The CLI reads a recorded Windows
// side and uses the same fake PowerShell through a preload, so its stdout/stderr/exits run on every OS.
export function wslCheckFixture(dir: string, env: NodeJS.ProcessEnv, checkLine: string) {
  const preload = join(dir, 'windows-check.cjs')
  const commandFile = join(dir, 'windows-command.cjs')
  const argsFile = join(dir, 'ps-args')
  writeFileSync(commandFile, `
const fs = require('node:fs')
const absent = () => { throw Object.assign(new Error('fixture command absent'), { code: 'ENOENT' }) }
const run = (command, args) => {
  if (command === 'tailscale' || command === 'tailscale.exe') return absent()
  if (command === 'powershell.exe') {
    fs.writeFileSync(${JSON.stringify(argsFile)}, args.join('\\n'))
    return args.some(arg => arg.includes('Invoke-WebRequest'))
      ? ${JSON.stringify(`${checkLine}\r\n`)} : ${JSON.stringify('C:\\Resolved\\tailscale.exe\r\n')}
  }
  if (command === 'wslpath') return '/fixture/tailscale.exe\\n'
  if (command === '/fixture/tailscale.exe') return '127.0.0.1\\n'
  throw new Error('unexpected fixture command: ' + command)
}
module.exports = run
`)
  writeFileSync(preload, `require('node:child_process').execFileSync = require(${JSON.stringify(commandFile)})
require('node:module').syncBuiltinESMExports()
`)
  const run = createRequire(import.meta.url)(commandFile) as (command: string, args: string[]) => string
  const commands: string[] = []
  return {
    options: { platform: 'linux', wsl: true, exists: () => false, env: {}, remote: true,
      run: (command: string, args: string[]) => { commands.push(command); return run(command, args) } },
    env: { ...env, PATH: dir, WT_ARTIFACT_SERVER_TAILSCALE_BINARY: undefined,
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` },
    args: () => readFileSync(argsFile, 'utf8'),
    commands,
  }
}
