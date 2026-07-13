// plugin-bundle-identity.test.ts — byte-identity gates over the plugin's
// bundled study material and the one promoted plugin workflow.
//
// Two contracts the plugin half depends on, neither covered until now:
//
//  1. EVERY composition source under toolkit/examples/*.workflow.ts is bundled
//     byte-identical into the workflow-composer skill's offline study copy
//     (plugin/skills/workflow-composer/assets/examples/toolkit/), and that dir
//     carries no orphan sources. Progressive disclosure makes bundling all of
//     them ~free in context (refs load only when read), so the skill no longer
//     bundles a hand-picked subset — it bundles the full set, and this gate
//     keeps the copies from drifting away from their toolkit/examples/ origin.
//
//  2. independent-analysis is promoted to a bundled PLUGIN workflow at
//     plugin/workflows/independent-analysis.js (discoverable as
//     workflow-toolbox:independent-analysis). To avoid changing the shared
//     build CLI's single-out-dir contract, that file is a MIRROR of the
//     canonical artifact toolkit/workflows/independent-analysis.js, refreshed by
//     `pnpm mirror:plugin-workflow`. This gate makes drift *detectable* — it does
//     NOT make it impossible: a maintainer who rebuilds the canonical and commits
//     without running the suite ships a stale mirror. Run the gates before commit.
//
// Remedy on failure:
//  (1) cp toolkit/examples/<entry>.workflow.ts
//         plugin/skills/workflow-composer/assets/examples/toolkit/
//  (2) cp toolkit/workflows/independent-analysis.js plugin/workflows/

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const EXAMPLES_DIR = join(REPO_ROOT, 'toolkit/examples')
const BUNDLED_DIR = join(
  REPO_ROOT,
  'plugin/skills/workflow-composer/assets/examples/toolkit',
)
const TOOLKIT_WORKFLOWS = join(REPO_ROOT, 'toolkit/workflows')
const PLUGIN_WORKFLOWS = join(REPO_ROOT, 'plugin/workflows')

// Study-bundled files: every composition source, PLUS the non-workflow support
// modules the compositions import and the skill bundles for study (today:
// docs-provenance.ts, imported by pr-review). The examples-root .pipeline.ts
// specs are deliberately NOT bundled — a different family, not workflow study
// material. A support module bundled without appearing here would silently
// escape the byte-identity gate (review finding, run wf_8c882e9f-54e).
const isStudyFile = (f: string): boolean => f.endsWith('.workflow.ts') || f === 'docs-provenance.ts'

const sources = readdirSync(EXAMPLES_DIR)
  .filter(isStudyFile)
  .sort()

describe('plugin bundled study sources — full set, byte-identical', () => {
  it('has sources to cover', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it('bundles EVERY toolkit/examples source byte-identically, with no orphans', () => {
    const bundled = existsSync(BUNDLED_DIR)
      ? readdirSync(BUNDLED_DIR)
          .filter(isStudyFile)
          .sort()
      : []

    // Set equality both ways: a source missing from the bundle is an offline
    // gap; a bundled file with no source is a stale orphan.
    expect(bundled).toEqual(sources)

    for (const name of sources) {
      const origin = readFileSync(join(EXAMPLES_DIR, name), 'utf8')
      const copy = existsSync(join(BUNDLED_DIR, name))
        ? readFileSync(join(BUNDLED_DIR, name), 'utf8')
        : ''
      expect(
        copy === origin,
        `${name} bundled copy is stale or missing — cp toolkit/examples/${name} ${'\\\n'}  plugin/skills/workflow-composer/assets/examples/toolkit/`,
      ).toBe(true)
    }
  })
})

describe('promoted plugin workflow — mirror of canonical artifact', () => {
  it('plugin/workflows/independent-analysis.js === toolkit/workflows/independent-analysis.js', () => {
    const canonicalPath = join(TOOLKIT_WORKFLOWS, 'independent-analysis.js')
    const mirrorPath = join(PLUGIN_WORKFLOWS, 'independent-analysis.js')

    expect(
      existsSync(canonicalPath),
      'canonical artifact missing — pnpm wt:build examples/independent-analysis.workflow.ts',
    ).toBe(true)

    const canonical = readFileSync(canonicalPath, 'utf8')
    const mirror = existsSync(mirrorPath) ? readFileSync(mirrorPath, 'utf8') : ''
    expect(
      mirror === canonical,
      'plugin/workflows/independent-analysis.js is stale or missing — ' +
        'cp toolkit/workflows/independent-analysis.js plugin/workflows/',
    ).toBe(true)
  })
})
