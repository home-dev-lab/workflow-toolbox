import { existsSync } from 'node:fs'
import { release } from 'node:os'
import path from 'node:path'

function isWsl(platform, env) {
  return platform === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(release()))
}

export function artifactBinaryContext(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  return { ...options, env, platform, wsl: options.wsl ?? isWsl(platform, env) }
}

function standardInstall(name, context) {
  if (context.wsl) {
    return {
      tailscale: '/mnt/c/Program Files/Tailscale/tailscale.exe',
      'powershell.exe': '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    }[name]
  }
  if (name !== 'tailscale') return null
  if (context.platform === 'darwin') return '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  if (context.platform !== 'win32') return null
  const programFiles = context.env.ProgramFiles || context.env.PROGRAMFILES || 'C:\\Program Files'
  return (context.windowsPath ?? path.win32).join(programFiles, 'Tailscale', 'tailscale.exe')
}

function* binaryCandidates(name, context) {
  yield name
  if (name === 'tailscale' && (context.wsl || context.platform === 'win32')) yield 'tailscale.exe'
  const installed = standardInstall(name, context)
  if (installed && (context.exists ?? existsSync)(installed)) yield installed
}

// Execute PATH candidates first. Standard locations are probed lazily, and both execution and filesystem
// access are injectable; a failed configured executable is handled by the caller, never replaced here.
export function runArtifactBinary(name, args, run, options = {}, timeout) {
  const context = artifactBinaryContext(options)
  let failure
  let knownCommand
  for (const command of binaryCandidates(name, context)) {
    try { return { command, output: run(command, args, timeout) } } catch (error) {
      failure = error
      if (error?.code !== 'ENOENT') knownCommand = command
    }
  }
  throw Object.assign(new Error(`could not run ${name}`, { cause: failure }), {
    code: failure?.code, status: failure?.status, artifactBinary: knownCommand,
  })
}
