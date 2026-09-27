import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'

export const commandIO = {
  join,
  run(program, args, { cwd }) {
    try {
      const stdout = execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: 300_000 })
      return { status: 0, stdout, stderr: '' }
    } catch (error) {
      return { status: error.status ?? 2, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) }
    }
  },
  // A push emits the hook's receipt on stderr; preserve it even on success.
  push(args, cwd) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 300_000 })
    return { status: result.status ?? 2, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  },
  readText: (path) => readFileSync(path, 'utf8'),
  writeText: (path, text, exclusive = false) => writeFileSync(path, text, { mode: 0o600, flag: exclusive ? 'wx' : 'w' }),
  removeFile: (path) => unlinkSync(path),
  exists: (path) => existsSync(path),
  mkdirp: (path) => mkdirSync(path, { recursive: true }),
  mtime: (path) => statSync(path).mtime.toISOString(),
  executable: (path) => { try { accessSync(path, constants.X_OK); return true } catch { return false } },
  onSignal(handler) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, handler)
    return () => { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, handler) }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}
