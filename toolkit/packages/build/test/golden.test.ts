// golden.test.ts — golden file test for wt-fixture-hello.js artifact.
//
// Commits the expected emitted hello artifact to test/golden/wt-fixture-hello.js.
// On each run, bundleWorkflow output is compared EXACTLY to the golden file.
//
// Guard: set UPDATE_GOLDEN=1 to regenerate the golden file instead of asserting.
// Example: UPDATE_GOLDEN=1 pnpm test
//
// NOTE: esbuild upgrades may legitimately drift the golden output (e.g. changed
// helper names or IIFE wrapper format). When that happens:
//   1. Run UPDATE_GOLDEN=1 pnpm test to regenerate.
//   2. Review the diff carefully before committing — the meta statement must
//      still be first, var __wt must still appear, glue must still be last.

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleWorkflow } from '../src/bundle.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')
const GOLDEN_FILE = path.join(__dirname, 'golden', 'wt-fixture-hello.js')

const UPDATE_GOLDEN = process.env['UPDATE_GOLDEN'] === '1'

describe('golden file — wt-fixture-hello', () => {
  it('bundled hello fixture matches golden file exactly', async () => {
    const result = await bundleWorkflow({
      entry: path.join(FIXTURES, 'hello.workflow.ts'),
    })

    if (UPDATE_GOLDEN) {
      // Regenerate mode: write golden and skip assertion
      fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true })
      fs.writeFileSync(GOLDEN_FILE, result.code, 'utf8')
      console.log(`[golden] Updated: ${GOLDEN_FILE}`)
      return
    }

    // Assert mode: golden must already exist
    expect(
      fs.existsSync(GOLDEN_FILE),
      `Golden file not found: ${GOLDEN_FILE}\nRun: UPDATE_GOLDEN=1 pnpm test to generate it`,
    ).toBe(true)

    const golden = fs.readFileSync(GOLDEN_FILE, 'utf8')
    expect(result.code).toBe(golden)
  })
})
