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
    targets.push({ ...identity.process })
  }
  return targets
}

const stopped = (process) => ['T', 't', 'Z', 'X'].includes(process.state)

async function signalProcess(context, target, signal) {
  if (!await ownedBackend(context)) return false
  const current = await context.readIdentity(target.pid)
  if (!context.active() || !sameBirth(current, target)) return false
  context.kill(target.pid, signal)
  return true
}

async function verifiedLineage(context, target, tree) {
  const nodes = new Map([tree.parent, ...tree.processes].map((node) => [node.pid, node]))
  const seen = new Set()
  let member = target
  while (member.pid !== context.child.pid) {
    if (seen.has(member.pid)) return false
    seen.add(member.pid)
    const current = await context.readIdentity(member.pid)
    if (!context.active() || !sameBirth(current, member)) return false
    if (current.process.ppid !== member.ppid) return false
    if (current.process.pgid === context.child.pid) return ownedBackend(context)
    member = nodes.get(member.ppid)
    if (!member) return false
  }
  return ownedBackend(context)
}

async function freezeMembers(context, tree, targets) {
  let quiet = stopped(tree.parent)
  for (const target of tree.processes) {
    if (!await verifiedLineage(context, target, tree)) return undefined
    targets.set(`${target.pid}/${target.identity}`, { ...target })
    if (stopped(target)) continue
    quiet = false
    if (!await signalProcess(context, target, 'SIGSTOP')) return undefined
  }
  return quiet
}

async function freezeTree(context, targets) {
  if (!await ownedBackend(context)) return false
  context.kill(-context.child.pid, 'SIGSTOP')
  // Freeze before the final walk: a stopped tree cannot fork an omitted sibling.
  let previous
  for (let attempt = 0; attempt < 5; attempt++) {
    await context.settle()
    const tree = await context.readTree(context.child.pid)
    if (!context.active() || tree.status !== 'measured') return false
    if (!sameBirth({ status: 'measured', process: tree.parent }, context.pinned)) return false
    const quiet = await freezeMembers(context, tree, targets)
    if (quiet === undefined) return false
    const snapshot = tree.processes.map((target) => `${target.pid}/${target.identity}`).sort().join(',')
    if (quiet && snapshot === previous) return true
    previous = snapshot
  }
  return false
}

async function signalTargets(context, targets) {
  const unknown = []
  for (const target of targets) {
    let current
    try {
      // Once tracked, a birth remains owned even after the backend exits.
      current = await context.readIdentity(target.pid)
    } catch { unknown.push(target); continue }
    if (current.status !== 'measured') unknown.push(target)
    else if (context.active() && sameBirth(current, target)) {
      try { context.kill(target.pid, 'SIGKILL') } catch { /* A readable census decides whether a failed signal left a survivor. */ }
    }
  }
  try {
    if (await ownedBackend(context)) context.kill(-context.child.pid, 'SIGKILL')
  } catch { /* A successful signal is not the termination verdict; the census is. */ }
  return unknown
}

function stopResult(context, state, status, extra = {}) {
  return { status, attempted: state.attempted, targets: [context.pinned, ...state.targets.values()],
    scope: 'tracked set', untrackedDescendants: 'unknown', ...extra }
}

async function censusTargets(context, state, unknown) {
  const after = await context.census([...new Set(state.remaining.map((target) => target.pid))])
  if (after.status !== 'measured') return stopResult(context, state, 'unknown', { unknown: state.remaining })
  const survivors = after.processes.filter((process) => state.remaining.some((target) => sameBirth({ status: 'measured', process }, target)))
  state.remaining = state.remaining.filter((target) => survivors.some((process) => process.pid === target.pid))
  if (unknown.length) return stopResult(context, state, 'unknown', { unknown })
  return survivors.length ? stopResult(context, state, 'survived', { survivors }) : stopResult(context, state, 'stopped')
}

export async function stopTsCpuFamily(context, sample, breach) {
  let state = context.cpuStop
  try {
    if (!state) {
      const verified = await verifyTargets(context, sample, breach)
      if (!verified) return { status: 'unknown', attempted: false, targets: [], unknown: breach.servers, scope: 'tracked set', untrackedDescendants: 'unknown' }
      state = context.cpuStop = { targets: new Map(verified.map((target) => [`${target.pid}/${target.identity}`, target])), attempted: false }
    }
    if (!state.ready) {
      state.attempted ||= await ownedBackend(context)
      if (!state.attempted || !await freezeTree(context, state.targets)) return stopResult(context, state, 'unknown', { unknown: [context.pinned, ...state.targets.values()] })
      state.ready = true
      state.remaining = [context.pinned, ...state.targets.values()]
    }
    const unknown = await signalTargets(context, state.remaining)
    await context.settle()
    return await censusTargets(context, state, unknown)
  } catch {
    return state ? stopResult(context, state, 'unknown', { unknown: state.remaining ?? [context.pinned, ...state.targets.values()] })
      : { status: 'unknown', attempted: false, targets: [], unknown: breach.servers, scope: 'tracked set', untrackedDescendants: 'unknown' }
  }
}
