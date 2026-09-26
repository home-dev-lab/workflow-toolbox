// pnpm-manager-pin.test.ts — root/toolkit pnpm pin consistency (card 1872504148).
//
// Corepack resolves the pnpm version to run by walking up from the WORKING
// directory for a "packageManager" field, then pnpm checks that resolved
// version against the "--dir" target's own package.json. So a gate invoked as
// `pnpm --dir toolkit <script>` from the repo ROOT is governed by the ROOT
// package.json's pin, not toolkit's — any Corepack user whose default pnpm
// isn't already toolkit's pinned version, and who has no ancestor directory
// pinning it either, hits "configured to use X … current pnpm is vY" and the
// gate refuses to run at all.
//
// RED when the root and toolkit "packageManager" fields diverge (including the
// root field being absent entirely).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

function readPackageManager(pkgJsonPath: string): string | undefined {
  const raw = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    packageManager?: string
  }
  return raw.packageManager
}

describe('root/toolkit pnpm pin', () => {
  it('root package.json pins the same packageManager as toolkit/package.json', () => {
    const rootPin = readPackageManager(join(REPO_ROOT, 'package.json'))
    const toolkitPin = readPackageManager(join(REPO_ROOT, 'toolkit/package.json'))

    expect(rootPin, 'root package.json is missing "packageManager"').toBeDefined()
    expect(rootPin).toBe(toolkitPin)
  })
})
