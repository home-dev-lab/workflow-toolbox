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
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, realpathSync, writeFileSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { treeSignature } from '../../../../plugin/bin/lib/gate-evidence.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-run-gate.mjs')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function mkDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'wt-run-gate-')))
  dirs.push(d)
  return d
}
function run(args: string[], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...options })
  return { ...res, out: (res.stdout ?? '') + (res.stderr ?? '') }
}
function exitFileContents(dir: string, name: string): string {
  return readFileSync(join(dir, `${name}.exit`), 'utf8').trim()
}

function gateRepo() {
  const root = mkDir()
  const state = mkDir()
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  mkdirSync(join(root, 'plugin'), { recursive: true })
  writeFileSync(join(root, 'plugin', 'thing.mjs'), '// base\n')
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base')
  return { root, env: { ...process.env, WT_GUARD_JOURNAL_DIR: state } }
}

function recordGate(root: string, env: NodeJS.ProcessEnv, name: string, exit = 0) {
  const result = run(['--record', name, '--', process.execPath, '-e', `process.exit(${exit})`], { cwd: root, env })
  expect(result.status).toBe(exit)
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

  it.skipIf(process.platform === 'win32')('POSIX-only: a command killed by a SIGNAL is recorded as SIGNAL, never silently coerced to a numeric code', () => {
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

describe('wt-run-gate --check', () => {
  it('reports the three default gates green for a fixture tree with matching records', () => {
    const { root, env } = gateRepo()
    for (const gate of ['test', 'typecheck', 'lint']) recordGate(root, env, gate)

    const result = run(['--check', root], { env })

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^test: green [a-f0-9]{64} .+\ntypecheck: green [a-f0-9]{64} .+\nlint: green [a-f0-9]{64} .+\n$/)
  })

  it('reports a matching non-zero record red with its exit code', () => {
    const { root, env } = gateRepo()
    recordGate(root, env, 'test', 1)

    const result = run(['--check', root, '--gate', 'test'], { env })

    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/^test: red [a-f0-9]{64} .+ exit=1\n$/)
  })

  it('reports an absent requested record missing', () => {
    const { root, env } = gateRepo()

    const result = run(['--check', root, '--gate', 'test'], { env })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('test: missing\n')
  })

  it('reports a record made for another tree signature missing', () => {
    const { root, env } = gateRepo()
    recordGate(root, env, 'test')
    writeFileSync(join(root, 'plugin', 'thing.mjs'), '// changed after gate\n')

    const result = run(['--check', root, '--gate', 'test'], { env })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('test: missing\n')
  })

  it('invalidates a green record when only an untracked file content changes', () => {
    const { root, env } = gateRepo()
    writeFileSync(join(root, 'scratch.txt'), 'first\n')
    recordGate(root, env, 'test')
    writeFileSync(join(root, 'scratch.txt'), 'second\n')
    const result = run(['--check', root, '--gate', 'test'], { env })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('test: missing\n')
  })

  it.skipIf(process.platform === 'win32')('POSIX-only filename/mode lock: keeps names unambiguous and invalidates binary bytes, deletion, symlinks, and modes', () => {
    const { root, env } = gateRepo()
    writeFileSync(join(root, 'space name\nnext'), Buffer.from([0, 1, 2]))
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255, 1]))
    writeFileSync(join(root, 'tracked-delete'), 'tracked\n')
    symlinkSync('/outside/first', join(root, 'link'))
    writeFileSync(join(root, 'mode-file'), 'mode\n')
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    expect(git('add', '.').status).toBe(0); expect(git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixtures').status).toBe(0)
    recordGate(root, env, 'test')
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 254, 1]))
    expect(run(['--check', root, '--gate', 'test'], { env }).status).toBe(1)
    recordGate(root, env, 'test'); unlinkSync(join(root, 'tracked-delete'))
    expect(run(['--check', root, '--gate', 'test'], { env }).status).toBe(1)
    writeFileSync(join(root, 'tracked-delete'), 'tracked\n'); recordGate(root, env, 'test'); unlinkSync(join(root, 'link')); symlinkSync('/outside/second', join(root, 'link'))
    expect(run(['--check', root, '--gate', 'test'], { env }).status).toBe(1)
    if (process.platform !== 'win32') { unlinkSync(join(root, 'link')); symlinkSync('/outside/first', join(root, 'link')); recordGate(root, env, 'test'); chmodSync(join(root, 'mode-file'), 0o755); expect(run(['--check', root, '--gate', 'test'], { env }).status).toBe(1) }
  })

  it('keeps a tracked deletion signature identical before and after staging', () => {
    const { root } = gateRepo()
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    unlinkSync(join(root, 'plugin', 'thing.mjs'))
    const beforeStage = treeSignature(root)
    expect(git('add', '-A').status).toBe(0)
    expect(treeSignature(root)).toBe(beforeStage)
    expect(git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'delete').status).toBe(0)
    expect(treeSignature(root)).toBe(beforeStage)
  })

  it('keeps a tracked rename signature identical before and after staging', () => {
    const { root } = gateRepo()
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    expect(git('mv', 'plugin/thing.mjs', 'plugin/renamed.mjs').status).toBe(0)
    const beforeStage = treeSignature(root)
    expect(git('add', '-A').status).toBe(0)
    expect(treeSignature(root)).toBe(beforeStage)
    expect(git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'rename').status).toBe(0)
    expect(treeSignature(root)).toBe(beforeStage)
  })

  it('is deterministic and fails loudly when its injected file reader cannot read an input', () => {
    const { root } = gateRepo()
    writeFileSync(join(root, 'a'), 'a'); writeFileSync(join(root, 'b'), 'b')
    expect(treeSignature(root)).toBe(treeSignature(root))
    expect(() => treeSignature(root, { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o644 }), readFileSync: () => { throw new Error('controlled unreadable input') }, readlinkSync: () => '' })).toThrow('controlled unreadable input')
  })

  it('rejects a version-1 record and refuses an actual during-gate mutation', () => {
    const { root, env } = gateRepo()
    const stateRoot = env.WT_GUARD_JOURNAL_DIR!
    const id = createHash('sha256').update(root).digest('hex')
    const record = join(stateRoot, 'wt-gate-records', id, 'test.json')
    mkdirSync(join(stateRoot, 'wt-gate-records', id), { recursive: true })
    writeFileSync(record, JSON.stringify({ version: 1, name: 'test', exit: 0, tree: treeSignature(root), finishedAt: new Date().toISOString() }))
    expect(run(['--check', root, '--gate', 'test'], { env }).status).toBe(1)
    const mutate = "require('fs').writeFileSync('plugin/thing.mjs','changed during gate\\n')"
    const result = run(['--record', 'test', '--', process.execPath, '-e', mutate], { cwd: root, env })
    expect(result.status).toBe(1)
    expect(result.out).toContain('tree changed during gate; record refused')
    expect(run(['--check', root, '--gate', 'test'], { env }).stdout).toMatch(/^test: red /)
  })

  it('returns a caller error for a tree directory outside a Git repository', () => {
    const result = run(['--check', mkDir()])

    expect(result.status).toBe(2)
    expect(result.out).toContain('wt-run-gate:')
  })

  // Card #1864603468384175920. A gate's exit code answers for the COMMAND, never for the SUBJECT:
  // four merged deliveries were gated from a checkout holding `main` while the work sat on
  // `develop` in a worktree, and every number was true about a tree nobody meant to certify.
  // These lock the identity onto the SAME line as the exit code — reading it at a different
  // moment is the whole failure, so a separate command would not close it.
  it('names the branch and HEAD of the tree it certified, on the exit line itself', () => {
    const { root, env } = gateRepo()
    const first = run(['--name', 'g', '--out-dir', join(root, 'out'), '--', process.execPath, '-e', 'process.exit(0)'], { cwd: root, env })
    expect(first.status).toBe(0)
    const head = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const branch = spawnSync('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    expect(first.out).toContain(`tree=${branch}@${head}`)
    expect(first.out).toContain(`dir=${root}`)

    // The discriminating half: the SAME command on a DIFFERENT branch must be distinguishable by
    // reading the printed line alone. An identity that never varies proves nothing.
    spawnSync('git', ['-C', root, 'checkout', '-q', '-b', 'other-branch'], { encoding: 'utf8' })
    const second = run(['--name', 'g', '--out-dir', join(root, 'out'), '--', process.execPath, '-e', 'process.exit(0)'], { cwd: root, env })
    expect(second.out).toContain(`tree=other-branch@${head}`)
    expect(second.out).not.toContain(`tree=${branch}@${head}`)
  })

  it('marks a tree with uncommitted tracked changes as dirty, because its record is not reproducible', () => {
    const { root, env } = gateRepo()
    const clean = run(['--name', 'g', '--out-dir', join(root, 'out'), '--', process.execPath, '-e', 'process.exit(0)'], { cwd: root, env })
    expect(clean.out).not.toContain(' dirty')

    writeFileSync(join(root, 'plugin', 'thing.mjs'), '// edited\n')
    const dirty = run(['--name', 'g', '--out-dir', join(root, 'out'), '--', process.execPath, '-e', 'process.exit(0)'], { cwd: root, env })
    expect(dirty.out).toContain(' dirty')
  })

  it('degrades LEGIBLY rather than omitting the field: not-a-repo outside one, unknown without git', () => {
    const outside = mkDir()
    const noRepo = run(['--name', 'g', '--out-dir', join(outside, 'out'), '--', process.execPath, '-e', 'process.exit(0)'], { cwd: outside })
    expect(noRepo.out).toContain('tree=not-a-repo')

    // An omitted field would read as "the same as expected", which is the one thing it must never
    // mean — so an unreachable git says so instead of going quiet.
    const { root, env } = gateRepo()
    const noGit = run(['--name', 'g', '--out-dir', join(root, 'out'), '--', process.execPath, '-e', 'process.exit(0)'], { cwd: root, env: { ...env, PATH: join(root, 'no-such-bin') } })
    expect(noGit.out).toContain('tree=unknown')
  })
})
