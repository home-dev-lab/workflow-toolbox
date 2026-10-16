// Pure state only: host API calls must remain in hooks.js.
const MAX_AGENT_TYPES = 256;
const agentTypes = new Map();
const lookups = new Map();
let noRefuseTypes = new Set();

export function resetAgentTypes() {
  agentTypes.clear();
  lookups.clear();
  noRefuseTypes.clear();
}

export function parseAgentTypes(value) {
  return typeof value === 'string' ? value.split(',').map((name) => name.trim()).filter(Boolean) : [];
}

export function configureAgentTypes(value) {
  const parsed = new Set(parseAgentTypes(value));
  if (parsed.size === noRefuseTypes.size && [...parsed].every((type) => noRefuseTypes.has(type))) return noRefuseTypes.size > 0;
  resetAgentTypes();
  noRefuseTypes = parsed;
  return noRefuseTypes.size > 0;
}

export const agentTypeOptOutConfigured = () => noRefuseTypes.size > 0;
export const neverRefuseType = (type) => noRefuseTypes.has(type);
export const knownAgentType = (id) => agentTypes.get(id);

export const pendingAgentType = (id) => lookups.get(id);
export function beginAgentLookup(id) {
  const entry = { version: 0, promise: null };
  lookups.set(id, entry);
  return entry;
}
export function finishAgentLookup(id, entry) {
  if (lookups.get(id) === entry) lookups.delete(id);
}

export function forgetAgentType(id) {
  const pending = lookups.get(id);
  if (pending) pending.version++;
  agentTypes.delete(id);
}

export function recordAgentType(id, type) {
  const pending = lookups.get(id);
  if (pending) pending.version++;
  if (typeof type === 'string' && type) rememberAgentType(id, type);
  else agentTypes.delete(id);
}

// Completed positive evidence and in-flight work have separate lifetimes.
export function rememberAgentType(id, type) {
  if (typeof id !== 'string' || !id) return;
  if (!agentTypes.has(id) && agentTypes.size >= MAX_AGENT_TYPES) agentTypes.delete(agentTypes.keys().next().value);
  agentTypes.set(id, type);
}
