// Every card branch adds its plugin/CHANGELOG.md entry right under `### Added` or `### Fixed` of
// `## [Unreleased]`, so two branches merged one after the other always touch the same lines and
// git stops on a conflict whose only correct answer is "keep both". The repository's
// `.gitattributes` gives that file git's built-in `union` merge driver, which keeps both sides'
// lines without asking. These tests pin the attribute and prove, on a throwaway repository that
// uses the real `.gitattributes`, that the collision merges and rebases cleanly — and that the same
// fixture without the attribute still conflicts, so a green run cannot come from a fixture that
// never collided.
//
// What union does NOT do: it never drops a line, so a line one side removed or reworded next to
// the other side's insertion survives (a reverted entry stays, a reworded one appears twice), and
// it cannot tell that a release moved lines under a version heading. Neither case is locked here;
// the `.gitattributes` comment states what does and does not guard them.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CHANGELOG = 'plugin/CHANGELOG.md'

const BASE = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '- An entry that was already there.',
  '',
  '## [1.0.0] - 2026-01-01',
  '',
  '### Added',
  '- The first release.',
  '',
].join('\n')

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// The suite's git-config-isolation setup already points every git child at a neutral global
// config with an identity and no signing, so fixture commits need no environment of their own.
function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

function ok(cwd: string, args: string[]) {
  const r = git(cwd, args)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`)
  return r.stdout
}

/** Insert `bullet` directly under the Unreleased `### Added` line — the spot every card writes to. */
function addBullet(dir: string, bullet: string) {
  const file = join(dir, CHANGELOG)
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.replace('## [Unreleased]\n\n### Added\n', `## [Unreleased]\n\n### Added\n- ${bullet}\n`))
}

/** Two branches off one base, each adding its own bullet at the same spot. */
function collidingBranches(withRepoAttributes: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-changelog-union-')); roots.push(dir)
  ok(dir, ['init', '-q', '-b', 'develop'])
  if (withRepoAttributes) copyFileSync(join(REPO_ROOT, '.gitattributes'), join(dir, '.gitattributes'))
  mkdirSync(join(dir, 'plugin'))
  writeFileSync(join(dir, CHANGELOG), BASE)
  ok(dir, ['add', '-A'])
  ok(dir, ['commit', '-q', '-m', 'base'])
  ok(dir, ['checkout', '-q', '-b', 'card-a'])
  addBullet(dir, 'Card A entry.')
  ok(dir, ['commit', '-q', '-am', 'card a'])
  ok(dir, ['checkout', '-q', '-b', 'card-b', 'develop'])
  addBullet(dir, 'Card B entry.')
  ok(dir, ['commit', '-q', '-am', 'card b'])
  ok(dir, ['checkout', '-q', 'develop'])
  ok(dir, ['merge', '-q', '--no-ff', '-m', 'merge a', 'card-a'])
  return dir
}

/** The Unreleased section's bullets, in order. */
function unreleasedBullets(dir: string) {
  const text = readFileSync(join(dir, CHANGELOG), 'utf8')
  const section = text.slice(text.indexOf('## [Unreleased]'), text.indexOf('## [1.0.0]'))
  return section.split('\n').filter((line) => line.startsWith('- '))
}

describe('plugin/CHANGELOG.md merges with the union driver', () => {
  it('declares merge=union for plugin/CHANGELOG.md in the repository attributes', () => {
    expect(ok(REPO_ROOT, ['check-attr', 'merge', '--', CHANGELOG]).trim()).toBe(`${CHANGELOG}: merge: union`)
  })

  it('control: without the attribute the same two entries conflict (the fixture really collides)', () => {
    const dir = collidingBranches(false)
    expect(git(dir, ['merge', '--no-ff', '-m', 'merge b', 'card-b']).status).not.toBe(0)
    expect(readFileSync(join(dir, CHANGELOG), 'utf8')).toContain('<<<<<<<')
  })

  it('merges two branches that add an entry at the same spot, keeping both entries under Unreleased', () => {
    const dir = collidingBranches(true)
    const merge = git(dir, ['merge', '--no-ff', '-m', 'merge b', 'card-b'])
    expect(merge.status, merge.stdout + merge.stderr).toBe(0)
    expect(readFileSync(join(dir, CHANGELOG), 'utf8')).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m)
    expect(unreleasedBullets(dir).sort()).toEqual(
      ['- An entry that was already there.', '- Card A entry.', '- Card B entry.'].sort(),
    )
  })

  it('rebases a card branch over another card entry without stopping', () => {
    const dir = collidingBranches(true)
    ok(dir, ['checkout', '-q', 'card-b'])
    const rebase = git(dir, ['rebase', 'develop'])
    expect(rebase.status, rebase.stdout + rebase.stderr).toBe(0)
    expect(unreleasedBullets(dir).sort()).toEqual(
      ['- An entry that was already there.', '- Card A entry.', '- Card B entry.'].sort(),
    )
  })
})
