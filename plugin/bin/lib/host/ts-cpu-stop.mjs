// Never infer ownership from the most recent sample: the birth is pinned at spawn.
const sameBirth = (current, pinned) => current.status === 'measured' && current.process.pid === pinned.pid && current.process.identity === pinned.identity

async function ownedBackend(context) {
  const current = await context.readIdentity(context.child.pid)
  return context.active() && sameBirth(current, context.pinned) && current.process.pgid === context.child.pid
}

async function verifyTargets(context, sample, breach) {
  const current = await context.readFamily(context.child.pid)
  if (!context.active() || current.status !== 'measured') return undefined
  if (current.parent.identity !== context.pinned.identity || current.parent.identity !== sample.parent.identity || current.parent.pgid !== context.child.pid) return undefined
  const targets = []
  for (const server of breach.servers) {
    if (!current.servers.some((candidate) => candidate.identity === server.identity && candidate.pid === server.pid)) return undefined
    const identity = await context.readIdentity(server.pid)
    if (!context.active() || !sameBirth(identity, server)) return undefined
    targets.push(identity.process)
  }
  return targets
}

async function signalEscaped(context, server) {
  if (!await ownedBackend(context)) return false
  const current = await context.readIdentity(server.pid)
  if (!context.active() || !sameBirth(current, server)) return false
  context.kill(server.pid, 'SIGKILL')
  return true
}

async function signalTargets(context, targets) {
  let signalled = false
  try {
    for (const server of targets) if (server.pgid !== context.child.pid) {
      if (!await signalEscaped(context, server)) return signalled
      signalled = true
    }
    if (!await ownedBackend(context)) return signalled
    context.kill(-context.child.pid, 'SIGKILL')
    return true
  } catch { return signalled }
}

export async function stopTsCpuFamily(context, sample, breach) {
  const targets = await verifyTargets(context, sample, breach)
  if (!targets || !await signalTargets(context, targets)) return { status: 'unavailable' }
  // Give SIGKILL delivery/reaping one turn, then take exactly one independent PID
  // census: escaped children are reparented when the backend dies.
  await context.settle()
  const after = await context.census([context.child.pid, ...targets.map((server) => server.pid)])
  if (after.status !== 'measured') return { status: 'unverified' }
  const expected = [context.pinned, ...targets]
  const survivors = after.processes.filter((process) => expected.some((target) => process.pid === target.pid && process.identity === target.identity))
  return survivors.length ? { status: 'survived', survivors } : { status: 'stopped' }
}
