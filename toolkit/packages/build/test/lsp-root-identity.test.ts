import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildLspRoot } from '../../../scripts/build-lsp-root.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

describe('plugin LSP root byte identity', () => {
  it('is exactly the deterministic merge of every pack declaration', () => {
    const committed = readFileSync(join(REPO_ROOT, 'plugin', '.lsp.json'), 'utf8')
    expect(
      committed === buildLspRoot(REPO_ROOT),
      'plugin/.lsp.json is stale - regenerate it with: pnpm packs:lsp',
    ).toBe(true)
  })
})
