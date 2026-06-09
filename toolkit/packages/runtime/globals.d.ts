// Ambient declarations for the Claude Code workflow sandbox globals.
// Import this file in consumer tsconfig.json (e.g. via `types` or `include`)
// to type-check raw workflow scripts and emitted bodies.
//
// console and setTimeout/clearTimeout also exist in-sandbox; standard lib
// types (lib.dom.d.ts or lib.es2022.d.ts) already cover them.
//
// This file lives OUTSIDE src/ so the package's own tsconfig (include:
// src+test) never picks it up — declaring these globals during the package's
// own compilation would let an accidental bare `agent` call in src/ typecheck
// silently. Consumers opt in by adding it to their tsconfig include/files list.

import type { AgentFn, ParallelFn, PipelineFn, Budget, WorkflowFn } from './src/types.js'

declare global {
  /** Spawn one fresh-context subagent. */
  const agent: AgentFn
  /** Run thunks concurrently; a barrier. */
  const parallel: ParallelFn
  /** Stream items through stages, no barrier. */
  const pipeline: PipelineFn
  /** Start a progress group; later agents join it. */
  function phase(title: string): void
  /** Emit a narrator line above the progress tree. */
  function log(message: string): void
  /** Token budget for this turn. */
  const budget: Budget
  /** Whatever was passed as the tool's args input. Normalize before use. */
  const args: unknown
  /** Run another workflow inline. One nesting level only. */
  const workflow: WorkflowFn
}

export {}
