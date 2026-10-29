import { describe, expect, it, vi } from 'vitest'

// Make the default export AND every named export of node:path the Windows flavour, keeping `posix` real. A module
// that resolves shell paths through the host's path module, by default or named import, would then spell them with
// backslashes.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return { ...actual.win32, posix: actual.posix, default: actual.win32 }
})

// @ts-expect-error -- plain ESM module without type declarations
import { lockCoverage, parseTestRunStart } from '../../../../plugin/bin/lib/test-run-lock-coverage.mjs'

const LEASED_CONFIG = "export default { test: { globalSetup: ['./test-support/suite-lease.global-setup.mjs'] } }"

describe('test-run lock coverage keeps POSIX spelling whatever the host path module is', () => {
  it.each([
    ['cd toolkit && pnpm test', '/repo', '/repo/toolkit'],
    ['cd /repo && cd toolkit && pnpm test', null, '/repo/toolkit'],
    ['pnpm -C toolkit vitest run a', '/repo', '/repo/toolkit'],
    ['pnpm --dir /y vitest run a', null, '/y'],
    ['cd ~/p && pnpm test', '/repo', '/home/x/p'],
  ])('resolves %s from cwd %s to %s', (command, cwd, dir) => {
    expect(parseTestRunStart(command, cwd, '/home/x')).toMatchObject({ dir })
  })

  it('walks up to a POSIX-keyed config to find the lease', () => {
    const files: Record<string, string> = { '/repo/toolkit/vitest.config.ts': LEASED_CONFIG }
    const readText = (file: string) => (Object.hasOwn(files, file) ? files[file] : null)
    expect(lockCoverage({ dir: '/repo/toolkit/packages/x', kind: 'vitest', readText })).toBe('lease-config')
  })
})
