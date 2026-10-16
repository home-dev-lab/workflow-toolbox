// Pure state only: host API calls must remain in hooks.js.
const MAX_AGENT_TYPES = 256;
const agentTypes = new Map();
let noRefuseTypes = new Set();

export function resetAgentTypes() {
  agentTypes.clear();
  noRefuseTypes.clear();
}

export function parseAgentTypes(value) {
  return typeof value === 'string' ? value.split(',').map((name) => name.trim()).filter(Boolean) : [];
}

export function configureAgentTypes(value) {
  resetAgentTypes();
  noRefuseTypes = new Set(parseAgentTypes(value));
  return noRefuseTypes.size > 0;
}

export const agentTypeOptOutConfigured = () => noRefuseTypes.size > 0;
export const neverRefuseType = (type) => noRefuseTypes.has(type);
export const knownAgentType = (id) => agentTypes.get(id);

// A cached lookup promise also remembers misses and shares concurrent lookups.
export function rememberAgentType(id, type) {
  if (typeof id !== 'string' || !id) return;
  if (!agentTypes.has(id) && agentTypes.size >= MAX_AGENT_TYPES) agentTypes.delete(agentTypes.keys().next().value);
  agentTypes.set(id, type);
}
