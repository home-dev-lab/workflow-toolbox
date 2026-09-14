import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-unsynced-buffer-hook.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function project(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wt-unsynced-buffer-${tag}-`))
  const cwd = join(root, 'project')
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  roots.push(root)
  return cwd
}

function run(cwd: string): { out: string; code: number | null } {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }),
    encoding: 'utf8',
  })
  return { out: `${result.stdout ?? ''}${result.stderr ?? ''}`, code: result.status }
}

describe('wt-unsynced-buffer-hook', () => {
  it('prints one loud line naming the two buffered entries, their file, and the remedy', () => {
    const cwd = project('present')
    const progress = join(cwd, '.claude', 'progress.md')
    writeFileSync(progress, '# Progress\n\n## Unsynced (Planka down)\n- First entry\n- Second entry\n\n## Done\n- Old work\n')

    const result = run(cwd)

    expect(result.out.trim().split('\n')).toHaveLength(1)
    expect(result.out).toContain('2 unsynced entries')
    expect(result.out).toContain(progress)
    expect(result.out).toContain('fold them back into the board and purge the section')
    expect(result.code).toBe(0)
  })

  it('is silent when progress.md has no unsynced heading', () => {
    const cwd = project('no-heading')
    writeFileSync(join(cwd, '.claude', 'progress.md'), '# Progress\n\n## Active\n- Work\n')

    expect(run(cwd)).toEqual({ out: '', code: 0 })
  })

  it('is silent when progress.md is absent', () => {
    expect(run(project('absent'))).toEqual({ out: '', code: 0 })
  })

  it('is silent when progress.md cannot be read', () => {
    const cwd = project('unreadable')
    mkdirSync(join(cwd, '.claude', 'progress.md'))

    expect(run(cwd)).toEqual({ out: '', code: 0 })
  })
})
