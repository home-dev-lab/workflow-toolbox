import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-actionable-gate-hook.mjs')
const CORE = join(REPO_ROOT, 'plugin/bin/lib/actionability-core.mjs')
const MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const roots: string[] = []
const laneProcesses: Array<{ pid: number; detached: boolean }> = []

afterEach(() => {
  for (const lane of laneProcesses.splice(0)) {
    try {
      process.kill(lane.pid, 'SIGKILL')
    } catch {
      // Already exited.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wt-actionable-${tag}-`))
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

function launchLane(args0: string, cwd: string, detached = false): number {
  const child = spawn('bash', ['-lc', `exec -a ${JSON.stringify(args0)} sleep 30`], {
    cwd,
    detached,
    stdio: detached ? 'ignore' : 'pipe',
  })
  if (detached) child.unref()
  if (!child.pid) throw new Error('lane did not start')
  laneProcesses.push({ pid: child.pid, detached })
  return child.pid
}

function launchDetachedLaneViaHelper(args0: string, cwd: string): void {
  const helper = spawnSync(
    'bash',
    ['-lc', `bash -lc 'exec -a ${JSON.stringify(args0)} sleep 30' >/dev/null 2>&1 &`],
    { cwd, encoding: 'utf8' },
  )
  if (helper.status !== 0) throw new Error(helper.stderr || 'detached lane helper failed')
  const pidLookup = spawnSync('pgrep', ['-f', args0], { encoding: 'utf8' })
  const pid = (pidLookup.stdout || '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .find((value) => Number.isInteger(value) && value > 0)
  if (!pid) throw new Error('detached lane pid lookup failed')
  laneProcesses.push({ pid, detached: true })
}

function scaffold(tag: string) {
  const root = mkRoot(tag)
  const home = join(root, 'home')
  const state = join(root, 'state')
  const transcripts = join(root, 'transcripts')
  const sessionId = `sess-${tag}`
  const transcriptPath = join(transcripts, `${sessionId}.jsonl`)
  const cwd = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(state, { recursive: true })
  mkdirSync(transcripts, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(transcriptPath, '{}\n')
  return {
    root,
    sessionId,
    transcriptPath,
    cwd,
    stateDir: join(state, 'wt-actionable'),
    subagentsDir: join(transcripts, sessionId, 'subagents'),
    payload: { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: sessionId, cwd },
    env: { ...process.env, HOME: home, XDG_STATE_HOME: state },
  }
}

function writeSnapshot(stateDir: string, cwd: string, snapshot: Record<string, unknown>) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, `${slug(cwd)}.json`), JSON.stringify(snapshot), 'utf8')
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
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('3 actionable item(s) remain')
    expect(r.stderr).toContain('CARD-42 fix the parser')
    expect(r.stderr).toContain('Block 1 of 3')
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
    expect(first.code).toBe(2)
    mkdirSync(subagentsDir, { recursive: true })
    const subagent = join(subagentsDir, 'agent-a.jsonl')
    writeFileSync(subagent, '{}\n')
    const running = runHook(payload, env)
    expect(running.code).toBe(0)
    expect(running.stderr).toBe('')
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(subagent, old, old)
    const again = runHook(payload, env)
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('Block 1 of 3')
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
    expect(first.code).toBe(2)
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
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('Block 1 of 3')
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
    expect(r.stderr).toBe('')
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
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('CARD-47 blocked item')
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
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('CARD-48 blocked item')
  })

  it('snapshot older than the staleness bound -> block', () => {
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
    const r = runHook(payload, env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Actionable count is UNKNOWN')
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
    expect(r1.code).toBe(2)
    expect(r2.code).toBe(2)
    expect(r3.code).toBe(2)
    expect(r4.code).toBe(0)
    expect(r4.stderr).toBe('')
  })

  it('malformed JSON -> no block, no throw', () => {
    const { env, payload, stateDir, cwd } = scaffold('malformed')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, `${slug(cwd)}.json`), '{"at":', 'utf8')
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
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
    expect(runHook(payload, env).code).toBe(2)
    rmSync(join(stateDir, `${slug(cwd)}.json`), { force: true })
    const missing = runHook(payload, env)
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('Actionable count is UNKNOWN')
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
    expect(r.code).toBe(2)
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
    expect(runHook(payload, env).code).toBe(2)
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
    expect(running.stderr).toBe('')
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
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('Block 1 of 3')
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
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('CARD-53 external lane expired')
  })

  it('a lane of this session detected by ancestry + cwd -> no block, and the counter resets', () => {
    const { env, payload, stateDir, cwd } = scaffold('lane-detected')
    writeSnapshot(stateDir, cwd, {
      at: Date.now(),
      actionable: 3,
      next: 'CARD-54 external lane detected',
      workPossible: true,
      reason: '',
      blockedUntil: null,
      inFlightUntil: null,
    })
    expect(runHook(payload, env).code).toBe(2)
    const pattern = 'wt-actionable-test same-session lane'
    launchLane(pattern, cwd)
    const running = runHook(payload, { ...env, WT_ACTIONABLE_LANE_PATTERNS: pattern })
    expect(running.code).toBe(0)
    expect(running.stderr).toBe('')
    const again = runHook(payload, { ...env, WT_ACTIONABLE_LANE_PATTERNS: 'wt-actionable-test no-match lane' })
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('Block 1 of 3')
  })

  it('blinding the matcher still blocks, proving the gate did not merely stay quiet', () => {
    const { env, payload, stateDir, cwd } = scaffold('lane-blinded')
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
    launchLane(pattern, cwd)
    const r = runHook(payload, { ...env, WT_ACTIONABLE_LANE_PATTERNS: 'wt-actionable-test definitely-no-match lane' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('CARD-55 blinded matcher')
  })

  it('a lane from another session is not counted as this session\'s work', () => {
    const { env, payload, stateDir, cwd } = scaffold('lane-other-session')
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
    launchDetachedLaneViaHelper(pattern, cwd)
    const r = runHook(payload, { ...env, WT_ACTIONABLE_LANE_PATTERNS: pattern })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('CARD-56 other session lane')
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
    launchLane(pattern, cwd)
    const blocked = runHook(payload, {
      ...env,
      WT_ACTIONABLE_LANE_DETECTION_MODE: 'unsupported',
      WT_ACTIONABLE_LANE_PATTERNS: pattern,
    })
    expect(blocked.code).toBe(2)
    expect(blocked.stderr).toContain('CARD-57 unsupported platform')

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
    expect(fallback.stderr).toBe('')
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
    ])
  })
})
