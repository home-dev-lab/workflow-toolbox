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

async function runIdleRegistryScenario(records: unknown[], runForMs = 11_000): Promise<string> {
  const root = tmpRoot('wt-idle-registry-watch')
  const home = path.join(root, 'home')
  const configDir = path.join(root, 'config')
  const projectDir = path.join(root, 'project')
  const stateDir = path.join(root, 'registry')
  const sessionId = 'idle-session'
  const subagentsDir = path.join(configDir, 'projects', projectSlug(projectDir), sessionId, 'subagents')
  mkdirSync(home, { recursive: true })
  mkdirSync(subagentsDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  touchFile(path.join(subagentsDir, 'agent-idle.jsonl'), Date.now())
  writeFileSync(path.join(stateDir, `${sessionId}.jsonl`), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)

  const child = spawn(process.execPath, [ARC_WATCH, '--project', projectDir, '--poll', '5'], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_SESSION_ID: sessionId,
      WT_OUTBOUND_GUARD_DIR: stateDir,
      WT_LIVENESS_DIR: path.join(root, 'missing-liveness-dir'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawned.push(child)

  return await new Promise<string>((resolve, reject) => {
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      if (child.exitCode !== null || child.signalCode !== null) resolve(stdout)
      else child.once('exit', () => resolve(stdout))
    }, runForMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stdout += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', () => clearTimeout(timer))
  })
}

type WatchPaths = { transcriptPath: string, metaPath: string }
type WatchCondition = { readonly description: string, readonly complete: boolean, test: (stdout: string) => boolean }
type WatchLineStep = { line: string | RegExp, after?: () => void }

function emittedLineSequence(name: string, steps: WatchLineStep[]): WatchCondition {
  let consumed = 0
  let next = 0
  return {
    get description() { return `${name}: ${steps[next]?.line ?? 'sequence completion'}` },
    get complete() { return next === steps.length },
    test(stdout) {
      const lines = stdout.split('\n')
      // Leave a partial final line for the next stdout chunk.
      while (consumed < lines.length - 1) {
        const line = lines[consumed++]!
        const step = steps[next]
        if (!step) break
        const matches = typeof step.line === 'string' ? line === step.line : step.line.test(line)
        if (!matches) continue
        next++
        step.after?.()
      }
      return next === steps.length
    },
  }
}

async function runWatchSequence(options: WatchScenarioOptions & { waitFor: WatchCondition }): Promise<string> {
  const stdout = await runWatchScenario(options)
  expect(options.waitFor.complete, `Missing watcher condition: ${options.waitFor.description}\n${stdout}`).toBe(true)
  return stdout
}

type WatchScenarioOptions = {
  transcriptName?: string
  metaName?: string | null
  meta?: object
  metaMtimeMs?: number
  livenessDir?: string
  livenessRecord?: unknown
  livenessFileName?: string
  transcriptAgeMs?: number
  transcriptRecords?: unknown[]
  staleMinutes?: number
  transcriptAfterArm?: boolean
  manualTranscript?: boolean
  afterArmed?: (paths: WatchPaths) => void
  waitFor?: RegExp | WatchCondition | null
  runForMs?: number
  cwd?: string
}

type ResolvedScenario = WatchScenarioOptions & {
  transcriptName: string
  metaName: string | null
  transcriptAgeMs: number
  staleMinutes: number
  transcriptAfterArm: boolean
  manualTranscript: boolean
  waitFor: RegExp | WatchCondition | null
  runForMs: number
}

// Same semantics as destructuring defaults: only an undefined option falls back to its default.
function resolveScenario(options: WatchScenarioOptions): ResolvedScenario {
  const defaults = {
    transcriptName: 'agent-under-test.jsonl',
    metaName: 'pilot under/test' as string | null,
    transcriptAgeMs: 2_000,
    staleMinutes: 0,
    transcriptAfterArm: true,
    manualTranscript: false,
    waitFor: /(STALE|IDLE-MID-MISSION|WAITING-ON-SPAWNER): /,
    runForMs: 7_500,
  }
  const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
  return { ...defaults, ...given } as ResolvedScenario
}

function makeScenarioDirs(root: string) {
  const home = path.join(root, 'home')
  const configDir = path.join(root, 'config')
  const projectDir = path.join(root, 'project')
  const subagentsDir = path.join(configDir, 'projects', projectSlug(projectDir), 'watch-session', 'subagents')
  mkdirSync(home, { recursive: true })
  mkdirSync(subagentsDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  return { home, configDir, projectDir, subagentsDir }
}

function writeScenarioMeta(s: ResolvedScenario, metaPath: string) {
  if (s.meta) {
    writeFileSync(metaPath, JSON.stringify(s.meta))
    if (s.metaMtimeMs !== undefined) utimesSync(metaPath, s.metaMtimeMs / 1000, s.metaMtimeMs / 1000)
  } else if (s.metaName !== null) writeFileSync(metaPath, JSON.stringify(s.metaName ? { name: s.metaName } : {}))
}

function writeScenarioTranscript(s: ResolvedScenario, transcriptPath: string, now: number) {
  if (!s.transcriptRecords) {
    touchFile(transcriptPath, now - s.transcriptAgeMs)
    return
  }
  writeFileSync(transcriptPath, `${s.transcriptRecords.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const t = (now - s.transcriptAgeMs) / 1000
  utimesSync(transcriptPath, t, t)
}

function writeScenarioLiveness(s: ResolvedScenario) {
  if (!s.livenessDir || s.livenessRecord === undefined) return
  mkdirSync(s.livenessDir, { recursive: true })
  const fileName = s.livenessFileName ?? `${sanitizeLivenessKey(s.metaName ?? '')}.json`
  const body = typeof s.livenessRecord === 'string' ? s.livenessRecord : JSON.stringify(s.livenessRecord)
  writeFileSync(path.join(s.livenessDir, fileName), body)
}

function startWatcher(s: ResolvedScenario, env: NodeJS.ProcessEnv, projectDir: string): ChildProcess {
  const child = spawn(process.execPath, [ARC_WATCH, '--project', projectDir, '--poll', '5', '--stale', String(s.staleMinutes)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(s.cwd ? { cwd: s.cwd } : {}),
  })
  spawned.push(child)
  return child
}

function killChild(child: ChildProcess) {
  try {
    child.kill('SIGKILL')
  } catch {
    // already dead
  }
}

async function collectWatcherOutput(child: ChildProcess, s: ResolvedScenario, onArmed: () => void): Promise<string> {
  let stdout = ''
  let armed = false
  let resolved = false
  const finish = (value: string, resolve: (value: string) => void) => {
    if (resolved) return
    resolved = true
    killChild(child)
    if (child.exitCode !== null || child.signalCode !== null) resolve(value)
    else child.once('exit', () => resolve(value))
  }
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(stdout, resolve), s.runForMs)
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk
      if (!armed && stdout.includes('ARC WATCH ARMED')) {
        armed = true
        onArmed()
      }
      if (s.waitFor && s.waitFor.test(stdout)) {
        clearTimeout(timer)
        finish(stdout, resolve)
      }
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
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

async function runWatchScenario(options: WatchScenarioOptions = {}): Promise<string> {
  const s = resolveScenario(options)
  const root = tmpRoot('wt-liveness-watch')
  const { home, configDir, projectDir, subagentsDir } = makeScenarioDirs(root)
  const transcriptPath = path.join(subagentsDir, s.transcriptName)
  const metaPath = transcriptPath.replace(/\.jsonl$/, '.meta.json')
  const now = Date.now()
  const prepareTranscript = () => {
    writeScenarioMeta(s, metaPath)
    writeScenarioTranscript(s, transcriptPath, now)
  }
  if (!s.manualTranscript && !s.transcriptAfterArm) prepareTranscript()
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_SESSION_ID: '',
    WT_LIVENESS_DIR: s.livenessDir ?? path.join(root, 'missing-liveness-dir'),
  }
  writeScenarioLiveness(s)
  const child = startWatcher(s, env, projectDir)
  return await collectWatcherOutput(child, s, () => {
    if (!s.manualTranscript && s.transcriptAfterArm) prepareTranscript()
    s.afterArmed?.({ transcriptPath, metaPath })
  })
}

afterEach(async () => {
  const exits: Promise<void>[] = []
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) exits.push(new Promise((resolve) => child.once('exit', () => resolve())))
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    } catch {
      // already dead
    }
  }
  await Promise.all(exits)
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
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


  // Sanitized from a real finished subagent transcript (Claude Code 2.1.312): after the final
  // end_turn the harness appends a SubagentStop hook attachment, and other out-of-band records
  // (cancelled hooks, api-request bookkeeping, system records, observer heartbeats) may follow.
const finalEndTurn = {
  parentUuid: 'p-1', isSidechain: true, agentId: 'a0000000000000001', type: 'assistant',
  uuid: 'u-assistant', timestamp: '2026-10-30T12:17:09.926Z',
  message: { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'Report delivered.' }], stop_reason: 'end_turn', stop_sequence: null },
}
const subagentStopAttachment = (uuid: string, type = 'hook_success') => ({
  parentUuid: 'u-assistant', isSidechain: true, agentId: 'a0000000000000001', type: 'attachment', uuid,
  timestamp: '2026-10-30T12:17:10.380Z',
  attachment: { type, hookName: 'SubagentStop', hookEvent: 'SubagentStop', content: '', stdout: '{}\n', stderr: '', exitCode: 0, durationMs: 432 },
})

async function caseEmitsEachActiveIdleRegistryRecordOnce() {
  const idle = {
    t: 'idle', name: 'pilot-idle', team: 'delivery', idleMin: 5,
    qualified: true, reason: 'active mandate and open cards', at: '2026-09-12T07:00:00.000Z',
  }
  const active = await runIdleRegistryScenario([idle])
  expect(active.match(/IDLE pilot-idle 5m — active mandate and open cards/g)).toHaveLength(1)

  const closed = await runIdleRegistryScenario([idle, {
    t: 'stop', name: 'pilot-idle', at: '2026-09-12T07:01:00.000Z',
  }])
  expect(closed).not.toContain('IDLE pilot-idle')
  // Windows worst 22046 ms on cross-os runs 36967768077/36971793287/36974201587; budget about 2.5x (was 30000 ms).
}


async function caseInvariant1NoLivenessFileBehavesExactly() {
  const out = await runWatchScenario({
    metaName: 'pilot/needs-liveness',
    livenessDir: path.join(tmpRoot('wt-no-liveness'), 'missing'),
  })
  expect(out).toContain('STALE: watch-session/agent-under-test.jsonl — no write for 0+ min')
  expect(out).not.toContain('IDLE-MID-MISSION:')
}


async function caseKeepsANormallyFinishedAgentSilentWhen() {
  const out = await runWatchScenario({
    transcriptRecords: [{
      type: 'assistant',
      timestamp: '2026-09-18T21:47:39.867Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Report delivered.' }], stop_reason: 'end_turn' },
    }, {
      type: 'observer-ref',
      timestamp: '2026-09-18T21:47:45.000Z',
    }],
    waitFor: null,
  })
  expect(out).toContain('ARC WATCH ARMED')
  expect(out).not.toContain('STALE: watch-session/agent-under-test.jsonl')
  // Windows worst 7533 ms on cross-os runs 36967768077/36971793287/36974201587; budget about 2.5x (was 12000 ms).
}


async function caseKeepsAFinishedAgentSilentWhenHarness() {
  const out = await runWatchScenario({
    transcriptRecords: [
      finalEndTurn,
      subagentStopAttachment('u-att-1'),
      subagentStopAttachment('u-att-2', 'hook_cancelled'),
      { type: 'api-request', agentId: 'a0000000000000001', id: 'r-1', timestamp: '2026-10-30T12:17:10.500Z' },
      { type: 'system', subtype: 'turn_duration', timestamp: '2026-10-30T12:17:10.600Z' },
      { type: 'observer-ref', timestamp: '2026-10-30T12:17:11.000Z' },
    ],
    waitFor: null,
  })
  expect(out).toContain('ARC WATCH ARMED')
  expect(out).not.toContain('STALE: watch-session/agent-under-test.jsonl')
}


async function caseStillEmitsSTALEWhenAUserTurn() {
  // A Stop hook that blocks feeds the agent a meta user turn; an agent that never answers it is stuck.
  const out = await runWatchScenario({
    transcriptRecords: [
      finalEndTurn,
      subagentStopAttachment('u-att-1'),
      { type: 'user', isMeta: true, timestamp: '2026-10-30T12:17:10.700Z', message: { role: 'user', content: 'Stop hook feedback' } },
      subagentStopAttachment('u-att-3'),
    ],
  })
  expect(out).toContain('STALE: watch-session/agent-under-test.jsonl — no write for 0+ min')
}


async function caseStillEmitsSTALEWhenSTrailsThe(_label: string, malformed: unknown) {
  const out = await runWatchScenario({
    transcriptRecords: [finalEndTurn, subagentStopAttachment('u-att-1'), malformed],
  })
  expect(out).toContain('STALE: watch-session/agent-under-test.jsonl — no write for 0+ min')
}


async function caseStillEmitsSTALEWhenOnlyAttachmentsTrail() {
  const out = await runWatchScenario({
    transcriptRecords: [
      { ...finalEndTurn, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }], stop_reason: 'tool_use' } },
      subagentStopAttachment('u-att-1'),
    ],
  })
  expect(out).toContain('STALE: watch-session/agent-under-test.jsonl — no write for 0+ min')
}


async function caseACleanEndTurnNeverSilencesAn() {
  // An agent that ends its turn waiting on a background task that never wakes it ends cleanly too;
  // its own declaration outranks the transcript's end_turn.
  const dir = tmpRoot('wt-liveness-endturn-idle')
  const out = await runWatchScenario({
    metaName: 'pilot/endturn-idle',
    livenessDir: dir,
    livenessRecord: {
      agentId: 'pilot/endturn-idle',
      agentIdSource: 'name',
      scope: 'card:123',
      complete: false,
      waitingOn: 'none',
      worktree: null,
      updatedAt: '2026-08-05T00:00:00.000Z',
    },
    transcriptRecords: [{
      type: 'assistant',
      timestamp: '2026-09-18T21:47:39.867Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Waiting for my background job.' }], stop_reason: 'end_turn' },
    }],
  })
  expect(out).toContain('IDLE-MID-MISSION: watch-session/agent-under-test.jsonl — declared not complete, no write for 0+ min')
}


// Real residual shape: the harness marks the agent finished but the last assistant record has stop_reason null.
const nullStopReasonRecords = () => [
  {
    parentUuid: 'p-1', isSidechain: true, agentId: 'a0000000000000001', type: 'assistant',
    uuid: 'u-assistant', timestamp: '2026-10-30T12:17:09.926Z',
    message: { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'Done.' }], stop_reason: null, stop_sequence: null },
  },
  subagentStopAttachment('u-att-1'),
]
const STALE_LINE = 'STALE: watch-session/agent-under-test.jsonl'

async function caseHarnessFinishedMetaKeepsAgentSilent() {
  const out = await runWatchScenario({
    transcriptRecords: nullStopReasonRecords(),
    meta: { agentType: 'h-chore', finished: true },
    waitFor: null,
  })
  expect(out).toContain('ARC WATCH ARMED')
  expect(out).not.toContain(STALE_LINE)
}

async function caseMetaWithoutFinishedStillStale() {
  const out = await runWatchScenario({ transcriptRecords: nullStopReasonRecords(), meta: { agentType: 'h-chore' } })
  expect(out).toContain(STALE_LINE)
}

async function caseMetaFinishedFalseStillStale() {
  const out = await runWatchScenario({ transcriptRecords: nullStopReasonRecords(), meta: { agentType: 'h-chore', finished: false } })
  expect(out).toContain(STALE_LINE)
}

async function caseResumedAgentWithOldFinishedFlagStillStale() {
  const anchorMs = Date.parse('2026-10-30T12:17:10.380Z')
  const out = await runWatchScenario({
    transcriptRecords: nullStopReasonRecords(),
    meta: { agentType: 'h-chore', finished: true },
    metaMtimeMs: anchorMs - 5_000,
  })
  expect(out).toContain(STALE_LINE)
}

async function caseDeclaredNotCompleteOutranksFinishedMeta() {
  const dir = tmpRoot('wt-liveness-finished-meta-idle')
  const out = await runWatchScenario({
    metaName: 'pilot/finished-idle',
    meta: { name: 'pilot/finished-idle', finished: true },
    livenessDir: dir,
    livenessRecord: {
      agentId: 'pilot/finished-idle',
      agentIdSource: 'name',
      scope: 'card:123',
      complete: false,
      waitingOn: 'none',
      worktree: null,
      updatedAt: '2026-08-05T00:00:00.000Z',
    },
    transcriptRecords: nullStopReasonRecords(),
  })
  expect(out).toContain('IDLE-MID-MISSION: watch-session/agent-under-test.jsonl — declared not complete, no write for 0+ min')
}

async function caseFinishedMetaDoesNotSilenceAToolUseEnding() {
  const records = [
    {
      ...nullStopReasonRecords()[0],
      message: { role: 'assistant', type: 'message', content: [{ type: 'tool_use', name: 'Bash', input: {} }], stop_reason: 'tool_use', stop_sequence: null },
    },
    subagentStopAttachment('u-att-1'),
  ]
  const out = await runWatchScenario({ transcriptRecords: records, meta: { agentType: 'h-chore', finished: true } })
  expect(out).toContain(STALE_LINE)
}

async function caseFinishedMetaDoesNotSilenceATrailingUserTurn() {
  const records = [
    ...nullStopReasonRecords(),
    { type: 'user', isMeta: true, timestamp: '2026-10-30T12:17:10.700Z', message: { role: 'user', content: 'Stop hook feedback' } },
  ]
  const out = await runWatchScenario({ transcriptRecords: records, meta: { agentType: 'h-chore', finished: true } })
  expect(out).toContain(STALE_LINE)
}

// Anchor lock: the last REAL record (R) decides, not the observer-ref heartbeat at R+10 s nor the
// transcript file mtime (later still). Meta mtime R+1 s is after R, so the agent is finished.
async function caseMetaFinishedAnchorIsLastRealRecord() {
  const realMs = Date.parse('2026-10-30T12:17:09.926Z')
  const out = await runWatchScenario({
    transcriptRecords: [
      nullStopReasonRecords()[0],
      { type: 'observer-ref', timestamp: new Date(realMs + 10_000).toISOString() },
    ],
    meta: { agentType: 'h-chore', finished: true },
    metaMtimeMs: realMs + 1_000,
    transcriptAgeMs: 2_000,
    waitFor: null,
  })
  expect(out).toContain('ARC WATCH ARMED')
  expect(out).not.toContain(STALE_LINE)
}


async function caseStillEmitsForAFrozenAgentWhose() {
  const out = await runWatchScenario({
    transcriptRecords: [{
      type: 'assistant',
      timestamp: '2026-09-18T21:47:39.867Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }], stop_reason: 'tool_use' },
    }],
  })
  expect(out).toContain('STALE: watch-session/agent-under-test.jsonl — no write for 0+ min')
}


async function caseInvariant2DeclaredNotCompleteEmitsIDLE() {
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
}


async function caseInvariant3MalformedLivenessJSONFallsBack() {
  const dir = tmpRoot('wt-liveness-malformed')
  const out = await runWatchScenario({
    metaName: 'pilot/malformed',
    livenessDir: dir,
    livenessRecord: '{bad json',
  })
  expect(out).toContain('STALE: watch-session/agent-under-test.jsonl — no write for 0+ min')
  expect(out).not.toContain('IDLE-MID-MISSION:')
}


async function caseInvariant3WaitingOnLaneWithAMissing() {
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
}


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
async function caseInvariant3WaitingOnLaneWithARELATIVE() {
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
  // Windows worst 11023 ms on cross-os runs 36967768077/36971793287/36974201587; budget about 2.5x (was 12000 ms).
}


  // Review finding (same source): correlation by filename alone is not sufficient proof — the
  // record's OWN declared identity must agree with the candidate key it was looked up under.
  // This reproduces a MISMATCHED-TIER record sitting under the transcript's raw-id filename (as
  // if left over from an unrelated write, or copy-pasted): agentIdSource:"name" under a raw-id
  // key. FAILS before the identity check: the old code returned any record found at the raw-id
  // key regardless of its declared tier, so this record's complete:true would wrongly silence a
  // transcript that in fact has no usable liveness declaration at all (no meta.name exists here,
  // so the name-tier fallback is also impossible — the correct behavior is plain STALE).
async function caseALivenessRecordWhoseDeclaredIdentityDoes() {
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
}


async function caseInvariant4ExplicitCompleteTrueStaysSilent() {
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
  // Windows worst 7526 ms on cross-os runs 36967768077/36971793287/36974201587; budget about 2.5x (was 12000 ms).
}


async function caseSilencesLegitimateLaneWaitsOnlyWhenThe() {
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
  // Windows worst 11029 ms on cross-os runs 36967768077/36971793287/36974201587; budget about 2.5x (was 12000 ms).
}


async function caseCorrelatesByTranscriptRawIdWhenNo() {
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
}


async function caseEmitsWAITINGONSPAWNERWithoutWaitingFor() {
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
}


async function caseLabelsWAITINGONSPAWNERRecordsFromOther() {
  const dir = tmpRoot('wt-liveness-spawner-foreign')
  const out = await runWatchScenario({
    metaName: 'pilot/local-only',
    livenessDir: dir,
    livenessRecord: {
      agentId: 'pilot/foreign-agent',
      agentIdSource: 'name',
      scope: 'card:foreign',
      complete: false,
      waitingOn: 'spawner',
      worktree: null,
      updatedAt: '2026-08-05T00:00:00.000Z',
    },
    transcriptAgeMs: 0,
    transcriptAfterArm: false,
    waitFor: /WAITING-ON-SPAWNER: /,
  })
  expect(out).toContain('WAITING-ON-SPAWNER: pilot/foreign-agent — card:foreign (foreign to this project)')
}


async function caseKeepsLocalWAITINGONSPAWNERWordingUnchanged() {
  const dir = tmpRoot('wt-liveness-spawner-local')
  const out = await runWatchScenario({
    metaName: 'pilot/local-spawner',
    livenessDir: dir,
    livenessRecord: {
      agentId: 'pilot/local-spawner',
      agentIdSource: 'name',
      scope: 'mission:local wait',
      complete: false,
      waitingOn: 'spawner',
      worktree: null,
      updatedAt: '2026-08-05T00:00:00.000Z',
    },
    transcriptAgeMs: 0,
    transcriptAfterArm: false,
    waitFor: /WAITING-ON-SPAWNER: /,
  })
  expect(out).toContain('WAITING-ON-SPAWNER: pilot/local-spawner — mission:local wait')
  expect(out).not.toContain('WAITING-ON-SPAWNER: pilot/local-spawner — mission:local wait (foreign to this project)')
}


async function caseKeepsLocalWAITINGONSPAWNERWordingUnchanged2() {
  const dir = tmpRoot('wt-liveness-spawner-local-brief')
  const transcriptName = 'agent-brieflocal123.jsonl'
  const rawId = /^agent-(.+)\.jsonl$/.exec(transcriptName)?.[1]
  expect(rawId).toBe('brieflocal123')
  const out = await runWatchScenario({
    transcriptName,
    metaName: null,
    livenessDir: dir,
    livenessFileName: `${sanitizeLivenessKey(rawId ?? '')}.json`,
    livenessRecord: {
      agentId: rawId,
      agentIdSource: 'brief',
      scope: 'mission:brief local wait',
      complete: false,
      waitingOn: 'spawner',
      worktree: null,
      updatedAt: '2026-08-05T00:00:00.000Z',
    },
    transcriptAgeMs: 0,
    transcriptAfterArm: false,
    waitFor: /WAITING-ON-SPAWNER: /,
  })
  expect(out).toContain(`WAITING-ON-SPAWNER: ${rawId} — mission:brief local wait`)
  expect(out).not.toContain(`WAITING-ON-SPAWNER: ${rawId} — mission:brief local wait (foreign to this project)`)
}


async function caseLabelsWAITINGONSPAWNERBriefSourcedRecords() {
  const dir = tmpRoot('wt-liveness-spawner-foreign-brief')
  const transcriptName = 'agent-brieflocal123.jsonl'
  const localRawId = /^agent-(.+)\.jsonl$/.exec(transcriptName)?.[1]
  expect(localRawId).toBe('brieflocal123')
  const foreignRawId = 'briefforeign456'
  const out = await runWatchScenario({
    transcriptName,
    metaName: null,
    livenessDir: dir,
    livenessFileName: `${sanitizeLivenessKey(foreignRawId)}.json`,
    livenessRecord: {
      agentId: foreignRawId,
      agentIdSource: 'brief',
      scope: 'card:brief foreign',
      complete: false,
      waitingOn: 'spawner',
      worktree: null,
      updatedAt: '2026-08-05T00:00:00.000Z',
    },
    transcriptAgeMs: 0,
    transcriptAfterArm: false,
    waitFor: /WAITING-ON-SPAWNER: /,
  })
  expect(out).toContain('WAITING-ON-SPAWNER: briefforeign456 — card:brief foreign (foreign to this project)')
}


function refreshSpawnerRecord(updatedAt: string) {
  return {
    agentId: 'pilot/cached-refresh',
    agentIdSource: 'name',
    scope: 'card:refresh',
    complete: false,
    waitingOn: 'spawner',
    worktree: null,
    updatedAt,
  }
}

function cachedRefreshSequence(dir: string) {
  let paths: WatchPaths
  const waiting = /^WAITING-ON-SPAWNER: pilot\/cached-refresh — card:refresh/
  return {
    afterArmed: (armedPaths: WatchPaths) => { paths = armedPaths },
    waitFor: emittedLineSequence('cached transcript refresh emissions', [
      { line: waiting, after: () => {
        touchFile(paths.transcriptPath, Date.now())
        writeFileSync(paths.metaPath, JSON.stringify({ name: 'pilot/cached-refresh' }))
        writeFileSync(path.join(dir, `${sanitizeLivenessKey('pilot/cached-refresh')}.json`), JSON.stringify(refreshSpawnerRecord('2026-08-05T00:00:10.000Z')))
      } },
      { line: waiting },
    ]),
    runForMs: 25_000,
  }
}

async function caseRefreshesTheCachedLocalTranscriptIdsWhen() {
  const dir = tmpRoot('wt-liveness-spawner-refresh')
  const out = await runWatchSequence({
    metaName: 'pilot/cached-refresh',
    livenessDir: dir,
    livenessRecord: refreshSpawnerRecord('2026-08-05T00:00:00.000Z'),
    transcriptAgeMs: 0,
    manualTranscript: true,
    ...cachedRefreshSequence(dir),
  })

  const waitingLines = out.split('\n').filter((line) => line.startsWith('WAITING-ON-SPAWNER: pilot/cached-refresh — card:refresh'))
  expect(waitingLines).toEqual([
    'WAITING-ON-SPAWNER: pilot/cached-refresh — card:refresh (foreign to this project)',
    'WAITING-ON-SPAWNER: pilot/cached-refresh — card:refresh',
  ])
}


async function caseKeepsTheSameEmissionCountWhileLabeling() {
  const dir = tmpRoot('wt-liveness-emission-count')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${sanitizeLivenessKey('pilot/local-count')}.json`), JSON.stringify({
    agentId: 'pilot/local-count',
    agentIdSource: 'name',
    scope: 'mission:local count',
    complete: false,
    waitingOn: 'spawner',
    worktree: null,
    updatedAt: '2026-08-05T00:00:00.000Z',
  }))
  writeFileSync(path.join(dir, 'orphan-count.json'), JSON.stringify({
    agentId: null,
    agentIdSource: 'none',
    scope: 'mission:uncorrelated count',
    complete: false,
    waitingOn: 'none',
    worktree: null,
    updatedAt: '2026-08-05T00:00:00.000Z',
  }))

  const out = await runWatchScenario({
    metaName: 'pilot/local-count',
    livenessDir: dir,
    transcriptAgeMs: 0,
    transcriptAfterArm: false,
    waitFor: null,
    runForMs: 7_500,
  })

  const emissionCount = out.split('\n').filter((line) => /^(WAITING-ON-SPAWNER|UNCORRELATABLE): /.test(line)).length
  expect(emissionCount).toBe(2)
  expect(out).toContain('UNCORRELATABLE: mission:uncorrelated count — liveness file declares no correlation key, cannot be matched to a transcript (project unknown)')
  // Windows worst 7521 ms on cross-os runs 36967768077/36971793287/36974201587; budget about 2.5x (was 12000 ms).
}


function orphanRecord(updatedAt: string) {
  return {
    agentId: null,
    agentIdSource: 'none',
    scope: 'mission:uncorrelated',
    complete: false,
    waitingOn: 'none',
    worktree: null,
    updatedAt,
  }
}

function uncorrelatableLine(scope: string): string {
  return `UNCORRELATABLE: ${scope} — liveness file declares no correlation key, cannot be matched to a transcript (project unknown)`
}

function orphanRewriteSequence(dir: string, file: string): WatchCondition {
  const original = '2026-08-05T00:00:00.000Z'
  const updated = '2026-08-05T00:00:10.000Z'
  const checkpoint = (scope: string, updatedAt: string) => {
    writeFileSync(path.join(dir, 'poll-checkpoint.json'), JSON.stringify({ ...orphanRecord(updatedAt), scope }))
  }
  const target = uncorrelatableLine('mission:uncorrelated')
  return emittedLineSequence('orphan updatedAt rewrite emissions', [
    { line: target, after: () => {
      writeFileSync(file, JSON.stringify(orphanRecord(original)))
      checkpoint('mission:checkpoint-original', original)
    } },
    { line: uncorrelatableLine('mission:checkpoint-original'), after: () => checkpoint('mission:checkpoint-next', updated) },
    // A second checkpoint emission requires a later sweep: the first sweep has
    // finished reading the same-updatedAt target, whichever entry was read first.
    { line: uncorrelatableLine('mission:checkpoint-next'), after: () => {
      writeFileSync(file, JSON.stringify(orphanRecord(updated)))
    } },
    { line: target },
  ])
}

async function caseEmitsUNCORRELATABLEOncePerDistinctUpdatedAtFor() {
  const dir = tmpRoot('wt-liveness-uncorrelatable')
  const file = path.join(dir, 'orphan-record.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(orphanRecord('2026-08-05T00:00:00.000Z')))

  const out = await runWatchSequence({
    metaName: 'pilot/unrelated-transcript',
    livenessDir: dir,
    transcriptAgeMs: 0,
    waitFor: orphanRewriteSequence(dir, file),
    runForMs: 25_000,
  })

  const marker = 'UNCORRELATABLE: mission:uncorrelated — liveness file declares no correlation key, cannot be matched to a transcript \(project unknown\)'
  expect(out.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2)
}

describe('wt-arc-watch liveness integration', () => {
  it('emits each active idle registry record once and suppresses one closed by stop', caseEmitsEachActiveIdleRegistryRecordOnce, 56_000)

  it('Invariant 1: no liveness file behaves exactly like the old STALE path', caseInvariant1NoLivenessFileBehavesExactly, 12_000)

  it('keeps a normally finished agent silent when its transcript ends with end_turn', caseKeepsANormallyFinishedAgentSilentWhen, 19_000)

  it('keeps a finished agent silent when harness-appended records trail its final end_turn', caseKeepsAFinishedAgentSilentWhenHarness, 19_000)

  it('still emits STALE when a user turn follows the end_turn, even behind trailing attachments', caseStillEmitsSTALEWhenAUserTurn, 12_000)

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['an untyped record that carries a user message', { message: { role: 'user', content: 'continue' } }],
  ])('still emits STALE when %s trails the end_turn (malformed record, fail loud)', caseStillEmitsSTALEWhenSTrailsThe, 12_000)

  it('still emits STALE when only attachments trail an assistant record that requested a tool', caseStillEmitsSTALEWhenOnlyAttachmentsTrail, 12_000)

  it('a clean end_turn never silences an agent whose liveness file says its mission is not complete', caseACleanEndTurnNeverSilencesAn, 12_000)

  it('keeps an agent silent when its meta says finished and was written after the last transcript record', caseHarnessFinishedMetaKeepsAgentSilent, 19_000)

  it('still emits STALE when the meta has no finished flag', caseMetaWithoutFinishedStillStale, 12_000)

  it('still emits STALE when the meta says finished:false', caseMetaFinishedFalseStillStale, 12_000)

  it('still emits STALE for a resumed agent whose finished flag is older than its last record', caseResumedAgentWithOldFinishedFlagStillStale, 12_000)

  it('a finished meta never silences a transcript that ends on a tool call', caseFinishedMetaDoesNotSilenceAToolUseEnding, 12_000)

  it('a finished meta never silences a transcript that ends on a user turn', caseFinishedMetaDoesNotSilenceATrailingUserTurn, 12_000)

  it('the finished-meta anchor is the last real record, not a heartbeat or the file mtime', caseMetaFinishedAnchorIsLastRealRecord, 19_000)

  it('a finished meta never silences an agent whose liveness file says its mission is not complete', caseDeclaredNotCompleteOutranksFinishedMeta, 12_000)

  it('still emits for a frozen agent whose last assistant record requests a tool', caseStillEmitsForAFrozenAgentWhose, 12_000)

  it('Invariant 2: declared not complete emits IDLE-MID-MISSION, never STALE', caseInvariant2DeclaredNotCompleteEmitsIDLE, 12_000)

  it('Invariant 3: malformed liveness JSON falls back to unchanged STALE, never silence', caseInvariant3MalformedLivenessJSONFallsBack, 12_000)

  it('Invariant 3: waitingOn lane with a missing worktree fails toward alerting, not silence', caseInvariant3WaitingOnLaneWithAMissing, 12_000)

  it('Invariant 3: waitingOn lane with a RELATIVE worktree path is neutralized, never trusted as recently active', caseInvariant3WaitingOnLaneWithARELATIVE, 28_000)

  it('a liveness record whose declared identity does not match the correlation candidate is never trusted, even when found under the right filename', caseALivenessRecordWhoseDeclaredIdentityDoes, 12_000)

  it('Invariant 4: explicit complete:true stays silent through the same watcher code path', caseInvariant4ExplicitCompleteTrueStaysSilent, 19_000)

  it('silences legitimate lane waits only when the declared worktree shows recent real activity', caseSilencesLegitimateLaneWaitsOnlyWhenThe, 28_000)

  it('correlates by transcript raw id when no declared name exists and emits IDLE-MID-MISSION', caseCorrelatesByTranscriptRawIdWhenNo, 12_000)

  it('emits WAITING-ON-SPAWNER without waiting for transcript staleness', caseEmitsWAITINGONSPAWNERWithoutWaitingFor, 12_000)

  it('labels WAITING-ON-SPAWNER records from other projects on the same line', caseLabelsWAITINGONSPAWNERRecordsFromOther, 12_000)

  it('keeps local WAITING-ON-SPAWNER wording unchanged for this project\'s own delegates', caseKeepsLocalWAITINGONSPAWNERWordingUnchanged, 12_000)

  it('keeps local WAITING-ON-SPAWNER wording unchanged for this project\'s own brief-sourced delegates', caseKeepsLocalWAITINGONSPAWNERWordingUnchanged2, 12_000)

  it('labels WAITING-ON-SPAWNER brief-sourced records from other projects on the same line', caseLabelsWAITINGONSPAWNERBriefSourcedRecords, 12_000)

  it('refreshes the cached local transcript ids when a newly-seen project transcript becomes part of the baseline', caseRefreshesTheCachedLocalTranscriptIdsWhen, 32_000)

  it('keeps the same emission count while labeling uncorrelatable records as project unknown', caseKeepsTheSameEmissionCountWhileLabeling, 19_000)

  it('emits UNCORRELATABLE once per distinct updatedAt for tier-none records', caseEmitsUNCORRELATABLEOncePerDistinctUpdatedAtFor, 32_000)
})

describe('test harness sanity', () => {
  it('uses the real watcher script path', () => {
    expect(existsSync(ARC_WATCH)).toBe(true)
  })
})
