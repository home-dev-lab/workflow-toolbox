import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { dedupFile, runSessionEnvDedup } from '../../../../plugin/bin/lib/host/session-env-dedup.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-session-env-dedup-hook.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  root: string
  envRoot: string
  dir: (id: string) => string
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wt-session-env-dedup-'))
  const envRoot = join(root, 'session-env')
  mkdirSync(envRoot, { recursive: true })
  roots.push(root)
  return {
    root,
    envRoot,
    dir: (id) => {
      const d = join(envRoot, id)
      mkdirSync(d, { recursive: true })
      return d
    },
  }
}

// The fixture root is the config dir the hook must find the session-env directory under.
function run(
  envFile: string | undefined,
  sessionId?: string,
  configDir?: string,
): { out: string; err: string; code: number | null } {
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '' }
  if (envFile !== undefined) {
    env['CLAUDE_ENV_FILE'] = envFile
    env['CLAUDE_CONFIG_DIR'] = configDir ?? dirname(dirname(dirname(envFile)))
  }
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', ...(sessionId ? { session_id: sessionId } : {}) }),
    encoding: 'utf8',
    env,
  })
  return { out: result.stdout ?? '', err: result.stderr ?? '', code: result.status }
}

// Deduplication replaces the file by renaming over it while the hook still holds the old inode open. Windows refuses
// to rename over a file that has an open handle, so the hook disables deduplication there and leaves every file
// untouched; the tests below that need a rewrite run on POSIX only, and the win32 degraded path has its own tests.
const POSIX_ONLY_REASON =
  'POSIX-only: deduplication renames over a file the hook holds open, which Windows refuses; win32 degrades to a no-op (see the degraded-path tests)'
function posixOnly(ctx: { skip: (note?: string) => void }): void {
  if (process.platform === 'win32') ctx.skip(POSIX_ONLY_REASON)
}

const L = {
  a: "export OPENAI_CODEX_SESSION_ID='abc-123'\n",
  b: "export CODEX_COMPANION_SESSION_ID='abc-123'\n",
  c: "export CLAUDE_PLUGIN_DATA='/home/u/.claude/plugins/data/codex'\n",
}

describe('wt-session-env-dedup-hook', () => {
  it('collapses 300 repeats of three codex lines to the three distinct lines', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, (L.a + L.b + L.c).repeat(300))

    const r = run(file, 's1')

    expect(r).toMatchObject({ out: '', code: 0 })
    expect(readFileSync(file, 'utf8')).toBe(L.a + L.b + L.c)
  })

  it('keeps the last occurrence and preserves a value with an embedded quote byte-identically', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    const tricky = `export NOTE='it'"'"'s fine'\n`
    writeFileSync(file, tricky + L.a + tricky + L.b)

    run(file, 's1')

    expect(readFileSync(file, 'utf8')).toBe(L.a + tricky + L.b)
  })

  it('A=1, A=2, A=1 becomes A=2, A=1', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, 'export A=1\nexport A=2\nexport A=1\n')

    run(file, 's1')

    expect(readFileSync(file, 'utf8')).toBe('export A=2\nexport A=1\n')
  })

  it.each([
    ['a $ expansion', 'export PATH="$PATH:x"\nexport PATH="$PATH:x"\n'],
    ['a tilde', 'export H=~/bin\nexport H=~/bin\n'],
    ['a command line', 'cd /tmp\ncd /tmp\nexport A=1\n'],
    ['a glob', 'export G=*.js\nexport G=*.js\n'],
    ['a backtick', 'export G="`id`"\nexport G="`id`"\n'],
  ])('leaves a file with %s byte-identical', (_name, content) => {
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, content)

    expect(run(file, 's1').code).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(content)
  })

  it('leaves a CRLF file untouched', () => {
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    const content = 'export A=1\r\nexport A=1\r\n'
    writeFileSync(file, content)

    run(file, 's1')

    expect(readFileSync(file, 'utf8')).toBe(content)
  })

  it('keeps comments and blank lines in place, and preserves a missing trailing newline', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, '# head\nexport A=1\n\n# mid\nexport B=2\nexport A=1')

    run(file, 's1')

    expect(readFileSync(file, 'utf8')).toBe('# head\n\n# mid\nexport B=2\nexport A=1')
  })

  it('dedups the resumed session directory too, and touches no other session, symlink or foreign name', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const pre = fx.dir('old-session')
    const resumed = fx.dir('resumed-session')
    const other = fx.dir('other-session')
    const own = join(pre, 'sessionstart-hook-2.sh')
    const sibling = join(resumed, 'sessionstart-hook-5.sh')
    const bystander = join(other, 'sessionstart-hook-5.sh')
    const notes = join(resumed, 'notes.sh')
    const target = join(fx.root, 'target.sh')
    const dup = L.a.repeat(4)
    writeFileSync(own, dup)
    writeFileSync(sibling, dup)
    writeFileSync(bystander, dup)
    writeFileSync(notes, dup)
    writeFileSync(target, dup)
    symlinkSync(target, join(resumed, 'sessionstart-hook-9.sh'))

    const r = run(own, 'resumed-session')

    expect(r.code).toBe(0)
    expect(readFileSync(own, 'utf8')).toBe(L.a)
    expect(readFileSync(sibling, 'utf8')).toBe(L.a)
    expect(readFileSync(bystander, 'utf8')).toBe(dup)
    expect(readFileSync(notes, 'utf8')).toBe(dup)
    expect(readFileSync(target, 'utf8')).toBe(dup)
  })

  it('ignores an unsafe session_id', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, L.a.repeat(2))
    const outside = join(fx.root, 'x')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'sessionstart-hook-1.sh'), L.a.repeat(2))

    run(file, '../x')

    expect(readFileSync(join(outside, 'sessionstart-hook-1.sh'), 'utf8')).toBe(L.a.repeat(2))
    expect(readFileSync(file, 'utf8')).toBe(L.a)
  })

  it('is a silent no-op without CLAUDE_ENV_FILE', () => {
    expect(run(undefined, 's1')).toEqual({ out: '', err: '', code: 0 })
  })

  it('does not touch a user-set CLAUDE_ENV_FILE that is not under session-env', () => {
    const fx = fixture()
    const venv = join(fx.root, 'venv', 'bin')
    mkdirSync(venv, { recursive: true })
    const activate = join(venv, 'activate.sh')
    const hookNamed = join(venv, 'sessionstart-hook-1.sh')
    writeFileSync(activate, L.a.repeat(3))
    writeFileSync(hookNamed, L.a.repeat(3))

    expect(run(activate, 's1')).toEqual({ out: '', err: '', code: 0 })
    expect(run(hookNamed, 's1')).toEqual({ out: '', err: '', code: 0 })
    expect(readFileSync(activate, 'utf8')).toBe(L.a.repeat(3))
    expect(readFileSync(hookNamed, 'utf8')).toBe(L.a.repeat(3))
  })

  it('warns naming the file and its size when non-literal content exceeds 64 KiB', () => {
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    const body = 'echo "padding"\n'.repeat(5000)
    writeFileSync(file, body)

    const r = run(file, 's1')

    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(parsed.hookSpecificOutput.additionalContext).toContain(file)
    expect(parsed.hookSpecificOutput.additionalContext).toContain(`${Buffer.byteLength(body)} bytes`)
    expect(parsed.hookSpecificOutput.additionalContext).toContain('E2BIG')
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'Files that could not be deduplicated contain non-literal lines, exceed 8 MiB, or could not be rewritten.',
    )
    expect(r.err.trim().split('\n')).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).toBe(body)
  })

  it('stays silent at 64 KiB exactly', () => {
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, 'x'.repeat(65536))

    expect(run(file, 's1')).toEqual({ out: '', err: '', code: 0 })
  })

  it('counts size after dedup, so a deduplicated directory does not alarm', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, (L.a + L.b + L.c).repeat(2000))

    expect(run(file, 's1').out).toBe('')
    expect(readFileSync(file, 'utf8')).toBe(L.a + L.b + L.c)
  })

  it.skipIf(process.platform === 'win32')('preserves the file mode and leaves no temp file in session-env', () => {
    const fx = fixture()
    const d = fx.dir('s1')
    const file = join(d, 'sessionstart-hook-1.sh')
    writeFileSync(file, L.a.repeat(3))
    chmodSync(file, 0o640)

    run(file, 's1')

    expect(readFileSync(file, 'utf8')).toBe(L.a)
    expect(statSync(file).mode & 0o777).toBe(0o640)
    expect(readdirSync(fx.envRoot)).toEqual(['s1'])
    expect(readdirSync(d)).toEqual(['sessionstart-hook-1.sh'])
  })

  it('removes stale temp files by exact name for its own directory only', () => {
    const fx = fixture()
    const file = join(fx.dir('s'), 'sessionstart-hook-1.sh')
    fx.dir('s-x')
    writeFileSync(file, L.a)
    const own = join(fx.envRoot, '.wt-session-env-dedup-s-sessionstart-hook-1.sh-123-abcdef01.tmp')
    const sibling = join(fx.envRoot, '.wt-session-env-dedup-s-x-sessionstart-hook-1.sh-123-abcdef01.tmp')
    const unrelated = join(fx.envRoot, '.wt-session-env-dedup-s-notes.tmp')
    const fresh = join(fx.envRoot, '.wt-session-env-dedup-s-sessionstart-hook-2.sh-123-abcdef02.tmp')
    for (const p of [own, sibling, unrelated, fresh]) writeFileSync(p, 'x')
    const old = new Date(Date.now() - 120_000)
    for (const p of [own, sibling, unrelated]) utimesSync(p, old, old)

    run(file, 's')

    expect(existsSync(own)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
    expect(existsSync(fresh)).toBe(true)
  })

  it('does not crash on a directory named like a hook file', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const d = fx.dir('s1')
    mkdirSync(join(d, 'sessionstart-hook-1.sh'))
    const real = join(d, 'sessionstart-hook-2.sh')
    writeFileSync(real, L.a.repeat(2))

    expect(run(real, 's1').code).toBe(0)
    expect(readFileSync(real, 'utf8')).toBe(L.a)
  })

  it('carries bytes a parallel hook appends to the old inode between the rename and the final fstat', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, L.a.repeat(3))
    const tmp = join(fx.envRoot, '.wt-session-env-dedup-s1-sessionstart-hook-1.sh-1-abcdef01.tmp')
    // The parallel writer opened the file before the rename, so its fd follows the old inode.
    const writerFd = openSync(file, 'a')
    try {
      const changed = dedupFile(file, tmp, {
        afterRename: () => {
          writeSync(writerFd, L.b)
        },
      })
      expect(changed).toBe(true)
    } finally {
      closeSync(writerFd)
    }

    expect(readFileSync(file, 'utf8')).toBe(L.a + L.b)
    expect(existsSync(tmp)).toBe(false)
  })

  it('writes the carried tail through the inode it created, never through the path', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, L.a.repeat(3))
    const sentinel = join(fx.root, 'sentinel.txt')
    writeFileSync(sentinel, 'sentinel')
    const tmp = join(fx.envRoot, '.wt-session-env-dedup-s1-sessionstart-hook-1.sh-1-abcdef01.tmp')
    const writerFd = openSync(file, 'a')
    let renamedInode = -1
    try {
      dedupFile(file, tmp, {
        afterRename: () => {
          writeSync(writerFd, L.b)
          // Hold the renamed inode, then swap the path for a symlink to a foreign file.
          renamedInode = openSync(file, 'r')
          rmSync(file)
          symlinkSync(sentinel, file)
        },
      })
      expect(readFileSync(sentinel, 'utf8')).toBe('sentinel')
      expect(readFileSync(renamedInode, 'utf8')).toBe(L.a + L.b)
    } finally {
      closeSync(writerFd)
      if (renamedInode >= 0) closeSync(renamedInode)
    }
  })

  it('does not touch a session-env directory that is not under the active config directory', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const foreign = join(fx.root, 'project', 'session-env', 's1')
    mkdirSync(foreign, { recursive: true })
    const file = join(foreign, 'sessionstart-hook-1.sh')
    writeFileSync(file, L.a.repeat(3))

    expect(run(file, 's1', join(fx.root, 'other-config'))).toEqual({ out: '', err: '', code: 0 })
    expect(readFileSync(file, 'utf8')).toBe(L.a.repeat(3))
    expect(run(file, 's1', join(fx.root, 'project')).code).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(L.a)
  })

  it('stops deduplicating past the byte budget but keeps earlier files cleaned', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const d = fx.dir('s1')
    const first = join(d, 'sessionstart-hook-1.sh')
    const second = join(d, 'sessionstart-hook-2.sh')
    writeFileSync(first, L.a.repeat(4))
    writeFileSync(second, L.b.repeat(4))

    runSessionEnvDedup(first, 's1', { configDir: fx.root, maxTotalBytes: Buffer.byteLength(L.a.repeat(4)) + 1 })

    expect(readFileSync(first, 'utf8')).toBe(L.a)
    expect(readFileSync(second, 'utf8')).toBe(L.b.repeat(4))
  })

  it('caps the files considered per directory', (ctx) => {
    posixOnly(ctx)
    const fx = fixture()
    const d = fx.dir('s1')
    const first = join(d, 'sessionstart-hook-1.sh')
    const second = join(d, 'sessionstart-hook-2.sh')
    writeFileSync(first, L.a.repeat(3))
    writeFileSync(second, L.b.repeat(3))

    runSessionEnvDedup(first, 's1', { configDir: fx.root, maxFiles: 1 })

    expect(readFileSync(first, 'utf8')).toBe(L.a)
    expect(readFileSync(second, 'utf8')).toBe(L.b.repeat(3))
  })

  it('on win32 leaves a duplicated file byte-identical and creates no temp file', () => {
    const fx = fixture()
    const d = fx.dir('s1')
    const file = join(d, 'sessionstart-hook-1.sh')
    writeFileSync(file, L.a.repeat(3))
    const tmp = join(fx.envRoot, '.wt-session-env-dedup-s1-sessionstart-hook-1.sh-1-abcdef01.tmp')

    expect(dedupFile(file, tmp, { platform: 'win32' })).toBe(false)
    expect(runSessionEnvDedup(file, 's1', { configDir: fx.root, platform: 'win32' })).toBeNull()

    expect(readFileSync(file, 'utf8')).toBe(L.a.repeat(3))
    expect(readdirSync(fx.envRoot)).toEqual(['s1'])
    expect(readdirSync(d)).toEqual(['sessionstart-hook-1.sh'])
  })

  it('on win32 still alarms over 64 KiB and says deduplication is unavailable on this platform', () => {
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    const body = (L.a + L.b + L.c).repeat(2000)
    writeFileSync(file, body)

    const text = runSessionEnvDedup(file, 's1', { configDir: fx.root, platform: 'win32' })

    expect(text).toContain(`${Buffer.byteLength(body)} bytes`)
    expect(text).toContain('Deduplication is unavailable on this platform')
    expect(readFileSync(file, 'utf8')).toBe(body)
  })

  it('does not name the platform limit where deduplication runs', () => {
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, 'echo "padding"\n'.repeat(5000))

    const text = runSessionEnvDedup(file, 's1', { configDir: fx.root, platform: 'linux' })

    expect(text).not.toContain('unavailable on this platform')
  })

  it('through the real hook on this platform: dedups on POSIX, leaves the file byte-identical on win32', () => {
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, L.a.repeat(3))

    const r = run(file, 's1')

    expect(r).toMatchObject({ out: '', code: 0 })
    expect(readFileSync(file, 'utf8')).toBe(process.platform === 'win32' ? L.a.repeat(3) : L.a)
  })

  it('counts every hook file for the alarm, including those past the per-directory dedup cap', () => {
    const fx = fixture()
    const d = fx.dir('s1')
    // 70 non-literal files of 1,023 bytes: 71,610 in total, but only 65,472 (under the alarm) in the first 64.
    for (let n = 1; n <= 70; n++) writeFileSync(join(d, `sessionstart-hook-${n}.sh`), `echo "${'x'.repeat(1015)}"\n`)

    const text = runSessionEnvDedup(join(d, 'sessionstart-hook-1.sh'), 's1', { configDir: fx.root })

    expect(text).toContain('holds 71610 bytes')
  })

  it.skipIf(process.platform === 'win32')('keeps the setgid bit when the platform allows it', (ctx) => {
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, L.a.repeat(3))
    chmodSync(file, 0o2640)
    if ((statSync(file).mode & 0o7777) !== 0o2640) ctx.skip('chmod to 02640 does not stick on this filesystem or group')

    run(file, 's1')

    expect(readFileSync(file, 'utf8')).toBe(L.a)
    expect(statSync(file).mode & 0o7777).toBe(0o2640)
  })

  it.skipIf(process.platform === 'win32')('exits 0 when stdout is a pipe whose reader is already gone', () => {
    const fx = fixture()
    const file = join(fx.dir('s1'), 'sessionstart-hook-1.sh')
    writeFileSync(file, 'echo "padding"\n'.repeat(5000))
    const input = join(fx.root, 'stdin.json')
    writeFileSync(input, JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1' }))

    // The reader closes its end before the hook writes; the hook's own status goes to stderr.
    const result = spawnSync(
      'bash',
      [
        '-c',
        `{ "${process.execPath}" "${HOOK}" < "${input}" 2>/dev/null; echo "HOOK_EXIT=$?" >&2; } | { exec <&-; sleep 1; }`,
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', CLAUDE_ENV_FILE: file, CLAUDE_CONFIG_DIR: fx.root },
      },
    )

    expect(result.stderr).toContain('HOOK_EXIT=0')
  })
})
