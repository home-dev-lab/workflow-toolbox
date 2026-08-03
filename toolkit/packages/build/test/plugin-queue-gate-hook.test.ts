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

function slug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200)
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
