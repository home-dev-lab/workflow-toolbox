// bundle-pipeline.ts — esbuild bundler for a PIPELINE entry (@workflow-toolbox/build, I5
// authoring increment). Mirrors bundle.ts's esbuild-then-node:vm-extraction mechanism, but for
// a definePipeline() entry instead of a defineWorkflow() one — see define-pipeline.ts's doc for
// why this needs no sandbox-pure subpath and bundles with `platform: 'node'` rather than
// bundleWorkflow's `platform: 'neutral'`: a PipelineSpec is a plain JSON document consumed by
// the observe-ui SERVER (POST /api/pipeline {spec}), never executed inside the Workflow
// sandbox, so there is no reason to forbid Node APIs in the entry's dependency graph.
//
// Pipeline:
//   1. esbuild: bundle the entry file to an IIFE with globalName '__wtp' (distinct from
//      bundleWorkflow's '__wt' so the two can never be confused if ever evaluated in one
//      process).
//   2. Spec extraction via node:vm: evaluate the IIFE in a fresh context and read
//      __wtp.default.spec. Safe-by-construction — same rationale as bundleWorkflow's own
//      meta-extraction step: the IIFE only DEFINES functions and calls definePipeline()
//      synchronously to validate the stage list; no agents run, no I/O occurs.
//   3. Round-trip parsePipelineSpec: JSON.stringify → JSON.parse → parsePipelineSpec — the
//      analogue of bundleWorkflow's serializeMeta JSON-purity walk, but reusing the SAME
//      structural validator the observe-ui runner and the HTTP boundary use. This is STRONGER
//      than a generic purity walk: definePipeline's own validateStageList only checks the
//      STAGE LIST shape (not goal/projectDir/workspaceId's types), so a spec that bypassed
//      TypeScript via a cast (`as PipelineSpec`) can pass definePipeline() yet still fail this
//      round-trip — exactly the case this step exists to catch.
//   4. Assembly: pretty-printed JSON. No glue, no sandbox globals — nothing RUNS; this is a
//      data artifact, not an executable one.

import { build as esbuild } from 'esbuild'
import * as vm from 'node:vm'
import * as path from 'node:path'
import { readFile } from 'node:fs/promises'
import { parsePipelineSpec, type PipelineSpec } from '@workflow-toolbox/pipeline-spec'

export interface BundlePipelineResult {
  /** The validated, round-tripped spec — guaranteed to be exactly what parsePipelineSpec would
   *  accept back from disk (the safety net a raw `defaultExport.spec` alone doesn't give). */
  spec: PipelineSpec
  /** Pretty-printed JSON — what gets written to disk. */
  json: string
  /** Buffer.byteLength(json). */
  bytes: number
}

export async function bundlePipeline(opts: { entry: string; minify?: boolean }): Promise<BundlePipelineResult> {
  // -------------------------------------------------------------------------
  // Step 0: pre-flight — a pipeline entry may safely BUNDLE against the '@workflow-toolbox/build'
  // root (platform:'node' resolves its node:vm/esbuild imports fine, unlike bundleWorkflow's
  // neutral-platform case) — but `workflow-toolbox pipeline --typecheck` runs a WHOLE-PROGRAM
  // tsc pass over the entry's reachable graph, and the root re-exports bundleWorkflow +
  // bundlePipeline themselves, dragging their Node-heavy internals into that graph for no
  // reason. Catch it here with the same actionable-error posture as bundleWorkflow's own Step 0.
  // -------------------------------------------------------------------------

  const entrySource = await readFile(opts.entry, 'utf8')
  if (/from\s+['"]@workflow-toolbox\/build['"]/.test(entrySource)) {
    throw new Error(
      `bundlePipeline: ${opts.entry} imports from '@workflow-toolbox/build' (the Node-side bundler). ` +
        `Pipeline entries must import from '@workflow-toolbox/build/define-pipeline' instead — ` +
        `change the import to: import { definePipeline } from '@workflow-toolbox/build/define-pipeline'`,
    )
  }

  // -------------------------------------------------------------------------
  // Step 1: esbuild — platform:'node' (not bundleWorkflow's 'neutral'): this artifact never
  // runs inside the Workflow sandbox, so node:vm/esbuild/any Node import in the entry's own
  // dependency graph resolves fine — no SANDBOX-purity reason for the '/define-pipeline'
  // subpath (Step 0's reason is a typecheck-graph one, not a sandbox one).
  // -------------------------------------------------------------------------

  const buildResult = await esbuild({
    entryPoints: [opts.entry],
    absWorkingDir: path.dirname(path.resolve(opts.entry)),
    bundle: true,
    format: 'iife',
    globalName: '__wtp',
    platform: 'node',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    ...(opts.minify ? { minifyWhitespace: true, minifySyntax: true } : {}),
  })

  if (buildResult.errors.length > 0) {
    const formatted = buildResult.errors
      .map((e) => {
        const loc = e.location ? ` (${e.location.file}:${e.location.line}:${e.location.column})` : ''
        return `esbuild error${loc}: ${e.text}`
      })
      .join('\n')
    throw new Error(`bundlePipeline: esbuild failed:\n${formatted}`)
  }

  const outputFile = buildResult.outputFiles[0]
  if (outputFile === undefined) {
    throw new Error('bundlePipeline: esbuild produced no output files')
  }
  // Same "use strict" strip as bundleWorkflow — esbuild prepends it to IIFE output bundled
  // from ESM sources; irrelevant here (no meta-must-be-first-statement rule for a JSON
  // artifact) but stripped for consistency with the sibling bundler.
  const iife = outputFile.text.replace(/^\s*['"]use strict['"];\s*\n?/, '')

  // -------------------------------------------------------------------------
  // Step 2: spec extraction via node:vm — NOT a trust boundary (see bundleWorkflow's own doc):
  // an extraction convenience for OUR OWN build-time output, never for untrusted third-party
  // sources.
  // -------------------------------------------------------------------------

  const context = vm.createContext({})
  try {
    vm.runInContext(iife, context)
  } catch (e) {
    throw new Error(
      `bundlePipeline: failed to evaluate bundled IIFE — `
      + `check that the entry file compiles and has no top-level side effects: ${String(e)}`,
    )
  }

  const wtpExport = (context as Record<string, unknown>)['__wtp']
  if (wtpExport === undefined) {
    throw new Error(
      `bundlePipeline: evaluated IIFE did not set __wtp — `
      + `the entry file must \`export default definePipeline({...})\``,
    )
  }

  const defaultExport = (wtpExport as Record<string, unknown>)['default']
  if (defaultExport === undefined || typeof (defaultExport as Record<string, unknown>)['spec'] !== 'object') {
    throw new Error(
      `bundlePipeline: __wtp.default is missing spec — `
      + `the entry file must \`export default definePipeline({...})\``,
    )
  }

  const rawSpec: unknown = (defaultExport as Record<string, unknown>)['spec']

  // -------------------------------------------------------------------------
  // Step 3: round-trip through parsePipelineSpec
  // -------------------------------------------------------------------------

  let json: string
  try {
    json = JSON.stringify(rawSpec, null, 2)
  } catch (e) {
    throw new Error(`bundlePipeline: spec is not JSON-serializable: ${String(e)}`)
  }
  const roundTripped = parsePipelineSpec(JSON.parse(json))
  if (roundTripped === null) {
    throw new Error(
      `bundlePipeline: the emitted spec failed the parsePipelineSpec round-trip check — this `
      + `usually means a field bypassed TypeScript's checks (e.g. an \`as PipelineSpec\` cast) `
      + `with a value the runtime parser rejects (wrong type, an unrecognized artifact/extractor `
      + `key, etc.); check the spec against PipelineSpec's shape. Raw spec (after JSON `
      + `round-trip): ${json}`,
    )
  }

  return { spec: roundTripped, json, bytes: Buffer.byteLength(json) }
}

/** Strip a `.pipeline.ts` suffix (the authoring convention, mirroring `*.workflow.ts`) if
 *  present, else just `.ts` — the base name the CLI derives BOTH the output JSON filename AND
 *  (card #1813065099577918566) the spec's own `name` field from, when the author's spec
 *  doesn't declare one (see cli.ts's `runPipeline`). Exported so the byte-identity gate
 *  (packages/build/test/pipeline-artifact-identity.test.ts) predicts the SAME output filename
 *  the CLI would, rather than a hand-duplicated copy that could silently drift out of sync
 *  with it — NOTE: that gate calls `bundlePipeline` directly, bypassing the CLI's own `name`
 *  injection entirely, so it does not exercise/enforce that step (see the CLI's own doc). */
export function pipelineBaseName(absEntry: string): string {
  const base = path.basename(absEntry)
  return base.endsWith('.pipeline.ts') ? base.slice(0, -'.pipeline.ts'.length) : base.replace(/\.ts$/, '')
}
