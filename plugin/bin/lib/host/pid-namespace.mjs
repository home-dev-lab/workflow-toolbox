import { readdirSync, readFileSync, readlinkSync } from 'node:fs'

// A process's start time (jiffies since boot, /proc/<pid>/stat field 22). Recorded beside a PID so a
// reused PID does not read as the same process. Lives here (the host perimeter) because it reads
// /proc directly. null off Linux or when the process is gone.
export function processStartTime(pid, readFile = (file) => readFileSync(file, 'utf8')) {
  try {
    const stat = readFile(`/proc/${pid}/stat`)
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const start = Number(fields[19])
    return Number.isFinite(start) ? start : null
  } catch { return null }
}

// Linux PID namespaces, as seen through /proc. A lane sandbox (lane-sandbox.mjs) runs in its own
// PID namespace, so a PID recorded inside it names a different process on the host, and a host PID
// does not exist inside it. Elsewhere these read as `null`: "cannot tell", never "same".

export function currentPidNamespace(readLink = readlinkSync) {
  try { return readLink('/proc/self/ns/pid') } catch { return null }
}

// true: a visible process lives in that namespace. false: none visible. A caller inside a child
// namespace cannot see its parent's processes, so `false` proves death only when read from the host.
export function pidNamespaceHasProcesses(namespace, { readDirectory = readdirSync, readLink = readlinkSync } = {}) {
  let entries
  try { entries = readDirectory('/proc') } catch { return null }
  return entries.some((name) => {
    if (!/^\d+$/.test(name)) return false
    try { return readLink(`/proc/${name}/ns/pid`) === namespace } catch { return false }
  })
}
