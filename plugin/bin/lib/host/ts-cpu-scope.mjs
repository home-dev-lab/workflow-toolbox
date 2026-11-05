import { spawnSync } from 'node:child_process'

const WEIGHT_PROBE = `const fs = require('node:fs');
const group = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\\n').find(line => line.startsWith('0::'));
if (!group) process.exit(1);
const weight = fs.readFileSync('/sys/fs/cgroup' + group.slice(3) + '/cpu.weight', 'utf8').trim();
process.exit(weight === '1' ? 0 : 1);`

// An existing user manager is optional. Probe the actual CPUWeight property and
// launch permission, rather than inferring support from a binary on PATH.
export function tsCpuScope({ platform = process.platform, probe = spawnSync, stderr = process.stderr } = {}) {
  if (platform !== 'linux') return { status: 'unavailable', reason: 'Linux user scopes only' }
  const args = ['--user', '--scope', '--quiet', '-p', 'CPUWeight=1', '--']
  try {
    const result = probe('systemd-run', [...args, process.execPath, '-e', WEIGHT_PROBE], { timeout: 2000, stdio: 'ignore' })
    if (result.status === 0) {
      stderr.write('wt-tsls: user scope CPUWeight=1 available; relative sibling-cgroup weight, not a CPU cap\n')
      return { status: 'available', command: 'systemd-run', args }
    }
  } catch { /* Optional installed service, never a startup dependency. */ }
  stderr.write('wt-tsls: low-weight scope unavailable (systemd user CPUWeight probe failed); nice-only fallback, cross-cgroup CPU share unknown\n')
  return { status: 'unavailable', reason: 'systemd user CPUWeight probe failed' }
}
