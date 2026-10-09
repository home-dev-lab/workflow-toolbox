import { dirname } from 'node:path'

// A PATH for tests that launch lanes through the lane sandbox. On Linux the sandbox mounts the
// directory of every toolchain executable it finds on PATH (node, pnpm, npm, git) and runs `find`
// over each mounted tree to mask unix sockets, once per sandboxed spawn. Inheriting the host PATH
// makes the test's cost depend on the machine: under WSL a Windows-side pnpm under /mnt/c puts a
// whole Windows node tree on 9P in that scan, which measured ~12 s per verifier run at load 22-26
// against ~1 s with this PATH. So on POSIX the PATH is the fixture's own directories, the running
// node's directory and the system directories, nothing inherited. Windows has no lane sandbox and
// resolves `.cmd` shims through the inherited PATH, so it keeps it.
// The sbin directories stay: the lane supervisor reads a macOS process's cwd with `lsof`, which
// macOS ships in /usr/sbin. Without them every cwd reads as unknown and the cwd guards refuse.
const POSIX_SYSTEM_DIRS = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

export function hermeticPath(
  prepend: readonly string[],
  platform: NodeJS.Platform = process.platform,
  inherited: string | undefined = process.env.PATH,
  execPath: string = process.execPath,
): string {
  if (platform === 'win32') return [...prepend, ...(inherited ? [inherited] : [])].join(';')
  return [...new Set([...prepend, dirname(execPath), ...POSIX_SYSTEM_DIRS])].join(':')
}
