const RELAY = 'relay'

export function sessionRole(env = process.env) {
  return String(env.WT_SESSION_ROLE || '').trim().toLowerCase() === RELAY ? RELAY : 'principal'
}

export function relaySkipLine(watcherName, env = process.env) {
  if (sessionRole(env) !== RELAY) return null
  return `${watcherName} NOT ARMED: relay session (WT_SESSION_ROLE=relay) — this session only relays; it cannot act on this watcher's events`
}
