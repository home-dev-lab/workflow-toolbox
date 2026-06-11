// artifact-identity.test.ts — rebuild-byte-identity gate over toolkit/workflows/.
//
// The repo's contract (CLAUDE.md, ADR 0002) says the committed artifacts under
// toolkit/workflows/ are generated, deterministic and byte-identity-checked —
// but until now the only byte-identity gate covered the two debugger bins, not
// the workflow artifacts. That gap let the votesPerClaim feature commit
// regenerate dev-review-fix.js while leaving every other artifact that bundles
// adversarialVerification stale, with the full suite green. This test closes
// the gap: every committed entry under toolkit/examples/ must rebuild
// byte-identical to its committed artifact, and every committed artifact must
// be produced by exactly one committed entry (no orphans, no stale siblings).
//
// Remedy on failure: `pnpm wt:build examples/<entry>.workflow.ts` (from
// toolkit/) for each stale artifact, then commit the regenerated .js.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundleWorkflow } from '../src/bundle.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const EXAMPLES_DIR = join(REPO_ROOT, 'toolkit/examples')
const WORKFLOWS_DIR = join(REPO_ROOT, 'toolkit/workflows')

const entries = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith('.workflow.ts'))
  .sort()
const artifacts = readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort()

describe('committed workflow artifacts — rebuild byte-identity', () => {
  it('the gate has sources and artifacts to cover', () => {
    expect(entries.length).toBeGreaterThan(0)
    expect(artifacts.length).toBeGreaterThan(0)
  })

  it(
    'every toolkit/workflows/*.js is exactly the rebuild of one toolkit/examples/*.workflow.ts',
    async () => {
      // <meta.name>.js → { entry, code } as bundleWorkflow emits it today.
      const rebuilt = new Map<string, { entry: string; code: string }>()
      for (const entry of entries) {
        const result = await bundleWorkflow({ entry: join(EXAMPLES_DIR, entry) })
        rebuilt.set(`${result.meta.name}.js`, { entry, code: result.code })
      }

      // Set equality both ways: a source without an artifact is an unbuilt
      // composition; an artifact without a source is an orphan.
      expect([...rebuilt.keys()].sort()).toEqual(artifacts)

      for (const [name, { entry, code }] of rebuilt) {
        const committed = readFileSync(join(WORKFLOWS_DIR, name), 'utf8')
        // Boolean compare on purpose — a string-diff over a bundled artifact
        // is noise; the remedy is a rebuild, not a manual edit.
        expect(
          committed === code,
          `${name} is stale — regenerate it with: pnpm wt:build examples/${entry}`,
        ).toBe(true)
      }
    },
    120_000,
  )
})
