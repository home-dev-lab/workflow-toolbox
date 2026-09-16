import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const EXPIRY = join(REPO_ROOT, 'plugin/bin/lib/queue-gate-marker-expiry.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stateDir() {
  const root = mkdtempSync(join(tmpdir(), 'wt-queue-gate-expiry-'))
  roots.push(root)
  const dir = join(root, 'state')
  const sessions = join(root, 'sessions')
  mkdirSync(dir)
  mkdirSync(sessions)
  return { dir, sessions }
}

function marker(dir: string, name: string, record: unknown) {
  const file = join(dir, name)
  writeFileSync(file, `${JSON.stringify(record)}\n`)
  return file
}

function invokeHelper(action: 'scan' | 'one', args: unknown, throwUnlink = false) {
  const program = `import { expireMarker, expireOwnedMarkers } from ${JSON.stringify(pathToFileURL(EXPIRY).href)};
const { action, args, throwUnlink } = JSON.parse(process.env.WT_MARKER_TEST);
const options = { ...(args.options || {}), ...(throwUnlink ? { unlinkSync: () => { throw new Error('read-only directory') } } : {}) };
const result = action === 'scan'
  ? expireOwnedMarkers(args.dir, args.kinds, args.now, options)
  : expireMarker(args.kind, args.file, args.now, options);
process.stdout.write(JSON.stringify({ ...result, error: result.error?.message }));`
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    encoding: 'utf8',
    env: { ...process.env, WT_MARKER_TEST: JSON.stringify({ action, args, throwUnlink }) },
  })
  if (run.status !== 0) throw new Error(run.stderr)
  return JSON.parse(run.stdout) as { expired: boolean; removed: boolean; unknown: string[]; error?: string }
}

describe('wt-queue-gate marker expiry', () => {
  it('removes every recognized expired kind in one bounded pass while preserving fresh and unknown records', () => {
    const { dir, sessions } = stateDir()
    const now = Date.now()
    const staleQueue = marker(dir, 'queue-project.json', { at: now - 121 * 60_000, open: 1, next: 'stale' })
    const staleMandate = marker(dir, 'engine-project.json', { declaredAtMs: now - 481 * 60_000, sessionId: 'old-session' })
    const staleCooldown = marker(dir, 'session-project-123456789abc.json', { lastBlockedAt: now - 46 * 60_000 })
    const staleEmission = marker(dir, 'autonomy-watch-dead-session.json', { transcriptMtimeMs: now, mandateDeclaredAtMs: now })
    const staleWatchState = marker(dir, 'autonomy-watch-mandate-dead-session.json', { observedAt: new Date(now).toISOString(), lastMandateKind: 'live' })
    const freshMandate = marker(dir, 'engine-fresh-project.json', { declaredAtMs: now - 5 * 60_000, sessionId: 'live-session' })
    const unknown = marker(dir, 'surprise.json', { keep: true })
    writeFileSync(join(sessions, 'live-session.jsonl'), '')
    const result = invokeHelper('scan', {
      dir,
      kinds: ['queue', 'mandate', 'cooldown', 'watch-emission', 'watch-mandate-state'],
      now,
      options: { sessionTranscriptDir: sessions },
    })

    for (const file of [staleQueue, staleMandate, staleCooldown, staleEmission, staleWatchState]) expect(existsSync(file)).toBe(false)
    expect(existsSync(freshMandate)).toBe(true)
    expect(existsSync(unknown)).toBe(true)
    expect(result.expired).toBe(5)
    expect(result.unknown).toContain('surprise.json')
  })

  it('keeps the reader verdict expired even when opportunistic removal fails', () => {
    const { dir } = stateDir()
    const now = Date.now()
    const queue = marker(dir, 'queue-project.json', { at: now - 121 * 60_000, open: 1, next: 'stale' })
    const result = invokeHelper('one', { kind: 'queue', file: queue, now }, true)

    expect(result.expired).toBe(true)
    expect(result.removed).toBe(false)
    expect(result.error).toBe('read-only directory')
    expect(existsSync(queue)).toBe(true)
  })

  it('uses a queue marker own window rather than deleting a fresh mandate beside it', () => {
    const { dir } = stateDir()
    const now = Date.now()
    const queue = marker(dir, 'queue-project.json', { at: now - 121 * 60_000, open: 1, next: 'stale' })
    const mandate = marker(dir, 'engine-project.json', { declaredAtMs: now - 5 * 60_000, sessionId: 'live-session' })
    invokeHelper('scan', { dir, kinds: ['queue', 'mandate'], now })

    expect(existsSync(queue)).toBe(false)
    expect(existsSync(mandate)).toBe(true)
  })
})
