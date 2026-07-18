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
//     mcpServers?:          { <name>: <SDK McpServerConfig> },  // per-run MCP servers
//     agents?:              { <name>: <SDK AgentDefinition> },  // per-role identities
//     skills?:              string[],                           // SDK skill enable-filter
//     skillOverrides?:      { <skill>: 'on'|'name-only'|'user-invocable-only'|'off' },
//     disableBundledSkills?: boolean,                           // drop the binary's built-in skills
//   }
//
// The last two feed the SETTINGS layer (SDK Options.settings). A delegated run
// starts ZERO-skill by default (BARE_SKILLS_SETTINGS below) — the server composes
// that default and deep-merges any spec-declared skillOverrides/disableBundledSkills
// OVER it (spec wins per key; see mergeSkillSettings). composeCapabilityOptions here
// only emits the SPEC's own fragment; it never carries the default.
//
// Both sides share THIS module: the launcher validates early (fail fast
// client-side, loud on typos — an unknown key is an error, not a silent no-op),
// and the server calls `composeCapabilityOptions` on the validated spec.
// Types are STRUCTURAL (no SDK import): this package must stay dependency-light,
// and the SDK owns deep validation of server configs / agent definitions at
// query() time. E2e semantics proven by packages/smoke/src/capabilities-probe.ts
// (bare session + composed mcpServers/agents → subagents see and call the MCP
// tools; exact-name allowlists fence them).

import { FORBIDDEN_ENTRY_NAMES, isRecord } from './validator-shared.js'

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

/** The four skill-override modes the SDK's `Settings.skillOverrides` accepts. An
 *  unknown mode is a TYPO ("loud on typos"), rejected at validation. */
export type SkillOverrideMode = 'on' | 'name-only' | 'user-invocable-only' | 'off'

export interface CapabilitiesSpec {
  mcpServers?: Record<string, Record<string, unknown>>
  agents?: Record<string, CapabilityAgentDef>
  skills?: string[]
  skillOverrides?: Record<string, SkillOverrideMode>
  disableBundledSkills?: boolean
}

const SECTION_KEYS = new Set(['mcpServers', 'agents', 'skills', 'skillOverrides', 'disableBundledSkills'])

const SKILL_OVERRIDE_MODES = new Set<SkillOverrideMode>(['on', 'name-only', 'user-invocable-only', 'off'])

/** The zero-skill default for a delegated launch (design §6.1). `disableBundledSkills`
 *  drops the binary's built-in skills; `doctor` SURVIVES disableBundledSkills (a harness
 *  quirk, cc 2.1.2xx), so the explicit override is the belt — a no-op if a future binary
 *  stops shipping doctor as a survivor. The server composes THIS into every delegated
 *  query()'s settings and deep-merges spec-declared skill settings over it. */
export const BARE_SKILLS_SETTINGS: {
  disableBundledSkills: boolean
  skillOverrides: Record<string, SkillOverrideMode>
} = {
  disableBundledSkills: true,
  skillOverrides: { doctor: 'off' },
}

/** The SDK AgentDefinition field set (0.3.205) — an unknown key inside an agent
 *  definition is a TYPO until proven otherwise ("loud on typos"); when the SDK
 *  grows a field, add it here in the same change that starts passing it. */
const AGENT_DEF_KEYS = new Set([
  'description', 'tools', 'disallowedTools', 'prompt', 'model', 'mcpServers',
  'criticalSystemReminder_EXPERIMENTAL', 'skills', 'initialPrompt', 'maxTurns',
  'background', 'memory', 'effort', 'permissionMode', 'observer', 'observerMessage',
])

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function checkEntryNames(map: Record<string, unknown>, path: string, errors: string[]): void {
  for (const name of Object.keys(map)) {
    if (FORBIDDEN_ENTRY_NAMES.has(name)) errors.push(`${path}.${name} is a forbidden entry name (prototype-collision defence)`)
  }
}

/** Keys any of which make an mcpServers entry launchable/connectable — the SDK
 *  validates the full config shape; we reject the obviously-degenerate AND
 *  wrong-typed anchor values (a `command: null` would otherwise ride to the
 *  server and die far from the operator). */
const MCP_ANCHOR_KEYS = ['command', 'url', 'type']

function validateMcpServers(v: unknown, errors: string[]): CapabilitiesSpec['mcpServers'] {
  if (!isRecord(v)) {
    errors.push('capabilities.mcpServers must be an object map of server-name → server config')
    return undefined
  }
  checkEntryNames(v, 'capabilities.mcpServers', errors)
  for (const [name, cfg] of Object.entries(v)) {
    if (!isRecord(cfg)) {
      errors.push(`capabilities.mcpServers.${name} must be an object (server config)`)
      continue
    }
    if (!MCP_ANCHOR_KEYS.some((k) => k in cfg)) {
      errors.push(`capabilities.mcpServers.${name} lacks any of ${MCP_ANCHOR_KEYS.join('/')} — not a launchable server config`)
    }
    for (const k of MCP_ANCHOR_KEYS) {
      if (k in cfg && typeof cfg[k] !== 'string') errors.push(`capabilities.mcpServers.${name}.${k} must be a string`)
    }
  }
  return v as CapabilitiesSpec['mcpServers']
}

function validateAgents(v: unknown, errors: string[]): CapabilitiesSpec['agents'] {
  if (!isRecord(v)) {
    errors.push('capabilities.agents must be an object map of agent-name → agent definition')
    return undefined
  }
  checkEntryNames(v, 'capabilities.agents', errors)
  for (const [name, def] of Object.entries(v)) {
    if (FORBIDDEN_ENTRY_NAMES.has(name)) continue
    if (!isRecord(def)) {
      errors.push(`capabilities.agents.${name} must be an object (agent definition)`)
      continue
    }
    for (const key of Object.keys(def)) {
      if (!AGENT_DEF_KEYS.has(key)) errors.push(`capabilities.agents.${name}.${key} is not a known AgentDefinition field (typo?)`)
    }
    if (typeof def['description'] !== 'string') errors.push(`capabilities.agents.${name} needs a string description`)
    if (typeof def['prompt'] !== 'string') errors.push(`capabilities.agents.${name} needs a string prompt`)
    if ('tools' in def && !isStringArray(def['tools'])) errors.push(`capabilities.agents.${name}.tools must be a string array`)
    // A `$cap:<need>` token reaching the SERVER is a resolver bypass — the launcher's
    // capability resolver must expand every placeholder to concrete tools BEFORE the
    // args are composed (design §5.2). Fail loud, naming the offending token.
    // Scope is DELIBERATELY `tools` only: §5.2 places placeholders exclusively in an
    // agent's `tools` array, so that is the only field where an unexpanded `$cap:` is a
    // real resolver bypass. The same token in `disallowedTools`/`skills` would be an inert
    // literal (no resolver step, no such tool/skill) — intentionally NOT scanned here; if a
    // future extension ever expands `$cap:` beyond `tools`, widen this scan to match.
    else if ('tools' in def && isStringArray(def['tools'])) {
      for (const t of def['tools']) {
        if (t.startsWith('$cap:')) errors.push(`capabilities.agents.${name}.tools contains an unresolved placeholder "${t}" — $cap:<need> tokens must be expanded by the launcher's resolver before reaching the server`)
      }
    }
    if ('disallowedTools' in def && !isStringArray(def['disallowedTools'])) errors.push(`capabilities.agents.${name}.disallowedTools must be a string array`)
    if ('skills' in def && !isStringArray(def['skills'])) errors.push(`capabilities.agents.${name}.skills must be a string array`)
    if ('model' in def && typeof def['model'] !== 'string') errors.push(`capabilities.agents.${name}.model must be a string`)
    if ('effort' in def && typeof def['effort'] !== 'string' && typeof def['effort'] !== 'number') errors.push(`capabilities.agents.${name}.effort must be a string or number`)
    if ('maxTurns' in def && typeof def['maxTurns'] !== 'number') errors.push(`capabilities.agents.${name}.maxTurns must be a number`)
    if ('background' in def && typeof def['background'] !== 'boolean') errors.push(`capabilities.agents.${name}.background must be a boolean`)
    if ('mcpServers' in def && !Array.isArray(def['mcpServers'])) errors.push(`capabilities.agents.${name}.mcpServers must be an array (SDK AgentMcpServerSpec[])`)
    for (const strField of ['memory', 'permissionMode', 'initialPrompt', 'criticalSystemReminder_EXPERIMENTAL', 'observer', 'observerMessage']) {
      if (strField in def && typeof def[strField] !== 'string') errors.push(`capabilities.agents.${name}.${strField} must be a string`)
    }
  }
  return v as CapabilitiesSpec['agents']
}

function validateSkillOverrides(v: unknown, errors: string[]): CapabilitiesSpec['skillOverrides'] {
  if (!isRecord(v)) {
    errors.push(`capabilities.skillOverrides must be an object map of skill-name → mode (${[...SKILL_OVERRIDE_MODES].join('|')})`)
    return undefined
  }
  checkEntryNames(v, 'capabilities.skillOverrides', errors)
  for (const [skill, mode] of Object.entries(v)) {
    if (FORBIDDEN_ENTRY_NAMES.has(skill)) continue
    if (typeof mode !== 'string' || !SKILL_OVERRIDE_MODES.has(mode as SkillOverrideMode)) {
      errors.push(`capabilities.skillOverrides.${skill} must be one of ${[...SKILL_OVERRIDE_MODES].join('|')} (got ${JSON.stringify(mode)})`)
    }
  }
  return v as CapabilitiesSpec['skillOverrides']
}

/** Read + validate the `capabilities` section of a launch's args.
 *  - args without a section (or non-object args) → `{ spec: null, errors: [] }`
 *  - a malformed section → `spec: null` and EVERY problem listed in `errors`
 *    (one pass, so the operator fixes them all at once). */
export function extractCapabilities(args: unknown): { spec: CapabilitiesSpec | null; errors: string[] } {
  if (!isRecord(args) || !('capabilities' in args)) return { spec: null, errors: [] }
  const raw = args['capabilities']
  // `capabilities: null` is the JSON idiom for an omitted key — treat as ABSENT,
  // not malformed (a present-but-null section hard-failing the launch was a
  // regression vs the pre-contract behavior; review finding 3.1).
  if (raw === null) return { spec: null, errors: [] }
  if (!isRecord(raw)) return { spec: null, errors: ['capabilities must be an object ({ mcpServers?, agents?, skills?, skillOverrides?, disableBundledSkills? })'] }
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
  if ('skillOverrides' in raw) {
    const so = validateSkillOverrides(raw['skillOverrides'], errors)
    if (so !== undefined) spec.skillOverrides = so
  }
  if ('disableBundledSkills' in raw) {
    if (typeof raw['disableBundledSkills'] !== 'boolean') errors.push('capabilities.disableBundledSkills must be a boolean')
    else spec.disableBundledSkills = raw['disableBundledSkills']
  }
  return errors.length > 0 ? { spec: null, errors } : { spec, errors: [] }
}

/** The query() options fragment for a VALIDATED spec — exactly the present
 *  sections, nothing invented. The server spreads this into its launch options.
 *
 *  ⚠ Contract change (design §6.3, MINOR-5): the fragment now emits a POSTURE-ADJACENT
 *  `settings` key (the skill layer) when the spec declares skillOverrides/
 *  disableBundledSkills — so it is NO LONGER true that this fragment "does not touch"
 *  the server's settings posture. The `settings` here is the SPEC's OWN fragment only;
 *  it does NOT carry the zero-skill default. The server composes BARE_SKILLS_SETTINGS
 *  as the base and DEEP-MERGES this fragment's settings OVER it (spec wins per key —
 *  see mergeSkillSettings). A naive spread of the two would lose the default's
 *  `doctor:'off'` the moment a spec carries its own skillOverrides; the deep-merge is
 *  the required mechanic. mcpServers/agents/skills are unchanged (spread verbatim). */
export function composeCapabilityOptions(spec: CapabilitiesSpec): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  if (spec.skillOverrides !== undefined) settings.skillOverrides = spec.skillOverrides
  if (spec.disableBundledSkills !== undefined) settings.disableBundledSkills = spec.disableBundledSkills
  return {
    ...(spec.mcpServers !== undefined ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.agents !== undefined ? { agents: spec.agents } : {}),
    ...(spec.skills !== undefined ? { skills: spec.skills } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  }
}

/** Deep-merge two skill-settings layers BY KEY (design §6.3): `disableBundledSkills`
 *  is overwritten (override wins, even a present `false` — the built-ins-declared
 *  regime, MINOR-6); `skillOverrides` is merged PER SKILL (override wins per skill key,
 *  base entries survive — the naive-spread guard, MINOR-5). Returns a fresh object and
 *  never mutates its inputs. Used by the delegated-run server (and the C5 tooled brain)
 *  to compose BARE_SKILLS_SETTINGS with a run's spec-declared skill settings — ONE
 *  merge implementation shared by every consumer. */
export function mergeSkillSettings(
  base: { disableBundledSkills?: boolean; skillOverrides?: Record<string, SkillOverrideMode> },
  override?: { disableBundledSkills?: boolean; skillOverrides?: Record<string, SkillOverrideMode> },
): { disableBundledSkills?: boolean; skillOverrides?: Record<string, SkillOverrideMode> } {
  const merged: { disableBundledSkills?: boolean; skillOverrides?: Record<string, SkillOverrideMode> } = {}
  const disable = override?.disableBundledSkills ?? base.disableBundledSkills
  if (disable !== undefined) merged.disableBundledSkills = disable
  const skillOverrides = { ...(base.skillOverrides ?? {}), ...(override?.skillOverrides ?? {}) }
  if (Object.keys(skillOverrides).length > 0) merged.skillOverrides = skillOverrides
  return merged
}
