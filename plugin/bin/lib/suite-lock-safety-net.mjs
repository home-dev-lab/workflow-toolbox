const STOP_DEADLINE_MS = 20_000
const SETTLE_MS = 5000
const finite = (value) => Number.isFinite(value) && value >= 0
const age = (holder, sequenced) => {
  const primary = sequenced ? holder.admittedSequence : holder.startedAtMs
  return finite(primary) ? primary : finite(holder.admittedSequence) ? holder.admittedSequence : -Infinity
}
const priority = (holder, index) => holder.watchdogPriority?.[index] ?? (index === 0 ? 2 : holder.level ?? 1)

function victimOrder(left, right, sequenced) {
  const ordered = priority(right, 0) - priority(left, 0) || priority(right, 1) - priority(left, 1)
  if (ordered) return ordered
  if (age(left, sequenced) !== age(right, sequenced)) return age(left, sequenced) > age(right, sequenced) ? -1 : 1
  return String(left.leaseId) < String(right.leaseId) ? -1 : String(left.leaseId) > String(right.leaseId) ? 1 : 0
}

export function selectMemoryVictim(holders, memory, { now = Date.now(), lastStopConfirmedAt = 0 } = {}) {
  if (!freshLowMemory(memory, now) || !memorySettled(memory, now, lastStopConfirmedAt)) return null
  if (holders.some((holder) => holder.stop && !holder.stop.abandoned)) return null
  const eligible = holders.filter((holder) => !holder.stop)
  const ordinary = eligible.filter((holder) => holder.priority !== 'release')
  const candidates = ordinary.length ? ordinary : eligible
  const sequenced = candidates.every((holder) => finite(holder.admittedSequence))
  return candidates.sort((left, right) => victimOrder(left, right, sequenced))[0] ?? null
}

function freshLowMemory(memory, now) {
  if (memory?.unknown || !finite(memory?.availableMiB) || !finite(memory?.floorMiB)) return false
  const sampledAt = memory.sampledAt ?? now
  return sampledAt <= now && now - sampledAt <= 5000 && memory.availableMiB < memory.floorMiB
}

function memorySettled(memory, now, confirmed) {
  return !confirmed || (now - confirmed >= SETTLE_MS && (memory.sampledAt ?? now) > confirmed)
}

export function expireMemoryStops(holders, now) {
  for (const holder of holders) {
    if (holder.stop && now > (holder.stop.deadline ?? holder.stop.at + STOP_DEADLINE_MS)) holder.stop.abandoned = true
  }
}

export function memoryStopRequest(machine, now) {
  return { cause: 'memory-pressure', at: now, deadline: now + STOP_DEADLINE_MS,
    ...(machine.floorOverrideMiB === undefined ? {} : { floorOverrideMiB: machine.floorOverrideMiB }) }
}
