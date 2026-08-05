import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(REPO_ROOT, 'plugin/bin/wt-lane-postdiff-check.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeWorktree(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-lane-postdiff-${tag}-`))
  roots.push(root)
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  writeFileSync(join(root, 'README.md'), 'hello\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', 'initial'])
  return root
}

function run(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
}

describe('wt-lane-postdiff-check CLI', () => {
  it('snapshot writes the current porcelain status to the given file', () => {
    const wt = makeWorktree('snapshot')
    writeFileSync(join(wt, 'wip.txt'), 'work in progress\n')
    const snap = join(wt, 'before.txt')
    const res = run(['snapshot', '--worktree', wt, '--out', snap])
    expect(res.status).toBe(0)
    const content = readFileSync(snap, 'utf8')
    expect(content).toContain('wip.txt')
  })

  it('RED then GREEN: flags a file the lane touched OUTSIDE the briefed paths', () => {
    const wt = makeWorktree('flag')
    // Pre-existing pilot work-in-progress, captured in the BEFORE snapshot.
    writeFileSync(join(wt, 'wip.txt'), 'pilot wip\n')
    const before = join(wt, 'before.txt')
    run(['snapshot', '--worktree', wt, '--out', before])

    // The lane does its briefed work AND an unrequested "defensive" edit elsewhere.
    mkdirSync(join(wt, 'src'), { recursive: true })
    writeFileSync(join(wt, 'src', 'module.ts'), 'export const x = 1\n')
    writeFileSync(join(wt, 'unrelated-test.ts'), 'it("x", () => {})\n')

    // RED PROOF: without the check, this out-of-brief file is invisible to a diff scoped
    // to the briefed paths alone — that is exactly the defect this tool mechanizes against.
    const briefed = ['src/module.ts']
    const briefDiff = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--stat', ...briefed], {
      cwd: wt,
      encoding: 'utf8',
    })
    expect(briefDiff).not.toContain('unrelated-test.ts') // proves the blind spot exists

    // GREEN: the check tool sees the whole tree and flags the unbriefed file.
    const res = run(['check', '--worktree', wt, '--before', before, '--brief-paths', 'src/module.ts'])
    expect(res.status).toBe(3)
    expect(res.stdout).toContain('OUT-OF-BRIEF')
    expect(res.stdout).toContain('unrelated-test.ts')
    // The pilot's own pre-existing WIP must NOT be flagged (it predates the before-snapshot).
    expect(res.stdout).not.toContain('wip.txt')
    // Nothing is reverted — the file must still exist on disk.
    expect(existsSync(join(wt, 'unrelated-test.ts'))).toBe(true)
  })

  it('does NOT flag a file that is covered by the briefed paths', () => {
    const wt = makeWorktree('in-brief')
    const before = join(wt, 'before.txt')
    run(['snapshot', '--worktree', wt, '--out', before])

    mkdirSync(join(wt, 'src'), { recursive: true })
    writeFileSync(join(wt, 'src', 'module.ts'), 'export const x = 1\n')
    writeFileSync(join(wt, 'src', 'module.test.ts'), 'it("x", () => {})\n')

    const res = run(['check', '--worktree', wt, '--before', before, '--brief-paths', 'src'])
    expect(res.status).toBe(0)
    expect(res.stdout).not.toContain('OUT-OF-BRIEF')
    expect(res.stdout).toContain('module.ts')
  })

  it('does not flag work-in-progress that already existed before the lane call', () => {
    const wt = makeWorktree('preexisting-wip')
    writeFileSync(join(wt, 'pilot-scratch.md'), 'notes\n')
    const before = join(wt, 'before.txt')
    run(['snapshot', '--worktree', wt, '--out', before])

    // Nothing changes after the snapshot — the lane made no edits at all.
    const res = run(['check', '--worktree', wt, '--before', before, '--brief-paths', 'src'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('no changes since the before-snapshot')
  })

  it('accepts brief-paths from a file via @-prefix, one path per line', () => {
    const wt = makeWorktree('brief-file')
    const before = join(wt, 'before.txt')
    run(['snapshot', '--worktree', wt, '--out', before])
    writeFileSync(join(wt, 'a.ts'), 'export {}\n')
    writeFileSync(join(wt, 'b.ts'), 'export {}\n')
    const briefFile = join(wt, 'brief.txt')
    writeFileSync(briefFile, '# comment\na.ts\n')

    const res = run(['check', '--worktree', wt, '--before', before, '--brief-paths', `@${briefFile}`])
    expect(res.status).toBe(3)
    expect(res.stdout).toContain('OUT-OF-BRIEF')
    expect(res.stdout).toContain('b.ts')
  })

  it('exits 2 with a clear error when the worktree is not a git repository', () => {
    const notGit = mkdtempSync(join(tmpdir(), 'wt-lane-postdiff-notgit-'))
    roots.push(notGit)
    const res = run(['snapshot', '--worktree', notGit, '--out', join(notGit, 'x.txt')])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('git')
  })

  it('exits 2 on missing arguments and prints usage', () => {
    const res = run(['check'])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('usage:')
  })

  it('exits 2 (never an uncaught-exception crash) on a corrupt/incompatible before-snapshot', () => {
    const wt = makeWorktree('corrupt-snapshot')
    const before = join(wt, 'before.txt')
    writeFileSync(before, 'not json at all\n')
    const res = run(['check', '--worktree', wt, '--before', before, '--brief-paths', 'src'])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('not a valid snapshot')
  })

  it('--help prints usage and exits 0', () => {
    const res = run(['--help'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('wt-lane-postdiff-check')
  })

  // RED-then-GREEN locks for the three false-negative classes an opencode
  // (openai/gpt-5.6-terra) cross-family review found and reproduced in the FIRST cut of
  // this tool, which compared porcelain STATUS CODES only.

  it('flags a file the lane edits AGAIN while it was already dirty at snapshot time (content-hash lock)', () => {
    const wt = makeWorktree('already-dirty')
    // Pilot's own pre-existing WIP: file already modified before the lane call, so its
    // status is already " M" in the BEFORE snapshot.
    writeFileSync(join(wt, 'README.md'), 'pilot wip\n')
    const before = join(wt, 'before.txt')
    run(['snapshot', '--worktree', wt, '--out', before])
    const beforeSnapshotLine = readFileSync(before, 'utf8').trim()
    expect(beforeSnapshotLine).toContain('README.md')
    expect(JSON.parse(beforeSnapshotLine).status).toBe(' M')

    // The lane edits the SAME already-dirty file. Its status code stays " M" — a
    // status-only comparison (the tool's first cut) cannot distinguish this from no
    // change at all, which is exactly the bug the review caught.
    writeFileSync(join(wt, 'README.md'), 'pilot wip PLUS a lane edit nobody asked for\n')
    const afterStatus = execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' })
    expect(afterStatus).toContain('M README.md') // status code alone is unchanged from " M"

    const res = run(['check', '--worktree', wt, '--before', before, '--brief-paths', 'src'])
    expect(res.status).toBe(3)
    expect(res.stdout).toContain('OUT-OF-BRIEF')
    expect(res.stdout).toContain('README.md')
  })

  it('does not mistake a literal backslash in a filename for a directory separator', () => {
    const wt = makeWorktree('literal-backslash')
    const before = join(wt, 'before.txt')
    run(['snapshot', '--worktree', wt, '--out', before])

    // A file whose NAME contains a literal backslash — a valid POSIX filename character,
    // not a path separator. It must never be read as living "inside" a brief directory
    // named the text before the backslash.
    writeFileSync(join(wt, 'brief\\outside.txt'), 'x\n')

    const res = run(['check', '--worktree', wt, '--before', before, '--brief-paths', 'brief'])
    expect(res.status).toBe(3)
    expect(res.stdout).toContain('OUT-OF-BRIEF')
    expect(res.stdout).toContain('brief\\outside.txt')
  })

  it('parses a rename correctly even though porcelain would otherwise be ambiguous', () => {
    const wt = makeWorktree('rename')
    writeFileSync(join(wt, 'old-name.ts'), 'export {}\n')
    execFileSync('git', ['add', '.'], { cwd: wt })
    execFileSync('git', ['commit', '-qm', 'add old-name'], { cwd: wt })
    const before = join(wt, 'before.txt')
    run(['snapshot', '--worktree', wt, '--out', before])

    execFileSync('git', ['mv', 'old-name.ts', 'src-new-name.ts'], { cwd: wt }).toString()
    // NOTE: 'src-new-name.ts' intentionally starts with the briefed prefix 'src' as a
    // STRING (not a real 'src/' directory) to prove prefix-matching stays path-boundary
    // aware, not merely a startsWith on the raw string.
    const res = run(['check', '--worktree', wt, '--before', before, '--brief-paths', 'src'])
    expect(res.status).toBe(3)
    expect(res.stdout).toContain('OUT-OF-BRIEF')
    // Both the new name (not literally under a 'src/' dir) and the vacated old name show up.
    expect(res.stdout).toContain('src-new-name.ts')
    expect(res.stdout).toContain('old-name.ts')
  })
})
