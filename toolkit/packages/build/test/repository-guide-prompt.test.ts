import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { withRepositoryGuide } from '../../../../plugin/bin/lib/sdk-role-profile.mjs'

const roots: string[] = []
const guideLine = (path: string) => `${path} is the repository's contributor guide; read it before planning or changing code.`

function fixture(setup: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'wt-repository-guide-'))
  roots.push(root)
  setup(root)
  return root
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('repository contributor-guide prompt', () => {
  it('composes exactly the existing guide pointers across all five worktree states', () => {
    const cases = [
      ['CLAUDE.md only', (root: string) => writeFileSync(join(root, 'CLAUDE.md'), '# Claude\n'), (root: string) => [join(root, 'CLAUDE.md')]],
      ['AGENTS.md only', (root: string) => writeFileSync(join(root, 'AGENTS.md'), '# Agents\n'), (root: string) => [join(root, 'AGENTS.md')]],
      ['both files', (root: string) => { writeFileSync(join(root, 'CLAUDE.md'), '# Claude\n'); writeFileSync(join(root, 'AGENTS.md'), '# Agents\n') }, (root: string) => [join(root, 'CLAUDE.md'), join(root, 'AGENTS.md')]],
      ['both paths share one symlink target', (root: string) => { writeFileSync(join(root, 'AGENTS.md'), '# Shared\n'); symlinkSync('AGENTS.md', join(root, 'CLAUDE.md')) }, (root: string) => [join(root, 'AGENTS.md')]],
      ['both paths share the reverse symlink target', (root: string) => { writeFileSync(join(root, 'CLAUDE.md'), '# Shared\n'); symlinkSync('CLAUDE.md', join(root, 'AGENTS.md')) }, (root: string) => [join(root, 'CLAUDE.md')]],
      ['neither file', () => {}, () => []],
    ] as const
    for (const [name, setup, expectedPaths] of cases) {
      const root = fixture(setup)
      const lines = expectedPaths(root).map((path) => guideLine(realpathSync(resolve(path))))
      expect(withRepositoryGuide(root, 'Task prompt'), name).toBe(lines.length ? `${lines.join('\n')}\n\nTask prompt` : 'Task prompt')
    }
  })
})
