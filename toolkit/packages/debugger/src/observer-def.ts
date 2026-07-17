// observer-def.ts — the per-run OBSERVERS section of a delegated launch's args
// (observers-custom design; sibling of capabilities.ts, which owns the machine-side
// resolution the definitions' abstract `requires` are matched against).
//
// Contract: `--args` JSON may carry an `observers` section — an array of observer
// DEFINITIONS (inline, or a `definitionFile` reference the server resolves under its
// registered workflows dir, the same resolution rule as scripts). A definition is
// WORKFLOW-owned authoring data: what to observe (role/phase selectors matched against
// wt-meta transcript heads), the brain mandate, the wt-comm types it may emit, its
// permitted actions, and its ABSTRACT capability needs. No concrete tool and no
// machine path may appear here — the machine-owned resolution travels separately in
// `capabilities` (sibling section, never merged).
//
//   observers: [
//     { definition: { schemaVersion, name, description, watch, cadenceMs?, brain,
//                     emits?, actions?, requires? } },
//     { definitionFile: '<name>.observer.json' },   // relative to the workflows dir
//   ]
//
// TWO REGIMES, by design: authoring/launch-time is FAIL-LOUD — this module is that
// regime (an invalid definition must break early and loudly, client-side in
// `wt-observe launch` and again server-side at POST /api/launch, which shares this
// module). Run-time attachment is NEVER-FAIL — an attached observer degrades loudly
// but can never fail a running workflow; that regime lives server-side, not here.
//
// Posture mirrors capabilities.ts exactly: unknown keys are typos (fail loud),
// prototype-collision names are refused outright, every violation is collected in
// ONE pass, and a section with any violation yields `entries: null` (all-or-nothing).

import { FORBIDDEN_ENTRY_NAMES, isRecord } from './validator-shared.js'

export interface ObserverWatch {
  roles?: string[]
  phases?: string[]
}

export interface ObserverBrainSpec {
  mandate: string
  model?: string
  timeoutMs?: number
}

/** 'pause' is RESERVED (refused with a named violation) until the pause primitive
 *  ships — listed here so the allowlist is forward-compatible. */
export type ObserverAction = 'summary' | 'nudge' | 'wt-comm'

export interface CapabilityNeed {
  need: string
  optional?: boolean
  /** Abstract refinement only (e.g. { language: 'ts' }) — never a binary or a path. */
  params?: Record<string, string>
}

export interface ObserverDefinition {
  schemaVersion: 1
  name: string
  description: string
  watch: ObserverWatch
  cadenceMs?: number
  brain: ObserverBrainSpec
  emits?: string[]
  actions?: ObserverAction[]
  requires?: CapabilityNeed[]
}

export type ObserversEntry = { definition: ObserverDefinition } | { definitionFile: string }

/** The wt-comm message types an observer may declare in `emits` — a LOCKED COPY of
 *  the observer-emittable (`observer.*`) subset of the comm package's closed type
 *  union. Kept import-free ON PURPOSE: this module is bundled into the launcher CLI,
 *  and a runtime import of @workflow-toolbox/comm drags schema consts the bundle
 *  never uses (caught by lint on the built bin). The observer-def test drift-locks
 *  this list against WT_COMM_SCHEMAS, so a type added there fails tests here until
 *  this list learns it — divergence is loud, never silent. */
export const OBSERVER_EMITTABLE_TYPES: readonly string[] = ['observer.hint']

const NAME_PATTERN = /^[a-z0-9-]{1,64}$/
const SELECTOR_ITEM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const NEED_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The observer cadence floor — NORMATIVE for both sides of the contract (bundle
 *  review lock F5): authoring validation refuses a faster declared cadence here, and
 *  the companion server should IMPORT this const as its registration floor rather
 *  than re-declaring the number (cross-repo drift protection by dependency
 *  inversion). A definition declaring a faster cadence is an authoring error, not
 *  something to silently clamp at run time. */
export const CADENCE_FLOOR_MS = 60_000

const MAX_OBSERVERS = 16
const MAX_SELECTOR_ITEMS = 16
const MAX_REQUIRES = 16
const MAX_PARAMS = 16

const DEFINITION_KEYS = new Set(['schemaVersion', 'name', 'description', 'watch', 'cadenceMs', 'brain', 'emits', 'actions', 'requires'])
const WATCH_KEYS = new Set(['roles', 'phases'])
const BRAIN_KEYS = new Set(['mandate', 'model', 'timeoutMs'])
const NEED_KEYS = new Set(['need', 'optional', 'params'])
const ACTION_VALUES = new Set<string>(['summary', 'nudge', 'wt-comm'])

function checkUnknownKeys(obj: Record<string, unknown>, known: Set<string>, path: string, errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_ENTRY_NAMES.has(key)) {
      errors.push(`${path}.${key} is a forbidden key name (prototype-collision defence)`)
    } else if (!known.has(key)) {
      errors.push(`${path}.${key} is not a known field (typo?)`)
    }
  }
}

function validateBoundedString(v: unknown, path: string, min: number, max: number, errors: string[]): void {
  if (typeof v !== 'string' || v.length < min || v.length > max) {
    errors.push(`${path} must be a string of ${min}-${max} chars`)
  }
}

function validateSelectorArray(v: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push(`${path} must be a string array`)
    return
  }
  if (v.length === 0 || v.length > MAX_SELECTOR_ITEMS) {
    errors.push(`${path} must carry 1-${MAX_SELECTOR_ITEMS} items`)
    return
  }
  for (const item of v) {
    if (typeof item !== 'string' || !SELECTOR_ITEM_PATTERN.test(item)) {
      errors.push(`${path} items must match ${SELECTOR_ITEM_PATTERN.source}`)
      return
    }
  }
}

function validateWatch(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path} must be an object ({ roles?, phases? })`)
    return
  }
  // Named refusals FIRST — these two are documented design decisions, not typos:
  // there is no whole-run content watch (a runId target tails no content), and a
  // machine path may never appear inside a workflow-owned artifact.
  if ('run' in v) errors.push(`${path}.run is not supported: whole-run content observation does not exist (role/phase selectors only)`)
  if ('transcriptFile' in v) errors.push(`${path}.transcriptFile is a machine path — forbidden in a workflow-owned definition (operator REST attach covers that case)`)
  const remaining = Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'run' && k !== 'transcriptFile'))
  checkUnknownKeys(remaining, WATCH_KEYS, path, errors)
  const hasRoles = 'roles' in v
  const hasPhases = 'phases' in v
  if (!hasRoles && !hasPhases) {
    errors.push(`${path} needs at least one selector (roles and/or phases)`)
    return
  }
  if (hasRoles) validateSelectorArray(v['roles'], `${path}.roles`, errors)
  if (hasPhases) validateSelectorArray(v['phases'], `${path}.phases`, errors)
}

function validateBrain(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path} must be an object ({ mandate, model?, timeoutMs? })`)
    return
  }
  checkUnknownKeys(v, BRAIN_KEYS, path, errors)
  validateBoundedString(v['mandate'], `${path}.mandate`, 20, 4000, errors)
  if ('model' in v && typeof v['model'] !== 'string') errors.push(`${path}.model must be a string`)
  if ('timeoutMs' in v) {
    const t = v['timeoutMs']
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1) errors.push(`${path}.timeoutMs must be a positive integer (milliseconds)`)
  }
}

function validateEmits(v: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push(`${path} must be a string array of wt-comm message types`)
    return
  }
  const seen = new Set<string>()
  for (const item of v) {
    if (typeof item !== 'string' || !OBSERVER_EMITTABLE_TYPES.includes(item)) {
      errors.push(`${path} carries ${JSON.stringify(item)} — observers may emit only: ${OBSERVER_EMITTABLE_TYPES.join(', ')}`)
      continue
    }
    if (seen.has(item)) errors.push(`${path} lists ${item} more than once`)
    seen.add(item)
  }
}

function validateActions(v: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push(`${path} must be an array of 'summary' | 'nudge' | 'wt-comm'`)
    return
  }
  const seen = new Set<string>()
  for (const item of v) {
    if (item === 'pause') {
      errors.push(`${path}: 'pause' is reserved until the pause primitive ships — not accepted yet`)
      continue
    }
    if (typeof item !== 'string' || !ACTION_VALUES.has(item)) {
      errors.push(`${path} carries ${JSON.stringify(item)} — known actions: ${[...ACTION_VALUES].join(', ')}`)
      continue
    }
    if (seen.has(item)) errors.push(`${path} lists ${item} more than once`)
    seen.add(item)
  }
}

function validateRequires(v: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push(`${path} must be an array of capability needs ({ need, optional?, params? })`)
    return
  }
  if (v.length > MAX_REQUIRES) {
    errors.push(`${path} must carry at most ${MAX_REQUIRES} needs`)
    return
  }
  v.forEach((item, i) => {
    const itemPath = `${path}[${i}]`
    if (!isRecord(item)) {
      errors.push(`${itemPath} must be an object ({ need, optional?, params? })`)
      return
    }
    checkUnknownKeys(item, NEED_KEYS, itemPath, errors)
    if (typeof item['need'] !== 'string' || !NEED_PATTERN.test(item['need'])) {
      errors.push(`${itemPath}.need must match ${NEED_PATTERN.source} (an abstract capability name, e.g. docs-lookup)`)
    }
    if ('optional' in item && typeof item['optional'] !== 'boolean') errors.push(`${itemPath}.optional must be a boolean`)
    if ('params' in item) {
      const params = item['params']
      if (!isRecord(params)) {
        errors.push(`${itemPath}.params must be an object map of string → string (abstract refinement only)`)
        return
      }
      const keys = Object.keys(params)
      if (keys.length > MAX_PARAMS) errors.push(`${itemPath}.params must carry at most ${MAX_PARAMS} entries`)
      for (const key of keys) {
        if (FORBIDDEN_ENTRY_NAMES.has(key)) {
          errors.push(`${itemPath}.params.${key} is a forbidden key name (prototype-collision defence)`)
          continue
        }
        if (typeof params[key] !== 'string') errors.push(`${itemPath}.params.${key} must be a string`)
      }
    }
  })
}

/** Validate ONE inline observer definition, appending every violation to `errors`
 *  (path-prefixed). Exported for the server side, which also validates definitions
 *  loaded from a `definitionFile` through the SAME rules. */
export function validateObserverDefinition(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path} must be an object (an ObserverDefinition)`)
    return
  }
  checkUnknownKeys(v, DEFINITION_KEYS, path, errors)

  if (v['schemaVersion'] !== 1) errors.push(`${path}.schemaVersion must be the integer 1`)
  if (typeof v['name'] !== 'string' || !NAME_PATTERN.test(v['name'])) {
    errors.push(`${path}.name must match ${NAME_PATTERN.source}`)
  }
  validateBoundedString(v['description'], `${path}.description`, 1, 500, errors)
  validateWatch(v['watch'], `${path}.watch`, errors)
  if ('cadenceMs' in v) {
    const c = v['cadenceMs']
    if (typeof c !== 'number' || !Number.isInteger(c) || c < CADENCE_FLOOR_MS) {
      errors.push(`${path}.cadenceMs must be an integer >= ${CADENCE_FLOOR_MS} (the registration floor)`)
    }
  }
  validateBrain(v['brain'], `${path}.brain`, errors)
  if ('emits' in v) validateEmits(v['emits'], `${path}.emits`, errors)
  if ('actions' in v) validateActions(v['actions'], `${path}.actions`, errors)
  if ('requires' in v) validateRequires(v['requires'], `${path}.requires`, errors)

  // Coherence: 'wt-comm' in actions <=> emits non-empty. An observer allowed to write
  // wt-comm with nothing it may emit is dead config; declared emits without the
  // wt-comm action could never be delivered — both are authoring mistakes.
  const emits = Array.isArray(v['emits']) ? (v['emits'] as unknown[]) : []
  const actions = Array.isArray(v['actions']) ? (v['actions'] as unknown[]) : []
  const wantsComm = actions.includes('wt-comm')
  if (wantsComm && emits.length === 0) errors.push(`${path}: action 'wt-comm' requires a non-empty emits allowlist`)
  if (!wantsComm && emits.length > 0) errors.push(`${path}: emits is declared but actions lacks 'wt-comm' — the emitted types could never be delivered`)
}

function validateDefinitionFile(v: unknown, path: string, errors: string[]): void {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) {
    errors.push(`${path} must be a non-empty string path`)
    return
  }
  if (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)) {
    errors.push(`${path} must be RELATIVE to the registered workflows dir — never an absolute path`)
  }
  if (v.split(/[\\/]/).includes('..')) {
    errors.push(`${path} must not traverse upward ('..')`)
  }
  if (!v.endsWith('.observer.json')) {
    errors.push(`${path} must reference a composer observer artifact ('<name>.observer.json')`)
  }
}

/** Read + validate the `observers` section of a launch's args.
 *  - args without a section (or `observers: null`, the omitted-key JSON idiom, or
 *    non-object args) → `{ entries: null, errors: [] }`
 *  - a malformed section → `entries: null` and EVERY problem listed in `errors`
 *    (one pass, so the author fixes them all at once). */
export function extractObservers(args: unknown): { entries: ObserversEntry[] | null; errors: string[] } {
  if (!isRecord(args) || !('observers' in args)) return { entries: null, errors: [] }
  const raw = args['observers']
  if (raw === null) return { entries: null, errors: [] }
  if (!Array.isArray(raw)) {
    return { entries: null, errors: ['observers must be an array of { definition } | { definitionFile } entries'] }
  }
  const errors: string[] = []
  if (raw.length > MAX_OBSERVERS) errors.push(`observers must carry at most ${MAX_OBSERVERS} entries`)

  const seenNames = new Set<string>()
  raw.forEach((entry, i) => {
    const path = `observers[${i}]`
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object ({ definition } or { definitionFile })`)
      return
    }
    const hasDefinition = 'definition' in entry
    const hasFile = 'definitionFile' in entry
    for (const key of Object.keys(entry)) {
      if (key !== 'definition' && key !== 'definitionFile') errors.push(`${path}.${key} is not a known field (typo?)`)
    }
    if (hasDefinition === hasFile) {
      errors.push(`${path} must carry exactly ONE of definition | definitionFile`)
      return
    }
    if (hasFile) {
      validateDefinitionFile(entry['definitionFile'], `${path}.definitionFile`, errors)
      return
    }
    validateObserverDefinition(entry['definition'], `${path}.definition`, errors)
    const def = entry['definition']
    if (isRecord(def) && typeof def['name'] === 'string') {
      if (seenNames.has(def['name'])) errors.push(`${path}.definition.name ${JSON.stringify(def['name'])} is declared twice — observer names must be unique per launch`)
      seenNames.add(def['name'])
    }
  })

  return errors.length > 0 ? { entries: null, errors } : { entries: raw as ObserversEntry[], errors: [] }
}
