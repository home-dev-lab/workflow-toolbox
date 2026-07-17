// dispatch.ts — the per-mode scaffold write-out plumbing shared by the two CLIs:
// @workflow-toolbox/build's published `workflow-toolbox scaffold` subcommand and the
// dev-only `wt:scaffold`. The mode->(load, render, outName) mapping is the ESSENTIAL
// shared knowledge — adding a scaffold mode or changing an artifact's filename
// convention is a one-place edit here, so the two CLIs cannot drift.
//
// IMPURE (renderScaffold reads the spec file; writeScaffoldArtifact touches the
// filesystem) — kept out of the pure `./` index (index.ts documents "the impure
// CLI lives in cli.ts") on its own `./dispatch` subpath. Each CLI keeps what
// genuinely differs between them: user-facing messages, the `next` hint, build's
// tsconfig emission, and the throw-vs-exit-code error idiom.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { scaffoldAgent, scaffoldObserver, scaffoldWorkflow } from './scaffold.js'
import type { AgentScaffoldSpec, ObserverScaffoldSpec, ScaffoldSpec } from './scaffold.js'
import { loadAgentSpec, loadObserverSpec, loadSpec } from './spec-io.js'

export type ScaffoldMode = 'workflow' | 'agent' | 'observer'

/** The loaded spec + rendered source + derived output filename for one mode.
 *  Discriminated on `mode` so a caller can narrow to the concrete spec type
 *  (its `next`-hint text is mode-specific and differs between the two CLIs). */
export type RenderedScaffold =
  | { mode: 'workflow'; source: string; outName: string; spec: ScaffoldSpec }
  | { mode: 'agent'; source: string; outName: string; spec: AgentScaffoldSpec }
  | { mode: 'observer'; source: string; outName: string; spec: ObserverScaffoldSpec }

/** Load the spec for `mode` from `specPath`, render its source, and derive the
 *  output filename. Loader / emitter validation errors propagate unchanged so
 *  both CLIs surface the same actionable messages. */
export function renderScaffold(mode: ScaffoldMode, specPath: string): RenderedScaffold {
  switch (mode) {
    case 'observer': {
      const spec = loadObserverSpec(specPath)
      return { mode, source: scaffoldObserver(spec), outName: `${spec.name}.observer.json`, spec }
    }
    case 'agent': {
      const spec = loadAgentSpec(specPath)
      return { mode, source: scaffoldAgent(spec), outName: `${spec.name}.md`, spec }
    }
    case 'workflow': {
      const spec = loadSpec(specPath)
      return { mode, source: scaffoldWorkflow(spec), outName: `${spec.meta.name}.workflow.ts`, spec }
    }
  }
}

export interface WriteScaffoldOptions {
  source: string
  outName: string
  outDir: string
  stdout: boolean
  force: boolean
}

/** Outcome of writeScaffoldArtifact. `outFile` is `path.join(outDir, outName)`
 *  using `outDir` exactly as the caller passed it (a caller that resolves outDir
 *  up front gets an absolute path; one that passes the raw value gets a relative
 *  one) — so each CLI keeps its own logged-path convention. */
export type ScaffoldWriteResult =
  | { kind: 'stdout' }
  | { kind: 'written'; outFile: string }
  | { kind: 'refused'; outFile: string }

/** The generic write-out mechanics both CLIs share: --stdout short-circuit,
 *  no-clobber-without-force refusal, mkdir -p, write. Filesystem operations always
 *  run against the resolved absolute path; the returned `outFile` preserves the
 *  caller's own outDir form (see ScaffoldWriteResult). The caller owns ALL
 *  user-facing messaging and the throw-vs-exit-code policy — a `refused` result is
 *  returned, never thrown, so build can throw and wt:scaffold can return a code. */
export function writeScaffoldArtifact(opts: WriteScaffoldOptions): ScaffoldWriteResult {
  if (opts.stdout) {
    process.stdout.write(opts.source)
    return { kind: 'stdout' }
  }
  const outFile = path.join(opts.outDir, opts.outName)
  if (fs.existsSync(path.resolve(outFile)) && !opts.force) {
    return { kind: 'refused', outFile }
  }
  fs.mkdirSync(path.resolve(opts.outDir), { recursive: true })
  fs.writeFileSync(path.resolve(outFile), opts.source, 'utf8')
  return { kind: 'written', outFile }
}
