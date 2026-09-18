import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-actionable-gate-hook.mjs')
const CORE = join(REPO_ROOT, 'plugin/bin/lib/actionability-core.mjs')
const MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wt-actionable-${tag}-`)))
  roots.push(root)
  return root
}

function slug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}

function runHook(payload: unknown, env: NodeJS.ProcessEnv): { code: number | null; stderr: string; stdout: string } {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
  return {
    code: res.status,
    stderr: (res.stderr ?? '').trim(),
    stdout: (res.stdout ?? '').trim(),
  }
}

// The hook now emits its block text as stdout JSON (hookSpecificOutput.additionalContext, see
// wt-actionable-gate-hook.mjs main()) rather than on stderr with exit 2. This is the
// discriminator every test below uses in place of the old `code === 2` / non-empty-stderr check:
// blocked cases carry a non-empty additionalContext, passed cases carry ''. Malformed or
// fieldless stdout also returns '' rather than throwing, since a PASS case legitimately emits no
// stdout at all.
function blockText(r: { stdout: string }): string {
  if (!r.stdout) return ''
  try {
    const parsed = JSON.parse(r.stdout) as { hookSpecificOutput?: { additionalContext?: unknown } }
    const text = parsed?.hookSpecificOutput?.additionalContext
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

function systemMessage(r: { stdout: string }): string {
  if (!r.stdout) return ''
  try {
    const parsed = JSON.parse(r.stdout) as { systemMessage?: unknown }
    return typeof parsed?.systemMessage === 'string' ? parsed.systemMessage : ''
  } catch {
    return ''
  }
}

function writeLaneFixture(root: string, processes: unknown[] = []): string {
  const path = join(root, 'lane-fixture.json')
  writeFileSync(path, JSON.stringify({ hookPid: 100, processes }), 'utf8')
  return path
}

function scaffold(tag: string) {
  const root = mkRoot(tag)
  const home = join(root, 'home')
  const state = join(root, 'state')
  const transcripts = join(root, 'transcripts')
  const sessionId = `sess-${tag}`
  const transcriptPath = join(transcripts, `${sessionId}.jsonl`)
  const cwd = join(root, 'project')
  const mandateDir = join(state, 'wt-queue-gate')
  const mandatePath = join(mandateDir, `engine-${slug(cwd)}.json`)
  const laneFixturePath = writeLaneFixture(root)
  mkdirSync(home, { recursive: true })
  mkdirSync(state, { recursive: true })
  mkdirSync(transcripts, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(mandateDir, { recursive: true })
  writeFileSync(transcriptPath, '{}\n')
  writeFileSync(mandatePath, JSON.stringify({ declaredAtMs: Date.now(), sessionId }), 'utf8')
  return {
    root,
    sessionId,
    transcriptPath,
    cwd,
    stateDir: join(state, 'wt-actionable'),
    mandatePath,
    subagentsDir: join(transcripts, sessionId, 'subagents'),
    payload: { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: sessionId, cwd },
    // Every hook invocation gets an empty scanner fixture, so no test observes host processes.
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: undefined,
      CLAUDE_PLUGIN_DATA: undefined,
      HOME: home,
      XDG_STATE_HOME: state,
      WT_AUTONOMY_WATCH_MANDATE_DIR: mandateDir,
      WT_ACTIONABLE_LANE_FIXTURE_PATH: laneFixturePath,
    },
  }
}

function writeSnapshot(stateDir: string, cwd: string, snapshot: Record<string, unknown>) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, `${slug(cwd)}.json`), JSON.stringify(snapshot), 'utf8')
}

function writeProjectState(stateDir: string, cwd: string, state: Record<string, unknown>) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, `${slug(cwd)}.project-state.json`), JSON.stringify(state), 'utf8')
}

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  }
}

function runDecide(input: unknown): Record<string, unknown> {
  const script = [
    `import { decide } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
    `const result = decide(${JSON.stringify(input)})`,
    'process.stdout.write(JSON.stringify(result))',
  ].join('\n')
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(res.stderr || 'runDecide failed')
  return JSON.parse(res.stdout) as Record<string, unknown>
}

describe('actionability-core', () => {
  it('blocks while actionable work remains and nothing is running', () => {
    const now = Date.now()
    const decision = runDecide({
      now,
      staleAfterMs: 1_000,
      inFlight: false,
      mandateKind: 'live',
      consecutiveBlocks: 0,
      blockMax: 3,
      snapshot: {
        status: 'present',
        at: now,
        actionable: 3,
        next: 'CARD-1 do the thing',
        workPossible: true,
        reason: '',
        blockedUntil: null,
        inFlightUntil: null,
      },
    })
    expect(decision.block).toBe(true)
    expect(decision.reason).toBe('actionable-work-remains')
    expect(decision.nextConsecutiveBlocks).toBe(1)
  })

  it('goes silent for a live blocked claim with a reason', () => {
    const now = Date.now()
    const decision = runDecide({
      now,
      staleAfterMs: 1_000,
      inFlight: false,
      mandateKind: 'live',
      consecutiveBlocks: 2,
      blockMax: 3,
      snapshot: {
        status: 'present',
        at: now,
        actionable: 3,
        next: 'CARD-1 do the thing',
        workPossible: false,
        reason: 'quota window exhausted',
        blockedUntil: now + 60_000,
        inFlightUntil: null,
      },
    })
    expect(decision.block).toBe(false)
    expect(decision.nextConsecutiveBlocks).toBe(0)
  })

  it('goes silent for a live declared in-flight bound', () => {
    const now = Date.now()
    const decision = runDecide({
      now,
      staleAfterMs: 1_000,
      inFlight: false,
      mandateKind: 'live',
      consecutiveBlocks: 2,
      blockMax: 3,
      snapshot: {
        status: 'present',
        at: now,
        actionable: 3,
        next: 'CARD-2 external lane is working',
        workPossible: true,
        reason: '',
        blockedUntil: null,
        inFlightUntil: now + 60_000,
      },
    })
    expect(decision.block).toBe(false)
    expect(decision.nextConsecutiveBlocks).toBe(0)
  })

  it('a GENEROUS inFlightUntil written long ago is CAPPED from the snapshot write time, not from now', () => {
    // The failure this locks: a bound reaching far into the future silences the gate for its
    // whole length, however stale the snapshot that declared it has become. The bound must be
    // honoured only up to a cap measured from `at` (when it was WRITTEN), never from `now` —
    // otherwise a stale file re-derives a fresh window merely by being read.
    const now = Date.now()
    const writtenAt = now - 40 * 60_000 // snapshot written 40 minutes ago
    const decision = runDecide({
      now,
      staleAfterMs: 24 * 60 * 60_000, // not stale by the ordinary staleness check
      inFlight: false,
      mandateKind: 'live',
      consecutiveBlocks: 0,
      blockMax: 3,
      inFlightCapMs: 10 * 60_000,
      snapshot: {
        status: 'present',
        at: writtenAt,
        actionable: 3,
        next: 'CARD-9 generous bound written long ago',
        workPossible: true,
        reason: '',
        blockedUntil: null,
        inFlightUntil: writtenAt + 50 * 60_000, // 50 min window: still > now if taken at face value
      },
    })
    expect(decision.block).toBe(true)
    expect(decision.reason).toBe('actionable-work-remains')
  })

  it('a FRESH inFlightUntil within the cap stays silent', () => {
    const now = Date.now()
    const decision = runDecide({
      now,
      staleAfterMs: 24 * 60 * 60_000,
      inFlight: false,
      mandateKind: 'live',
      consecutiveBlocks: 2,
      blockMax: 3,
      inFlightCapMs: 10 * 60_000,
      snapshot: {
        status: 'present',
        at: now,
        actionable: 3,
        next: 'CARD-10 lane just declared',
        workPossible: true,
        reason: '',
        blockedUntil: null,
        inFlightUntil: now + 5 * 60_000,
      },
    })
    expect(decision.block).toBe(false)
    expect(decision.nextConsecutiveBlocks).toBe(0)
  })

  const holdSnapshots = {
    'snapshot-missing': { status: 'missing' },
    'snapshot-stale': {
      status: 'present', at: 1, actionable: 0, next: '', workPossible: true,
      reason: '', blockedUntil: null, inFlightUntil: null,
    },
    'actionable-work-remains': {
      status: 'present', at: 10_000, actionable: 1, next: 'CARD-1', workPossible: true,
      reason: '', blockedUntil: null, inFlightUntil: null,
    },
  } as const

  for (const mandateKind of ['absent', 'expired', 'unknown', 'live'] as const) {
    for (const [holdReason, snapshot] of Object.entries(holdSnapshots)) {
      it(`${mandateKind} mandate + ${holdReason}`, () => {
        const decision = runDecide({
          snapshot,
          now: 10_000,
          staleAfterMs: 1_000,
          mandateKind,
          consecutiveBlocks: 0,
          blockMax: 3,
        })
        expect(decision.block).toBe(mandateKind === 'unknown' || mandateKind === 'live')
        expect(decision.reason).toBe(mandateKind === 'unknown' || mandateKind === 'live' ? holdReason : '')
      })
    }
  }
})

describe('wt-actionable-gate-hook', () => {
  it('no snapshot ever written -> no block, no output', () => {
    const { env, payload } = scaffold('no-snapshot')
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('')
  })

  it('actionable:3, nothing in flight -> block', () => {
    const { env, payload, stateDir, cwd } = scaffold('blocks')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-42 fix the parser',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    const text = blockText(r)
    expect(text).toContain('3 actionable item(s) remain')
    expect(text).toContain('CARD-42 fix the parser')
    expect(text).toContain('Snapshot is less than 1 minute old')
    expect(text).toContain('Block 1 of 3')
  })

  it('a snapshot past the proposal bound reports count and age without naming a card', () => {
    const { env, payload, stateDir, cwd } = scaffold('proposal-stale')
    writeSnapshot(stateDir, cwd, {
      at: Date.now() - 20 * 60_000,
      actionable: 3,
      next: 'CARD-STALE was moved to Blocked',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })

    const result = runHook(payload, { ...env, WT_ACTIONABLE_PROPOSAL_MAX_AGE_MS: '600000' })
    const text = blockText(result)

    expect(result.code).toBe(0)
    expect(text).toContain('3 actionable item(s) remain')
    expect(text).toContain('Snapshot is 20 minutes old')
    expect(text).toContain('not proposing a card because the snapshot is stale')
    expect(text).not.toContain('CARD-STALE')
  })

  it('falls back from a non-numeric proposal bound instead of naming an old card', () => {
    const { env, payload, stateDir, cwd } = scaffold('proposal-invalid-bound')
    writeSnapshot(stateDir, cwd, {
      at: Date.now() - 60 * 60_000,
      actionable: 3,
      next: 'CARD-OLD',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })

    const text = blockText(runHook(payload, { ...env, WT_ACTIONABLE_PROPOSAL_MAX_AGE_MS: 'garbage' }))
    expect(text).toContain('3 actionable item(s) remain')
    expect(text).toContain('not proposing a card because the snapshot is stale')
    expect(text).not.toContain('CARD-OLD')
  })

  it('reports a future snapshot as unusable without dropping its count or refusal', () => {
    const { env, payload, stateDir, cwd } = scaffold('proposal-future')
    writeSnapshot(stateDir, cwd, {
      at: Date.now() + 24 * 60 * 60_000,
      actionable: 3,
      next: 'CARD-FUTURE',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })

    const text = blockText(runHook(payload, env))
    expect(text).toContain('3 actionable item(s) remain')
    expect(text).toContain('snapshot timestamp is in the future')
    expect(text).toContain('not proposing a card')
    expect(text).not.toContain('CARD-FUTURE')
  })

  it('actionable:3, work in flight -> no block, and the counter resets', () => {
    const { env, payload, stateDir, cwd, subagentsDir } = scaffold('inflight')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-43 keep going',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const first = runHook(payload, env)
    expect(first.code).toBe(0)
    expect(blockText(first)).toContain('actionable item(s) remain')
    mkdirSync(subagentsDir, { recursive: true })
    const subagent = join(subagentsDir, 'agent-a.jsonl')
    writeFileSync(subagent, '{}\n')
    const running = runHook(payload, env)
    expect(running.code).toBe(0)
    expect(blockText(running)).toBe('')
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(subagent, old, old)
    const again = runHook(payload, env)
    expect(again.code).toBe(0)
    expect(blockText(again)).toContain('Block 1 of 3')
  })

  it('actionable:0 -> no block, counter resets', () => {
    const { env, payload, stateDir, cwd } = scaffold('empty')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-44 prior item',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const first = runHook(payload, env)
    expect(first.code).toBe(0)
    expect(blockText(first)).toContain('actionable item(s) remain')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 0,
      next: '',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const drained = runHook(payload, env)
    expect(drained.code).toBe(0)
    expect(blockText(drained)).toBe('')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-45 back again',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const again = runHook(payload, env)
    expect(again.code).toBe(0)
    expect(blockText(again)).toContain('Block 1 of 3')
  })

  it('workPossible:false + reason + future blockedUntil -> no block', () => {
    const { env, payload, stateDir, cwd } = scaffold('blocked-future')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-46 blocked item',
      workPossible: false,
      reason: 'quota window exhausted',
      blockedUntil: Date.now() + 60_000,
      inFlightUntil: null,
    })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('workPossible:false + reason + past blockedUntil -> block', () => {
    const { env, payload, stateDir, cwd } = scaffold('blocked-past')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-47 blocked item',
      workPossible: false,
      reason: 'quota window exhausted',
      blockedUntil: Date.now() - 1_000,
      inFlightUntil: null,
    })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('CARD-47 blocked item')
  })

  it('workPossible:false with no reason -> block', () => {
    const { env, payload, stateDir, cwd } = scaffold('blocked-no-reason')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-48 blocked item',
      workPossible: false,
      reason: '',
      blockedUntil: Date.now() + 60_000,
      inFlightUntil: null,
    })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('CARD-48 blocked item')
  })

  it('live mandate + stale snapshot blocks exactly once and asks for a board refresh', () => {
    const { env, payload, stateDir, cwd } = scaffold('stale')
    writeSnapshot(stateDir, cwd, {
      at: Date.now() - (2 * 60 * 60 * 1000 + 1),
      actionable: 0,
      next: '',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    writeProjectState(stateDir, cwd, {
      optedIn: true,
      heartbeatAt: Date.now() - (2 * 60 * 60 * 1000 + 1),
      lastOutcome: 'snapshot-written',
    })
    const first = runHook(payload, env)
    const second = runHook(payload, env)
    expect(first.code).toBe(0)
    expect(blockText(first)).toContain('refresh the board snapshot')
    expect(blockText(first)).toContain('Block 1 of 1')
    expect(second.code).toBe(0)
    expect(blockText(second)).toBe('')
  })

  it('observed regression: no mandate + stale snapshot -> no block', () => {
    const { env, payload, stateDir, cwd, mandatePath } = scaffold('no-mandate-stale')
    rmSync(mandatePath, { force: true })
    writeSnapshot(stateDir, cwd, {
      at: Date.now() - (2 * 60 * 60 * 1000 + 1),
      actionable: 0,
      next: '',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    writeProjectState(stateDir, cwd, {
      optedIn: true,
      heartbeatAt: Date.now() - (2 * 60 * 60 * 1000 + 1),
      lastOutcome: 'snapshot-written',
    })

    const result = runHook(payload, env)

    expect(result.code).toBe(0)
    expect(blockText(result)).toBe('')
  })

  it('names a declared producer with no heartbeat and says to wire it', () => {
    const declaredButUnwired = scaffold('declared-but-unwired')
    writeProjectState(declaredButUnwired.stateDir, declaredButUnwired.cwd, { optedIn: true })
    const unwired = runHook(declaredButUnwired.payload, declaredButUnwired.env)
    expect(unwired.code).toBe(0)
    expect(blockText(unwired)).toContain('wire the producer')
  })

  it('names a stale producer heartbeat and asks for a board refresh', () => {
    const normalLag = scaffold('normal-lag')
    writeSnapshot(normalLag.stateDir, normalLag.cwd, {
      at: Date.now() - (2 * 60 * 60 * 1000 + 1),
      actionable: 0,
      next: '',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    writeProjectState(normalLag.stateDir, normalLag.cwd, {
      optedIn: true,
      heartbeatAt: Date.now() - (2 * 60 * 60 * 1000 + 1),
      lastOutcome: 'snapshot-written',
    })
    const lag = runHook(normalLag.payload, normalLag.env)
    expect(lag.code).toBe(0)
    expect(blockText(lag)).toContain('heartbeat is stale')
    expect(blockText(lag)).toContain('refresh the board snapshot')
  })

  it('an unreadable mandate keeps the hold legible instead of silently disabling it', () => {
    const { env, payload, stateDir, cwd, mandatePath } = scaffold('unknown-mandate')
    writeFileSync(mandatePath, '{', 'utf8')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(), actionable: 1, next: 'CARD-unknown', workPossible: true,
      reason: '', blockedUntil: null, inFlightUntil: null,
    })

    const result = runHook(payload, env)

    expect(blockText(result)).toContain('Autonomy mandate could not be read')
    expect(blockText(result)).toContain('CARD-unknown')
  })

  it('journals every block with its hold reason, mandate kind, and block index', () => {
    const { env, payload, root, stateDir, cwd } = scaffold('journal')
    const journalDir = join(root, 'journal')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(), actionable: 1, next: 'CARD-journal', workPossible: true,
      reason: '', blockedUntil: null, inFlightUntil: null,
    })

    const result = runHook(payload, { ...env, WT_GUARD_JOURNAL_DIR: journalDir })

    expect(blockText(result)).toContain('CARD-journal')
    const files = readdirSync(journalDir)
    expect(files).toHaveLength(1)
    const journalFile = files[0]
    if (!journalFile) throw new Error('journal file missing')
    const entries = readFileSync(join(journalDir, journalFile), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      guard: 'wt-actionable-gate-hook.mjs',
      decision: 'blocked',
      reason: 'actionable-work-remains',
      evidence: {
        holdReason: 'actionable-work-remains',
        mandateKind: 'live',
        blockIndex: '1',
      },
    })
  })

  it('names a fresh failed producer heartbeat and says to check the tracker', () => {
    const boardUnreachable = scaffold('board-unreachable')
    writeSnapshot(boardUnreachable.stateDir, boardUnreachable.cwd, {
      at: Date.now() - (2 * 60 * 60 * 1000 + 1),
      actionable: 0,
      next: '',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    writeProjectState(boardUnreachable.stateDir, boardUnreachable.cwd, {
      optedIn: true,
      heartbeatAt: Date.now(),
      lastOutcome: 'unreachable',
    })
    const unreachable = runHook(boardUnreachable.payload, boardUnreachable.env)
    expect(unreachable.code).toBe(0)
    expect(blockText(unreachable)).toContain('could not read the board')
    expect(blockText(unreachable)).toContain('check the tracker')
  })

  it('names a fresh first-read producer failure as a tracker problem, not an unwired producer', () => {
    const firstReadFailure = scaffold('first-read-failure')
    writeProjectState(firstReadFailure.stateDir, firstReadFailure.cwd, {
      optedIn: true,
      heartbeatAt: Date.now(),
      lastOutcome: 'unreachable',
    })

    const result = runHook(firstReadFailure.payload, firstReadFailure.env)

    expect(result.code).toBe(0)
    expect(blockText(result)).toContain('could not read the board')
    expect(blockText(result)).not.toContain('wire the producer')
  })

  it('names a fresh unavailable producer heartbeat as a tracker problem, not stale lag', () => {
    const unavailable = scaffold('fresh-unavailable')
    writeSnapshot(unavailable.stateDir, unavailable.cwd, {
      at: Date.now() - (2 * 60 * 60 * 1000 + 1),
      actionable: 0,
      next: '',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    writeProjectState(unavailable.stateDir, unavailable.cwd, {
      optedIn: true,
      heartbeatAt: Date.now(),
      lastOutcome: 'unavailable',
    })

    const result = runHook(unavailable.payload, unavailable.env)

    expect(result.code).toBe(0)
    expect(blockText(result)).toContain('check the tracker')
    expect(blockText(result)).not.toContain('heartbeat is stale')
  })

  it('does not guess when legacy snapshot evidence has no producer heartbeat', () => {
    const { env, payload, stateDir, cwd } = scaffold('legacy-unknown')
    writeSnapshot(stateDir, cwd, {
      at: Date.now() - (2 * 60 * 60 * 1000 + 1),
      actionable: 0,
      next: '',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const result = runHook(payload, env)
    expect(result.code).toBe(0)
    expect(blockText(result)).toContain('cannot be distinguished')
    expect(blockText(result)).toContain('check the tracker')
  })

  it('consecutive blocks reach the ceiling -> passes', () => {
    const { env, payload, stateDir, cwd } = scaffold('ceiling')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-49 ceiling item',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const r1 = runHook(payload, env)
    const r2 = runHook(payload, env)
    const r3 = runHook(payload, env)
    const r4 = runHook(payload, env)
    expect(r1.code).toBe(0)
    expect(blockText(r1)).toContain('actionable item(s) remain')
    expect(r2.code).toBe(0)
    expect(blockText(r2)).toContain('actionable item(s) remain')
    expect(r3.code).toBe(0)
    expect(blockText(r3)).toContain('actionable item(s) remain')
    expect(r4.code).toBe(0)
    expect(blockText(r4)).toBe('')
  })

  it('malformed JSON -> no block, but reports unknown snapshot age', () => {
    const { env, payload, stateDir, cwd } = scaffold('malformed')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, `${slug(cwd)}.json`), '{"at":', 'utf8')
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(blockText(r)).toBe('')
    expect(systemMessage(r)).toContain('snapshot is unreadable')
    expect(systemMessage(r)).toContain('age is unknown')
  })

  it('once opted in, deleting the snapshot blocks on the next stop', () => {
    const { env, payload, stateDir, cwd } = scaffold('missing-after-optin')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 1,
      next: 'CARD-50 seed opt-in',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    expect(runHook(payload, env).code).toBe(0)
    rmSync(join(stateDir, `${slug(cwd)}.json`), { force: true })
    const missing = runHook(payload, env)
    expect(missing.code).toBe(0)
    expect(blockText(missing)).toContain('wire the producer')
    expect(blockText(missing)).toContain('snapshot is missing; age is unknown')
  })

  it('reads only subagent mtimes, not the main transcript touched by the turn', () => {
    const { env, payload, stateDir, cwd, transcriptPath } = scaffold('subagents-only')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 2,
      next: 'CARD-51 do the next thing',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    utimesSync(transcriptPath, new Date(), new Date())
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('actionable item(s) remain')
  })

  it('future inFlightUntil -> no block, and the counter resets', () => {
    const { env, payload, stateDir, cwd } = scaffold('declared-inflight-future')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-52 external lane running',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    expect(runHook(payload, env).code).toBe(0)
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-52 external lane running',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: Date.now() + 60_000,
    })
    const running = runHook(payload, env)
    expect(running.code).toBe(0)
    expect(blockText(running)).toBe('')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-52 external lane running',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const again = runHook(payload, env)
    expect(again.code).toBe(0)
    expect(blockText(again)).toContain('Block 1 of 3')
  })

  it('expired inFlightUntil -> block', () => {
    const { env, payload, stateDir, cwd } = scaffold('declared-inflight-expired')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-53 external lane expired',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: Date.now() - 1_000,
    })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('CARD-53 external lane expired')
  })

  it('a generous inFlightUntil written long ago is capped and the hook blocks anyway', () => {
    const { env, payload, stateDir, cwd } = scaffold('declared-inflight-capped')
    const writtenAt = Date.now() - 40 * 60_000
    writeSnapshot(stateDir, cwd, {
      at: writtenAt,
      actionable: 3,
      next: 'CARD-54 generous bound written long ago',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: writtenAt + 50 * 60_000,
    })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('3 actionable item(s) remain')
    expect(blockText(r)).toContain('Snapshot is 40 minutes old')
    expect(blockText(r)).not.toContain('CARD-54 generous bound written long ago')
  })

  it('a lane of this session detected by ancestry + cwd -> no block, and the counter resets', () => {
    const { env, payload, root, stateDir, cwd } = scaffold('lane-detected')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-54 external lane detected',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    expect(runHook(payload, env).code).toBe(0)
    const pattern = 'wt-actionable-test same-session lane'
    writeLaneFixture(root, [
      { pid: 100, ppid: 90, cwd, command: 'hook', patterns: [] },
      { pid: 90, ppid: 1, cwd, command: 'parent', patterns: [] },
      { pid: 200, ppid: 90, cwd, command: pattern, patterns: [pattern] },
    ])
    const running = runHook(payload, {
      ...env,
      WT_ACTIONABLE_LANE_PATTERNS: pattern,
    })
    expect(running.code).toBe(0)
    expect(blockText(running)).toBe('')
    const again = runHook(payload, {
      ...env,
      WT_ACTIONABLE_LANE_PATTERNS: 'wt-actionable-test no-match lane',
    })
    expect(again.code).toBe(0)
    expect(blockText(again)).toContain('Block 1 of 3')
  })

  it('blinding the matcher still blocks, proving the gate did not merely stay quiet', () => {
    const { env, payload, root, stateDir, cwd } = scaffold('lane-blinded')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 2,
      next: 'CARD-55 blinded matcher',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const pattern = 'wt-actionable-test blinded matcher lane'
    writeLaneFixture(root, [
      { pid: 100, ppid: 90, cwd, command: 'hook', patterns: [] },
      { pid: 90, ppid: 1, cwd, command: 'parent', patterns: [] },
      { pid: 200, ppid: 90, cwd, command: pattern, patterns: [pattern] },
    ])
    const r = runHook(payload, {
      ...env,
      WT_ACTIONABLE_LANE_PATTERNS: 'wt-actionable-test definitely-no-match lane',
    })
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('CARD-55 blinded matcher')
  })

  it('a lane from another session is not counted as this session\'s work', () => {
    const { env, payload, root, stateDir, cwd } = scaffold('lane-other-session')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 2,
      next: 'CARD-56 other session lane',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const pattern = 'wt-actionable-test detached lane'
    writeLaneFixture(root, [
      { pid: 100, ppid: 90, cwd, command: 'hook', patterns: [] },
      { pid: 90, ppid: 1, cwd, command: 'this-session parent', patterns: [] },
      { pid: 200, ppid: 300, cwd, command: pattern, patterns: [pattern] },
      { pid: 300, ppid: 1, cwd, command: 'other-session parent', patterns: [] },
    ])
    const r = runHook(payload, {
      ...env,
      WT_ACTIONABLE_LANE_PATTERNS: pattern,
    })
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('CARD-56 other session lane')
  })

  it('platform gap falls back to transcript + declared bound without throwing or claiming a lane', () => {
    const { env, payload, stateDir, cwd } = scaffold('lane-unsupported')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 2,
      next: 'CARD-57 unsupported platform',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const pattern = 'wt-actionable-test unsupported mode lane'
    const blocked = runHook(payload, {
      ...env,
      WT_ACTIONABLE_LANE_DETECTION_MODE: 'unsupported',
      WT_ACTIONABLE_LANE_PATTERNS: pattern,
    })
    expect(blocked.code).toBe(0)
    expect(blockText(blocked)).toContain('CARD-57 unsupported platform')

    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 2,
      next: 'CARD-57 unsupported platform',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: Date.now() + 60_000,
    })
    const fallback = runHook(payload, {
      ...env,
      WT_ACTIONABLE_LANE_DETECTION_MODE: 'unsupported',
      WT_ACTIONABLE_LANE_PATTERNS: pattern,
    })
    expect(fallback.code).toBe(0)
    expect(blockText(fallback)).toBe('')
  })

  it('a lane detection error falls back to transcript + declared bound and names the error', () => {
    const { env, payload, root, stateDir, cwd } = scaffold('lane-detection-error')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 2,
      next: 'CARD-58 lane detection error',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const fixturePath = join(root, 'lane-fixture.json')
    writeFileSync(fixturePath, '{', 'utf8')

    const result = runHook(payload, {
      ...env,
    })

    expect(result.code).toBe(0)
    const text = blockText(result)
    expect(text).toContain('CARD-58 lane detection error')
    expect(text).toContain('lane detection unavailable: lane fixture:')
  })

  it('uses the scanner fixture without invoking pgrep', () => {
    const { env, payload, root, stateDir, cwd } = scaffold('lane-fixture-lock')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(), actionable: 1, next: 'CARD-59 fixture lock', workPossible: true,
      reason: '', blockedUntil: null, inFlightUntil: null,
    })
    const pattern = 'wt-actionable-test fixture lock lane'
    writeLaneFixture(root, [
      { pid: 100, ppid: 90, cwd, command: 'hook', patterns: [] },
      { pid: 90, ppid: 1, cwd, command: 'parent', patterns: [] },
      { pid: 200, ppid: 90, cwd, command: pattern, patterns: [pattern] },
    ])
    const shimDir = join(root, 'bin')
    const sentinel = join(root, 'pgrep-called')
    mkdirSync(shimDir, { recursive: true })
    const pgrepShim = join(shimDir, 'pgrep')
    writeFileSync(pgrepShim, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nexit 2\n`, 'utf8')
    chmodSync(pgrepShim, 0o755)

    const result = runHook(payload, {
      ...env,
      PATH: shimDir,
      WT_ACTIONABLE_LANE_PATTERNS: pattern,
    })

    expect(result.code).toBe(0)
    expect(blockText(result)).toBe('')
    expect(existsSync(sentinel)).toBe(false)
  })

  it('the emitted additionalContext is exactly one line', () => {
    const { env, payload, stateDir, cwd } = scaffold('length-lock')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-58 length lock',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    const r = runHook(payload, env)
    const text = blockText(r)
    expect(text).not.toBe('')
    expect(text.split('\n')).toHaveLength(1)
  })
})

describe('plugin manifest wiring', () => {
  it('registers wt-actionable-gate-hook.mjs on Stop', () => {
    const stopHooks = readManifest().hooks?.Stop ?? []
    const commands = stopHooks.flatMap((group) => group.hooks ?? []).map((hook) => hook.command ?? '')
    expect(commands).toEqual([
      'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-stop-hook.mjs"',
      'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-registry-heartbeat-hook.mjs"',
      'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-actionable-gate-hook.mjs"',
      'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-queue-not-empty-gate-hook.mjs"',
      'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-lesson-harvest-hook.mjs"',
      'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-escalation-journal-hook.mjs"',
    ])
  })
})

describe('actionability decide() — bounded under a stale snapshot with no usable timestamp', () => {
  it('a live mandate with a non-finite snapshot time stops blocking after the ceiling, never forever', () => {
    const now = Date.now()
    let consecutiveBlocks = 0
    let staleSnapshotAt: number | null = null
    const blocks: boolean[] = []
    for (let i = 0; i < 5; i += 1) {
      const decision = runDecide({
        // `at: null` survives JSON and is the non-finite case the core must bound.
        snapshot: { status: 'present', at: null, actionable: 0, next: '', workPossible: true, reason: '', blockedUntil: null, inFlightUntil: null },
        now,
        staleAfterMs: 2 * 60 * 60 * 1000,
        mandateKind: 'live',
        consecutiveBlocks,
        staleSnapshotAt,
        blockMax: 3,
      })
      blocks.push(decision.block === true)
      consecutiveBlocks = Number(decision.nextConsecutiveBlocks)
      staleSnapshotAt = typeof decision.staleSnapshotAt === 'number' ? decision.staleSnapshotAt : staleSnapshotAt
    }
    expect(blocks).toEqual([true, true, true, false, false])
  })

  it('an omitted mandate kind fails closed: it keeps the protection instead of disabling the gate', () => {
    const now = Date.now()
    const decision = runDecide({
      snapshot: { status: 'present', at: now, actionable: 2, next: 'card', workPossible: true, reason: '', blockedUntil: null, inFlightUntil: null },
      now,
      staleAfterMs: 2 * 60 * 60 * 1000,
    })
    expect(decision.block).toBe(true)
  })
})
