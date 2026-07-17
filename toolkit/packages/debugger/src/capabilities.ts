// capabilities.ts — the per-run CAPABILITIES section of a delegated launch's
// args (card #1820698986697196666; feeds the composer capability-registry design
// #1820675961738232936).
//
// Contract: `--args` JSON may carry a `capabilities` section that the
// delegated-run server composes VERBATIM into the SDK query() options at
// launch — per-run tool provisioning is DATA (args→query()), while a reusable
// specialist identity (prompt+model+tools) is an AGENT (the `agents` map here,
// or a plugin-dir shim). The section is machine-owned (the requester's local
// tooling), never shipped inside a workflow script.
//
//   capabilities: {
//     mcpServers?: { <name>: <SDK McpServerConfig> },   // per-run MCP servers
//     agents?:     { <name>: <SDK AgentDefinition> },   // per-role identities
//     skills?:     string[],                            // SDK skill enable-filter
//   }
//
// Both sides share THIS module: the launcher validates early (fail fast
// client-side, loud on typos — an unknown key is an error, not a silent no-op),
// and the server calls `composeCapabilityOptions` on the validated spec.
// Types are STRUCTURAL (no SDK import): this package must stay dependency-light,
// and the SDK owns deep validation of server configs / agent definitions at
// query() time. E2e semantics proven by packages/smoke/src/capabilities-probe.ts
// (bare session + composed mcpServers/agents → subagents see and call the MCP
// tools; exact-name allowlists fence them).

export interface CapabilityAgentDef {
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  effort?: string | number
  maxTurns?: number
  mcpServers?: unknown[]
}

export interface CapabilitiesSpec {
  mcpServers?: Record<string, Record<string, unknown>>
  agents?: Record<string, CapabilityAgentDef>
  skills?: string[]
}

const SECTION_KEYS = new Set(['mcpServers', 'agents', 'skills'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/** Keys any of which make an mcpServers entry launchable/connectable — the SDK
 *  validates the full config shape; we only reject the obviously-degenerate. */
const MCP_ANCHOR_KEYS = ['command', 'url', 'type']

function validateMcpServers(v: unknown, errors: string[]): CapabilitiesSpec['mcpServers'] {
  if (!isRecord(v)) {
    errors.push('capabilities.mcpServers must be an object map of server-name → server config')
    return undefined
  }
  for (const [name, cfg] of Object.entries(v)) {
    if (!isRecord(cfg)) {
      errors.push(`capabilities.mcpServers.${name} must be an object (server config)`)
    } else if (!MCP_ANCHOR_KEYS.some((k) => k in cfg)) {
      errors.push(`capabilities.mcpServers.${name} lacks any of ${MCP_ANCHOR_KEYS.join('/')} — not a launchable server config`)
    }
  }
  return v as CapabilitiesSpec['mcpServers']
}

function validateAgents(v: unknown, errors: string[]): CapabilitiesSpec['agents'] {
  if (!isRecord(v)) {
    errors.push('capabilities.agents must be an object map of agent-name → agent definition')
    return undefined
  }
  for (const [name, def] of Object.entries(v)) {
    if (!isRecord(def)) {
      errors.push(`capabilities.agents.${name} must be an object (agent definition)`)
      continue
    }
    if (typeof def['description'] !== 'string') errors.push(`capabilities.agents.${name} needs a string description`)
    if (typeof def['prompt'] !== 'string') errors.push(`capabilities.agents.${name} needs a string prompt`)
    if ('tools' in def && !isStringArray(def['tools'])) errors.push(`capabilities.agents.${name}.tools must be a string array`)
    if ('disallowedTools' in def && !isStringArray(def['disallowedTools'])) errors.push(`capabilities.agents.${name}.disallowedTools must be a string array`)
  }
  return v as CapabilitiesSpec['agents']
}

/** Read + validate the `capabilities` section of a launch's args.
 *  - args without a section (or non-object args) → `{ spec: null, errors: [] }`
 *  - a malformed section → `spec: null` and EVERY problem listed in `errors`
 *    (one pass, so the operator fixes them all at once). */
export function extractCapabilities(args: unknown): { spec: CapabilitiesSpec | null; errors: string[] } {
  if (!isRecord(args) || !('capabilities' in args)) return { spec: null, errors: [] }
  const raw = args['capabilities']
  if (!isRecord(raw)) return { spec: null, errors: ['capabilities must be an object ({ mcpServers?, agents?, skills? })'] }
  const errors: string[] = []
  for (const key of Object.keys(raw)) {
    if (!SECTION_KEYS.has(key)) errors.push(`capabilities.${key} is not a known section (known: ${[...SECTION_KEYS].join(', ')})`)
  }
  const spec: CapabilitiesSpec = {}
  if ('mcpServers' in raw) {
    const m = validateMcpServers(raw['mcpServers'], errors)
    if (m !== undefined) spec.mcpServers = m
  }
  if ('agents' in raw) {
    const a = validateAgents(raw['agents'], errors)
    if (a !== undefined) spec.agents = a
  }
  if ('skills' in raw) {
    if (!isStringArray(raw['skills'])) errors.push('capabilities.skills must be a string array (SDK skill enable-filter)')
    else spec.skills = raw['skills']
  }
  return errors.length > 0 ? { spec: null, errors } : { spec, errors: [] }
}

/** The query() options fragment for a VALIDATED spec — exactly the present
 *  sections, nothing invented. The server spreads this into its launch options
 *  (after its own settingSources/strictMcpConfig posture, which this fragment
 *  deliberately does not touch). */
export function composeCapabilityOptions(spec: CapabilitiesSpec): Record<string, unknown> {
  return {
    ...(spec.mcpServers !== undefined ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.agents !== undefined ? { agents: spec.agents } : {}),
    ...(spec.skills !== undefined ? { skills: spec.skills } : {}),
  }
}
