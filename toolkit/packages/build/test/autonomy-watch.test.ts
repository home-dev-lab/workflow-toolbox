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
  const mandatePath = join(stateDir, `engine-${sessionId}.json`)
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
    touch(s.mandatePath, now - 5 * 60_000)
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
    touch(s.mandatePath, now - 5 * 60_000)
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
    touch(missing.mandatePath, now - 5 * 60_000)
    touch(stale.transcriptPath, now - 20 * 60_000)
    touch(stale.mandatePath, now - 5 * 60_000)
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
    touch(s.mandatePath, now - 5 * 60_000)
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
    touch(s.mandatePath, now - 5 * 60_000)
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
    touch(s.mandatePath, now - 5 * 60_000)
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
    touch(s.mandatePath, now - 5 * 60_000)
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
    touch(s2.mandatePath, now - 5 * 60_000)

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
