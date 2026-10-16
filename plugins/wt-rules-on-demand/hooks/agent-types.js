// Pure state only: host API calls must remain in hooks.js.
const MAX_AGENT_TYPES = 256;
const agentTypes = new Map();
const lookups = new Map();
const spawning = new Map();
const spawnSequences = new Map();
const failures = new Map();
const retryAt = new Map();
let noRefuseTypes = new Set();
let spawnSequence = 0;
let sequenceFloor = 0;

export function resetAgentTypes() {
  for (const map of [agentTypes, lookups, spawning, spawnSequences, failures, retryAt]) map.clear();
  noRefuseTypes.clear();
  spawnSequence = 0;
  sequenceFloor = 0;
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
export const agentSpawning = (id) => spawning.has(id);
export const pendingAgentType = (id) => lookups.get(id);
const valid = (value) => typeof value === 'string' && value.length > 0;

function boundedSet(map, id, value) {
  if (!map.has(id) && map.size >= MAX_AGENT_TYPES) map.delete(map.keys().next().value);
  map.set(id, value);
}

export function beginAgentSpawn(id) {
  const ticket = { sequence: ++spawnSequence, id };
  if (valid(id)) {
    spawning.set(id, (spawning.get(id) ?? 0) + 1);
    forgetAgentType(id);
  }
  return ticket;
}

export function finishAgentSpawn(ticket) {
  const count = spawning.get(ticket.id);
  if (count > 1) spawning.set(ticket.id, count - 1);
  else spawning.delete(ticket.id);
}

export function recordAgentType(id, type, ticket) {
  if (!valid(id) || ticket.sequence <= sequenceFloor || ticket.sequence < (spawnSequences.get(id) ?? 0)) return;
  if (!spawnSequences.has(id) && spawnSequences.size >= MAX_AGENT_TYPES) {
    const oldest = spawnSequences.keys().next().value;
    sequenceFloor = Math.max(sequenceFloor, spawnSequences.get(oldest));
    spawnSequences.delete(oldest);
    agentTypes.delete(oldest);
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

export function beginAgentLookup(id, now) {
  if (lookups.size >= 32 || now < (retryAt.get(id) ?? 0)) return null;
  const entry = { version: 0, promise: null };
  lookups.set(id, entry);
  return entry;
}

export function finishAgentLookup(id, entry, type, now) {
  if (lookups.get(id) !== entry) return;
  lookups.delete(id);
  if (valid(type)) {
    failures.delete(id);
    retryAt.delete(id);
    if (entry.version === 0 && !agentTypes.has(id) && !agentSpawning(id)) boundedSet(agentTypes, id, type);
  } else {
    const count = (failures.get(id) ?? 0) + 1;
    boundedSet(failures, id, count);
    boundedSet(retryAt, id, now + Math.min(60_000, 1000 * 2 ** (count - 1)));
  }
}
