import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WATCH = join(REPO_ROOT, 'plugin/bin/wt-autonomy-watch.mjs')
const MONITORS_JSON = join(REPO_ROOT, 'plugin/monitors/monitors.json')

const roots: string[] = []
const laneProcesses: number[] = []

afterEach(() => {
  for (const pid of laneProcesses.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already dead
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function projectSlug(dir: string): string {
  return resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

function touch(filePath: string, mtimeMs: number, contents = '{}\n'): void {
  writeFileSync(filePath, contents)
  const t = mtimeMs / 1000
  utimesSync(filePath, t, t)
}

function launchLane(args0: string, cwd: string): number {
  const child = spawn('bash', ['-lc', `exec -a ${JSON.stringify(args0)} sleep 30`], {
    cwd,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  if (!child.pid) throw new Error('lane did not start')
  laneProcesses.push(child.pid)
  return child.pid
}

function scaffold(tag: string) {
  const root = tmpRoot(`wt-autonomy-watch-${tag}-`)
  const projectDir = join(root, 'project')
  const configDir = join(root, 'config')
  const stateHome = join(root, 'state-home')
  const stateDir = join(stateHome, 'wt-queue-gate')
  const sessionId = 'session-under-test'
  const projectRoot = join(configDir, 'projects', projectSlug(projectDir))
  const transcriptPath = join(projectRoot, `${sessionId}.jsonl`)
  const subagentsDir = join(projectRoot, sessionId, 'subagents')
  // ⚠ The snapshot is PER PROJECT, and this expression is a CONTRACT with a different file:
  // `wt-queue-not-empty-gate-hook.mjs` writes `queue-<slug>.json` with exactly this slug, and
  // the watcher reads it. Reproduced here rather than imported because the two scripts are
  // loaded from different roots by the harness — so this line is what makes a divergence break
  // a test instead of silently producing a path that never exists. A wrong slug reads as
  // "unknown", unknown keeps the watcher quiet by design, and a quiet watcher looks exactly
  // like a working one with nothing to report.
  const queueSlug = `${projectDir.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)}-${createHash('sha1').update(projectDir).digest('hex').slice(0, 12)}`
  const queuePath = join(stateDir, `queue-${queueSlug}.json`)
  // ⚠ PROJECT-KEYED, matching wt-autonomy-arm.mjs's contract: `engine-<projectSlug>.json`, never
  // session-keyed — that is the whole point of the fix under test (a restart must inherit the
  // marker the OLD session wrote, which is impossible if the path carries the session id).
  const mandatePath = join(stateDir, `engine-${projectSlug(projectDir)}.json`)
  const markerPath = join(stateDir, `autonomy-watch-${sessionId}.json`)
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(subagentsDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return {
    root,
    projectDir,
    configDir,
    stateHome,
    stateDir,
    sessionId,
    transcriptPath,
    subagentsDir,
    queuePath,
    mandatePath,
    markerPath,
  }
}

function writeQueue(queuePath: string, snapshot: Record<string, unknown>) {
  writeFileSync(queuePath, `${JSON.stringify(snapshot)}\n`)
}

// The marker's freshness and provenance are read from ITS CONTENT (`declaredAtMs`, `sessionId`),
// never its mtime — so fixtures must write real JSON, not merely touch a file into existence.
// `declaredAtMs` defaults to `now`; pass an older value to simulate a mandate declared earlier
// (own-session re-arm) or a stale one, and a different `sessionId` to simulate inheritance.
function writeMandate(mandatePath: string, sessionId: string, declaredAtMs: number) {
  writeFileSync(mandatePath, `${JSON.stringify({ sessionId, declaredAtMs, declaredAt: new Date(declaredAtMs).toISOString() })}\n`)
}

// The watcher's idle check reads the CURRENT session's own transcript, never the mandate
// declarer's — a restarted session has its own, freshly started conversation. A restart fixture
// must therefore touch the transcript at the RESTARTED session's own path, not the scaffold's
// default one (which belongs to a DIFFERENT, earlier session).
function transcriptPathFor(configDir: string, projectDir: string, sessionId: string): string {
  return join(configDir, 'projects', projectSlug(projectDir), `${sessionId}.jsonl`)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runWatch(
  projectDir: string,
  env: NodeJS.ProcessEnv,
  extraArgs: string[] = [],
): { status: number | null; stdout: string; stderr: string; armed: string } {
  const res = spawnSync(process.execPath, [WATCH, '--once', '--project', projectDir, ...extraArgs], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  })
  // The watcher now writes ONE unconditional banner at arming, on the same stream as its wakes.
  // It is split out here rather than folded into `stdout` so that every silence assertion below
  // keeps asserting exactly what it always asserted — "no WAKE was emitted" — instead of being
  // quietly relaxed to "no wake, plus whatever else the process decided to print". The banner
  // gets its own assertions; the silence guarantees are untouched.
  const lines = res.stdout.trim().split('\n').filter(Boolean)
  const armed = lines.find((l) => l.startsWith('AUTONOMY WATCH ARMED:')) ?? ''
  return {
    status: res.status,
    stdout: lines.filter((l) => l !== armed).join('\n').trim(),
    stderr: res.stderr.trim(),
    armed,
  }
}

describe('wt-autonomy-watch', () => {
  it('no mandate marker emits NOTHING even when the other conditions are satisfied', () => {
    const s = scaffold('no-mandate')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeQueue(s.queuePath, { at: now, open: 3, next: 'CARD-1 keep going' })

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(s.markerPath)).toBe(false)
  })

  it('mandate + work + idle + nothing in flight emits exactly one line and writes the marker', () => {
    const s = scaffold('wake')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeMandate(s.mandatePath, s.sessionId, now - 5 * 60_000)
    writeQueue(s.queuePath, { at: now, open: 2, next: 'CARD-2 implement watcher' })

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('AUTONOMY WAKE: idle session with mandate, 2 open, next: CARD-2 implement watcher')
    expect(existsSync(s.markerPath)).toBe(true)
    const marker = JSON.parse(readFileSync(s.markerPath, 'utf8')) as { next: string }
    expect(marker.next).toBe('CARD-2 implement watcher')
  })

  it('stays silent while a delegate transcript is still recent', () => {
    const s = scaffold('delegate-active')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeMandate(s.mandatePath, s.sessionId, now - 5 * 60_000)
    touch(join(s.subagentsDir, 'agent-live.jsonl'), now - 60_000)
    writeQueue(s.queuePath, { at: now, open: 2, next: 'CARD-3 wait for delegate' })

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(s.markerPath)).toBe(false)
  })

  it('stays silent when the queue snapshot is missing or stale', () => {
    const missing = scaffold('queue-missing')
    const stale = scaffold('queue-stale')
    const now = Date.now()
    touch(missing.transcriptPath, now - 20 * 60_000)
    writeMandate(missing.mandatePath, missing.sessionId, now - 5 * 60_000)
    touch(stale.transcriptPath, now - 20 * 60_000)
    writeMandate(stale.mandatePath, stale.sessionId, now - 5 * 60_000)
    writeQueue(stale.queuePath, { at: now - 3 * 60 * 60_000, open: 9, next: 'CARD-4 stale snapshot' })

    const missingResult = runWatch(missing.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: missing.configDir,
      CLAUDE_CODE_SESSION_ID: missing.sessionId,
      XDG_STATE_HOME: missing.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })
    const staleResult = runWatch(stale.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: stale.configDir,
      CLAUDE_CODE_SESSION_ID: stale.sessionId,
      XDG_STATE_HOME: stale.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(missingResult.stdout).toBe('')
    expect(staleResult.stdout).toBe('')
    expect(existsSync(missing.markerPath)).toBe(false)
    expect(existsSync(stale.markerPath)).toBe(false)
  })

  it('two consecutive polls in the same idle stretch emit once, not twice', () => {
    const s = scaffold('reemit')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeMandate(s.mandatePath, s.sessionId, now - 5 * 60_000)
    writeQueue(s.queuePath, { at: now, open: 4, next: 'CARD-5 emit once' })
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    }

    const first = runWatch(s.projectDir, env)
    const second = runWatch(s.projectDir, env)

    expect(first.stdout).toContain('AUTONOMY WAKE:')
    expect(second.stdout).toBe('')
  })

  it('a satisfying fixture with the mandate path pointed at a nonexistent directory stays silent and does not write the marker', () => {
    const s = scaffold('negative-control')
    const now = Date.now()
    const missingMandateDir = join(s.root, 'missing-mandate-dir')
    touch(s.transcriptPath, now - 20 * 60_000)
    writeQueue(s.queuePath, { at: now, open: 2, next: 'CARD-6 negative control' })

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_MANDATE_DIR: missingMandateDir,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(result.stdout).toBe('')
    expect(existsSync(s.markerPath)).toBe(false)
  })

  it('stays silent while an external lane process is running', () => {
    const s = scaffold('lane-active')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeMandate(s.mandatePath, s.sessionId, now - 5 * 60_000)
    writeQueue(s.queuePath, { at: now, open: 2, next: 'CARD-7 lane running' })
    launchLane('opencode run', s.projectDir)

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
    })

    expect(result.stdout).toBe('')
    expect(existsSync(s.markerPath)).toBe(false)
  })

  it('a fresh mandate produces no expiry event, and no marker at all still stays silent', () => {
    const absent = scaffold('expiry-absent')
    const fresh = scaffold('expiry-fresh')
    const now = Date.now()
    touch(absent.transcriptPath, now - 20 * 60_000)
    touch(fresh.transcriptPath, now - 20 * 60_000)
    writeMandate(fresh.mandatePath, fresh.sessionId, now)

    const absentResult = runWatch(absent.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: absent.configDir,
      CLAUDE_CODE_SESSION_ID: absent.sessionId,
      XDG_STATE_HOME: absent.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })
    const freshResult = runWatch(fresh.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: fresh.configDir,
      CLAUDE_CODE_SESSION_ID: fresh.sessionId,
      XDG_STATE_HOME: fresh.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
      WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES: '1',
    })

    expect(absentResult.stdout).toBe('')
    expect(freshResult.stdout).toBe('')
  })

  it('a mandate that crosses its freshness window mid-session emits exactly once at the crossing', async () => {
    const s = scaffold('expiry-crossing')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeMandate(s.mandatePath, s.sessionId, now)
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
      // ⚠ 1.8s, not the 60ms this used to use. The FIRST check below must complete while the
      // mandate is still fresh — and it SPAWNS A SUBPROCESS, which cannot be relied on to finish
      // inside 60ms on a loaded machine. Measured 2026-08-28: this test failed twice in three full
      // parallel suite runs and passed 5/5 alone, and the failure was always the first assertion
      // seeing EXPIRED. The window has to outlast a spawn; the delay only has to outlast the window.
      WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES: '0.03',
    }

    const beforeExpiry = runWatch(s.projectDir, env)
    await delay(2500)
    const atCrossing = runWatch(s.projectDir, env)
    const afterCrossing = runWatch(s.projectDir, env)

    expect(beforeExpiry.stdout).toBe('')
    expect(atCrossing.stdout).toBe('AUTONOMY MANDATE EXPIRED: mandate freshness window elapsed; nothing is watching this session now. Re-arm with `wt-autonomy-arm.mjs` if autonomy should continue.')
    expect(afterCrossing.stdout).toBe('')
  })

  it('an unreadable marker is reported as unknown, never absent', () => {
    const s = scaffold('expiry-unknown')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeFileSync(s.mandatePath, '{not json}\n')

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(result.armed).toContain('mandate=unknown')
    expect(result.armed).not.toContain('mandate=absent')
    expect(result.stdout).toBe('')
  })
})

// The whole point of the fix under test: a marker keyed on the PROJECT survives a session
// restart (a new CLAUDE_CODE_SESSION_ID), where the old per-session key could not. Both
// directions are asserted, deliberately — a suite that only proved recovery could not see a
// mandate that never expires, which is exactly the failure this route was chosen to avoid.
describe('wt-autonomy-watch inherits a project-keyed mandate across a session restart', () => {
  it('a restarted session (different CLAUDE_CODE_SESSION_ID) still fires on a fresh mandate, and announces the inheritance', () => {
    const s = scaffold('restart-inherits')
    const now = Date.now()
    const restartedSessionId = 'session-after-restart'
    const originalSessionId = 'session-before-restart'
    // The RESTARTED session's own transcript — a fresh session has its own conversation file,
    // distinct from the one the original (now-dead) session was writing to.
    touch(transcriptPathFor(s.configDir, s.projectDir, restartedSessionId), now - 20 * 60_000)
    // The mandate was declared by a DIFFERENT session than the one polling now — simulating a
    // restart that minted a fresh CLAUDE_CODE_SESSION_ID while the marker (keyed on the project)
    // stayed put.
    writeMandate(s.mandatePath, originalSessionId, now - 45 * 60_000)
    writeQueue(s.queuePath, { at: now, open: 1, next: 'CARD-8 resume after restart' })

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: restartedSessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(result.armed).toContain('mandate=present(inherited)')
    expect(result.stdout).toContain('AUTONOMY WAKE:')
    expect(result.stdout).toContain('inherited from session session-before-restart')
    expect(result.stdout).toContain('mandate declared 45min ago')
  })

  it('a mandate older than the freshness window does NOT fire, and the banner says stale, not absent', () => {
    const s = scaffold('restart-stale')
    const now = Date.now()
    const restartedSessionId = 'session-yet-another-restart'
    touch(transcriptPathFor(s.configDir, s.projectDir, restartedSessionId), now - 20 * 60_000)
    // Declared 9 hours ago — past the default 8h freshness window. The human who declared this
    // has, by every reasonable reading, stopped caring; the marker must stop counting on its own.
    writeMandate(s.mandatePath, 'session-long-gone', now - 9 * 60 * 60_000)
    writeQueue(s.queuePath, { at: now, open: 1, next: 'CARD-9 should not wake anyone' })

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: restartedSessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(result.stdout).toBe('')
    expect(existsSync(s.markerPath)).toBe(false)
    expect(result.armed).toContain('mandate=stale(')
    expect(result.armed).not.toContain('mandate=absent')
    expect(result.armed).toContain('CANNOT FIRE')
  })

  it('a mandate stamped by the SAME session (own re-arm) fires with no inheritance wording — existing behaviour unchanged', () => {
    const s = scaffold('restart-own')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeMandate(s.mandatePath, s.sessionId, now - 5 * 60_000)
    writeQueue(s.queuePath, { at: now, open: 1, next: 'CARD-10 own session, own mandate' })

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(result.armed).toContain('mandate=present(own)')
    expect(result.stdout).toBe('AUTONOMY WAKE: idle session with mandate, 1 open, next: CARD-10 own session, own mandate')
    expect(result.stdout).not.toContain('inherited')
  })
})

// An unarmed watcher and a watcher with nothing to report produce the identical observation —
// nothing. That is the defect this monitor exists to remove elsewhere, and it had it itself: a
// reader could not tell "running and quiet because all is well" from "running and structurally
// unable to ever fire here". These lock the banner that separates the two.
describe('wt-autonomy-watch says whether it can actually fire', () => {
  it('always announces itself, even in a session with no mandate — the case a silent watcher hides', () => {
    const s = scaffold('armed-no-mandate')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeQueue(s.queuePath, { at: now, open: 2, next: 'CARD-2 implement watcher' })

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(result.armed).toContain('AUTONOMY WATCH ARMED:')
    expect(result.armed).toContain('mandate=absent')
    expect(result.armed).toContain('CANNOT FIRE')
    expect(result.stdout).toBe('')
  })

  it('does NOT claim it cannot fire when both preconditions are satisfied', () => {
    const s = scaffold('armed-ready')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeMandate(s.mandatePath, s.sessionId, now - 5 * 60_000)
    writeQueue(s.queuePath, { at: now, open: 2, next: 'CARD-2 implement watcher' })

    const result = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(result.armed).toContain('mandate=present')
    expect(result.armed).toContain('queue=fresh')
    expect(result.armed).not.toContain('CANNOT FIRE')
  })

  it('names a stale queue snapshot distinctly from an absent one — they need different actions', () => {
    const s = scaffold('armed-stale-queue')
    const now = Date.now()
    touch(s.transcriptPath, now - 20 * 60_000)
    writeMandate(s.mandatePath, s.sessionId, now - 5 * 60_000)
    writeQueue(s.queuePath, { at: now - 200 * 60_000, open: 2, next: 'CARD-2 implement watcher' })

    const stale = runWatch(s.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_SESSION_ID: s.sessionId,
      XDG_STATE_HOME: s.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(stale.armed).toContain('queue=stale')
    expect(stale.armed).toContain('CANNOT FIRE')
    expect(stale.stdout).toBe('')

    const s2 = scaffold('armed-absent-queue')
    touch(s2.transcriptPath, now - 20 * 60_000)
    writeMandate(s2.mandatePath, s2.sessionId, now - 5 * 60_000)

    const absent = runWatch(s2.projectDir, {
      ...process.env,
      CLAUDE_CONFIG_DIR: s2.configDir,
      CLAUDE_CODE_SESSION_ID: s2.sessionId,
      XDG_STATE_HOME: s2.stateHome,
      WT_AUTONOMY_WATCH_LANE_PATTERNS: 'definitely-no-match',
    })

    expect(absent.armed).toContain('queue=absent')
    expect(absent.armed).not.toContain('queue=stale')
  })
})

describe('monitors.json registers autonomy-watch', () => {
  it('lists autonomy-watch pointing at wt-autonomy-watch.mjs and armed unconditionally', () => {
    const monitors = JSON.parse(readFileSync(MONITORS_JSON, 'utf8')) as Array<{ name: string; command: string; when: string }>
    const entry = monitors.find((monitor) => monitor.name === 'autonomy-watch')
    expect(entry).toBeTruthy()
    expect(entry?.command).toContain('wt-autonomy-watch.mjs')
    expect(entry?.when).toBe('always')
  })
})
