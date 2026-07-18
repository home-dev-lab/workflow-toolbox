// launch-capabilities.ts — the LAUNCHER-side capability composition glue (card I3
// #1821494490959971801; frozen design v2 §3.2/§5/§9 capability-registry-design.md,
// design card #1820675961738232936).
//
// `wt-observe launch` reads a workflow's sidecar (<artifact>.capabilities.json),
// loads the machine registry, runs the declared probes (all I/O, in cmdLaunch),
// then hands the parsed pieces to this PURE function. It:
//   1. resolves each role need to a provider or a named degradation (resolveCapabilities);
//   2. substitutes the $CWD registry token with the requester's launch cwd
//      LAUNCHER-side (capability-registry.ts keeps the token verbatim by design §4.2);
//   3. projects the sidecar into the shipped `capabilities` spec — $cap expansion,
//      provider mcpServers mount, the MAJOR-2 guard, required-unresolved refusal
//      (sidecarToCapabilitiesSpec);
//   4. projects the SEAM skill settings (skillOverrides/disableBundledSkills that I2
//      deliberately leaves on the CapabilitySidecar type for the launcher to read);
//   5. merges the caller's `--args` capabilities OVER the sidecar resolution
//      (precedence §3.3: server-BARE default < sidecar resolution < caller args —
//      the server applies the BARE default; this function does sidecar < caller).
//
// Fail-loud: any launch-refusal error (malformed/guarded sidecar, required need with
// no fallback, an unresolvable $CWD) forces `capabilities: null`. The launcher refuses
// the launch; `report` still carries the resolutions for auditing (embedded as a
// sibling `capabilitiesReport` key in the launch args — never inside `capabilities`,
// which the server validates strictly).

import { mergeSkillSettings, type CapabilitiesSpec, type SkillOverrideMode } from './capabilities.js'
import {
  resolveCapabilities,
  sidecarToCapabilitiesSpec,
  type CapabilityRegistry,
  type CapabilitySidecar,
  type CapabilityNeed,
  type NeedResolution,
} from './capability-registry.js'
import { isRecord } from './validator-shared.js'

const CWD_TOKEN = '$CWD'

/** The capability sidecar path beside a resolved workflow artifact (design §3.2):
 *  `<artifact>.capabilities.json`. The workflow allowlist only ever serves `.js`
 *  (discoverWorkflows), so the `.js` suffix is stripped; any other path gets the
 *  suffix appended (defensive — never silently returns the workflow path itself). */
export function sidecarPathFor(workflowPath: string): string {
  const base = workflowPath.endsWith('.js') ? workflowPath.slice(0, -'.js'.length) : workflowPath
  return `${base}.capabilities.json`
}

/** Recursively substitute the $CWD registry token (design §4.2 — the only v0
 *  registry variable) with the requester's launch cwd. LAUNCHER-side by necessity:
 *  a delegated run's server cwd is its own, never the requester's (Path B rule).
 *  Replaces every occurrence inside strings; recurses arrays and plain objects;
 *  leaves other values untouched. Pure — returns a fresh structure. */
export function substituteCwd<T>(value: T, cwd: string): T {
  if (typeof value === 'string') return value.split(CWD_TOKEN).join(cwd) as unknown as T
  if (Array.isArray(value)) return value.map((v) => substituteCwd(v, cwd)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substituteCwd(v, cwd)
    return out as unknown as T
  }
  return value
}

/** Whether any $CWD token appears anywhere in a value — the degenerate-cwd guard:
 *  a provider that needs $CWD when the requester cwd is unresolvable is fail-loud,
 *  not a silent empty substitution (which would ship a broken `--project ` arg). */
function containsCwdToken(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(CWD_TOKEN)
  if (Array.isArray(value)) return value.some(containsCwdToken)
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsCwdToken)
  return false
}

export interface LaunchCapabilitiesInput {
  /** The parsed sidecar beside the resolved workflow artifact (untrusted JSON —
   *  sidecarToCapabilitiesSpec re-validates its shape at the trust boundary). */
  sidecar: CapabilitySidecar
  /** The loaded machine registry (loadCapabilityRegistry). */
  registry: CapabilityRegistry
  /** Per-provider probe results (probeProviders). Missing ⇒ assumed available. */
  availability: Record<string, boolean>
  /** Whether the target session has WebSearch/WebFetch (docs-lookup degradation). */
  webAvailable: boolean
  /** The requester's launch cwd for $CWD substitution ('' when unresolvable). */
  requesterCwd: string
  /** The caller's already-validated `--args` capabilities (extractCapabilities().spec),
   *  null when the caller passed no capabilities section. */
  callerCapabilities: CapabilitiesSpec | null
}

/** The audit-report projection of a NeedResolution — the same outcome MINUS the provider
 *  mcpServers CONFIG. The report is display/audit only (embedded as `capabilitiesReport`);
 *  the ACTUAL mcpServers the server launches live, necessarily, in `args.capabilities`. So
 *  the report keeps only the mounted server NAMES (`servers`), never the config values —
 *  which can carry secrets (env tokens, command args). Reduces the redundant secret
 *  surface (review finding, high). */
export type ReportResolution =
  | { need: string; provider: string; servers: string[]; tools: string[]; protocolHint?: string }
  | { need: string; unresolved: true; degradation: string; tools: string[] }

function redactResolutionsForReport(resolutions: NeedResolution[]): ReportResolution[] {
  return resolutions.map((r) =>
    'unresolved' in r
      ? r
      : { need: r.need, provider: r.provider, servers: Object.keys(r.mcpServers), tools: r.tools, ...(r.protocolHint !== undefined ? { protocolHint: r.protocolHint } : {}) },
  )
}

export interface LaunchCapabilitiesResult {
  /** The merged spec to place in `args.capabilities`, or null on a launch refusal. */
  capabilities: CapabilitiesSpec | null
  /** The REDACTED resolution report (embedded as `args.capabilitiesReport` for auditing —
   *  provider mcpServers config stripped to server names, see ReportResolution). */
  report: ReportResolution[]
  /** Every launch-refusal reason (one pass, deduped) — empty ⇒ launch proceeds. */
  errors: string[]
}

/** Collect the needs declared across all sidecar roles, defensively (the shape is
 *  re-validated by sidecarToCapabilitiesSpec — this just avoids crashing on a
 *  malformed hand-written sidecar before that validation runs). */
function collectNeeds(sidecar: CapabilitySidecar): CapabilityNeed[] {
  const needs: CapabilityNeed[] = []
  const roles: unknown = isRecord(sidecar) ? sidecar.roles : undefined
  if (!isRecord(roles)) return needs
  for (const role of Object.values(roles)) {
    if (isRecord(role) && Array.isArray(role.needs)) {
      for (const n of role.needs) if (isRecord(n) && typeof n.need === 'string') needs.push(n as unknown as CapabilityNeed)
    }
  }
  return needs
}

type SkillLayer = { disableBundledSkills?: boolean; skillOverrides?: Record<string, SkillOverrideMode> }

/** Extract just the skill-settings layer from a sidecar/spec, OMITTING undefined
 *  fields (exactOptionalPropertyTypes: an optional prop must be absent, not
 *  present-and-undefined, to satisfy mergeSkillSettings). */
function skillLayer(x: SkillLayer | null | undefined): SkillLayer {
  const out: SkillLayer = {}
  if (x?.disableBundledSkills !== undefined) out.disableBundledSkills = x.disableBundledSkills
  if (x?.skillOverrides !== undefined) out.skillOverrides = x.skillOverrides
  return out
}

/** Merge the sidecar-resolved spec with the caller's args capabilities — per
 *  section, then per key, the caller winning (design §3.3). The SEAM skill settings
 *  (sidecar.skillOverrides/disableBundledSkills) enter here as the lower layer of a
 *  mergeSkillSettings pass; the server later composes BARE_SKILLS_SETTINGS UNDER the
 *  whole thing (so the full chain is BARE < sidecar < caller). */
function mergeCapabilitiesSpecs(
  sidecarSpec: CapabilitiesSpec,
  sidecarSkill: SkillLayer,
  caller: CapabilitiesSpec | null,
): CapabilitiesSpec {
  const merged: CapabilitiesSpec = {}
  const mcpServers = { ...(sidecarSpec.mcpServers ?? {}), ...(caller?.mcpServers ?? {}) }
  if (Object.keys(mcpServers).length > 0) merged.mcpServers = mcpServers
  const agents = { ...(sidecarSpec.agents ?? {}), ...(caller?.agents ?? {}) }
  if (Object.keys(agents).length > 0) merged.agents = agents
  // `skills` is an enable-filter array — the sidecar carries none, so it is the caller's
  // when present (kept general in case a future sidecar field adds one).
  if (caller?.skills !== undefined) merged.skills = caller.skills
  else if (sidecarSpec.skills !== undefined) merged.skills = sidecarSpec.skills
  const skill = mergeSkillSettings(sidecarSkill, skillLayer(caller))
  if (skill.disableBundledSkills !== undefined) merged.disableBundledSkills = skill.disableBundledSkills
  if (skill.skillOverrides !== undefined) merged.skillOverrides = skill.skillOverrides
  return merged
}

/** Warning lines for the v0 boundary (card I3 scope extension): a `{ definitionFile }`
 *  observer entry's abstract `requires` are NOT resolved launcher-side (they live in a
 *  file the server resolves under the workflows roots). Emitted ONLY when a registry is
 *  present — on a harness-only machine nothing would resolve anyway, so the warning would
 *  be noise. The author sees it at launch, not by digging the run record. Kept internal-
 *  ref-free (the message ships in the CLI bin): it states the limitation self-containedly,
 *  no tracking id. `observers` is the raw args.observers array. */
export function observerDefinitionFileWarnings(observers: readonly unknown[], registryPresent: boolean): string[] {
  if (!registryPresent) return []
  const out: string[] = []
  for (const e of observers) {
    if (isRecord(e) && typeof e['definitionFile'] === 'string') {
      out.push(
        `observer requires: '${e['definitionFile']}' is a definitionFile — its abstract requires are NOT resolved launcher-side (only inline observer definitions are; a definitionFile's requires are resolved by the server). An unresolved required need becomes a server-side not-attach, never a launch failure.`,
      )
    }
  }
  return out
}

/** Fold the resolved `capabilities` + the redacted audit `report` into the launch args
 *  (pure — the I/O adapter's one non-I/O decision, extracted for unit coverage). Requires
 *  OBJECT args: capabilities live at `args.capabilities`, so a workflow WITH a capability
 *  sidecar but a non-object `--args` is a usage error, fail-loud with the script name. The
 *  report rides as a SIBLING `capabilitiesReport` key (the server persists the whole args
 *  object and ignores keys outside capabilities/observers). */
export function foldCapabilitiesIntoArgs(args: unknown, capabilities: CapabilitiesSpec | null, report: ReportResolution[], script: string): Record<string, unknown> {
  if (args !== undefined && !isRecord(args)) {
    throw new Error(`workflow "${script}" has a capability sidecar but --args is not a JSON object — capabilities require object args`)
  }
  return { ...(args ?? {}), capabilities, capabilitiesReport: report }
}

/** Resolve an observer definition's abstract `requires` against the machine registry
 *  for the launcher-emitted `resolution` wire contract (card I3 scope extension). The
 *  companion server stores this on the ObserverTarget and composes it into the brain.
 *
 *  Unlike the sidecar path there is NO refusal and NO error channel: a required observer
 *  need that resolves to `degraded:none` rides through as an UNRESOLVED NeedResolution —
 *  an observer is peripheral (design invariant: a missing observer never fails the run),
 *  and the SERVER decides "not attached + noisy record". $CWD is substituted launcher-side
 *  (the delegated server's cwd is its own), with ONE observer-specific twist on the
 *  degenerate case: where the sidecar REFUSES the launch when the requester cwd is
 *  unresolvable ('') and a resolved provider still needs $CWD, the observer instead
 *  DOWNGRADES that entry to UNRESOLVED — never fails the launch, and never ships a
 *  blank-$CWD-substituted (corrupted) config mislabeled RESOLVED (review, high). */
export function resolveObserverRequires(
  requires: CapabilityNeed[],
  registry: CapabilityRegistry,
  availability: Record<string, boolean>,
  webAvailable: boolean,
  requesterCwd: string,
): NeedResolution[] {
  const resolved = resolveCapabilities(requires, registry, { availability, webAvailable })
  return resolved.map((r) => {
    if ('unresolved' in r) return r
    if (requesterCwd.length === 0 && containsCwdToken(r.mcpServers)) {
      return { need: r.need, unresolved: true, degradation: 'degraded:cwd-unresolvable', tools: [] }
    }
    return { ...r, mcpServers: substituteCwd(r.mcpServers, requesterCwd) }
  })
}

/** An observers entry's INLINE definition `requires` (card I3 scope extension), or null.
 *  v0 resolves requires for inline `{ definition }` entries only — a `{ definitionFile }`
 *  entry's requires live in a file the SERVER resolves under the workflows roots, which the
 *  launcher does not load (a documented boundary; those pass through unresolved). */
export function inlineObserverRequires(entry: unknown): CapabilityNeed[] | null {
  if (!isRecord(entry) || !isRecord(entry['definition'])) return null
  const req = (entry['definition'] as Record<string, unknown>)['requires']
  return Array.isArray(req) && req.length > 0 ? (req as CapabilityNeed[]) : null
}

/** Enforce "the launcher OWNS the `resolution` wire field" (design §5.3; review, high):
 *  STRIP any caller-supplied `resolution` off EVERY observers entry, then set the
 *  launcher-produced one ONLY on an inline definition carrying `requires` (via `resolve`).
 *  This is why a caller cannot inject an unverified resolution the server would compose into
 *  the brain. Pure — `resolve` is the (impure) resolver closure supplied by the launcher. */
export function ownObserverResolutions(
  observers: readonly unknown[],
  resolve: (requires: CapabilityNeed[]) => NeedResolution[],
): { observers: unknown[]; resolved: number; strippedCaller: number } {
  let resolved = 0
  let strippedCaller = 0
  const out = observers.map((entry) => {
    if (!isRecord(entry)) return entry
    const { resolution: callerResolution, ...rest } = entry
    if (callerResolution !== undefined) strippedCaller++
    const requires = inlineObserverRequires(entry)
    if (requires === null) return rest
    resolved++
    return { ...rest, resolution: resolve(requires) }
  })
  return { observers: out, resolved, strippedCaller }
}

/** PURE (probes/registry/sidecar already read): resolve → $CWD-substitute → project
 *  → SEAM → merge caller. See the module header for the full contract. */
export function composeLaunchCapabilities(input: LaunchCapabilitiesInput): LaunchCapabilitiesResult {
  const { sidecar, registry, availability, webAvailable, requesterCwd, callerCapabilities } = input
  const errors: string[] = []

  const needs = collectNeeds(sidecar)
  const resolved = resolveCapabilities(needs, registry, { availability, webAvailable })

  // $CWD substitution, LAUNCHER-side (design §4.2). A resolved provider whose config
  // needs $CWD when the requester cwd is unresolvable is fail-loud — never a silent
  // empty substitution.
  const substituted = resolved.map((r): NeedResolution => {
    if ('unresolved' in r) return r
    if (requesterCwd.length === 0 && containsCwdToken(r.mcpServers)) {
      errors.push(`capability '${r.need}' provider '${r.provider}' uses ${CWD_TOKEN} but the requester cwd is unresolvable — launch from a resolvable directory`)
      return r
    }
    return { ...r, mcpServers: substituteCwd(r.mcpServers, requesterCwd) }
  })

  const projected = sidecarToCapabilitiesSpec(sidecar, substituted)
  errors.push(...projected.errors)

  let capabilities: CapabilitiesSpec | null = null
  if (projected.spec !== null && errors.length === 0) {
    capabilities = mergeCapabilitiesSpecs(projected.spec, skillLayer(sidecar), callerCapabilities)
  }

  const deduped = [...new Set(errors)]
  return { capabilities: deduped.length > 0 ? null : capabilities, report: redactResolutionsForReport(projected.report), errors: deduped }
}
