// define-workflow.ts — workflow declaration helper for @dwt/build.
//
// SANDBOX-PURE CONSTRAINT: this file is bundled into workflow artifacts that
// run inside the Claude Code workflow sandbox. The sandbox has no Node.js
// APIs, no filesystem, no require(), no dynamic imports. Therefore:
//   • No imports except type-only imports from @dwt/runtime (erased at emit).
//   • No `node:` imports, no `process`, no `Buffer`, no esbuild.
//   • All validation is synchronous and uses only primitive JS operations.
//
// Design:
//   defineWorkflow() validates meta at CALL TIME (before the workflow is ever
//   run) so configuration errors surface immediately at load/bundle time rather
//   than inside a live run. This follows the @dwt/patterns convention: "config
//   errors throw at entry" (see envelope.ts applyCap, e.g.).
//
//   The run pipeline is: normalizeArgs(rawArgs) → parseInput (default: identity
//   cast) → def.run(rt, input). parseInput errors propagate untouched — the
//   caller-supplied validator owns its error messages (fail-fast input guard).

import type { WorkflowRuntime } from '@dwt/runtime'

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

      // Step 3: delegate to the workflow body
      return def.run(rt, input)
    },
  }
}
