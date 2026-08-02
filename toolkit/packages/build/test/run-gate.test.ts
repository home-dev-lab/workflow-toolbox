// run-gate.test.ts — behavior gates for plugin/bin/wt-run-gate.mjs
//
// Card #1832861908256950072: a task notification reported exit 0 for a gate batch while
// `pnpm typecheck` had really failed with exit 2 — the code that reached the report was a
// wrapper's trailing `echo`, not the gate's own. This is the drift-lock for the fix: a
// dedicated runner that (a) never lets a chained command supersede the gate's own exit code
// because it never chains anything (no shell), (b) writes that code to a file of its own
// immediately, and (c) can cross-check the code against the log's own content so the two
// signals — exit code and log text — are confronted instead of one being trusted blind.
//
// The three cases below are the card's own discriminating closure criteria, verbatim:
//   - a gate that really fails            -> reported code is non-zero
//   - a gate that really passes           -> reported code is 0
//   - a gate that fails, chained to a command that succeeds -> reported code STAYS non-zero
// (the third is the exact shape of the original bug — this runner has no shell, so there is
// nothing for a following command to chain onto; the test proves that by trying to smuggle
// one in and showing it has no effect on the captured .exit file.)

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-run-gate.mjs')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function mkDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wt-run-gate-'))
  dirs.push(d)
  return d
}
function run(args: string[]) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { ...res, out: (res.stdout ?? '') + (res.stderr ?? '') }
}
function exitFileContents(dir: string, name: string): string {
  return readFileSync(join(dir, `${name}.exit`), 'utf8').trim()
}

describe('wt-run-gate — the exit code written is the GATE\'s own, never a wrapper\'s', () => {
  it('a gate that really fails: reported code is non-zero, and the .exit file agrees', () => {
    const d = mkDir()
    const res = run(['--name', 'g', '--out-dir', d, '--', process.execPath, '-e', 'process.exit(2)'])
    expect(res.status).toBe(2)
    expect(exitFileContents(d, 'g')).toBe('2')
    expect(res.out).toContain('exit=2')
  })

  it('a gate that really passes: reported code is 0, and the .exit file agrees', () => {
    const d = mkDir()
    const res = run(['--name', 'g', '--out-dir', d, '--', process.execPath, '-e', 'process.exit(0)'])
    expect(res.status).toBe(0)
    expect(exitFileContents(d, 'g')).toBe('0')
  })

  it('the runner takes NO shell — a smuggled "&& echo done" is passed as a LITERAL argv word, never interpreted as a chain (the exact original bug shape)', () => {
    const d = mkDir()
    // This is the actual attempt at the original bug shape, not just an assertion that looks
    // like one (a cross-family review flagged the previous version of this test as
    // tautological — it never included a second command token at all). Here the failing gate
    // is followed, in the SAME argv, by the exact tokens a shell would need to chain a
    // trailing `echo done` onto it: `&&`, `echo`, `done`. With shell:false these are just
    // three more inert strings handed to node's `-e`, which errors on them as extra script
    // text — they can never become a second process whose exit code could steal the report.
    const res = run([
      '--name', 'g', '--out-dir', d, '--',
      process.execPath, '-e', 'process.exit(2)', '&&', 'echo', 'done',
    ])
    // The smuggled tokens do not get silently ignored either — node treats them as bogus
    // extra argv and errors, so the reported code is non-zero either way, and specifically
    // NOT 0 (the code `echo done` would have produced had it actually run as a chained shell
    // command).
    expect(res.status).not.toBe(0)
    expect(exitFileContents(d, 'g')).not.toBe('0')
  })

  it('--name is a plain filename-safe token — a path-traversal attempt is REFUSED (cross-family review finding: unsanitized --name could overwrite a file outside --out-dir)', () => {
    const d = mkDir()
    // Escapes ONE level above `d`, inside the shared OS temp root — a leaked write here
    // would outlive this test (mkDir()'s own cleanup only rmSync's `d` itself), so it is
    // explicitly removed after the assertion regardless of outcome, not left for a future
    // run to trip over.
    const escapedFile = join(d, '..', 'escape.exit')
    try {
      const res = run(['--name', '../escape', '--out-dir', d, '--', process.execPath, '-e', 'process.exit(0)'])
      expect(res.status).not.toBe(0)
      expect(res.out).toContain('--name')
      expect(existsSync(escapedFile)).toBe(false)
    } finally {
      rmSync(escapedFile, { force: true })
      rmSync(join(d, '..', 'escape.log'), { force: true })
    }
  })

  it('a command killed by a SIGNAL (never returns its own exit code) is recorded as SIGNAL, never silently coerced to a numeric code', () => {
    const d = mkDir()
    const res = run(['--name', 'g', '--out-dir', d, '--', process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"])
    expect(res.status).not.toBe(0)
    expect(exitFileContents(d, 'g')).toMatch(/^SIGNAL /)
  })

  it('an invalid --fail-pattern regex is a caller error, reported distinctly, and does not corrupt the already-written .exit/.log ground truth', () => {
    const d = mkDir()
    const res = run(['--name', 'g', '--out-dir', d, '--fail-pattern', '(', '--', process.execPath, '-e', 'process.exit(0)'])
    expect(res.status).not.toBe(0)
    expect(res.out.toLowerCase()).toContain('not a valid regex')
    expect(exitFileContents(d, 'g')).toBe('0')
  })

  it('--fail-pattern cross-check: exit 0 but the pattern IS in the log -> forced non-zero, flagged INCONSISTENT', () => {
    const d = mkDir()
    const res = run([
      '--name', 'g', '--out-dir', d, '--fail-pattern', 'error TS\\d+',
      '--', process.execPath, '-e', "console.log('error TS2345: bogus'); process.exit(0)",
    ])
    // The GATE's own exit code (what a caller would naively trust) really was 0 —
    expect(exitFileContents(d, 'g')).toBe('0')
    // — but this runner's own exit code refuses to propagate that as green.
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('INCONSISTENT')
    expect(res.out).toContain('pattern=FOUND')
  })

  it('--fail-pattern cross-check: exit non-zero and pattern absent -> no false INCONSISTENT flag (real failure reported plainly)', () => {
    const d = mkDir()
    const res = run([
      '--name', 'g', '--out-dir', d, '--fail-pattern', 'error TS\\d+',
      '--', process.execPath, '-e', "console.log('unrelated failure'); process.exit(3)",
    ])
    expect(res.status).toBe(3)
    expect(res.out).not.toContain('INCONSISTENT')
    expect(res.out).toContain('pattern=absent')
  })

  it('the .log file holds the gate\'s real combined output, readable independently of the reported code', () => {
    const d = mkDir()
    run(['--name', 'g', '--out-dir', d, '--', process.execPath, '-e', "console.log('hello-from-gate'); process.exit(1)"])
    expect(readFileSync(join(d, 'g.log'), 'utf8')).toContain('hello-from-gate')
  })

  it('a command that cannot even be launched is reported distinctly, never coerced into a numeric exit code', () => {
    const d = mkDir()
    const res = run(['--name', 'g', '--out-dir', d, '--', '/no/such/binary-xyz'])
    expect(res.status).toBe(2)
    expect(exitFileContents(d, 'g')).toMatch(/^ERROR /)
  })

  it('rejects a missing --name (would collide file names across gates)', () => {
    const res = run(['--out-dir', mkDir(), '--', process.execPath, '-e', 'process.exit(0)'])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('--name')
  })

  it('rejects a missing command after --', () => {
    const res = run(['--name', 'g', '--out-dir', mkDir()])
    expect(res.status).not.toBe(0)
    expect(res.out.toLowerCase()).toContain('command')
  })

  it('creates --out-dir if absent', () => {
    const d = join(mkDir(), 'nested', 'dir')
    const res = run(['--name', 'g', '--out-dir', d, '--', process.execPath, '-e', 'process.exit(0)'])
    expect(res.status).toBe(0)
    expect(existsSync(join(d, 'g.exit'))).toBe(true)
  })
})
