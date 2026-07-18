// capability-registry.ts — the AUTHORING→LAUNCH capability resolver (card I2
// #1821494465542489559; frozen design v2 §3-5 capability-registry-design.md,
// design card #1820675961738232936).
//
// The model has two times (design §2):
//   AUTHORING  — the composer derives each role's ABSTRACT needs and emits a
//                sidecar (<artifact>.capabilities.json) with $cap:<need>
//                placeholders in the agent tool allowlists. Machine-agnostic:
//                a sidecar NEVER names a concrete provider or path.
//   LAUNCH     — the launcher (I3) reads the machine registry
//                (~/.config/workflow-toolbox/capability-registry.json), runs the
//                declared availability probes, RESOLVES each need to the first
//                available provider (or a named vocabulary degradation), and
//                projects the sidecar into the shipped `capabilities` args
//                section that the delegated-run server composes into query().
//
// This module ships the LAUNCH column (registry load + resolver + projections).
// CapabilityNeed is IMPORTED + re-exported from observer-def.ts (its pre-existing
// shared home in this package; design §1.8's "canonical source here" is amended —
// observer-def.ts predates this module, so one declaration, no drift). The module
// stays dependency-light and structurally typed like `capabilities.ts` (no SDK import).
//
// The C5 tooled-observer brain (card #1821198087868122467) consumes
// `resolveCapabilities` + `resolutionsToBrainOptions`; the launch path (I3)
// consumes `loadCapabilityRegistry` + `resolveCapabilities` + `probeProviders` +
// `sidecarToCapabilitiesSpec`.
//
// SEAM (I1/I3): the sidecar's skills settings (`skillOverrides`,
// `disableBundledSkills`) are carried on the CapabilitySidecar type for the
// launcher to read, but `sidecarToCapabilitiesSpec` deliberately does NOT project
// them into the returned spec — those two spec fields are added to
// `CapabilitiesSpec` by card I1 (concurrent), and the launcher (I3) merges them
// where the caller-args merge already happens (precedence §3.3:
// server BARE default < sidecar resolution < caller args).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

import type { CapabilitiesSpec, CapabilityAgentDef } from './capabilities.js'
import type { CapabilityNeed } from './observer-def.js'
import { FORBIDDEN_ENTRY_NAMES, isRecord, validateMcpServersShape } from './validator-shared.js'

// ------------------------------- types -------------------------------

/** A role's ABSTRACT need — imported from observer-def.ts (its pre-existing home)
 *  and re-exported so consumers can import it from either module without drift.
 *  Shape: { need: string; optional?: boolean; params?: Record<string,string> }.
 *  Open vocabulary; v0 = READ-ONLY retrieval needs only. */
export type { CapabilityNeed }

/** A concrete provider declared by the machine registry (never in a shipped
 *  artifact). `mcpServers` fragments are verbatim SDK server configs (same
 *  anchor keys as the shipped `capabilities` contract). `$CWD` in a value is
 *  substituted LAUNCHER-side (I3) with the requester's cwd — this module
 *  preserves the token verbatim. */
export interface CapabilityProvider {
  name: string
  mcpServers?: Record<string, Record<string, unknown>>
  tools?: string[]
  protocolHint?: string
  probe?: { command: string; timeoutMs?: number }
}

export interface CapabilityRegistry {
  version: 1
  /** need → ORDERED provider list (first available wins). */
  providers: Record<string, CapabilityProvider[]>
}

/** The outcome of resolving one need. A superset of the C5 observer resolution
 *  shape (resolved: +protocolHint?; unresolved: carries the named degradation
 *  and its fallback tools). */
export type NeedResolution =
  | { need: string; provider: string; mcpServers: Record<string, Record<string, unknown>>; tools: string[]; protocolHint?: string }
  | { need: string; unresolved: true; degradation: string; tools: string[] }

/** SDK Settings.skillOverrides value union (card I1 mirrors this on CapabilitiesSpec). */
export type SkillOverrideMode = 'on' | 'name-only' | 'user-invocable-only' | 'off'

export interface CapabilitySidecarRole {
  /** Key into `agents`. Several roles may share one agent identity. */
  agent: string
  needs: CapabilityNeed[]
}

/** A sidecar agent def — the launch-time CapabilityAgentDef MINUS `mcpServers`:
 *  a sidecar is machine-agnostic, so it may never carry a concrete server. The
 *  runtime guard in sidecarToCapabilitiesSpec still rejects one that a
 *  hand-written JSON sidecar smuggles in (types don't bind untrusted JSON); this
 *  omission just makes the TS surface honest about what is accepted. */
export type CapabilitySidecarAgent = Omit<CapabilityAgentDef, 'mcpServers'>

/** The composer-emitted (or hand-written, design §3.2) declaration living beside
 *  a workflow artifact. Machine-agnostic by construction. */
export interface CapabilitySidecar {
  version: 1
  roles: Record<string, CapabilitySidecarRole>
  agents: Record<string, CapabilitySidecarAgent>
  /** Optional skills settings — READ by the launcher (I3), NOT projected here (SEAM). */
  skillOverrides?: Record<string, SkillOverrideMode>
  disableBundledSkills?: boolean
}

export interface ProbeOutcome {
  code: number | null
  timedOut: boolean
  error?: string
}

/** Injectable probe runner (tests inject a fake — ZERO real processes). The
 *  default spawns argv WITHOUT a shell (no metacharacter interpretation). */
export type ProbeSpawn = (argv: string[], opts: { timeoutMs: number }) => Promise<ProbeOutcome>

// ------------------------------- vocabulary degradations (§4.3) -------------------------------

const DEGRADATIONS: Record<string, { degradation: string; tools: string[] }> = {
  'code-intelligence': { degradation: 'degraded:grep-glob', tools: ['Grep', 'Glob', 'Read'] },
  'web-search': { degradation: 'degraded:none', tools: [] },
  'context-offload': { degradation: 'degraded:inline', tools: [] },
}

function degradationFor(need: string, webAvailable: boolean): { degradation: string; tools: string[] } {
  if (need === 'docs-lookup') {
    return webAvailable ? { degradation: 'degraded:web', tools: ['WebSearch', 'WebFetch'] } : { degradation: 'degraded:none', tools: [] }
  }
  // Unknown open-vocabulary needs with no provider degrade to none (tools []).
  return DEGRADATIONS[need] ?? { degradation: 'degraded:none', tools: [] }
}

// ------------------------------- resolveCapabilities -------------------------------

export interface ResolveOptions {
  /** Per-provider probe results (by provider name). Missing => assumed available. */
  availability?: Record<string, boolean>
  /** Whether WebSearch/WebFetch exist in the target session (docs-lookup degradation). Default true. */
  webAvailable?: boolean
}

/** PURE (probes have already run): per DEDUPLICATED need, the first AVAILABLE
 *  provider in registry order, else the vocabulary's named degradation. */
export function resolveCapabilities(needs: CapabilityNeed[], registry: CapabilityRegistry, opts: ResolveOptions = {}): NeedResolution[] {
  const availability = opts.availability ?? {}
  const webAvailable = opts.webAvailable ?? true
  const seen = new Set<string>()
  const out: NeedResolution[] = []
  for (const n of needs) {
    if (seen.has(n.need)) continue
    seen.add(n.need)
    const providers = Object.hasOwn(registry.providers, n.need) ? (registry.providers[n.need] ?? []) : []
    const provider = providers.find((p) => availability[p.name] ?? true)
    if (provider) {
      out.push({
        need: n.need,
        provider: provider.name,
        mcpServers: provider.mcpServers ?? {},
        tools: provider.tools ?? [],
        ...(provider.protocolHint !== undefined ? { protocolHint: provider.protocolHint } : {}),
      })
    } else {
      const d = degradationFor(n.need, webAvailable)
      out.push({ need: n.need, unresolved: true, degradation: d.degradation, tools: d.tools })
    }
  }
  return out
}

// ------------------------------- probeProviders -------------------------------

const DEFAULT_PROBE_TIMEOUT_MS = 5000

/** Split a probe command into argv WITHOUT shell interpretation. The security
 *  property is "no shell" (no metacharacter/glob/substitution expansion) — that
 *  holds for ANY input. Quote handling is a v0 convenience for well-formed
 *  quoting (a path with spaces): balanced `"…"`/`'…'` become one token.
 *  Malformed quoting (an unterminated or mid-token quote) is tokenized literally
 *  rather than raising — acceptable because the command comes from the
 *  user-owned registry (the trust root), where a self-inflicted typo surfaces as
 *  the probe simply failing (provider marked unavailable), not as an exploit. */
function tokenizeCommand(command: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out
}

const defaultProbeSpawn: ProbeSpawn = (argv, { timeoutMs }) =>
  new Promise((resolve) => {
    let settled = false
    const finish = (o: ProbeOutcome): void => {
      if (settled) return
      settled = true
      resolve(o)
    }
    const cmd = argv[0]
    if (cmd === undefined) {
      finish({ code: null, timedOut: false, error: 'empty probe command' })
      return
    }
    let child
    try {
      child = nodeSpawn(cmd, argv.slice(1), { stdio: 'ignore' })
    } catch (e) {
      finish({ code: null, timedOut: false, error: String(e) })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, timedOut: true })
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ code: null, timedOut: false, error: String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, timedOut: false })
    })
  })

/** Run each provider's declared availability probe (once per provider name, in
 *  parallel, timeout-bounded, argv/no-shell). Providers WITHOUT a probe are
 *  omitted from the map (resolveCapabilities then assumes them available). */
export async function probeProviders(registry: CapabilityRegistry, opts: { spawn?: ProbeSpawn } = {}): Promise<Record<string, boolean>> {
  const spawn = opts.spawn ?? defaultProbeSpawn
  const seen = new Set<string>()
  const jobs: Array<Promise<[string, boolean]>> = []
  for (const providers of Object.values(registry.providers)) {
    for (const p of providers) {
      if (!p.probe || seen.has(p.name)) continue
      seen.add(p.name)
      const timeoutMs = p.probe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
      const argv = tokenizeCommand(p.probe.command)
      const name = p.name
      jobs.push(
        (async (): Promise<[string, boolean]> => {
          if (argv.length === 0) return [name, false]
          try {
            const r = await spawn(argv, { timeoutMs })
            return [name, !r.timedOut && r.error === undefined && r.code === 0]
          } catch {
            return [name, false]
          }
        })(),
      )
    }
  }
  const results = await Promise.all(jobs)
  const out: Record<string, boolean> = {}
  for (const [name, ok] of results) out[name] = ok
  return out
}

// ------------------------------- loadCapabilityRegistry -------------------------------

const PROVIDER_KEYS = new Set(['name', 'mcpServers', 'tools', 'protocolHint', 'probe'])
const PROBE_KEYS = new Set(['command', 'timeoutMs'])

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function defaultRegistryPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'workflow-toolbox', 'capability-registry.json')
}

function validateProbe(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path} must be an object { command, timeoutMs? }`)
    return
  }
  for (const k of Object.keys(v)) {
    if (!PROBE_KEYS.has(k)) errors.push(`${path}.${k} is not a known probe field (typo?)`)
  }
  if (typeof v['command'] !== 'string' || v['command'].length === 0) errors.push(`${path}.command must be a non-empty string`)
  if ('timeoutMs' in v && typeof v['timeoutMs'] !== 'number') errors.push(`${path}.timeoutMs must be a number`)
}

function validateProvider(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path} must be an object (provider)`)
    return
  }
  for (const k of Object.keys(v)) {
    if (!PROVIDER_KEYS.has(k)) errors.push(`${path}.${k} is not a known provider field (typo?)`)
  }
  if (typeof v['name'] !== 'string' || v['name'].length === 0) errors.push(`${path}.name must be a non-empty string`)
  if ('tools' in v && !isStringArray(v['tools'])) errors.push(`${path}.tools must be a string array`)
  if ('protocolHint' in v && typeof v['protocolHint'] !== 'string') errors.push(`${path}.protocolHint must be a string`)
  if ('mcpServers' in v) validateMcpServersShape(v['mcpServers'], `${path}.mcpServers`, errors)
  if ('probe' in v) validateProbe(v['probe'], `${path}.probe`, errors)
}

function validateRegistry(v: unknown, errors: string[]): CapabilityRegistry {
  if (!isRecord(v)) {
    errors.push('capability-registry must be a JSON object { version, providers }')
    return { version: 1, providers: {} }
  }
  if (v['version'] !== 1) errors.push('capability-registry.version must be 1')
  const providers: Record<string, CapabilityProvider[]> = {}
  const raw = v['providers']
  if (!isRecord(raw)) {
    errors.push('capability-registry.providers must be an object map of need → provider[]')
  } else {
    for (const need of Object.keys(raw)) {
      if (FORBIDDEN_ENTRY_NAMES.has(need)) {
        errors.push(`capability-registry.providers.${need} is a forbidden entry name (prototype-collision defence)`)
        continue
      }
      const arr = raw[need]
      if (!Array.isArray(arr)) {
        errors.push(`capability-registry.providers.${need} must be an array of providers`)
        continue
      }
      arr.forEach((p, i) => validateProvider(p, `capability-registry.providers.${need}[${i}]`, errors))
      providers[need] = arr as CapabilityProvider[]
    }
  }
  return { version: 1, providers }
}

/** Read + validate the machine registry (fail-loud, extractCapabilities style).
 *  An ABSENT file is an EMPTY registry (harness-only machine), NOT an error; an
 *  invalid file lists every problem and yields an empty registry (the caller —
 *  I3 launcher — refuses the launch when `errors` is non-empty). */
export function loadCapabilityRegistry(opts: { path?: string } = {}): { registry: CapabilityRegistry; errors: string[] } {
  const path = opts.path ?? process.env.WT_CAPABILITY_REGISTRY ?? defaultRegistryPath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { registry: { version: 1, providers: {} }, errors: [] }
    return { registry: { version: 1, providers: {} }, errors: [`capability-registry: cannot read ${path}: ${String(e)}`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { registry: { version: 1, providers: {} }, errors: [`capability-registry: invalid JSON at ${path}: ${(e as Error).message}`] }
  }
  const errors: string[] = []
  const registry = validateRegistry(parsed, errors)
  return errors.length > 0 ? { registry: { version: 1, providers: {} }, errors } : { registry, errors: [] }
}

// ------------------------------- sidecarToCapabilitiesSpec (launch projection) -------------------------------

const CAP_PREFIX = '$cap:'

function paramsNote(params: Record<string, string> | undefined): string {
  if (!params || Object.keys(params).length === 0) return ''
  return ` [${Object.entries(params).map(([k, val]) => `${k}=${val}`).join(', ')}]`
}

/** The mechanical `## Capability resolution` section appended to a tooled role's
 *  prompt (design §5.2) — the tooling instruction at the TASK level, not just the
 *  allowlist. Deduplicated by need. */
function buildResolutionNote(needs: CapabilityNeed[], resMap: Map<string, NeedResolution>): string {
  const byNeed = new Map<string, CapabilityNeed>()
  for (const n of needs) if (!byNeed.has(n.need)) byNeed.set(n.need, n)
  if (byNeed.size === 0) return ''
  const lines: string[] = []
  for (const n of byNeed.values()) {
    const res = resMap.get(n.need)
    const p = paramsNote(n.params)
    if (!res) lines.push(`- ${n.need}${p} → (unresolved)`)
    else if ('unresolved' in res) lines.push(`- ${n.need}${p} → DEGRADED: ${res.degradation}`)
    else lines.push(`- ${n.need}${p} → ${res.provider}${res.protocolHint !== undefined ? ` — ${res.protocolHint}` : ''}`)
  }
  return `\n\n## Capability resolution\n${lines.join('\n')}\nUse the resolved tools above to RETRIEVE; prefer them over generic text search.`
}

/** Structural validation of an UNTRUSTED sidecar (a hand-written JSON file is an
 *  explicitly-supported input, design §3.2, and this function is documented as
 *  its launch-time trust boundary). A TS type does not bind parsed JSON, so the
 *  shape is checked at runtime BEFORE any field is trusted — otherwise a missing
 *  `prompt` would ship a literal "undefined…" prompt and a non-object `roles`
 *  would crash. Returns every structural problem in one pass. */
function validateSidecarShape(sidecar: CapabilitySidecar): string[] {
  const errors: string[] = []
  if (!isRecord(sidecar)) return ['sidecar must be an object { version, roles, agents }']
  if (!isRecord(sidecar.roles)) {
    errors.push('sidecar.roles must be an object map of role-name → { agent, needs }')
  } else {
    for (const [roleName, role] of Object.entries(sidecar.roles)) {
      if (!isRecord(role)) {
        errors.push(`sidecar.roles.${roleName} must be an object { agent, needs }`)
        continue
      }
      if (typeof role.agent !== 'string' || role.agent.length === 0) errors.push(`sidecar.roles.${roleName}.agent must be a non-empty string`)
      if (!Array.isArray(role.needs)) {
        errors.push(`sidecar.roles.${roleName}.needs must be an array of { need, optional?, params? }`)
      } else {
        role.needs.forEach((n: unknown, i: number) => {
          if (!isRecord(n)) errors.push(`sidecar.roles.${roleName}.needs[${i}] must be an object`)
          else if (typeof n['need'] !== 'string' || n['need'].length === 0) errors.push(`sidecar.roles.${roleName}.needs[${i}].need must be a non-empty string`)
        })
      }
    }
  }
  if (!isRecord(sidecar.agents)) {
    errors.push('sidecar.agents must be an object map of agent-name → { description, prompt, tools? }')
  } else {
    for (const [agentName, def] of Object.entries(sidecar.agents)) {
      if (!isRecord(def)) {
        errors.push(`sidecar.agents.${agentName} must be an object (agent definition)`)
        continue
      }
      if (typeof def['description'] !== 'string') errors.push(`sidecar.agents.${agentName}.description must be a string`)
      if (typeof def['prompt'] !== 'string') errors.push(`sidecar.agents.${agentName}.prompt must be a string`)
      if ('tools' in def && !isStringArray(def['tools'])) errors.push(`sidecar.agents.${agentName}.tools must be a string array`)
    }
  }
  return errors
}

/** EMISSION-time machine-agnostic lint of a sidecar — the RESOLUTION-INDEPENDENT
 *  subset of the launch-time guard `sidecarToCapabilitiesSpec` enforces (design
 *  §7.2, §5.1/§9.1). The composer (card I4) calls this the moment it emits a
 *  sidecar so a machine-specific authoring mistake fails LOUD with the SAME message
 *  the launch would show — but the launch-time `sidecarToCapabilitiesSpec` stays the
 *  ENFORCEMENT (it re-checks the SAME rules, so a hand-written sidecar that skipped
 *  the composer, design §3.2, is caught anyway). Returns EVERY problem in one pass.
 *
 *  Machine-agnostic rules (all resolution-independent, so they run without a
 *  registry): structural shape (validateSidecarShape); a role referencing an unknown
 *  agent; a forbidden agent entry name (prototype-collision); an agent def carrying
 *  `mcpServers` (the machine registry is the sole provider source); an agent def
 *  carrying ANY field beyond the known machine-agnostic surface (an unknown key could
 *  smuggle a machine-specific value past the checked channels); an agent with NO
 *  `tools` allowlist (an omitted allowlist inherits ALL ambient tools — fail-open);
 *  a CONCRETE `mcp__…` tool in EITHER tool channel (`tools` allowlist OR
 *  `disallowedTools` denylist — a concrete provider name is machine-specific
 *  wherever it appears); a `$cap:<need>` whose need is not declared in the role's
 *  needs (typo). The resolution-DEPENDENT checks (a need with no resolution; a
 *  required need that degrades to `degraded:none`) are NOT here — they belong to
 *  launch, when the registry exists. `sidecarToCapabilitiesSpec` DELEGATES its
 *  structural + machine-agnostic pass to this function (single source of truth), so
 *  the emission courtesy and the launch enforcement can never drift. */
export function lintSidecarMachineAgnostic(sidecar: CapabilitySidecar): string[] {
  const structuralErrors = validateSidecarShape(sidecar)
  if (structuralErrors.length > 0) return structuralErrors

  const errors: string[] = []

  // The ONLY fields a machine-agnostic sidecar agent def may carry. `mcpServers` is
  // deliberately absent (it names a concrete provider — rejected with its own message
  // below); every other key is a smuggling surface and rejected.
  const KNOWN_AGENT_KEYS = new Set(['description', 'prompt', 'tools', 'disallowedTools', 'model', 'effort', 'maxTurns'])

  // A concrete `mcp__…` string names a provider — machine-specific in ANY tool list,
  // allowlist or denylist. (`$cap:<need>` is the only admitted namespaced token.)
  const scanConcreteMcp = (agentName: string, channel: string, list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const tool of list) {
      if (typeof tool === 'string' && !tool.startsWith(CAP_PREFIX) && tool.startsWith('mcp__')) {
        errors.push(`agent '${agentName}' ${channel} '${tool}' is a concrete MCP tool; a sidecar may only use ${CAP_PREFIX}<need> and non-MCP builtin tools (the machine registry is the trust root)`)
      }
    }
  }

  // role → agent → needs (also flags an unknown-agent reference and any unmodelled
  // field on the role object — the same "no arbitrary passthrough" surface as agent defs).
  const agentNeeds = new Map<string, CapabilityNeed[]>()
  for (const [roleName, role] of Object.entries(sidecar.roles)) {
    for (const key of Object.keys(role)) {
      if (key !== 'agent' && key !== 'needs') {
        errors.push(`role '${roleName}' has unexpected field '${key}' — a sidecar role may only carry agent, needs`)
      }
    }
    if (!Object.hasOwn(sidecar.agents, role.agent)) {
      errors.push(`role '${roleName}' references unknown agent '${role.agent}'`)
    } else {
      const acc = agentNeeds.get(role.agent) ?? []
      acc.push(...role.needs)
      agentNeeds.set(role.agent, acc)
    }
  }

  for (const [agentName, def] of Object.entries(sidecar.agents)) {
    if (FORBIDDEN_ENTRY_NAMES.has(agentName)) {
      errors.push(`agents.${agentName} is a forbidden entry name (prototype-collision defence)`)
      continue
    }
    if ((def as { mcpServers?: unknown }).mcpServers !== undefined) {
      errors.push(`agent '${agentName}' must not declare mcpServers — the machine registry is the only provider source (a sidecar is machine-agnostic)`)
    }
    // Allowlist the agent-def surface: an unmodelled field is a smuggling channel
    // (the machine-agnostic invariant must not be enforced only on two hardcoded keys).
    for (const key of Object.keys(def)) {
      if (key !== 'mcpServers' && !KNOWN_AGENT_KEYS.has(key)) {
        errors.push(`agent '${agentName}' has unexpected field '${key}' — a machine-agnostic sidecar agent def may only carry ${[...KNOWN_AGENT_KEYS].join(', ')}`)
      }
    }
    if (def.tools === undefined) {
      errors.push(`agent '${agentName}' declares no tools allowlist — a sidecar agent must declare an EXACT allowlist (an omitted allowlist inherits ALL ambient tools; design §9.2/§9.3 'rien d'implicite')`)
    }
    scanConcreteMcp(agentName, 'tool', def.tools)
    scanConcreteMcp(agentName, 'disallowedTools entry', (def as { disallowedTools?: unknown }).disallowedTools)
    const declared = new Set((agentNeeds.get(agentName) ?? []).map((n) => n.need))
    for (const tool of def.tools ?? []) {
      if (tool.startsWith(CAP_PREFIX)) {
        const need = tool.slice(CAP_PREFIX.length)
        if (!declared.has(need)) {
          errors.push(`agent '${agentName}' uses '${tool}' but need '${need}' is not declared in its role needs (typo?)`)
        }
      }
    }
  }
  return [...new Set(errors)]
}

/** Project a sidecar + its resolutions into the shipped `capabilities` spec:
 *  expand $cap:<need> placeholders in agent tool allowlists, mount resolved
 *  providers' mcpServers at session level, and append the resolution note to
 *  each tooled agent's prompt.
 *
 *  Trust boundary (design §5.1/§9.1). The structural + MACHINE-AGNOSTIC pass is
 *  DELEGATED to `lintSidecarMachineAgnostic` (single source — the launch enforcement
 *  and the emission courtesy cannot drift): malformed structure; a CONCRETE `mcp__…`
 *  in EITHER tool channel (`tools` or `disallowedTools`); `mcpServers` or any other
 *  unmodelled field on an agent def; an omitted `tools` allowlist (fail-open); a
 *  `$cap:<need>` typo; a role referencing an unknown agent. This function then adds the
 *  RESOLUTION-dependent fail-loud checks: a need with no resolution, and a REQUIRED
 *  (non-optional) need resolving to `degraded:none` (§5.4).
 *
 *  NULL-ON-ERROR (parity with extractCapabilities / loadCapabilityRegistry): when
 *  `errors` is non-empty the returned `spec` is `null` — an unsafe spec is not
 *  representable, so a caller that forgets to check `errors` cannot launch a
 *  half-sanitized spec. The launch is refused; `report` still carries the
 *  resolutions for auditing. */
export function sidecarToCapabilitiesSpec(
  sidecar: CapabilitySidecar,
  resolutions: NeedResolution[],
): { spec: CapabilitiesSpec | null; report: NeedResolution[]; errors: string[] } {
  // Structural + machine-agnostic gate: DELEGATED to lintSidecarMachineAgnostic so the
  // launch ENFORCEMENT and the emission courtesy share ONE rule set — no drift, and no
  // one-sided blind spot (the disallowedTools/arbitrary-field hole came from two hand-
  // maintained copies checking only `tools`+`mcpServers`). On any machine-agnostic
  // violation the launch is refused here; the sidecar never reaches expansion.
  const machineAgnosticErrors = lintSidecarMachineAgnostic(sidecar)
  if (machineAgnosticErrors.length > 0) return { spec: null, report: resolutions, errors: machineAgnosticErrors }

  // From here the sidecar is machine-agnostic-valid (every role→agent resolves, no
  // concrete provider in any tool channel, no smuggled field); only the RESOLUTION-
  // dependent checks and the $cap expansion remain.
  const errors: string[] = []
  const resMap = new Map<string, NeedResolution>()
  for (const r of resolutions) resMap.set(r.need, r)

  const agentNeeds = new Map<string, CapabilityNeed[]>()
  for (const [roleName, role] of Object.entries(sidecar.roles)) {
    const acc = agentNeeds.get(role.agent) ?? []
    acc.push(...role.needs)
    agentNeeds.set(role.agent, acc)
    for (const need of role.needs) {
      const res = resMap.get(need.need)
      if (!res) {
        errors.push(`role '${roleName}' need '${need.need}' has no resolution (resolve it before projecting)`)
      } else if ('unresolved' in res && res.degradation === 'degraded:none' && need.optional !== true) {
        errors.push(`required capability '${need.need}' for role '${roleName}' is unresolvable (no provider and no fallback) — declare optional:true to run degraded`)
      }
    }
  }

  const mountedMcp: Record<string, Record<string, unknown>> = {}
  const outAgents: Record<string, CapabilityAgentDef> = {}

  for (const [agentName, def] of Object.entries(sidecar.agents)) {
    const expanded: string[] = []
    for (const tool of def.tools ?? []) {
      if (tool.startsWith(CAP_PREFIX)) {
        const need = tool.slice(CAP_PREFIX.length)
        const res = resMap.get(need)
        if (!res) {
          errors.push(`agent '${agentName}' '${tool}': no resolution for need '${need}'`)
          continue
        }
        for (const t of res.tools) expanded.push(t)
        if (!('unresolved' in res)) {
          for (const [srv, cfg] of Object.entries(res.mcpServers)) {
            if (FORBIDDEN_ENTRY_NAMES.has(srv)) {
              errors.push(`provider mcpServers key '${srv}' is a forbidden entry name (prototype-collision defence)`)
              continue
            }
            mountedMcp[srv] = cfg
          }
        }
      } else {
        expanded.push(tool)
      }
    }
    // `...def` carries the machine-agnostic-validated fields through (disallowedTools,
    // model, effort…); mcpServers is impossible here (the lint rejected it) — the delete
    // is a type-level belt for the Omit.
    const outDef: CapabilityAgentDef = { ...def, prompt: def.prompt + buildResolutionNote(agentNeeds.get(agentName) ?? [], resMap), tools: [...new Set(expanded)] }
    if ('mcpServers' in outDef) delete outDef.mcpServers
    outAgents[agentName] = outDef
  }

  const built: CapabilitiesSpec = {}
  if (Object.keys(mountedMcp).length > 0) built.mcpServers = mountedMcp
  if (Object.keys(outAgents).length > 0) built.agents = outAgents
  const deduped = [...new Set(errors)]
  return { spec: deduped.length > 0 ? null : built, report: resolutions, errors: deduped }
}

// ------------------------------- resolutionsToBrainOptions (brain projection, C5) -------------------------------

/** The C5 tooled-observer brain runs a SINGLE query() with NO agents map, so its
 *  exact tool allowlist must go to Options.allowedTools — which
 *  composeCapabilityOptions does NOT emit. This helper projects the stored
 *  resolutions into the brain's query() inputs (design §5.1, MINOR-3). */
export function resolutionsToBrainOptions(
  resolutions: NeedResolution[],
): { mcpServers: Record<string, Record<string, unknown>>; allowedTools: string[]; protocolHints: string[] } {
  const mcpServers: Record<string, Record<string, unknown>> = {}
  const allowedTools: string[] = []
  const protocolHints: string[] = []
  for (const r of resolutions) {
    for (const t of r.tools) allowedTools.push(t)
    if (!('unresolved' in r)) {
      for (const [srv, cfg] of Object.entries(r.mcpServers)) {
        if (FORBIDDEN_ENTRY_NAMES.has(srv)) continue // proto-collision defence (parity with the launch-spec mount)
        mcpServers[srv] = cfg
      }
      if (r.protocolHint !== undefined) protocolHints.push(r.protocolHint)
    }
  }
  return { mcpServers, allowedTools: [...new Set(allowedTools)], protocolHints: [...new Set(protocolHints)] }
}
