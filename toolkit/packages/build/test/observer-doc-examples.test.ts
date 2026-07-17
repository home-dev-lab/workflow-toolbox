// observer-doc-examples.test.ts — the observer authoring reference's own examples must
// satisfy the shipped observer-def contract (review lock, run wf_9f3dc111-f31: the
// reference's schema block carried `"phases": []`, which the shared validator refuses —
// a copy-pasted example that throws contradicts the doc's central claim that the
// scaffolder can never emit a definition the launch would reject). docs-contract checks
// symbol PRESENCE; this gate checks the doc's EXAMPLE BLOCKS against the real validator:
// every ```jsonc block that looks like an ObserverDefinition (or a scaffold spec) must
// validate through the SAME shared module the launch bridge uses.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateObserverDefinition } from '@workflow-toolbox/debugger/observer-def'
import { scaffoldObserver } from '@workflow-toolbox/scaffold'
import type { ObserverScaffoldSpec } from '@workflow-toolbox/scaffold'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const DOC = readFileSync(
  join(REPO_ROOT, 'plugin/skills/workflow-composer/references/observer-definitions.md'),
  'utf8',
)

/** Strip jsonc comments. Doc examples keep `//` out of string values by convention — if a
 *  future example needs one (e.g. a URL), extend this stripper first; the parse assertion
 *  below fails loud rather than silently skipping the block. */
function stripJsonc(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const blocks = [...DOC.matchAll(/```jsonc\n([\s\S]*?)```/g)].map((m) => m[1] ?? '')

describe('observer-definitions.md examples honor the shipped contract', () => {
  it('has jsonc example blocks to check', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2)
  })

  it('every jsonc block parses after comment-stripping (keep // out of string values)', () => {
    for (const block of blocks) {
      expect(() => JSON.parse(stripJsonc(block)), block.slice(0, 80)).not.toThrow()
    }
  })

  it('every definition-shaped block passes the shared validator / the scaffolder round-trip', () => {
    let checked = 0
    for (const block of blocks) {
      const parsed = JSON.parse(stripJsonc(block)) as Record<string, unknown>
      if (!('watch' in parsed) || !('brain' in parsed)) continue // e.g. the args-bridge block
      checked += 1
      if ('schemaVersion' in parsed) {
        const errors: string[] = []
        validateObserverDefinition(parsed, 'doc-example', errors)
        expect(errors, `doc schema example invalid:\n${errors.join('\n')}`).toEqual([])
      } else {
        // A spec-shaped block (no schemaVersion) must round-trip through the scaffolder.
        expect(() => scaffoldObserver(parsed as unknown as ObserverScaffoldSpec)).not.toThrow()
      }
    }
    // The schema block AND the worked docs-butler spec must both be caught.
    expect(checked).toBeGreaterThanOrEqual(2)
  })

  // Review lock (same run): the needs vocabulary is OPEN in the shipped validator
  // (NEED_PATTERN accepts any kebab-case string) — the doc must not present the v0 names
  // as a schema-enforced allowlist. The anchor phrase carries the distinction.
  it('does not present the open need vocabulary as a schema-enforced allowlist', () => {
    expect(DOC).toContain('not a schema-enforced allowlist')
  })
})
