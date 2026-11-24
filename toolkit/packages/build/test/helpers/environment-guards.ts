import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'

/** Only a local checkout with mechanically demonstrated missing ancestry may skip. */
export function historySkipReason(root: string, ci: string | undefined): string | null {
  if (ci) return null
  const options = { cwd: root, encoding: 'utf8' as const }
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], options)
  if (shallow.status === 0 && shallow.stdout.trim() === 'true') return 'local shallow clone has incomplete history'
  const history = spawnSync('git', ['rev-list', '--parents', '--max-count=3', 'HEAD'], options)
  if (history.status !== 0) return null
  const commits = history.stdout.trim().split('\n')
  const rootCommit = commits.at(-1) ?? ''
  if (commits.length > 2 || !/^[0-9a-f]{40,64}$/.test(rootCommit)) return null
  return `local history-free repository: HEAD ancestry has ${commits.length} commit(s), ending at a parentless root`
}

type ProbeResult = Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'error' | 'stdout' | 'stderr'>
type ProbeSpawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => ProbeResult

export function spawnDiagnostics(result: ProbeResult): string {
  return `status=${result.status} signal=${result.signal} error=${(result.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'} stdout=${result.stdout} stderr=${result.stderr}`
}

export function ptyUnavailableReason(result: ProbeResult): string | null {
  if (result.status === 0 && !result.signal && !result.error && result.stdout.includes('PTY READY')) return null
  return `python3 POSIX pty.spawn controlling-terminal probe failed: ${spawnDiagnostics(result)}`
}

/** A capability deadline, not a sleep: run the same PTY wrapper around a trivial /dev/tty child. */
export function probePty(env: NodeJS.ProcessEnv, platform = process.platform, start: ProbeSpawn = spawnSync): string | null {
  if (platform === 'win32') return 'POSIX PTY and /dev/tty are unavailable on Windows'
  const script = 'import os,pty,sys;status=pty.spawn(sys.argv[1:]);sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)'
  const child = 'require("fs").closeSync(require("fs").openSync("/dev/tty","r"));if(!process.stdin.isTTY||!process.stdout.isTTY)process.exit(1);process.stdout.write("PTY READY")'
  return ptyUnavailableReason(start('python3', ['-c', script, process.execPath, '-e', child], {
    env, encoding: 'utf8', timeout: 5000,
  }))
}
