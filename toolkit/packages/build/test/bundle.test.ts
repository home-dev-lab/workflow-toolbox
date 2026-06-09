// bundle.test.ts — integration tests for bundleWorkflow (real esbuild).
//
// These tests are the heart of M3. They exercise the full build pipeline:
// esbuild IIFE → meta extraction via vm → serialization → glue assembly.
//
// TDD cycle: tests written first (RED), then src/bundle.ts makes them GREEN.

import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleWorkflow, sizeWarnings, SANDBOX_GLOBAL_NAMES } from '../src/bundle.js'
import { lintWorkflowSource } from '../src/lint.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')

function fixturePath(name: string): string {
  return path.join(FIXTURES, name)
}

// ---------------------------------------------------------------------------
// hello fixture — structural checks
// ---------------------------------------------------------------------------

describe('bundleWorkflow — hello fixture', () => {
  it('emits code where meta statement is the FIRST statement', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    // The very first non-whitespace content must be `export const meta =`
    expect(result.code.trimStart()).toMatch(/^export const meta = \{/)
  })

  it('emitted code contains `var __dwt` (esbuild IIFE)', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    expect(result.code).toContain('var __dwt')
  })

  it('emitted code ends with the glue block', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    const trimmed = result.code.trimEnd()
    // Must end with the return statement from the glue
    expect(trimmed).toMatch(/return await __dwt\.default\.run\(__rt,/)
  })

  it('lintWorkflowSource reports zero errors on emitted code', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    const lint = lintWorkflowSource(result.code)
    expect(lint.errors).toHaveLength(0)
  })

  it('no import or require in emitted code (fully bundled)', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    // After esbuild bundles, there should be no import/require statements
    // The lint warnings check catches import…from; also check require
    const lint = lintWorkflowSource(result.code)
    // Filter out only import/require warnings (not other warnings)
    const importWarnings = lint.warnings.filter(
      w => w.includes('import') || w.includes('require()'),
    )
    expect(importWarnings).toHaveLength(0)
  })

  it('extracted meta equals the fixture meta', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    expect(result.meta.name).toBe('dwt-fixture-hello')
    expect(result.meta.description).toContain('Minimal fixture')
    expect(result.meta.phases).toHaveLength(1)
    expect(result.meta.phases?.[0]?.title).toBe('Run')
  })

  it('bytes equals Buffer.byteLength(code)', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    expect(result.bytes).toBe(Buffer.byteLength(result.code))
  })

  it('parts.metaStatement + parts.iife + parts.glue assembles to code', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    const assembled = result.parts.metaStatement + '\n' + result.parts.iife + result.parts.glue
    expect(assembled).toBe(result.code)
  })

  it('parts.metaStatement starts with export const meta', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    expect(result.parts.metaStatement.trimStart()).toMatch(/^export const meta = \{/)
  })

  it('parts.iife contains var __dwt', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    expect(result.parts.iife).toContain('var __dwt')
  })

  it('parts.glue contains all SANDBOX_GLOBAL_NAMES names', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    for (const name of SANDBOX_GLOBAL_NAMES) {
      expect(result.parts.glue).toContain(name)
    }
  })
})

// ---------------------------------------------------------------------------
// with-pattern fixture — proves pattern inlining
// ---------------------------------------------------------------------------

describe('bundleWorkflow — with-pattern fixture', () => {
  it('bundles cleanly (no esbuild errors)', async () => {
    await expect(
      bundleWorkflow({ entry: fixturePath('with-pattern.workflow.ts') }),
    ).resolves.toBeDefined()
  })

  it('emitted code contains inlined fanOutAndSynthesize function name', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('with-pattern.workflow.ts') })
    expect(result.code).toContain('fanOutAndSynthesize')
  })

  it('lintWorkflowSource reports zero errors on emitted code', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('with-pattern.workflow.ts') })
    const lint = lintWorkflowSource(result.code)
    expect(lint.errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// no-default-export fixture — negative case
// ---------------------------------------------------------------------------

describe('bundleWorkflow — no-default-export fixture', () => {
  it('rejects with actionable message about export default defineWorkflow', async () => {
    await expect(
      bundleWorkflow({ entry: fixturePath('no-default-export.workflow.ts') }),
    ).rejects.toThrow(/export default defineWorkflow/)
  })
})

// ---------------------------------------------------------------------------
// '@workflow-toolbox/build' root-import pre-flight — negative case
//
// Importing the package root from a workflow entry drags node:vm/esbuild into
// the platform-neutral bundle; the pre-flight converts esbuild's cryptic
// "Could not resolve node:vm" into an actionable pointer at '@workflow-toolbox/build/define'.
// ---------------------------------------------------------------------------

describe('bundleWorkflow — @workflow-toolbox/build root-import pre-flight', () => {
  it('rejects an entry importing from the package root, pointing at @workflow-toolbox/build/define', async () => {
    await expect(
      bundleWorkflow({ entry: fixturePath('imports-build-root.workflow.ts') }),
    ).rejects.toThrow(/@workflow-toolbox\/build\/define/)
  })
})

// ---------------------------------------------------------------------------
// vm-evaluation error paths — negative cases
// ---------------------------------------------------------------------------

describe('bundleWorkflow — vm-evaluation error paths', () => {
  it('rejects an entry whose module top level throws', async () => {
    await expect(
      bundleWorkflow({ entry: fixturePath('top-level-throw.workflow.ts') }),
    ).rejects.toThrow(/failed to evaluate bundled IIFE/)
  })

  it('rejects a default export with meta but no run function', async () => {
    await expect(
      bundleWorkflow({ entry: fixturePath('missing-run.workflow.ts') }),
    ).rejects.toThrow(/export default defineWorkflow/)
  })
})

// ---------------------------------------------------------------------------
// minify option
// ---------------------------------------------------------------------------

describe('bundleWorkflow — minify option', () => {
  it('minified output is smaller than default', async () => {
    const [normal, minified] = await Promise.all([
      bundleWorkflow({ entry: fixturePath('with-pattern.workflow.ts') }),
      bundleWorkflow({ entry: fixturePath('with-pattern.workflow.ts'), minify: true }),
    ])
    expect(minified.bytes).toBeLessThan(normal.bytes)
  })

  it('minified output still has meta statement first', async () => {
    const result = await bundleWorkflow({
      entry: fixturePath('with-pattern.workflow.ts'),
      minify: true,
    })
    expect(result.code.trimStart()).toMatch(/^export const meta = \{/)
  })

  it('minified output passes lintWorkflowSource with zero errors', async () => {
    const result = await bundleWorkflow({
      entry: fixturePath('with-pattern.workflow.ts'),
      minify: true,
    })
    const lint = lintWorkflowSource(result.code)
    expect(lint.errors).toHaveLength(0)
  })

  it('identifiers are NOT mangled (fanOutAndSynthesize still present)', async () => {
    // minifyIdentifiers is never set — names must remain readable
    const result = await bundleWorkflow({
      entry: fixturePath('with-pattern.workflow.ts'),
      minify: true,
    })
    expect(result.code).toContain('fanOutAndSynthesize')
  })
})

// ---------------------------------------------------------------------------
// sizeWarnings — unit tests for size policy pure function
// ---------------------------------------------------------------------------

describe('sizeWarnings — size policy boundary tests', () => {
  const WARN_THRESHOLD = 400 * 1024   // 409600
  const ERROR_THRESHOLD = 524288       // MAX_WORKFLOW_BYTES

  it('returns no warning/error for normal-sized artifacts', () => {
    const result = sizeWarnings(1000)
    expect(result.warning).toBeUndefined()
    expect(result.error).toBeUndefined()
  })

  it('returns no warning at exactly WARN_THRESHOLD - 1', () => {
    const result = sizeWarnings(WARN_THRESHOLD - 1)
    expect(result.warning).toBeUndefined()
    expect(result.error).toBeUndefined()
  })

  it('returns a warning at exactly WARN_THRESHOLD', () => {
    const result = sizeWarnings(WARN_THRESHOLD)
    expect(result.warning).toBeDefined()
    expect(result.error).toBeUndefined()
  })

  it('returns a warning at WARN_THRESHOLD + 1', () => {
    const result = sizeWarnings(WARN_THRESHOLD + 1)
    expect(result.warning).toBeDefined()
    expect(result.error).toBeUndefined()
  })

  it('returns no error at exactly ERROR_THRESHOLD - 1', () => {
    const result = sizeWarnings(ERROR_THRESHOLD - 1)
    expect(result.error).toBeUndefined()
  })

  it('returns an error at exactly ERROR_THRESHOLD', () => {
    const result = sizeWarnings(ERROR_THRESHOLD)
    expect(result.error).toBeDefined()
  })

  it('returns an error at ERROR_THRESHOLD + 1', () => {
    const result = sizeWarnings(ERROR_THRESHOLD + 1)
    expect(result.error).toBeDefined()
  })

  it('error message explains why (runtime silently excludes oversized)', () => {
    const result = sizeWarnings(ERROR_THRESHOLD + 100)
    expect(result.error).toMatch(/runtime|registry|disappears|silent/i)
  })

  it('warning message names the mitigation levers', () => {
    const result = sizeWarnings(WARN_THRESHOLD + 1)
    expect(result.warning).toMatch(/args|disk|split|minify/i)
  })
})

// ---------------------------------------------------------------------------
// cwd independence — the artifact must not depend on the invocation cwd
// ---------------------------------------------------------------------------
//
// esbuild writes module-path comments (e.g. `// examples/foo.workflow.ts`)
// relative to its working directory. Without pinning absWorkingDir, the same
// entry built from two different cwds produces different bytes — breaking
// ADR 0002 (committed artifacts must be deterministic and diffable) and the
// plugin-twin byte-identity guarantee. Discovered in P3.4 when the root-level
// `pnpm dwt:build` script (cwd toolkit/) emitted a different artifact than the
// legacy `pnpm -F @workflow-toolbox/build dwt` form (cwd packages/build/).

// NOTE: a chdir-based "build twice from two cwds" test would be VACUOUS here:
// esbuild's JS API spawns a long-lived service process whose working directory
// is pinned at spawn, so an in-process chdir never reaches it (verified: such
// a test passes even without the absWorkingDir fix). The invariant is pinned
// instead by (a) the entry-anchored comment assertion below — absWorkingDir
// makes the cwd irrelevant by construction — and (b) the golden-file test,
// which fails on any cross-process drift of the emitted bytes.
describe('bundleWorkflow — output is cwd-independent', () => {
  it('module-path comments are relative to the entry directory, not the cwd', async () => {
    const result = await bundleWorkflow({ entry: fixturePath('hello.workflow.ts') })
    // The entry lives in fixtures/ — anchored there, its own comment is bare
    // (cwd-relative anchoring would emit e.g. `// test/fixtures/hello.workflow.ts`).
    expect(result.code).toContain('// hello.workflow.ts\n')
  })
})
