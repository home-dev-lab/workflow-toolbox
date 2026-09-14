import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A merge whose conflict was committed unresolved leaves `<<<<<<< ` / `>>>>>>> ` lines in a
// tracked file. Measured 2026-09-13: a language-pack merge committed them into plugin/CHANGELOG.md,
// and no gate noticed — the changelog gate reads headings, not markers. This lock reads every
// tracked file in the working tree, so it fails the moment such a merge is committed.
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

describe('no committed merge-conflict markers', () => {
  it('no tracked file carries a line starting with a conflict marker', () => {
    let hits = ''
    try {
      hits = execFileSync('git', ['grep', '-n', '-I', '-E', '^(<<<<<<< |>>>>>>> )', '--', '.'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
    } catch (error) {
      // git grep exits 1 when nothing matches: that is the passing case, not an error.
      const status = (error as { status?: number }).status
      if (status !== 1) throw error
    }
    expect(hits, `unresolved conflict markers committed:\n${hits}`).toBe('')
  })
})
