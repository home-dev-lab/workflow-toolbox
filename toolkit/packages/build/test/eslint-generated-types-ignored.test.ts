import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { afterAll, describe, expect, it } from 'vitest'

// Claude Code writes git-ignored type stubs into plugin/.claude-plugin/types/ when it loads the
// plugin from a checkout (--plugin-dir). The quality lint must not grade them: they are not ours
// and they turn the gate red on any tree that was ever loaded.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const stub = join(repoRoot, 'plugin/.claude-plugin/types/claude-code-probe/index.d.ts')

describe('quality lint ignores host-generated plugin type stubs', () => {
  afterAll(() => rmSync(dirname(stub), { recursive: true, force: true }))

  it('ignores a generated stub the way the quality root gate invokes ESLint', async () => {
    mkdirSync(dirname(stub), { recursive: true })
    writeFileSync(stub, 'export interface Probe {}\n')
    const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: join(repoRoot, 'toolkit/eslint.config.mjs') })
    expect(await eslint.isPathIgnored(stub)).toBe(true)
    expect(await eslint.isPathIgnored(join(repoRoot, 'plugin/hooks/hooks.js'))).toBe(false)
  })
})
