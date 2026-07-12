// define-workflow.ts — workflow declaration helper for @workflow-toolbox/build.
//
// SANDBOX-PURE CONSTRAINT: this file is bundled into workflow artifacts that
// run inside the Claude Code workflow sandbox. The sandbox has no Node.js
// APIs, no filesystem, no require(), no dynamic imports. Therefore:
//   • Imports from @workflow-toolbox/runtime are type-only (erased at emit) —
//     with one deliberate value exception: withPromptTags, itself sandbox-pure
//     (primitive JS only), bundled into the artifact by esbuild.
//   • No `node:` imports, no `process`, no `Buffer`, no esbuild.
//   • All validation is synchronous and uses only primitive JS operations.
//
// Design:
//   defineWorkflow() validates meta at CALL TIME (before the workflow is ever
//   run) so configuration errors surface immediately at load/bundle time rather
//   than inside a live run. This follows the @workflow-toolbox/patterns convention: "config
//   errors throw at entry" (see envelope.ts applyCap, e.g.).
//
//   The run pipeline is: normalizeArgs(rawArgs) → parseInput (default: identity
//   cast) → def.run(rt, input). parseInput errors propagate untouched — the
//   caller-supplied validator owns its error messages (fail-fast input guard).

import type { WorkflowRuntime, ModelAlias, EffortAlias, AgentDefaults } from '@workflow-toolbox/runtime'
import { withPromptTags } from '@workflow-toolbox/runtime'

// ---------------------------------------------------------------------------
// WorkflowMeta — the static descriptor every workflow must declare
// ---------------------------------------------------------------------------

/** Static descriptor for a workflow. Displayed in /workflows and used by the
 *  scheduler to select the right workflow for a request. */
export interface WorkflowMeta {
  /** Unique workflow identifier. Must be non-empty kebab-case
   *  (e.g. `"my-workflow"`, `"plan-and-execute-v2"`). */
  name: string
  /** Human-readable summary of what the workflow does. Must be non-empty. */
  description: string
  /** Optional guidance for the orchestrator on when to pick this workflow. */
  whenToUse?: string
  /** Optional ordered list of phases shown in the /workflows progress UI. */
  phases?: ReadonlyArray<{
    title: string
    detail?: string
    model?: string
  }>
}

// ---------------------------------------------------------------------------
// DefinedWorkflow — the object returned by defineWorkflow()
// ---------------------------------------------------------------------------

/** A compiled workflow definition: its metadata plus a typed run function.
 *  Carries only TOut: TInput is internal to the run pipeline (rawArgs comes in
 *  as unknown; parseInput narrows it) — flat generics, only used type params. */
export interface DefinedWorkflow<TOut> {
  meta: WorkflowMeta
  /** Execute the workflow. rawArgs is the raw value delivered by the runtime
   *  (typically a JSON-encoded string); run normalizes and parses it before
   *  forwarding to the user-supplied run function.
   *
   *  NOTE: defineWorkflow executes inside the sandbox when the bundled
   *  workflow runs, so all logic here must stay tiny and synchronous except
   *  for the async delegation to def.run. */
  run(rt: WorkflowRuntime, rawArgs: unknown): Promise<TOut>
}

// ---------------------------------------------------------------------------
// normalizeArgs — raw-argument adapter
//
// The runtime delivers string args JSON-encoded (i.e. the string "hello" is
// delivered as '"hello"' with the outer quotes). We try JSON.parse first; on
// failure we return the raw string unchanged so plain (non-encoded) strings
// are tolerated. Non-string values are passed through by identity.
// ---------------------------------------------------------------------------

/** Normalize the raw argument value delivered by the runtime.
 *
 *  - undefined  → undefined (no args supplied)
 *  - string     → JSON.parse attempt; on failure return the raw string
 *  - any other  → returned unchanged (by reference)
 *
 *  Exported for testability. */
export function normalizeArgs(raw: unknown): unknown {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (all synchronous, no Node APIs)
// ---------------------------------------------------------------------------

/** Kebab-case pattern: one or more lowercase-alphanumeric segments joined by
 *  hyphens. Each segment must start with a letter or digit (no leading/trailing
 *  hyphens, no consecutive hyphens, no uppercase, no underscores). */
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function validateMeta(meta: WorkflowMeta): void {
  if (!KEBAB_RE.test(meta.name)) {
    throw new Error(
      `defineWorkflow: invalid name "${meta.name}" — name must be non-empty kebab-case `
      + `(e.g. "my-workflow", "plan-and-execute-v2"); only lowercase letters, digits, `
      + `and hyphens are allowed, starting and ending with a letter or digit`,
    )
  }

  if (meta.description.trim().length === 0) {
    throw new Error(
      `defineWorkflow: description must be a non-empty string — provide a short summary `
      + `of what this workflow does`,
    )
  }

  if (meta.phases !== undefined) {
    for (let i = 0; i < meta.phases.length; i++) {
      const phase = meta.phases[i]
      // noUncheckedIndexedAccess: phase may be undefined (ReadonlyArray access)
      if (phase === undefined) continue
      if (phase.title.trim().length === 0) {
        throw new Error(
          `defineWorkflow: phase at index ${i} has an empty title — `
          + `every phase must have a non-empty title string`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// defineWorkflow — main entry point
//
// Validates meta synchronously at call time, returns a DefinedWorkflow whose
// run() method wires: normalizeArgs → parseInput (default: identity) → def.run.
// ---------------------------------------------------------------------------

/**
 * Declare a workflow with typed input/output.
 *
 * @param def.meta        - Static workflow descriptor (validated immediately).
 * @param def.parseInput  - Optional input parser/validator. Receives the
 *                          normalized rawArgs and returns TInput. Throws
 *                          propagate untouched (fail-fast input guard).
 * @param def.run         - The workflow body. Receives (rt, input: TInput).
 *
 * NOTE: defineWorkflow executes inside the sandbox when the bundled workflow
 * runs, so the meta validation must remain tiny and synchronous — no I/O.
 */
export function defineWorkflow<TInput = unknown, TOut = unknown>(def: {
  meta: WorkflowMeta
  parseInput?: (raw: unknown) => TInput
  run: (rt: WorkflowRuntime, input: TInput) => Promise<TOut>
}): DefinedWorkflow<TOut> {
  // Validate meta immediately — config errors throw before any run() call.
  validateMeta(def.meta)

  return {
    meta: def.meta,

    async run(rt: WorkflowRuntime, rawArgs: unknown): Promise<TOut> {
      // Step 1: normalize (JSON-decode string args, pass others through)
      const normalized = normalizeArgs(rawArgs)

      // Step 2: parse/validate input — parseInput errors propagate untouched
      const input: TInput = def.parseInput !== undefined
        ? def.parseInput(normalized)
        : (normalized as TInput)

      // Step 3: delegate to the workflow body. rt is wrapped with
      // withPromptTags so every labeled/phased agent call carries the
      // observe-facing wt-meta marker line (live agent→phase assignment for
      // attached runs) — patterns and plain rt.agent() calls alike.
      return def.run(withPromptTags(rt), input)
    },
  }
}

// ---------------------------------------------------------------------------
// parseConfig — launch-time tuning-config normalizer (Class B/C convention)
//
// Validates the conventional tuning envelope a workflow author threads from
// `args` into a typed WorkflowConfig. SANDBOX-PURE (only primitive JS; the
// runtime imports above are type-only, erased at emit). Two policies:
//   • UNRECOGNIZED top-level keys are IGNORED — so a workflow can pass its own
//     bespoke args next to the tuning slices (e.g. { target, models:{…} }) and
//     parseConfig reads `models`, leaving `target` to the author's own parser.
//   • Recognized slices are validated STRICTLY; a bad value throws an actionable
//     message (fail-fast, same discipline as a parseInput guard).
//
// `perAgent` is a FIXED shape (the AgentDefaults knobs) — unknown keys there ARE
// rejected (typo-catching where we can afford it). The role maps (`models` /
// `effort` / `agentTypes` / `sizing`) have author-defined role keys, so only
// their VALUES are validated, never the key set.
// ---------------------------------------------------------------------------

/** A per-ROLE effort override value: one of the five tiers, or the sentinel
 *  `'auto'` meaning "use this role's own stage-class default" (resolved by
 *  the composition via `resolveEffort`/`resolveVerifierEffort` from
 *  `@workflow-toolbox/std` — parseConfig only validates the token, it has no
 *  notion of what a role's default IS). Scoped to the `effort` role map ONLY:
 *  `perAgent.effort` (Class A) stays the strict 5-tier `EffortAlias` — it is a
 *  blanket default with no per-role resolution step downstream, so 'auto'
 *  would reach the sandbox as a literal (which does not understand it). */
export type EffortRoleValue = EffortAlias | 'auto'

/** The conventional launch-time tuning envelope. Feed `perAgent` straight to
 *  withAgentDefaults (Class A); spread the role maps into pattern options
 *  (Class B/C), e.g. `judgeModel: config.models?.judge`. */
export interface WorkflowConfig {
  /** Class-A blanket per-agent defaults (model/effort/agentType/isolation/stallMs). */
  perAgent?: AgentDefaults
  /** Class-B role→model map. Role keys are author-defined (e.g. attempt, judge). */
  models?: Readonly<Record<string, ModelAlias>>
  /** role→effort map. Values may be 'auto' — see {@link EffortRoleValue}. */
  effort?: Readonly<Record<string, EffortRoleValue>>
  /** role→agentType map. */
  agentTypes?: Readonly<Record<string, string>>
  /** Class-C role→numeric-knob map (votes, judgeCount, count, maxIterations, …).
   *  Structured knobs like scoreAndRank's `cutoff` are pattern-specific and stay
   *  the author's bespoke arg — they are intentionally out of this generic map. */
  sizing?: Readonly<Record<string, number>>
  /** Blanket opt-OUT of the toolkit's default leaf-agent fence (see
   *  `@workflow-toolbox/patterns`' `withLeafFence`): toolkit-spawned leaf/worker
   *  agents deny SendMessage by default (a fresh-context task executor has no
   *  legitimate use for an inter-agent channel). Set `messaging: true` only when
   *  a workflow genuinely needs its leaves to coordinate (e.g. an agent that
   *  must notify a live teammate) — the fence's own per-role escape hatch
   *  (`agentTypes.<role>`) still applies for a single role. Default false/omitted
   *  — the fence applies. */
  messaging?: boolean
}

// Local effort allowlist for runtime validation. Annotated `readonly EffortAlias[]`
// so a value that is NOT a valid EffortAlias fails to compile; keep it in sync if
// the EffortAlias union ever grows (a new alias missing here is merely rejected).
const EFFORTS: readonly EffortAlias[] = ['low', 'medium', 'high', 'xhigh', 'max']
// effort role-map allowlist = the 5 tiers + the 'auto' sentinel (role-map ONLY —
// see EffortRoleValue; perAgent.effort keeps the strict EFFORTS list via asEffort).
// A literal array, NOT `[...EFFORTS, 'auto']`: spread syntax invokes the iterable
// protocol (a method call), which a bundler's tree-shaker cannot statically prove
// side-effect-free — the same class of issue as a module-scope `new Set(...)` (see
// packages/std/src/resolve-effort.ts). An unreferenced spread-built array survives
// into consumers that only import THIS file's OTHER exports (observed live via the
// wt-fixture-hello golden bundle). A plain literal has no such side effect.
const EFFORT_ROLE_VALUES: readonly EffortRoleValue[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
const PER_AGENT_KEYS = ['model', 'effort', 'agentType', 'isolation', 'stallMs'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asNonEmptyString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`parseConfig: ${where} must be a non-empty string, got ${JSON.stringify(v)}`)
  }
  return v
}

function asEffort(v: unknown, where: string): EffortAlias {
  if (typeof v !== 'string' || !(EFFORTS as readonly string[]).includes(v)) {
    throw new Error(`parseConfig: ${where} must be one of ${EFFORTS.join(', ')}, got ${JSON.stringify(v)}`)
  }
  return v as EffortAlias
}

function asEffortRoleValue(v: unknown, where: string): EffortRoleValue {
  if (typeof v !== 'string' || !(EFFORT_ROLE_VALUES as readonly string[]).includes(v)) {
    throw new Error(`parseConfig: ${where} must be one of ${EFFORT_ROLE_VALUES.join(', ')}, got ${JSON.stringify(v)}`)
  }
  return v as EffortRoleValue
}

function parsePerAgent(raw: unknown): AgentDefaults {
  if (!isRecord(raw)) throw new Error(`parseConfig: perAgent must be an object, got ${raw === null ? 'null' : typeof raw}`)
  for (const key of Object.keys(raw)) {
    if (!(PER_AGENT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`parseConfig: unknown perAgent key "${key}" — expected one of ${PER_AGENT_KEYS.join(', ')}`)
    }
  }
  const out: AgentDefaults = {}
  if (raw.model !== undefined) out.model = asNonEmptyString(raw.model, 'perAgent.model')
  if (raw.effort !== undefined) out.effort = asEffort(raw.effort, 'perAgent.effort')
  if (raw.agentType !== undefined) out.agentType = asNonEmptyString(raw.agentType, 'perAgent.agentType')
  if (raw.isolation !== undefined) {
    if (raw.isolation !== 'worktree') {
      throw new Error(`parseConfig: perAgent.isolation must be 'worktree' when set, got ${JSON.stringify(raw.isolation)}`)
    }
    out.isolation = 'worktree'
  }
  if (raw.stallMs !== undefined) {
    const n = raw.stallMs
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw new Error(`parseConfig: perAgent.stallMs must be a positive finite number, got ${JSON.stringify(n)}`)
    }
    out.stallMs = n
  }
  return out
}

function parseStringMap(raw: unknown, where: string): Record<string, string> {
  if (!isRecord(raw)) throw new Error(`parseConfig: ${where} must be an object, got ${raw === null ? 'null' : typeof raw}`)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = asNonEmptyString(v, `${where}.${k}`)
  return out
}

function parseEffortMap(raw: unknown): Record<string, EffortRoleValue> {
  if (!isRecord(raw)) throw new Error(`parseConfig: effort must be an object, got ${raw === null ? 'null' : typeof raw}`)
  const out: Record<string, EffortRoleValue> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = asEffortRoleValue(v, `effort.${k}`)
  return out
}

function asBoolean(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') {
    throw new Error(`parseConfig: ${where} must be a boolean, got ${JSON.stringify(v)}`)
  }
  return v
}

function parseNumberMap(raw: unknown, where: string): Record<string, number> {
  if (!isRecord(raw)) throw new Error(`parseConfig: ${where} must be an object, got ${raw === null ? 'null' : typeof raw}`)
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`parseConfig: ${where}.${k} must be a finite number, got ${JSON.stringify(v)}`)
    }
    out[k] = v
  }
  return out
}

/** Normalize + validate the conventional tuning envelope into a typed
 *  WorkflowConfig. `undefined`/`null` → `{}` (no tuning supplied). A non-object
 *  throws. Recognized slices (perAgent/models/effort/agentTypes/sizing) are
 *  validated; unrecognized top-level keys are ignored. */
export function parseConfig(raw: unknown): WorkflowConfig {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) {
    throw new Error(`parseConfig: expected an object (or undefined), got ${typeof raw}`)
  }
  const config: WorkflowConfig = {}
  if (raw.perAgent !== undefined) config.perAgent = parsePerAgent(raw.perAgent)
  if (raw.models !== undefined) config.models = parseStringMap(raw.models, 'models')
  if (raw.effort !== undefined) config.effort = parseEffortMap(raw.effort)
  if (raw.agentTypes !== undefined) config.agentTypes = parseStringMap(raw.agentTypes, 'agentTypes')
  if (raw.sizing !== undefined) config.sizing = parseNumberMap(raw.sizing, 'sizing')
  if (raw.messaging !== undefined) config.messaging = asBoolean(raw.messaging, 'messaging')
  return config
}
