function unknown(reason) { return { status: 'unknown', reason } }

// Birth identity must not be inferred from signal zero, command text or HTTP fields.
export function readProcessIdentity(platform, invoke, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return unknown('PROCESS_IDENTITY_INVALID_PID')
  if (platform !== 'linux') return unknown(`PROCESS_IDENTITY_UNAVAILABLE on ${platform}`)
  try {
    const stat = invoke.read(`/proc/${pid}/stat`)
    const boot = invoke.read('/proc/sys/kernel/random/boot_id')
    if (stat.status !== 'read' || boot.status !== 'read') return unknown('PROCESS_IDENTITY_UNAVAILABLE')
    return linuxBirthIdentity(pid, stat.value, boot.value.trim())
  } catch { return unknown('PROCESS_IDENTITY_UNAVAILABLE') }
}

function linuxBirthIdentity(pid, stat, bootId) {
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
  const startTicks = fields[19] // /proc stat field 22; preserve its full decimal precision.
  if (!stat.startsWith(`${pid} (`) || !/^[RSDZTtXxKWPI]$/.test(fields[0]) ||
    !/^\d+$/.test(startTicks) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootId)) {
    return unknown('PROCESS_IDENTITY_INVALID')
  }
  return { status: 'known', pid, startIdentity: `linux:${bootId}:${startTicks}` }
}
