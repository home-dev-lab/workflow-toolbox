// Pure state only: host API calls must remain in hooks.js.
const MAX_AGENT_TYPES = 256;
const MAX_HOST_LOOKUPS = 32;
const agentTypes = new Map();
const lookups = new Map();
const spawning = new Map();
const spawnSequences = new Map();
// id -> { count, at }: a retry deadline is never evicted before it passes, so cycling identities cannot shorten it.
const retries = new Map();
let noRefuseTypes = new Set();
let spawnSequence = 0;
let sequenceFloor = 0;
// Resumes past the spawning bound are counted, not dropped: while any is in flight, no agent is waived.
let untrackedSpawns = 0;
// Host agent-list requests sent and not yet settled. A deadline frees the waiting call, never the request, and the
// count deliberately survives a reset: the requests are still outstanding on the host.
let hostLookups = 0;
let epoch = 0;

export function resetAgentTypes() {
  for (const map of [agentTypes, lookups, spawning, spawnSequences, retries]) map.clear();
  noRefuseTypes.clear();
  spawnSequence = 0;
  sequenceFloor = 0;
  untrackedSpawns = 0;
  epoch++;
}

export function parseAgentTypes(value) {
  return typeof value === 'string' ? value.split(',').map((name) => name.trim()).filter(Boolean) : [];
}

export function configureAgentTypes(value) {
  const parsed = new Set(parseAgentTypes(value));
  if (parsed.size !== noRefuseTypes.size || [...parsed].some((type) => !noRefuseTypes.has(type))) noRefuseTypes = parsed;
  return noRefuseTypes.size > 0;
}

export const agentTypeOptOutConfigured = () => noRefuseTypes.size > 0;
export const neverRefuseType = (type) => noRefuseTypes.has(type);
export const knownAgentType = (id) => agentTypes.get(id);
export const agentSpawning = (id) => untrackedSpawns > 0 || spawning.has(id);
export const pendingAgentType = (id) => lookups.get(id);
const valid = (value) => typeof value === 'string' && value.length > 0;

function boundedSet(map, id, value) {
  if (!map.has(id) && map.size >= MAX_AGENT_TYPES) map.delete(map.keys().next().value);
  map.set(id, value);
}

export function beginAgentSpawn(id) {
  const ticket = { sequence: ++spawnSequence, id, epoch, mark: null };
  if (valid(id)) {
    if (spawning.has(id) || spawning.size < MAX_AGENT_TYPES) {
      spawning.set(id, (spawning.get(id) ?? 0) + 1);
      ticket.mark = 'tracked';
    } else {
      untrackedSpawns++;
      ticket.mark = 'untracked';
    }
    forgetAgentType(id);
  }
  return ticket;
}

export function finishAgentSpawn(ticket) {
  if (ticket.epoch !== epoch) return;
  if (ticket.mark === 'untracked') untrackedSpawns--;
  if (ticket.mark !== 'tracked') return;
  const count = spawning.get(ticket.id);
  if (count > 1) spawning.set(ticket.id, count - 1);
  else spawning.delete(ticket.id);
}

export function recordAgentType(id, type, ticket) {
  if (!valid(id) || ticket.epoch !== epoch) return;
  const recorded = spawnSequences.get(id);
  // A record for this id is always newer than any evicted one, so it orders the ticket. With no record, a newer one
  // may have been evicted: the completion cannot be ordered, so it leaves no type standing either way.
  if (recorded !== undefined ? ticket.sequence < recorded : ticket.sequence <= sequenceFloor) {
    if (recorded === undefined) forgetAgentType(id);
    return;
  }
  if (recorded === undefined && spawnSequences.size >= MAX_AGENT_TYPES) {
    const oldest = spawnSequences.keys().next().value;
    sequenceFloor = Math.max(sequenceFloor, spawnSequences.get(oldest));
    spawnSequences.delete(oldest);
    forgetAgentType(oldest);
  }
  spawnSequences.set(id, ticket.sequence);
  forgetAgentType(id);
  if (valid(type)) boundedSet(agentTypes, id, type);
}

export function forgetAgentType(id) {
  const pending = lookups.get(id);
  if (pending) pending.version++;
  agentTypes.delete(id);
}

function dropPassedRetries(now) {
  for (const [id, retry] of retries) if (retry.at <= now) retries.delete(id);
}

// Pending lookups plus retry deadlines never exceed the bound, so recording a failure never has to evict a deadline.
export function beginAgentLookup(id, now) {
  if (now < (retries.get(id)?.at ?? 0) || hostLookups >= MAX_HOST_LOOKUPS) return null;
  if (lookups.size + retries.size >= MAX_AGENT_TYPES) dropPassedRetries(now);
  if (lookups.size + retries.size >= MAX_AGENT_TYPES) return null;
  hostLookups++;
  const entry = { version: 0, promise: null, outstanding: true };
  lookups.set(id, entry);
  return entry;
}

// Called once the host request itself settles, or at once when it could not be sent.
export function settleAgentLookup(entry) {
  if (!entry.outstanding) return;
  entry.outstanding = false;
  hostLookups--;
}

export function finishAgentLookup(id, entry, type, now) {
  if (lookups.get(id) !== entry) return;
  lookups.delete(id);
  if (valid(type)) {
    retries.delete(id);
    if (entry.version === 0 && !agentTypes.has(id) && !agentSpawning(id)) boundedSet(agentTypes, id, type);
  } else {
    const count = (retries.get(id)?.count ?? 0) + 1;
    retries.set(id, { count, at: now + Math.min(60_000, 1000 * 2 ** (count - 1)) });
  }
}
