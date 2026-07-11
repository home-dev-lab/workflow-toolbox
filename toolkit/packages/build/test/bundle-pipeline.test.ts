// bundle-pipeline.test.ts — integration tests for bundlePipeline (real esbuild), modeled on
// bundle.test.ts's structure.
//
// TDD cycle: tests written first (RED), then src/bundle-pipeline.ts makes them GREEN.

import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundlePipeline } from '../src/bundle-pipeline.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')

function fixturePath(name: string): string {
  return path.join(FIXTURES, name)
}

describe('bundlePipeline — hello fixture', () => {
  it('extracts the spec unchanged (round-tripped through parsePipelineSpec)', async () => {
    const result = await bundlePipeline({ entry: fixturePath('hello.pipeline.ts') })
    expect(result.spec.goal).toBe('minimal fixture pipeline')
    expect(result.spec.projectDir).toBe('/repo')
    expect(result.spec.stages).toHaveLength(2)
    expect(result.spec.stages[0]).toMatchObject({ name: 'plan', gateAfter: true, artifact: { extract: 'plan-artifact' } })
    expect(result.spec.stages[1]).toMatchObject({ name: 'implement', input: { artifactPath: { from: 'artifactPath' } } })
  })

  it('emits pretty-printed JSON matching the extracted spec', async () => {
    const result = await bundlePipeline({ entry: fixturePath('hello.pipeline.ts') })
    expect(JSON.parse(result.json)).toEqual(result.spec)
    expect(result.json).toContain('\n') // pretty-printed, not minified to one line
  })

  it('bytes equals Buffer.byteLength(json)', async () => {
    const result = await bundlePipeline({ entry: fixturePath('hello.pipeline.ts') })
    expect(result.bytes).toBe(Buffer.byteLength(result.json))
  })

  it('no import/require left in the process — fully bundled (no dangling module specifiers in the JSON)', async () => {
    const result = await bundlePipeline({ entry: fixturePath('hello.pipeline.ts') })
    expect(result.json).not.toContain('import ')
    expect(result.json).not.toContain('require(')
  })
})

describe('bundlePipeline — negative fixtures (actionable errors)', () => {
  it('rejects an entry that imports definePipeline from the package root instead of /define-pipeline', async () => {
    await expect(bundlePipeline({ entry: fixturePath('wrong-import.pipeline.ts') })).rejects.toThrow(
      /define-pipeline/,
    )
  })

  it('rejects an entry with no default export', async () => {
    await expect(bundlePipeline({ entry: fixturePath('no-default-export.pipeline.ts') })).rejects.toThrow(
      /export default definePipeline/,
    )
  })

  it('rejects a default export missing `spec` (author forgot definePipeline)', async () => {
    await expect(bundlePipeline({ entry: fixturePath('missing-spec.pipeline.ts') })).rejects.toThrow(
      /export default definePipeline/,
    )
  })

  // batch 5, item 5: definePipeline() now runs its OWN parsePipelineSpec round-trip, so this
  // failure surfaces at MODULE-EVALUATION time (definePipeline() throws synchronously while the
  // bundled IIFE's top-level `export default definePipeline({...})` runs) — bundlePipeline's
  // Step 2 (evaluate the IIFE) is what actually observes and re-throws it, never reaching its
  // OWN Step 3 round-trip at all for this fixture. Still a real, end-to-end proof that the
  // error propagates cleanly through the whole bundle pipeline, not just a definePipeline unit
  // test (define-pipeline.test.ts has that).
  it('rejects a spec that passes definePipeline\'s own validateStageList but fails ITS OWN parsePipelineSpec round-trip (a type-system bypass) — propagates end-to-end through the bundle', async () => {
    await expect(bundlePipeline({ entry: fixturePath('bad-roundtrip.pipeline.ts') })).rejects.toThrow(
      /round-trip/,
    )
  })

  // Defense-in-depth (batch 5, item 5): an author who bypasses definePipeline() ENTIRELY
  // (hand-constructing `export default { spec: badSpec }`) skips every check definePipeline()
  // now performs — bundlePipeline's OWN Step 3 round-trip is what still catches this shape,
  // proving that check remains load-bearing even now that definePipeline() has its own copy.
  it('rejects a bare `{ spec }` default export (definePipeline bypassed entirely) via bundlePipeline\'s OWN round-trip', async () => {
    await expect(bundlePipeline({ entry: fixturePath('bypass-define-bad-roundtrip.pipeline.ts') })).rejects.toThrow(
      /round-trip/,
    )
  })
})
