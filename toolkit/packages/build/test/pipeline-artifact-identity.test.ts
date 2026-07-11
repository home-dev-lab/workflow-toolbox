// pipeline-artifact-identity.test.ts — rebuild-byte-identity gate over toolkit/pipelines/
// (I5 authoring increment). Modeled directly on artifact-identity.test.ts's own gate for
// toolkit/workflows/*.js — the SAME "commit built artifacts" contract (CLAUDE.md, ADR 0002)
// applies to a definePipeline() entry's emitted PipelineSpec JSON: every committed entry under
// toolkit/examples/*.pipeline.ts must rebuild byte-identical to its committed
// toolkit/pipelines/*.json, and every committed artifact must come from exactly one committed
// entry (no orphans, no stale siblings).
//
// Remedy on failure: `pnpm wt:pipeline examples/<entry>.pipeline.ts` (from toolkit/) for each
// stale artifact, then commit the regenerated .json.
//
// Routes through `main()` — the REAL CLI entry point `workflow-toolbox pipeline` itself
// dispatches through — rather than calling `bundlePipeline()` bare (card #1813065099577918566
// follow-up, closing a real blind spot found live): `bundlePipeline()` alone never exercised
// `runPipeline`'s own filename-derived `name` injection step, so this gate stayed green
// forever comparing two bundlePipeline-only outputs even as the committed
// toolkit/pipelines/feature-review.json silently drifted out of sync with what the CLI users
// actually run now produces. Routing through `main()` closes that gap FOR ANY future
// CLI-level transformation, not just this one field.

import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { main } from '../src/cli.js'
import { pipelineBaseName } from '../src/bundle-pipeline.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const EXAMPLES_DIR = join(REPO_ROOT, 'toolkit/examples')
const PIPELINES_DIR = join(REPO_ROOT, 'toolkit/pipelines')

const entries = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith('.pipeline.ts'))
  .sort()
const artifacts = readdirSync(PIPELINES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('committed pipeline artifacts — rebuild byte-identity', () => {
  it('the gate has sources and artifacts to cover', () => {
    expect(entries.length).toBeGreaterThan(0)
    expect(artifacts.length).toBeGreaterThan(0)
  })

  it(
    'every toolkit/pipelines/*.json is exactly what `workflow-toolbox pipeline` (the real CLI) would write for one toolkit/examples/*.pipeline.ts',
    async () => {
      // <pipelineBaseName>.json → { entry, text } as the REAL CLI writes it today (via main(),
      // the exact code path `pnpm wt:pipeline`/`workflow-toolbox pipeline` runs — name
      // injection, trailing newline, and any future runPipeline-level step all included).
      const rebuilt = new Map<string, { entry: string; text: string }>()
      for (const entry of entries) {
        const outDir = mkdtempSync(join(tmpdir(), 'wt-pipeline-identity-'))
        tmpDirs.push(outDir)
        await main(['pipeline', join(EXAMPLES_DIR, entry), '--out-dir', outDir])
        const name = `${pipelineBaseName(join(EXAMPLES_DIR, entry))}.json`
        const text = readFileSync(join(outDir, name), 'utf8')
        rebuilt.set(name, { entry, text })
      }

      // Set equality both ways: a source without an artifact is an unbuilt pipeline; an
      // artifact without a source is an orphan.
      expect([...rebuilt.keys()].sort()).toEqual(artifacts)

      for (const [name, { entry, text }] of rebuilt) {
        const committed = readFileSync(join(PIPELINES_DIR, name), 'utf8')
        // Boolean compare on purpose — a string-diff over a JSON artifact is noise; the remedy
        // is a rebuild, not a manual edit.
        expect(
          committed === text,
          `${name} is stale — regenerate it with: pnpm wt:pipeline examples/${entry}`,
        ).toBe(true)
      }
    },
    120_000,
  )
})
