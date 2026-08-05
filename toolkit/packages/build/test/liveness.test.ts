import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// liveness.mjs lives at plugin/bin/lib/ -- a shipped plugin script outside this package's
// include/rootDir (and outside the whole toolkit/ TS project), so it has no declaration file TS
// can resolve. Narrow, explicit suppression of TS7016 is the same pattern used by
// stop-correlation.test.ts for the same out-of-project plain-JS reason.
// @ts-expect-error TS7016 -- liveness.mjs has no declaration file (see note above)
import { defaultLivenessDir, sanitizeLivenessKey, validateLivenessRecord, readLivenessRecord, worktreeRecentlyActive } from '../../../../plugin/bin/lib/liveness.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const ARC_WATCH = path.join(REPO_ROOT, 'plugin/bin/wt-arc-watch.mjs')

const spawned: ChildProcess[] = []
const roots: string[] = []

function tmpRoot(tag: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${tag}-`))
  roots.push(dir)
  return dir
}

function projectSlug(dir: string): string {
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

function touchFile(file: string, mtimeMs: number): void {
  writeFileSync(file, '{}\n')
  const t = mtimeMs / 1000
  utimesSync(file, t, t)
}

type WatchScenarioOptions = {
  transcriptName?: string
  metaName?: string | null
  livenessDir?: string
  livenessRecord?: unknown
  livenessFileName?: string
  transcriptAgeMs?: number
  staleMinutes?: number
  transcriptAfterArm?: boolean
  afterArmed?: () => void
  waitFor?: RegExp | null
  runForMs?: number
  cwd?: string
}

async function runWatchScenario(options: WatchScenarioOptions = {}): Promise<string> {
  const {
    transcriptName = 'agent-under-test.jsonl',
    metaName = 'pilot under/test',
    livenessDir,
    livenessRecord,
    livenessFileName,
    transcriptAgeMs = 2_000,
    staleMinutes = 0,
    transcriptAfterArm = true,
    cwd,
    afterArmed,
    waitFor = /(STALE|IDLE-MID-MISSION|WAITING-ON-SPAWNER): /,
    runForMs = 7_500,
  } = options

  const root = tmpRoot('wt-liveness-watch')
  const home = path.join(root, 'home')
  const configDir = path.join(root, 'config')
  const projectDir = path.join(root, 'project')
  const sessionId = 'watch-session'
  const subagentsDir = path.join(configDir, 'projects', projectSlug(projectDir), sessionId, 'subagents')
  mkdirSync(home, { recursive: true })
  mkdirSync(subagentsDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })

  const transcriptPath = path.join(subagentsDir, transcriptName)
  const metaPath = transcriptPath.replace(/\.jsonl$/, '.meta.json')
  const now = Date.now()

  const prepareTranscript = () => {
    touchFile(transcriptPath, now - transcriptAgeMs)
    if (metaName !== null) writeFileSync(metaPath, JSON.stringify(metaName ? { name: metaName } : {}))
  }

  if (!transcriptAfterArm) prepareTranscript()

  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_SESSION_ID: '',
    WT_LIVENESS_DIR: livenessDir ?? path.join(root, 'missing-liveness-dir'),
  }

  if (livenessDir && livenessRecord !== undefined) {
    mkdirSync(livenessDir, { recursive: true })
    const fileName = livenessFileName ?? `${sanitizeLivenessKey(metaName ?? '')}.json`
    writeFileSync(path.join(livenessDir, fileName), typeof livenessRecord === 'string' ? livenessRecord : JSON.stringify(livenessRecord))
  }

  const child = spawn(process.execPath, [ARC_WATCH, '--project', projectDir, '--poll', '5', '--stale', String(staleMinutes)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
  })
  spawned.push(child)

  let stdout = ''
  let armed = false
  let resolved = false

  const finish = (value: string, resolve: (value: string) => void) => {
    if (resolved) return
    resolved = true
    try {
      child.kill('SIGKILL')
    } catch {
      // already dead
    }
    resolve(value)
  }

  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(stdout, resolve), runForMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!armed && stdout.includes('ARC WATCH ARMED')) {
        armed = true
        if (transcriptAfterArm) prepareTranscript()
        afterArmed?.()
      }
      if (waitFor && waitFor.test(stdout)) {
        clearTimeout(timer)
        finish(stdout, resolve)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', () => {
      if (resolved) return
      clearTimeout(timer)
      resolve(stdout)
    })
  })
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill('SIGKILL')
    } catch {
      // already dead
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('defaultLivenessDir', () => {
  it('mirrors the outbound-guard default pattern under the provided homedir', () => {
    expect(defaultLivenessDir('/home/tester')).toBe(path.join('/home/tester', '.local', 'state', 'wt-liveness'))
  })
})

describe('sanitizeLivenessKey', () => {
  it('replaces unsafe characters, trims edges, truncates long names, and returns null for blank input', () => {
    expect(sanitizeLivenessKey('  pilot/name:?*  ')).toBe('pilot-name---')
    expect(sanitizeLivenessKey('   ')).toBeNull()
    expect(sanitizeLivenessKey('a'.repeat(140))).toBe('a'.repeat(120))
  })
})

describe('validateLivenessRecord', () => {
  it('accepts a well-formed record and normalizes optional fields', () => {
    expect(validateLivenessRecord({
      agentId: 'pilot-1',
      agentIdSource: 'name',
      scope: 'card:123',
      complete: true,
      waitingOn: 'lane',
      worktree: '/tmp/worktree',
      updatedAt: '2026-08-05T00:00:00.000Z',
    })).toEqual({
      ok: true,
      record: {
        agentId: 'pilot-1',
        agentIdSource: 'name',
        scope: 'card:123',
        complete: true,
        waitingOn: 'lane',
        worktree: '/tmp/worktree',
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    })
  })

  it('rejects missing agentId or scope', () => {
    expect(validateLivenessRecord({ scope: 'card:123', complete: false })).toEqual({ ok: false, reason: 'agentId' })
    expect(validateLivenessRecord({ agentId: 'pilot-1', complete: false })).toEqual({ ok: false, reason: 'scope' })
  })

  it('rejects an invalid waitingOn value and defaults waitingOn to none when absent', () => {
    expect(validateLivenessRecord({ agentId: 'pilot-1', scope: 'card:123', complete: false, waitingOn: 'queue' }))
      .toEqual({ ok: false, reason: 'waitingOn' })
    expect(validateLivenessRecord({ agentId: 'pilot-1', scope: 'card:123', complete: false }))
      .toEqual({
        ok: true,
        record: {
          agentId: 'pilot-1',
          agentIdSource: 'unknown',
          scope: 'card:123',
          complete: false,
          waitingOn: 'none',
          worktree: null,
          updatedAt: null,
        },
      })
  })

  it('does not treat string complete:"true" as boolean true', () => {
    expect(validateLivenessRecord({ agentId: 'pilot-1', scope: 'card:123', complete: 'true' }))
      .toEqual({
        ok: true,
        record: {
          agentId: 'pilot-1',
          agentIdSource: 'unknown',
          scope: 'card:123',
          complete: false,
          waitingOn: 'none',
          worktree: null,
          updatedAt: null,
        },
      })
  })

  it('accepts declared correlation tiers, rejects invalid ones, and allows null agentId only for tier none', () => {
    for (const agentIdSource of ['brief', 'name', 'none'] as const) {
      expect(validateLivenessRecord({
        agentId: agentIdSource === 'none' ? null : 'pilot-1',
        agentIdSource,
        scope: 'card:123',
        complete: false,
      })).toEqual({
        ok: true,
        record: {
          agentId: agentIdSource === 'none' ? null : 'pilot-1',
          agentIdSource,
          scope: 'card:123',
          complete: false,
          waitingOn: 'none',
          worktree: null,
          updatedAt: null,
        },
      })
    }

    expect(validateLivenessRecord({
      agentId: 'pilot-1',
      agentIdSource: 'bogus',
      scope: 'card:123',
      complete: false,
    })).toEqual({ ok: false, reason: 'agentIdSource' })

    expect(validateLivenessRecord({
      agentId: null,
      agentIdSource: 'name',
      scope: 'card:123',
      complete: false,
    })).toEqual({ ok: false, reason: 'agentId' })
  })
})

describe('readLivenessRecord', () => {
  it('returns null for missing files, malformed JSON, and failed validation', async () => {
    const dir = tmpRoot('wt-liveness-read')
    mkdirSync(dir, { recursive: true })
    expect(await readLivenessRecord(dir, 'missing')).toBeNull()

    writeFileSync(path.join(dir, 'bad.json'), '{not json')
    expect(await readLivenessRecord(dir, 'bad')).toBeNull()

    writeFileSync(path.join(dir, 'invalid.json'), JSON.stringify({ complete: true }))
    expect(await readLivenessRecord(dir, 'invalid')).toBeNull()
  })
})

describe('worktreeRecentlyActive', () => {
  it('returns true when a regular file at the root is fresh enough', async () => {
    const dir = tmpRoot('wt-worktree-active')
    const file = path.join(dir, 'file.txt')
    touchFile(file, Date.now())
    expect(await worktreeRecentlyActive(dir, Date.now() - 5_000)).toBe(true)
  })

  it('returns false when only old files exist', async () => {
    const dir = tmpRoot('wt-worktree-old')
    const file = path.join(dir, 'file.txt')
    touchFile(file, Date.now() - 60_000)
    expect(await worktreeRecentlyActive(dir, Date.now() - 5_000)).toBe(false)
  })

  it('returns false when the scan hits maxEntries without finding a qualifying file', async () => {
    const dir = tmpRoot('wt-worktree-cap')
    for (let i = 0; i < 5; i += 1) {
      touchFile(path.join(dir, `old-${i}.txt`), Date.now() - 60_000)
    }
    expect(await worktreeRecentlyActive(dir, Date.now() - 5_000, { maxEntries: 3 })).toBe(false)
  })

  it('returns null when the path does not exist at all', async () => {
    const dir = path.join(tmpRoot('wt-worktree-missing'), 'does-not-exist')
    expect(await worktreeRecentlyActive(dir, Date.now() - 5_000)).toBeNull()
  })

  it('never descends into .git or node_modules', async () => {
    const dir = tmpRoot('wt-worktree-skip')
    const gitDir = path.join(dir, '.git')
    const depsDir = path.join(dir, 'node_modules')
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(depsDir, { recursive: true })
    touchFile(path.join(gitDir, 'fresh.txt'), Date.now())
    touchFile(path.join(depsDir, 'fresh.txt'), Date.now())
    expect(await worktreeRecentlyActive(dir, Date.now() - 5_000)).toBe(false)
  })

  it('uses lstat and never follows symlinked directories', async () => {
    const dir = tmpRoot('wt-worktree-symlink')
    const outside = tmpRoot('wt-worktree-symlink-target')
    mkdirSync(path.join(outside, 'nested'), { recursive: true })
    touchFile(path.join(outside, 'nested', 'fresh.txt'), Date.now())
    symlinkSync(outside, path.join(dir, 'linked-dir'))
    expect(await worktreeRecentlyActive(dir, Date.now() - 5_000)).toBe(false)
  })
})

describe('wt-arc-watch liveness integration', () => {
  it('Invariant 1: no liveness file behaves exactly like the old STALE path', async () => {
    const out = await runWatchScenario({
      metaName: 'pilot/needs-liveness',
      livenessDir: path.join(tmpRoot('wt-no-liveness'), 'missing'),
    })
    expect(out).toContain('STALE: watch-session/agent-under-test.jsonl — no write for 0+ min')
    expect(out).not.toContain('IDLE-MID-MISSION:')
  }, 12_000)

  it('Invariant 2: declared not complete emits IDLE-MID-MISSION, never STALE', async () => {
    const dir = tmpRoot('wt-liveness-idle')
    const out = await runWatchScenario({
      metaName: 'pilot/idle-mid-mission',
      livenessDir: dir,
      livenessRecord: {
        agentId: 'pilot/idle-mid-mission',
        agentIdSource: 'name',
        scope: 'card:123',
        complete: false,
        waitingOn: 'none',
        worktree: null,
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    })
    expect(out).toContain('IDLE-MID-MISSION: watch-session/agent-under-test.jsonl — declared not complete, no write for 0+ min')
    expect(out).not.toContain('STALE: watch-session/agent-under-test.jsonl — no write for 0+ min')
  }, 12_000)

  it('Invariant 3: malformed liveness JSON falls back to unchanged STALE, never silence', async () => {
    const dir = tmpRoot('wt-liveness-malformed')
    const out = await runWatchScenario({
      metaName: 'pilot/malformed',
      livenessDir: dir,
      livenessRecord: '{bad json',
    })
    expect(out).toContain('STALE: watch-session/agent-under-test.jsonl — no write for 0+ min')
    expect(out).not.toContain('IDLE-MID-MISSION:')
  }, 12_000)

  it('Invariant 3: waitingOn lane with a missing worktree fails toward alerting, not silence', async () => {
    const dir = tmpRoot('wt-liveness-lane-missing')
    const out = await runWatchScenario({
      metaName: 'pilot/lane-missing',
      livenessDir: dir,
      livenessRecord: {
        agentId: 'pilot/lane-missing',
        agentIdSource: 'name',
        scope: 'card:123',
        complete: false,
        waitingOn: 'lane',
        worktree: path.join(dir, 'does-not-exist'),
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    })
    expect(out).toContain('IDLE-MID-MISSION: watch-session/agent-under-test.jsonl — declared not complete, no write for 0+ min')
  }, 12_000)

  // Review finding (opencode gpt-5.6-terra, card 1834979064838882934): a RELATIVE worktree path
  // is resolved by worktreeRecentlyActive() against the WATCHER PROCESS's own cwd, not the
  // delegate's tree. Without validateLivenessRecord() neutralizing it, `worktree: "."` would make
  // the watcher check its own working directory and, if that directory happens to contain a
  // recently-modified file, wrongly silence a genuinely stale transcript. Made DETERMINISTIC by
  // pinning the watcher CHILD PROCESS's own cwd to a directory this test fully controls, and by
  // reusing the SAME staleMinutes/afterArmed timing shape as the passing
  // "silences legitimate lane waits ... recent real activity" test below (a razor-thin
  // now-vs-sinceMs window, as a naive `staleMinutes: 0` scenario would produce, cannot
  // discriminate the guard from its absence: neither path finds anything "fresh enough" in time,
  // and the test would pass for the WRONG reason regardless of the fix — this shape is what
  // avoids that trap).
  it('Invariant 3: waitingOn lane with a RELATIVE worktree path is neutralized, never trusted as recently active', async () => {
    const dir = tmpRoot('wt-liveness-lane-relative')
    const watcherCwd = tmpRoot('wt-liveness-lane-relative-cwd')
    const freshFile = path.join(watcherCwd, 'freshly-touched.txt')
    const out = await runWatchScenario({
      metaName: 'pilot/lane-relative',
      livenessDir: dir,
      cwd: watcherCwd,
      livenessRecord: {
        agentId: 'pilot/lane-relative',
        agentIdSource: 'name',
        scope: 'card:123',
        complete: false,
        waitingOn: 'lane',
        worktree: '.', // relative — must NOT be treated as a valid, checkable worktree
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
      transcriptAgeMs: 20_000,
      staleMinutes: 0.2,
      // Fired right after ARMED, exactly like the sibling "recent real activity" test — an
      // UN-guarded relative resolution ('.' against the watcher's own cwd) would find this file
      // comfortably inside the 12s window and wrongly conclude "recently active".
      afterArmed: () => touchFile(freshFile, Date.now()),
      waitFor: null,
      runForMs: 11_000,
    })
    expect(out).toContain('ARC WATCH ARMED')
    expect(out).toContain('IDLE-MID-MISSION: watch-session/agent-under-test.jsonl — declared not complete, no write for 0.2+ min')
    expect(out).not.toContain('STALE: watch-session/agent-under-test.jsonl')
  }, 12_000)

  // Review finding (same source): correlation by filename alone is not sufficient proof — the
  // record's OWN declared identity must agree with the candidate key it was looked up under.
  // This reproduces a MISMATCHED-TIER record sitting under the transcript's raw-id filename (as
  // if left over from an unrelated write, or copy-pasted): agentIdSource:"name" under a raw-id
  // key. FAILS before the identity check: the old code returned any record found at the raw-id
  // key regardless of its declared tier, so this record's complete:true would wrongly silence a
  // transcript that in fact has no usable liveness declaration at all (no meta.name exists here,
  // so the name-tier fallback is also impossible — the correct behavior is plain STALE).
  it('a liveness record whose declared identity does not match the correlation candidate is never trusted, even when found under the right filename', async () => {
    const dir = tmpRoot('wt-liveness-identity-mismatch')
    const transcriptName = 'agent-a013def19e5877298.jsonl'
    const rawId = /^agent-(.+)\.jsonl$/.exec(transcriptName)?.[1]
    const out = await runWatchScenario({
      transcriptName,
      metaName: null, // no declared name — the name-tier fallback must be unreachable too
      livenessDir: dir,
      livenessFileName: `${sanitizeLivenessKey(rawId ?? '')}.json`,
      livenessRecord: {
        agentId: 'some-other-agents-name', // wrong tier AND wrong identity for this raw-id file
        agentIdSource: 'name',
        scope: 'card:999',
        complete: true, // if trusted, this would wrongly silence
        waitingOn: 'none',
        worktree: null,
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    })
    expect(out).toContain(`STALE: watch-session/${transcriptName} — no write for 0+ min`)
    expect(out).not.toContain('IDLE-MID-MISSION:')
  }, 12_000)

  it('Invariant 4: explicit complete:true stays silent through the same watcher code path', async () => {
    const dir = tmpRoot('wt-liveness-complete')
    const out = await runWatchScenario({
      metaName: 'pilot/complete',
      livenessDir: dir,
      livenessRecord: {
        agentId: 'pilot/complete',
        agentIdSource: 'name',
        scope: 'card:123',
        complete: true,
        waitingOn: 'none',
        worktree: null,
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
      waitFor: null,
    })
    expect(out).toContain('ARC WATCH ARMED')
    expect(out).not.toContain('STALE:')
    expect(out).not.toContain('IDLE-MID-MISSION:')
  }, 12_000)

  it('silences legitimate lane waits only when the declared worktree shows recent real activity', async () => {
    const dir = tmpRoot('wt-liveness-lane-active')
    const worktree = tmpRoot('wt-lane-worktree')
    const recentFile = path.join(worktree, 'recent.txt')
    const out = await runWatchScenario({
      metaName: 'pilot/lane-active',
      livenessDir: dir,
      livenessRecord: {
        agentId: 'pilot/lane-active',
        agentIdSource: 'name',
        scope: 'card:123',
        complete: false,
        waitingOn: 'lane',
        worktree,
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
      transcriptAgeMs: 20_000,
      staleMinutes: 0.2,
      afterArmed: () => touchFile(recentFile, Date.now()),
      waitFor: null,
      runForMs: 11_000,
    })
    expect(out).toContain('ARC WATCH ARMED')
    expect(out).not.toContain('STALE:')
    expect(out).not.toContain('IDLE-MID-MISSION:')
  }, 12_000)

  it('correlates by transcript raw id when no declared name exists and emits IDLE-MID-MISSION', async () => {
    const dir = tmpRoot('wt-liveness-raw-id')
    const transcriptName = 'agent-a77d35c2be335f181.jsonl'
    const rawId = /^agent-(.+)\.jsonl$/.exec(transcriptName)?.[1]
    expect(rawId).toBe('a77d35c2be335f181')
    const out = await runWatchScenario({
      transcriptName,
      metaName: null,
      livenessDir: dir,
      livenessFileName: `${sanitizeLivenessKey(rawId ?? '')}.json`,
      livenessRecord: {
        agentId: rawId,
        agentIdSource: 'brief',
        scope: 'card:456',
        complete: false,
        waitingOn: 'none',
        worktree: null,
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    })
    expect(out).toContain(`IDLE-MID-MISSION: watch-session/${transcriptName} — declared not complete, no write for 0+ min`)
    expect(out).not.toContain(`STALE: watch-session/${transcriptName} — no write for 0+ min`)
  }, 12_000)

  it('emits WAITING-ON-SPAWNER without waiting for transcript staleness', async () => {
    const dir = tmpRoot('wt-liveness-spawner')
    const out = await runWatchScenario({
      metaName: 'pilot/spawner',
      livenessDir: dir,
      livenessRecord: {
        agentId: 'pilot/spawner',
        agentIdSource: 'name',
        scope: 'mission:keep waiting',
        complete: false,
        waitingOn: 'spawner',
        worktree: null,
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
      transcriptAgeMs: 0,
      waitFor: /WAITING-ON-SPAWNER: /,
    })
    expect(out).toContain('WAITING-ON-SPAWNER: pilot/spawner — mission:keep waiting')
    expect(out).not.toContain('STALE: watch-session/agent-under-test.jsonl')
  }, 12_000)

  it('emits UNCORRELATABLE once per distinct updatedAt for tier-none records', async () => {
    const dir = tmpRoot('wt-liveness-uncorrelatable')
    const file = path.join(dir, 'orphan-record.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({
      agentId: null,
      agentIdSource: 'none',
      scope: 'mission:uncorrelated',
      complete: false,
      waitingOn: 'none',
      worktree: null,
      updatedAt: '2026-08-05T00:00:00.000Z',
    }))

    const out = await runWatchScenario({
      metaName: 'pilot/unrelated-transcript',
      livenessDir: dir,
      transcriptAgeMs: 0,
      waitFor: null,
      afterArmed: () => {
        setTimeout(() => {
          writeFileSync(file, JSON.stringify({
            agentId: null,
            agentIdSource: 'none',
            scope: 'mission:uncorrelated',
            complete: false,
            waitingOn: 'none',
            worktree: null,
            updatedAt: '2026-08-05T00:00:00.000Z',
          }))
        }, 1_000)
        setTimeout(() => {
          writeFileSync(file, JSON.stringify({
            agentId: null,
            agentIdSource: 'none',
            scope: 'mission:uncorrelated',
            complete: false,
            waitingOn: 'none',
            worktree: null,
            updatedAt: '2026-08-05T00:00:10.000Z',
          }))
        }, 6_000)
      },
      runForMs: 12_500,
    })

    const marker = 'UNCORRELATABLE: mission:uncorrelated — liveness file declares no correlation key, cannot be matched to a transcript'
    expect(out.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2)
  }, 15_000)
})

describe('test harness sanity', () => {
  it('uses the real watcher script path', () => {
    expect(existsSync(ARC_WATCH)).toBe(true)
  })
})
