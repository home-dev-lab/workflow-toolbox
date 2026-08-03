// plugin-queue-gate-hook.test.ts — behavior gates for the hand-written Stop hook
// plugin/bin/wt-queue-not-empty-gate-hook.mjs (a shipped, tracker-agnostic port of a
// private, single-project original). Drives the REAL hook script as a child process
// with a crafted stdin payload and asserts exit code + stderr — the "closest to real"
// option, where a wiring regression hides.
//
// The one property that DECIDES whether this hook is safe to ship (card
// 1833094164359677860): an adopter who never wires anything to write the queue
// snapshot must see this hook do NOTHING, forever — never a block they cannot satisfy.
// That case gets its own describe block and is asserted first.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-queue-not-empty-gate-hook.mjs')

interface Run {
  code: number | null
  stderr: string
}
function runHook(payload: unknown, env: NodeJS.ProcessEnv): Run {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
  return { code: res.status, stderr: (res.stderr ?? '').trim() }
}

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function mkRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `wt-queue-gate-${tag}-`))
  roots.push(r)
  return r
}

// Builds the (transcriptPath, sessionId, cwd, gateDir) tuple every case needs, plus the
// env the hook reads WT_QUEUE_GATE_DIR from (isolated per test — never the real
// ~/.local/state/wt-queue-gate, which would leak state across test runs and across a
// developer's real sessions).
function scaffold(tag: string) {
  const root = mkRoot(tag)
  const sessionId = 'sess-' + tag
  const transcriptDir = join(root, 'transcripts')
  mkdirSync(transcriptDir, { recursive: true })
  const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`)
  writeFileSync(transcriptPath, '{}\n')
  const cwd = join(root, 'project')
  mkdirSync(cwd, { recursive: true })
  const gateDir = join(root, 'gate-state')
  const subagentsDir = join(transcriptDir, sessionId, 'subagents')
  const env = { ...process.env, WT_QUEUE_GATE_DIR: gateDir }
  const payload = { transcript_path: transcriptPath, session_id: sessionId, cwd }
  return { root, sessionId, cwd, gateDir, subagentsDir, env, payload }
}

// Mirrors the hook's OWN projectSlug() exactly (readable prefix + hash of the full cwd) — a
// naive readable-only slug is what let two different cwds collide on the same snapshot
// filename (cross-family review finding, fixed in the hook alongside this test).
function slug(cwd: string): string {
  const readable = cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 12)
  return `${readable}-${hash}`
}
function writeSnapshot(gateDir: string, cwd: string, open: number, atMsAgo = 0, next = 'next item') {
  mkdirSync(gateDir, { recursive: true })
  writeFileSync(
    join(gateDir, `queue-${slug(cwd)}.json`),
    JSON.stringify({ open, at: Date.now() - atMsAgo, next }),
  )
}

describe('wt-queue-not-empty-gate-hook — the case that decides whether this ships', () => {
  it('NO TRACKER: no snapshot ever written ⇒ silent, even with work-shaped state elsewhere', () => {
    const { env, payload } = scaffold('no-tracker')
    // No queue-*.json written at all — this project structurally has no tracker convention
    // wired to this guard. Must be silent unconditionally, however long since anything ran.
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })
})

describe('wt-queue-not-empty-gate-hook — the four behaviours with a tracker wired', () => {
  it('work remains + nothing running ⇒ blocks (exit 2) with a stated queue count', () => {
    const { env, payload, gateDir, cwd } = scaffold('blocks')
    writeSnapshot(gateDir, cwd, 7, 0, 'card #42 (the thing)')
    const r = runHook(payload, env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('7 open item')
    expect(r.stderr).toContain('card #42')
  })

  it('something running (recent subagent transcript) ⇒ silent even though work remains', () => {
    const { env, payload, gateDir, cwd, subagentsDir } = scaffold('inflight')
    writeSnapshot(gateDir, cwd, 3, 0)
    mkdirSync(subagentsDir, { recursive: true })
    writeFileSync(join(subagentsDir, 'agent-x.jsonl'), '{}\n') // fresh mtime = just written
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('queue genuinely empty (fresh snapshot, open:0) ⇒ silent', () => {
    const { env, payload, gateDir, cwd } = scaffold('empty')
    writeSnapshot(gateDir, cwd, 0)
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('second stop within the cooldown window ⇒ passes even though work still remains', () => {
    const { env, payload, gateDir, cwd } = scaffold('cooldown')
    writeSnapshot(gateDir, cwd, 5, 0)
    const first = runHook(payload, env)
    expect(first.code).toBe(2) // first stop still blocks
    const second = runHook(payload, env)
    expect(second.code).toBe(0) // same session, inside the 45-min cooldown ⇒ silent
    expect(second.stderr).toBe('')
  })
})

describe('wt-queue-not-empty-gate-hook — fail-closed and fail-open edges', () => {
  it('snapshot present but STALE (older than 120 min) ⇒ treated as work remains ⇒ blocks', () => {
    const { env, payload, gateDir, cwd } = scaffold('stale')
    writeSnapshot(gateDir, cwd, 0, 130 * 60_000) // open:0 but 130 min old — past the freshness window
    const r = runHook(payload, env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('UNKNOWN state')
  })

  it('missing transcript_path ⇒ fails open (silent), never blocks on its own malfunction', () => {
    const { env, gateDir, cwd } = scaffold('badinput')
    writeSnapshot(gateDir, cwd, 9, 0)
    const r = runHook({ session_id: 'x', cwd }, env) // no transcript_path at all
    expect(r.code).toBe(0)
  })
})

// --- Test-locks for the two findings a cross-family review surfaced on the diff -----------

describe('wt-queue-not-empty-gate-hook — cross-family review finding: malformed open coerces to 0', () => {
  it('fresh snapshot with a non-numeric "open" ⇒ NOT treated as empty ⇒ blocks (fail-closed)', () => {
    const { env, payload, gateDir, cwd } = scaffold('malformed-open')
    mkdirSync(gateDir, { recursive: true })
    // A naive `Number(snap.open)` coerces "" (and null, false) to 0, which would silently read
    // as "queue empty" and bail — the exact fail-OPEN this section exists to prevent. Only a
    // real number may silence the guard.
    writeFileSync(
      join(gateDir, `queue-${slug(cwd)}.json`),
      JSON.stringify({ open: '', at: Date.now(), next: 'card #9' }),
    )
    const r = runHook(payload, env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('UNKNOWN state')
  })
})

describe('wt-queue-not-empty-gate-hook — card 1833578371640984633: work-possible signal', () => {
  // The discriminating case, per the card: budget EXHAUSTED / context SATURATED → silent;
  // budget LOW BUT NOT ZERO → still shouts. All five cases below use the SAME base fixture
  // (open:5, fresh, nothing in flight) that the first test in this file already proves blocks —
  // only the work-possible fields differ, so a passing "silent" case here is a genuine control:
  // remove the fields and the fixture reverts to case 1's proven-blocking shape.
  it('workPossible:false + workBlockedUntil in the FUTURE ⇒ silent even though work remains', () => {
    const { env, payload, gateDir, cwd } = scaffold('blocked-future')
    mkdirSync(gateDir, { recursive: true })
    writeFileSync(
      join(gateDir, `queue-${slug(cwd)}.json`),
      JSON.stringify({
        open: 5,
        at: Date.now(),
        next: 'card #1',
        workPossible: false,
        workBlockedUntil: Date.now() + 3_600_000,
      }),
    )
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('workBlockedUntil in the PAST ⇒ block resumes (self-expiring, not a permanent silence)', () => {
    const { env, payload, gateDir, cwd } = scaffold('blocked-past')
    mkdirSync(gateDir, { recursive: true })
    writeFileSync(
      join(gateDir, `queue-${slug(cwd)}.json`),
      JSON.stringify({
        open: 5,
        at: Date.now(),
        next: 'card #1',
        workPossible: false,
        workBlockedUntil: Date.now() - 1_000,
      }),
    )
    const r = runHook(payload, env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('5 open item')
  })

  it('workPossible:false with NO workBlockedUntil ⇒ malformed, fails CLOSED (still blocks)', () => {
    const { env, payload, gateDir, cwd } = scaffold('blocked-no-deadline')
    mkdirSync(gateDir, { recursive: true })
    writeFileSync(
      join(gateDir, `queue-${slug(cwd)}.json`),
      JSON.stringify({ open: 5, at: Date.now(), next: 'card #1', workPossible: false }),
    )
    const r = runHook(payload, env)
    expect(r.code).toBe(2)
  })

  it('workBlockedUntil present but workPossible is NOT false ⇒ the deadline alone does nothing', () => {
    const { env, payload, gateDir, cwd } = scaffold('deadline-without-flag')
    mkdirSync(gateDir, { recursive: true })
    writeFileSync(
      join(gateDir, `queue-${slug(cwd)}.json`),
      JSON.stringify({
        open: 5,
        at: Date.now(),
        next: 'card #1',
        workBlockedUntil: Date.now() + 3_600_000,
      }),
    )
    const r = runHook(payload, env)
    expect(r.code).toBe(2)
  })

  it('the discriminating case — LOW but nonzero, no work-possible fields set ⇒ still shouts', () => {
    const { env, payload, gateDir, cwd } = scaffold('low-not-zero')
    writeSnapshot(gateDir, cwd, 1, 0, 'card #9 (last one)')
    const r = runHook(payload, env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('1 open item')
  })

  // The two locks below close a gap a cross-family review found: the five tests above prove the
  // FIELDS work when present in their documented shape, but none of them prove the check is
  // STRICTLY typed rather than coercive — a looser `Number(until)` or truthy check would satisfy
  // every test above just as well while wrongly silencing on a numeric STRING deadline.
  it('workBlockedUntil as a numeric STRING (not a number) ⇒ fails the strict typeof check, still blocks', () => {
    const { env, payload, gateDir, cwd } = scaffold('deadline-is-a-string')
    mkdirSync(gateDir, { recursive: true })
    writeFileSync(
      join(gateDir, `queue-${slug(cwd)}.json`),
      JSON.stringify({
        open: 5,
        at: Date.now(),
        next: 'card #1',
        workPossible: false,
        workBlockedUntil: String(Date.now() + 3_600_000), // e.g. "1785791955480" — a STRING
      }),
    )
    const r = runHook(payload, env)
    expect(r.code).toBe(2)
  })

  it('workBlockedUntil set to "now" at write time ⇒ already past by the time the hook reads it, blocks', () => {
    const { env, payload, gateDir, cwd } = scaffold('deadline-boundary')
    mkdirSync(gateDir, { recursive: true })
    writeFileSync(
      join(gateDir, `queue-${slug(cwd)}.json`),
      JSON.stringify({ open: 5, at: Date.now(), next: 'card #1', workPossible: false, workBlockedUntil: Date.now() }),
    )
    const r = runHook(payload, env) // strict `<`, and real wall-clock time has moved on by now
    expect(r.code).toBe(2)
  })
})

describe('wt-queue-not-empty-gate-hook — cross-family review finding: project-slug collision', () => {
  it('two cwds that collide on the READABLE-ONLY slug never share a snapshot', () => {
    // "/…/a/b" and "/…/a-b" both reduce to the same string once every non-alnum character
    // becomes "-" — the exact collision shape found by review. The hash suffix in the real
    // projectSlug() (and mirrored in slug() above) must keep them on separate files.
    const root = mkRoot('collide')
    const gateDir = join(root, 'gate-state')
    const cwdA = join(root, 'a', 'b')
    const cwdB = join(root, 'a-b')
    expect(slug(cwdA)).not.toBe(slug(cwdB)) // the fix, asserted directly
    writeSnapshot(gateDir, cwdA, 9, 0, 'card #1 (project A)') // project A: work remains

    const transcriptDir = join(root, 'transcripts')
    mkdirSync(transcriptDir, { recursive: true })
    const sessionId = 'sess-collide-b'
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, '{}\n')
    const env = { ...process.env, WT_QUEUE_GATE_DIR: gateDir }
    // Project B never wrote its own snapshot — must be silent, even though project A's
    // snapshot (claiming work remains) sits in the same state dir.
    const r = runHook({ transcript_path: transcriptPath, session_id: sessionId, cwd: cwdB }, env)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })
})
