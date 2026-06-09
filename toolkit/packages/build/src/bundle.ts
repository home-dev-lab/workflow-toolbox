// bundle.ts — esbuild bundler for @dwt/build (Node-side; node: imports allowed).
//
// Pipeline:
//   1. esbuild: bundle the entry file to an IIFE with globalName '__dwt'.
//   2. Meta extraction via node:vm: evaluate the IIFE in a fresh context and
//      read __dwt.default.meta. Safe-by-construction: the IIFE only DEFINES
//      functions (defineWorkflow validates meta synchronously, no agents run).
//   3. serializeMeta: walk the meta value and reject non-JSON-pure content
//      with path-qualified actionable errors.
//   4. Glue generation: built from SANDBOX_GLOBAL_NAMES (single source of truth) so the
//      globals-typecheck test and the emitted code always stay in sync.
//   5. Assembly: metaStatement + '\n' + iife + glue.
//   6. Size policy: >512 KB → throw; >400 KB → warning.
//
// Design note on minifyIdentifiers: we deliberately NEVER pass minifyIdentifiers
// to esbuild. Identifier names must remain readable in stack traces and in the
// Claude Code permission dialogs where users review what an agent is doing.

import { build as esbuild } from 'esbuild'
import * as vm from 'node:vm'
import * as path from 'node:path'
import { readFile } from 'node:fs/promises'
import { MAX_WORKFLOW_BYTES } from './lint.js'
import type { WorkflowMeta } from './define-workflow.js'

// ---------------------------------------------------------------------------
// SANDBOX_GLOBAL_NAMES — single source of truth for the sandbox global names.
//
// Used to generate:
//   • The glue block (const __rt = { agent, parallel, … })
//   • The AsyncFunction parameter list in replay.test.ts
//   • The typecheck snippet in globals-typecheck.test.ts
// Any addition to the sandbox surface requires only this array to change.
// ---------------------------------------------------------------------------

export const SANDBOX_GLOBAL_NAMES = [
  'agent',
  'parallel',
  'pipeline',
  'phase',
  'log',
  'budget',
  'workflow',
] as const

// ---------------------------------------------------------------------------
// BundleResult — what bundleWorkflow returns
// ---------------------------------------------------------------------------

export interface BundleResult {
  /** Full emitted artifact: metaStatement + '\n' + iife + glue */
  code: string
  /** Individual parts for tests and replay (meta statement stripped so the
   *  replay AsyncFunction can use top-level return legally). */
  parts: {
    metaStatement: string
    iife: string
    glue: string
  }
  /** Extracted, validated WorkflowMeta from the bundled entry. */
  meta: WorkflowMeta
  /** Buffer.byteLength(code) — precomputed for size-policy checks. */
  bytes: number
  /** Size warnings (e.g. approaching the 512 KB limit). Never fatal. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// sizeWarnings — pure size-policy function, unit-testable at boundaries.
//
// Two thresholds:
//   >400 KB → warning (name the levers so the author knows what to do)
//   >=512 KB → error (the runtime silently excludes oversized files from the
//              name registry — the workflow "disappears" with no diagnostic)
//
// Exported so bundle.test.ts can unit-test the exact boundary values without
// needing giant fixtures.
// ---------------------------------------------------------------------------

export function sizeWarnings(bytes: number): { error?: string; warning?: string } {
  // WARN is BUILD policy (advisory headroom, ours to tune); MAX is the
  // runtime parser's hard rule, shared with lint.ts — hence imported, not
  // redefined. The asymmetry is deliberate.
  const WARN = 400 * 1024  // 409 600
  const MAX = MAX_WORKFLOW_BYTES  // 524 288

  if (bytes >= MAX) {
    return {
      error:
        `artifact is ${bytes} bytes — at or over the ${MAX}-byte (512 KB) limit. `
        + `The runtime silently excludes oversized files from the name registry, `
        + `so the workflow disappears with no diagnostic. `
        + `Levers: move embedded data to args or leave it on disk for agents to read; `
        + `split into two workflows with a checkpoint between; --minify as a last resort.`,
    }
  }

  if (bytes >= WARN) {
    return {
      warning:
        `artifact is ${bytes} bytes — approaching the 512 KB runtime limit. `
        + `Levers: move embedded data to args or leave it on disk for agents to read; `
        + `split into two workflows with a checkpoint between; --minify as a last resort.`,
    }
  }

  return {}
}

// ---------------------------------------------------------------------------
// serializeMeta — walk meta and reject non-JSON-pure values.
//
// JSON-pure: plain objects, arrays, strings, finite numbers, booleans, null.
// Rejected: undefined, functions, symbols, bigint, class instances (incl. Date).
//
// Errors include the full dot-bracket path (e.g. `meta.phases[0].title`) so
// the workflow author knows exactly where the violation is.
//
// Exported so serialize-meta.test.ts can unit-test it in isolation.
// ---------------------------------------------------------------------------

export function serializeMeta(meta: WorkflowMeta): string {
  walkForPurity(meta, 'meta')
  return `export const meta = ${JSON.stringify(meta, null, 2)}`
}

function walkForPurity(value: unknown, path: string): void {
  if (value === null) return
  if (value === undefined) {
    throw new Error(
      `meta serialization error at ${path}: undefined values are not JSON-pure — `
      + `remove the key or assign an explicit value`,
    )
  }

  const type = typeof value

  if (type === 'function') {
    throw new Error(
      `meta serialization error at ${path}: function values are not JSON-pure — `
      + `meta must be a plain data object; move logic to the run function`,
    )
  }
  if (type === 'symbol') {
    throw new Error(
      `meta serialization error at ${path}: symbol values are not JSON-pure — `
      + `only strings, numbers, booleans, null, arrays, and plain objects are allowed`,
    )
  }
  if (type === 'bigint') {
    throw new Error(
      `meta serialization error at ${path}: bigint values are not JSON-pure — `
      + `use a regular number instead (or a string if precision matters)`,
    )
  }
  if (type === 'number') {
    // The cast is compiler-required: `type` is a stored typeof result and TS
    // only narrows `value` to {} here, not number (isFinite wants number).
    if (!isFinite(value as number)) {
      throw new Error(
        `meta serialization error at ${path}: ${String(value)} is not JSON-pure — `
        + `only finite numbers are allowed (not NaN or Infinity)`,
      )
    }
    return
  }
  if (type === 'string' || type === 'boolean') return

  // Object — must be a plain object or array (no class instances).
  //
  // Cross-realm note: the meta object may come from a node:vm context where
  // Object.prototype !== the host Object.prototype. We therefore check by
  // constructor name rather than prototype identity. The allowed constructor
  // names for JSON-pure values are 'Object', 'Array', and '' (null-prototype).
  if (type === 'object') {
    const ctorName: string = (value as object).constructor?.name ?? ''

    if (Array.isArray(value)) {
      // Arrays are always JSON-pure containers; recurse into elements.
      for (let i = 0; i < value.length; i++) {
        walkForPurity(value[i], `${path}[${i}]`)
      }
    } else if (ctorName === 'Object' || ctorName === '') {
      // Plain object (own or null-prototype) — recurse into values.
      for (const key of Object.keys(value as object)) {
        walkForPurity((value as Record<string, unknown>)[key], `${path}.${key}`)
      }
    } else {
      // Class instance (Date, RegExp, Map, Set, …) — not JSON-pure.
      throw new Error(
        `meta serialization error at ${path}: class instance (${ctorName}) is not JSON-pure — `
        + `only plain objects, arrays, strings, numbers, booleans, and null are allowed`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// buildGlue — generate the glue block from SANDBOX_GLOBAL_NAMES.
//
// The glue binds sandbox globals into __rt and invokes __dwt.default.run.
// We standardize on `__dwt.default.run` because bundleWorkflow requires the
// entry to `export default defineWorkflow({...})`.
// ---------------------------------------------------------------------------

function buildGlue(): string {
  const rtFields = SANDBOX_GLOBAL_NAMES.join(', ')
  return (
    '\n'
    + '// --- dwt glue: bind sandbox globals into rt, run the workflow, return ---\n'
    + `const __rt = { ${rtFields} };\n`
    + `return await __dwt.default.run(__rt, typeof args !== "undefined" ? args : undefined);\n`
  )
}

// ---------------------------------------------------------------------------
// bundleWorkflow — main entry point
// ---------------------------------------------------------------------------

export async function bundleWorkflow(opts: {
  entry: string
  minify?: boolean
}): Promise<BundleResult> {
  const warnings: string[] = []

  // -------------------------------------------------------------------------
  // Step 0: pre-flight — catch the '@dwt/build' foot-gun with an actionable
  // error. Workflow entries must import defineWorkflow from the sandbox-pure
  // '@dwt/build/define' subpath; importing the package root drags the Node
  // bundler (node:vm, esbuild) into the platform-neutral bundle and esbuild
  // fails with a cryptic "Could not resolve node:vm".
  // -------------------------------------------------------------------------

  const entrySource = await readFile(opts.entry, 'utf8')
  if (/from\s+['"]@dwt\/build['"]/.test(entrySource)) {
    throw new Error(
      `bundleWorkflow: ${opts.entry} imports from '@dwt/build' (the Node-side bundler). ` +
        `Workflow entries must import from '@dwt/build/define' (sandbox-pure) instead — ` +
        `change the import to: import { defineWorkflow } from '@dwt/build/define'`,
    )
  }

  // -------------------------------------------------------------------------
  // Step 1: esbuild
  //
  // format: 'iife' + globalName: '__dwt' → the output is:
  //   var __dwt = (() => { … return __toCommonJS(entry_exports); })();
  //
  // platform: 'neutral' → no Node/browser specific shimming; the artifact
  // runs in the Claude Code sandbox which is neither.
  //
  // minifyIdentifiers is intentionally absent — see file header.
  //
  // absWorkingDir: anchored to the ENTRY's directory, not the process cwd.
  // esbuild writes module-path comments relative to its working directory;
  // left at the default (process cwd — pinned at esbuild-service spawn), the
  // same entry built from two cwds emits different bytes, breaking ADR 0002
  // (committed artifacts must be deterministic and diffable) and the plugin
  // twin byte-identity. Entry-dir anchoring is invocation-independent.
  // -------------------------------------------------------------------------

  const buildResult = await esbuild({
    entryPoints: [opts.entry],
    absWorkingDir: path.dirname(path.resolve(opts.entry)),
    bundle: true,
    format: 'iife',
    globalName: '__dwt',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    ...(opts.minify
      ? { minifyWhitespace: true, minifySyntax: true }
      : {}),
  })

  if (buildResult.errors.length > 0) {
    const formatted = buildResult.errors
      .map(e => {
        const loc = e.location
          ? ` (${e.location.file}:${e.location.line}:${e.location.column})`
          : ''
        return `esbuild error${loc}: ${e.text}`
      })
      .join('\n')
    throw new Error(`bundleWorkflow: esbuild failed:\n${formatted}`)
  }

  const outputFile = buildResult.outputFiles[0]
  if (outputFile === undefined) {
    throw new Error('bundleWorkflow: esbuild produced no output files')
  }

  // esbuild prepends `"use strict";\n` to IIFE output bundled from ESM sources
  // (verified with esbuild 0.25.12 — the version this package pins; the golden
  // test pins the full output shape). Strip it — anchored to the very start of
  // the output only (optional leading whitespace, either quote style), so a
  // literal "use strict" line elsewhere in user code is left alone. Rationale:
  // the directive would be a statement BEFORE `export const meta` in the
  // assembled artifact, and the workflow parser rejects any code preceding
  // meta (M0 canary C3). The live-proven C6 artifact shape carries no
  // directive; ESM-generated bundle code does not rely on sloppy/strict
  // differences the strip could break. A post-assembly invariant below catches
  // any future esbuild preamble this regex misses.
  const rawIife = outputFile.text
  const iife = rawIife.replace(/^\s*['"]use strict['"];\s*\n?/, '')

  // -------------------------------------------------------------------------
  // Step 2: meta extraction via node:vm
  //
  // We evaluate the IIFE in a fresh V8 context to read __dwt.default.meta.
  // This is safe-by-construction: the IIFE only DEFINES functions and calls
  // defineWorkflow() synchronously to validate meta. No agents run, no I/O
  // occurs. We never eval user-supplied data — only our own build-time output.
  //
  // NOT a trust boundary: node:vm provides no isolation guarantees (no
  // timeout, escapable context). It is an extraction convenience for OUR OWN
  // code. If this ever needs to evaluate untrusted third-party workflow
  // sources, vm is the wrong tool — do not reuse this as a sandbox.
  // -------------------------------------------------------------------------

  const context = vm.createContext({})
  try {
    vm.runInContext(iife, context)
  } catch (e) {
    throw new Error(
      `bundleWorkflow: failed to evaluate bundled IIFE — `
      + `check that the entry file compiles and has no top-level side effects: ${String(e)}`,
    )
  }

  const dwtExport = (context as Record<string, unknown>)['__dwt']
  if (dwtExport === undefined) {
    throw new Error(
      `bundleWorkflow: evaluated IIFE did not set __dwt — `
      + `the entry file must \`export default defineWorkflow({...})\``,
    )
  }

  const defaultExport = (dwtExport as Record<string, unknown>)['default']
  if (
    defaultExport === undefined
    || typeof (defaultExport as Record<string, unknown>)['meta'] !== 'object'
    || typeof (defaultExport as Record<string, unknown>)['run'] !== 'function'
  ) {
    throw new Error(
      `bundleWorkflow: __dwt.default is missing meta or run — `
      + `the entry file must \`export default defineWorkflow({...})\``,
    )
  }

  const rawMeta = (defaultExport as Record<string, unknown>)['meta'] as WorkflowMeta

  // -------------------------------------------------------------------------
  // Step 3: serializeMeta — validate JSON-purity and emit the meta statement
  // -------------------------------------------------------------------------

  const metaStatement = serializeMeta(rawMeta)

  // -------------------------------------------------------------------------
  // Step 4: glue generation
  // -------------------------------------------------------------------------

  const glue = buildGlue()

  // -------------------------------------------------------------------------
  // Step 5: assemble code
  //
  // Exact newline: metaStatement + '\n' + iife + glue
  // The meta statement is the first parseable statement — lintWorkflowSource
  // enforces this by checking that nothing precedes `export const meta =`.
  // -------------------------------------------------------------------------

  const code = metaStatement + '\n' + iife + glue
  const bytes = Buffer.byteLength(code)

  // Invariant: meta must be the first parseable statement of the artifact —
  // the workflow parser rejects anything before it (M0 canary C3). This guards
  // against a future esbuild emitting a preamble the "use strict" strip above
  // does not recognize. Defense-in-depth with cli.ts's lint pass, but enforced
  // HERE so direct bundleWorkflow() callers can never receive a broken artifact.
  if (!code.startsWith('export const meta =')) {
    throw new Error(
      'bundleWorkflow: assembled artifact does not start with `export const meta =` — '
      + 'esbuild emitted an unrecognized preamble before the bundle (bundler bug, please report); '
      + `artifact starts with: ${JSON.stringify(code.slice(0, 60))}`,
    )
  }

  // -------------------------------------------------------------------------
  // Step 6: size policy
  // -------------------------------------------------------------------------

  const sizeResult = sizeWarnings(bytes)
  if (sizeResult.error !== undefined) {
    throw new Error(`bundleWorkflow: ${sizeResult.error}`)
  }
  if (sizeResult.warning !== undefined) {
    warnings.push(sizeResult.warning)
  }

  return {
    code,
    parts: { metaStatement, iife, glue },
    meta: rawMeta,
    bytes,
    warnings,
  }
}
