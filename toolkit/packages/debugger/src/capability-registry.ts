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
// This module ships the LAUNCH column (registry load + resolver + projections)
// and the shared types (CapabilityNeed is adopted VERBATIM from the C5 observer
// schema — this file is now its canonical source, design §1.8). It stays
// dependency-light and structurally typed like `capabilities.ts` (no SDK import).
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
import { FORBIDDEN_ENTRY_NAMES, isRecord } from './validator-shared.js'

// ------------------------------- types -------------------------------

/** A role's ABSTRACT need. Adopted verbatim from the C5 observer schema.
 *  Open vocabulary; v0 = READ-ONLY retrieval needs only ('docs-lookup',
 *  'code-intelligence', 'web-search', 'context-offload'). 'process-exec' is
 *  deferred until its command-allowlist spec exists. */
export interface CapabilityNeed {
  need: string
  /** Default false. Required-and-unresolvable (degraded:none) => fail-loud at launch. */
  optional?: boolean
  /** Abstract refinement only (e.g. {language:'ts'}) — never a binary/path. */
  params?: Record<string, string>
}

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

/** The composer-emitted (or hand-written, design §3.2) declaration living beside
 *  a workflow artifact. Machine-agnostic by construction. */
export interface CapabilitySidecar {
  version: 1
  roles: Record<string, CapabilitySidecarRole>
  agents: Record<string, CapabilityAgentDef>
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

/** Split a probe command into argv WITHOUT shell interpretation (basic quote
 *  handling; no metacharacter expansion). */
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
const MCP_ANCHOR_KEYS = ['command', 'url', 'type']

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function defaultRegistryPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'workflow-toolbox', 'capability-registry.json')
}

function validateMcpServers(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path} must be an object map of server-name → server config`)
    return
  }
  for (const name of Object.keys(v)) {
    if (FORBIDDEN_ENTRY_NAMES.has(name)) {
      errors.push(`${path}.${name} is a forbidden entry name (prototype-collision defence)`)
      continue
    }
    const cfg = v[name]
    if (!isRecord(cfg)) {
      errors.push(`${path}.${name} must be an object (server config)`)
      continue
    }
    if (!MCP_ANCHOR_KEYS.some((k) => k in cfg)) {
      errors.push(`${path}.${name} lacks any of ${MCP_ANCHOR_KEYS.join('/')} — not a launchable server config`)
    }
    for (const k of MCP_ANCHOR_KEYS) {
      if (k in cfg && typeof cfg[k] !== 'string') errors.push(`${path}.${name}.${k} must be a string`)
    }
  }
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
  if ('mcpServers' in v) validateMcpServers(v['mcpServers'], `${path}.mcpServers`, errors)
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

/** Project a sidecar + its resolutions into the shipped `capabilities` spec:
 *  expand $cap:<need> placeholders in agent tool allowlists, mount resolved
 *  providers' mcpServers at session level, and append the resolution note to
 *  each tooled agent's prompt.
 *
 *  Launch-time GUARD (design §5.1/§9.1, MAJOR-2 — covers hand-written sidecars,
 *  §3.2): rejects (a) any CONCRETE `mcp__…` tool in a sidecar agent's allowlist
 *  (only `$cap:<need>` and non-MCP builtin tools are admitted — the registry is
 *  the sole provider source), and (b) any `mcpServers` on a sidecar agent def.
 *  Also fail-loud on: a `$cap:<need>` whose need is not declared by the role
 *  (typo, MINOR-7), a role referencing an unknown agent, and a REQUIRED
 *  (non-optional) need that resolves to `degraded:none` (§5.4).
 *
 *  `errors` non-empty ⇒ the launch MUST be refused; the returned spec is
 *  sanitized (rejected tokens never leak) but is not launch-safe. */
export function sidecarToCapabilitiesSpec(
  sidecar: CapabilitySidecar,
  resolutions: NeedResolution[],
): { spec: CapabilitiesSpec; report: NeedResolution[]; errors: string[] } {
  const errors: string[] = []
  const resMap = new Map<string, NeedResolution>()
  for (const r of resolutions) resMap.set(r.need, r)

  // Map each agent to the needs declared by the role(s) referencing it, and run
  // the role-level guards (unknown agent, required-unresolvable).
  const agentNeeds = new Map<string, CapabilityNeed[]>()
  for (const [roleName, role] of Object.entries(sidecar.roles)) {
    if (!Object.hasOwn(sidecar.agents, role.agent)) {
      errors.push(`role '${roleName}' references unknown agent '${role.agent}'`)
    } else {
      const acc = agentNeeds.get(role.agent) ?? []
      acc.push(...role.needs)
      agentNeeds.set(role.agent, acc)
    }
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
    if (FORBIDDEN_ENTRY_NAMES.has(agentName)) {
      errors.push(`agents.${agentName} is a forbidden entry name (prototype-collision defence)`)
      continue
    }
    if ('mcpServers' in def && def.mcpServers !== undefined) {
      errors.push(`agent '${agentName}' must not declare mcpServers — the machine registry is the only provider source (a sidecar is machine-agnostic)`)
    }
    const declared = new Set((agentNeeds.get(agentName) ?? []).map((n) => n.need))
    const expanded: string[] = []
    for (const tool of def.tools ?? []) {
      if (tool.startsWith(CAP_PREFIX)) {
        const need = tool.slice(CAP_PREFIX.length)
        if (!declared.has(need)) {
          errors.push(`agent '${agentName}' uses '${tool}' but need '${need}' is not declared in its role needs (typo?)`)
          continue
        }
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
      } else if (tool.startsWith('mcp__')) {
        errors.push(`agent '${agentName}' tool '${tool}' is a concrete MCP tool; a sidecar may only use ${CAP_PREFIX}<need> and non-MCP builtin tools (the machine registry is the trust root)`)
      } else {
        expanded.push(tool)
      }
    }
    const outDef: CapabilityAgentDef = { ...def, prompt: def.prompt + buildResolutionNote(agentNeeds.get(agentName) ?? [], resMap) }
    if ('mcpServers' in outDef) delete outDef.mcpServers
    if (def.tools !== undefined || expanded.length > 0) outDef.tools = [...new Set(expanded)]
    outAgents[agentName] = outDef
  }

  const spec: CapabilitiesSpec = {}
  if (Object.keys(mountedMcp).length > 0) spec.mcpServers = mountedMcp
  if (Object.keys(outAgents).length > 0) spec.agents = outAgents
  return { spec, report: resolutions, errors: [...new Set(errors)] }
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
      for (const [srv, cfg] of Object.entries(r.mcpServers)) mcpServers[srv] = cfg
      if (r.protocolHint !== undefined) protocolHints.push(r.protocolHint)
    }
  }
  return { mcpServers, allowedTools: [...new Set(allowedTools)], protocolHints: [...new Set(protocolHints)] }
}
