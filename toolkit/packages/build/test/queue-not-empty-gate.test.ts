import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error TS7016 -- lane-live-scan.mjs is a shipped plain-JS plugin script.
import { registeredWorktrees, scanLiveLaneProcesses } from '../../../../plugin/bin/lib/lane-live-scan.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = process.env.WT_QUEUE_GATE_HOOK || join(REPO_ROOT, 'plugin/bin/wt-queue-not-empty-gate-hook.mjs')
const HELP_FILE = join(REPO_ROOT, 'plugin/bin/wt-queue-not-empty-gate-hook.help.md')
const LANE_LIVE_SCAN = join(REPO_ROOT, 'plugin/bin/lib/lane-live-scan.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wt-queue-gate-${tag}-`))
  roots.push(root)
  return root
}

function slug(cwd: string): string {
  const readable = cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 12)
  return `${readable}-${hash}`
}

type Scaffold = {
  env: NodeJS.ProcessEnv
  payload: unknown
  stateDir: string
  cwd: string
  transcriptPath: string
}

function scaffold(tag: string): Scaffold {
  const root = mkRoot(tag)
  const stateDir = join(root, 'queue-gate-state')
  const configDir = join(root, 'config')
  const procRoot = join(root, 'fake-proc')
  const cwd = join(root, 'project')
  const transcriptPath = join(root, 'transcript.jsonl')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(procRoot)
  mkdirSync(join(configDir, 'plugins', 'store'), { recursive: true })
  // The guard journal masks with this installed-store contract. Pin it here so this
  // output-shape test does not inherit whether the host has a Claude config directory.
  writeFileSync(join(configDir, 'plugins', 'store', 'wt-secret-guard.json'), JSON.stringify({
    salt: 'fixture-salt', detections: { entries: [] },
  }))
  if (spawnSync('git', ['init', '--quiet'], { cwd }).status !== 0) throw new Error('git init failed')
  writeFileSync(transcriptPath, '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WT_QUEUE_GATE_DIR: stateDir,
    WT_QUEUE_GATE_PROC_ROOT: procRoot,
    // These fixtures provide a synthetic /proc tree; do not inherit the host OS provider.
    WT_QUEUE_GATE_PROCESS_PLATFORM: 'linux',
    HOME: root,
    CLAUDE_CONFIG_DIR: configDir,
  }
  const payload = {
    hook_event_name: 'Stop',
    session_id: `session-${tag}`,
    cwd,
    transcript_path: transcriptPath,
  }
  return { env, payload, stateDir, cwd, transcriptPath }
}

function writeSnapshot(stateDir: string, cwd: string, snap: Record<string, unknown>): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, `queue-${slug(cwd)}.json`), JSON.stringify(snap), 'utf8')
}

function agePath(path: string, minutesAgo = 15): void {
  const staleDate = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(path, staleDate, staleDate)
}

function runHook(payload: unknown, env: NodeJS.ProcessEnv): { code: number | null; stderr: string; stdout: string } {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
  return { code: res.status, stderr: (res.stderr ?? '').trim(), stdout: (res.stdout ?? '').trim() }
}

// The hook emits its block text as stdout JSON (hookSpecificOutput.additionalContext) with
// exit 0, not stderr with exit 2 — this is the discriminator every test below uses. A PASS case
// legitimately emits no stdout at all, so malformed/absent stdout returns ''.
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

describe('registeredWorktrees', () => {
  it('returns unknown when git is unavailable', () => {
    expect(registeredWorktrees('/repo', {
      spawnSyncImpl: () => ({ error: new Error('ENOENT'), status: null }),
    })).toEqual({ status: 'unknown', worktrees: [] })
  })

  it('returns unknown when git worktree enumeration times out', () => {
    expect(registeredWorktrees('/repo', {
      spawnSyncImpl: () => ({ signal: 'SIGTERM', status: null, stdout: '' }),
    })).toEqual({ status: 'unknown', worktrees: [] })
  })

  it('returns unknown for malformed git worktree output', () => {
    expect(registeredWorktrees('/repo', {
      spawnSyncImpl: () => ({ status: 0, stdout: 'not porcelain output\n' }),
    })).toEqual({ status: 'unknown', worktrees: [] })
  })

  it('reports failed enumeration as unknown in the queue guard', () => {
    const { env, payload, stateDir, cwd } = scaffold('unavailable-worktree-enumeration')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })

    const r = runHook(payload, { ...env, PATH: '' })
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('Worktree activity is unknown — git worktree enumeration failed')
  })
})

describe('scanLiveLaneProcesses', () => {
  it('enumerates Darwin lanes from one quote-aware ps transcript', () => {
    const calls: unknown[][] = []
    const result = scanLiveLaneProcesses({
      platform: 'darwin',
      spawnSyncImpl: (...args: unknown[]) => {
        calls.push(args)
        return { status: 0, stdout: '  101 /usr/local/bin/node /tools/wt-lane.mjs --dir "/tmp/work trees/lane 15"\n  102 node worker.mjs\n' }
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 2)).toEqual(['ps', ['-axo', 'pid=,command=']])
    expect(result).toEqual({ status: 'known', processes: [{ pid: '101', dir: '/tmp/work trees/lane 15', command: 'node wt-lane.mjs' }] })
  })

  it('bounds Darwin enumeration forks by the 100 ms snapshot TTL under a 10 ms poll', () => {
    vi.useFakeTimers()
    try {
      const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: '  101 node /tools/wt-lane.mjs --dir /tmp/lane\n' }))
      for (let tick = 0; tick < 100; tick += 1) {
        expect(scanLiveLaneProcesses({ platform: 'darwin', spawnSyncImpl }).status).toBe('known')
        vi.advanceTimersByTime(10)
      }
      expect(spawnSyncImpl).toHaveBeenCalledTimes(10)
    } finally { vi.useRealTimers() }
  })

  it('names ps when Darwin process enumeration is unavailable', () => {
    expect(scanLiveLaneProcesses({ platform: 'darwin', spawnSyncImpl: () => ({ error: new Error('ENOENT'), status: null }) }))
      .toEqual({ status: 'unknown', processes: [], source: 'ps' })
  })

  it('reports process inspection as unknown on unsupported platforms', () => {
    expect(scanLiveLaneProcesses({ platform: 'freebsd' })).toEqual({ status: 'unknown', processes: [] })
  })

  it('ignores a matching process whose --dir is not absolute', () => {
    expect(scanLiveLaneProcesses({
      platform: 'linux',
      readdirImpl: () => ['101'],
      readFileImpl: () => Buffer.from('node\0wt-lane.mjs\0--dir\0relative/lane\0'),
    })).toEqual({ status: 'known', processes: [] })
  })

  it('caps process inspection at the first 5,000 numeric entries', () => {
    const entries = Array.from({ length: 5_001 }, (_, index) => String(index + 1))
    let reads = 0
    const result = scanLiveLaneProcesses({
      platform: 'linux',
      readdirImpl: () => entries,
      readFileImpl: () => {
        reads += 1
        return Buffer.from('node\0worker.mjs\0')
      },
    })
    expect(result).toEqual({ status: 'capped', processes: [] })
    expect(reads).toBe(5_000)
  })

  it('uses one PowerShell CIM table query and preserves a drive-qualified lane directory', () => {
    const calls: unknown[][] = []
    const result = scanLiveLaneProcesses({
      platform: 'win32',
      spawnSyncImpl: (...args: unknown[]) => {
        calls.push(args)
        return {
          status: 0,
          stdout: JSON.stringify({
            ProcessId: 404,
            CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "D:\\tools\\wt-lane.mjs" --dir "D:\\work trees\\lane-14"',
          }),
        }
      },
    })
    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.[1])).toContain('Get-CimInstance Win32_Process')
    expect(result).toEqual({
      status: 'known',
      processes: [{ pid: '404', dir: 'D:\\work trees\\lane-14', command: 'node.exe wt-lane.mjs' }],
    })
  })

  it('names PowerShell when Windows process enumeration is unavailable', () => {
    expect(scanLiveLaneProcesses({
      platform: 'win32',
      spawnSyncImpl: () => ({ error: new Error('ENOENT'), status: null }),
    })).toEqual({ status: 'unknown', processes: [], source: 'powershell' })
  })
})

describe('wt-queue-not-empty-gate-hook: emission shape', () => {
  it('refuses a known startable queue and emits nothing for a finished mission', () => {
    const startable = scaffold('v2-startable')
    writeSnapshot(startable.stateDir, startable.cwd, { at: Date.now(), startable: 2, awaitingOwner: 3, unclassified: 1, next: 'CARD-startable' })
    const startableText = blockText(runHook(startable.payload, startable.env))
    expect(startableText).toContain('2 startable (3 awaiting owner, 1 unclassified)')

    const finished = scaffold('v2-finished')
    writeSnapshot(finished.stateDir, finished.cwd, { at: Date.now(), startable: 0, awaitingOwner: 3, unclassified: 1, next: '' })
    const result = runHook(finished.payload, finished.env)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('')
  })

  it.each([
    ['known startable queue', { at: Date.now(), startable: 2, awaitingOwner: 0, unclassified: 0, next: 'CARD-known' }],
    ['legacy open queue', { open: 2, at: Date.now(), next: 'CARD-legacy' }],
    ['malformed queue', { open: '2', at: Date.now(), next: 'CARD-malformed' }],
  ])('stays silent when stop_hook_active=true for a blocking %s branch', (_name, snapshot) => {
    const { env, payload, stateDir, cwd } = scaffold(`retry-${_name.replaceAll(' ', '-')}`)
    writeSnapshot(stateDir, cwd, snapshot)

    const result = runHook({ ...(payload as Record<string, unknown>), stop_hook_active: true }, env)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('')
  })

  it('retains legacy refusal with an explicit classification suffix', () => {
    const { env, payload, stateDir, cwd } = scaffold('legacy-suffix')
    writeSnapshot(stateDir, cwd, { open: 2, at: Date.now(), next: 'CARD-legacy' })
    expect(blockText(runHook(payload, env))).toContain('2 open [legacy snapshot: classification unknown]')
  })

  it('uses one exported 12-minute window for registered-worktree and lane-log liveness', () => {
    expect(readFileSync(LANE_LIVE_SCAN, 'utf8')).toContain('export const ACTIVITY_WINDOW_MIN = 12')
  })

  it('reaches the same queue verdict from a project root and every nested directory', () => {
    const { env, payload, stateDir, cwd } = scaffold('ancestor-family')
    writeSnapshot(stateDir, cwd, { open: 7, at: Date.now(), next: 'CARD-7 inherited item' })

    const repository = join(cwd, 'repository')
    const packages = join(repository, 'packages')
    const core = join(packages, 'core')
    mkdirSync(core, { recursive: true })
    agePath(repository)
    agePath(packages)
    agePath(core)
    const directories = [cwd, repository, core]
    const verdicts = directories.map((directory, index) => {
      const r = runHook({
        ...(payload as Record<string, unknown>),
        cwd: directory,
        session_id: `session-ancestor-family-${index}`,
      }, env)
      expect(r.code).toBe(0)
      return blockText(r)
    })

    for (const verdict of verdicts) {
      expect(verdict).toContain('7 open')
      expect(verdict).toContain('next: CARD-7 inherited item')
    }
    expect(verdicts[0]).not.toContain('using ancestor snapshot')
    for (const verdict of verdicts.slice(1)) {
      expect(verdict).toContain(`using ancestor snapshot from ${cwd}`)
    }
  })

  it('uses the most specific ancestor snapshot', () => {
    const { env, payload, stateDir, cwd } = scaffold('specific-ancestor')
    const repository = join(cwd, 'repository')
    const nested = join(repository, 'packages', 'core')
    mkdirSync(nested, { recursive: true })
    agePath(repository)
    agePath(join(repository, 'packages'))
    agePath(nested)
    writeSnapshot(stateDir, cwd, { open: 11, at: Date.now(), next: 'root item' })
    writeSnapshot(stateDir, repository, { open: 3, at: Date.now(), next: 'repository item' })

    const r = runHook({ ...(payload as Record<string, unknown>), cwd: nested }, env)
    const text = blockText(r)
    expect(text).toContain('3 open')
    expect(text).toContain('next: repository item')
    expect(text).toContain(`using ancestor snapshot from ${repository}`)
    expect(text).not.toContain('11 open')
  })

  it('ignores a truncated readable-prefix match without the full ancestor hash', () => {
    const { env, payload, stateDir, cwd } = scaffold('truncated-prefix')
    const shared = 'x'.repeat(140)
    const current = join(cwd, shared, 'current', 'nested')
    const sibling = join(cwd, shared, 'sibling')
    mkdirSync(current, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeSnapshot(stateDir, sibling, { open: 9, at: Date.now(), next: 'sibling item' })
    expect(slug(current).slice(0, 120)).toBe(slug(sibling).slice(0, 120))

    const r = runHook({ ...(payload as Record<string, unknown>), cwd: current }, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('blocks via stdout hookSpecificOutput.additionalContext + exit 0, never stderr + exit 2', () => {
    const { env, payload, stateDir, cwd } = scaffold('emission-shape')
    writeSnapshot(stateDir, cwd, { open: 3, at: Date.now(), next: 'CARD-1 next item' })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    const text = blockText(r)
    expect(text).not.toBe('')
    expect(text).toContain('open work remains')
  })

  it('stays silent when the worktree was written to seconds ago even if no subagent transcript moved', () => {
    const { env, payload, stateDir, cwd } = scaffold('recent-worktree-activity')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    writeFileSync(join(cwd, 'lane-output.txt'), 'external lane wrote here', 'utf8')

    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('stays silent for a fresh file in another registered worktree with no subagent transcript', () => {
    const { env, payload, stateDir, cwd } = scaffold('registered-worktree-activity')
    const lane = join(dirname(cwd), 'registered-lane')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    rmSync(join(cwd, '.git'), { recursive: true, force: true })
    expect(spawnSync('git', ['init', '--quiet'], { cwd }).status).toBe(0)
    expect(spawnSync('git', ['config', 'user.email', 'queue-gate@example.test'], { cwd }).status).toBe(0)
    expect(spawnSync('git', ['config', 'user.name', 'Queue Gate'], { cwd }).status).toBe(0)
    writeFileSync(join(cwd, 'seed.txt'), 'seed', 'utf8')
    expect(spawnSync('git', ['add', 'seed.txt'], { cwd }).status).toBe(0)
    expect(spawnSync('git', ['-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'seed'], { cwd }).status).toBe(0)
    expect(spawnSync('git', ['worktree', 'add', '--quiet', '-b', 'lane-branch', lane], { cwd }).status).toBe(0)
    writeFileSync(join(lane, 'lane-output.txt'), 'external lane wrote here', 'utf8')
    agePath(join(cwd, 'seed.txt'))

    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('stays silent for a fresh non-terminal lane run log', () => {
    const { env, payload, stateDir, cwd } = scaffold('active-lane-log')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    mkdirSync(join(cwd, '.lane'), { recursive: true })
    writeFileSync(join(cwd, '.lane', 'run.log'), 'working\n', 'utf8')

    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('does not mistake a lane ending EXIT=124 for a running lane', () => {
    const { env, payload, stateDir, cwd } = scaffold('finished-lane-log')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    mkdirSync(join(cwd, '.lane'), { recursive: true })
    writeFileSync(join(cwd, '.lane', 'run.log'), 'working\nEXIT=124\n', 'utf8')

    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('open work remains')
  })

  it('ignores a fresh env.log because it is not launcher-owned', () => {
    const { env, payload, stateDir, cwd } = scaffold('fresh-env-log')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    mkdirSync(join(cwd, '.lane'), { recursive: true })
    writeFileSync(join(cwd, '.lane', 'env.log'), 'worker environment\n', 'utf8')

    expect(blockText(runHook(payload, env))).toContain('open work remains')
  })

  it('stays silent for a fresh non-terminal launcher-owned nonce log', () => {
    const { env, payload, stateDir, cwd } = scaffold('active-named-lane-log')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    mkdirSync(join(cwd, '.lane'), { recursive: true })
    writeFileSync(join(cwd, '.lane', 'critic-run.abc123.log'), 'working\n', 'utf8')

    expect(blockText(runHook(payload, env))).toBe('')
  })

  it('does not mistake a launcher-owned nonce log ending in EXIT for a running lane', () => {
    const { env, payload, stateDir, cwd } = scaffold('finished-nonce-lane-log')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    mkdirSync(join(cwd, '.lane'), { recursive: true })
    writeFileSync(join(cwd, '.lane', 'critic-run.abc123.log'), 'working\nEXIT=0\n', 'utf8')

    expect(blockText(runHook(payload, env))).toContain('open work remains')
  })

  it('reads only a bounded tail when checking launcher-owned logs', () => {
    const source = readFileSync(LANE_LIVE_SCAN, 'utf8')
    expect(source).toContain('export const LANE_LOG_TAIL_BYTES = 4096')
    expect(source).toContain('readSync(')
  })

  it.each(['wt-pilot-runner.mjs', 'wt-lane.mjs'])('stays silent for a detached %s process scoped to this project', (script) => {
    const { env, payload, stateDir, cwd } = scaffold('live-external-lane')
    const laneDir = join(cwd, 'lane-worktree')
    const procRoot = join(cwd, 'fake-proc')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    mkdirSync(join(procRoot, '101'), { recursive: true })
    mkdirSync(laneDir, { recursive: true })
    writeFileSync(join(procRoot, '101', 'cmdline'), `node\0/opt/toolbox/${script}\0--card\0C-1\0--dir\0${laneDir}\0`)
    agePath(join(procRoot, '101', 'cmdline'))
    agePath(join(procRoot, '101'))
    agePath(procRoot)
    agePath(laneDir)
    agePath(cwd)

    const r = runHook(payload, { ...env, WT_QUEUE_GATE_PROC_ROOT: procRoot })
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('does not let a matching detached process outside the project root silence the gate', () => {
    const { env, payload, stateDir, cwd } = scaffold('outside-live-external-lane')
    const laneDir = join(dirname(cwd), 'outside-session-root')
    const procRoot = join(cwd, 'fake-proc')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    mkdirSync(join(procRoot, '101'), { recursive: true })
    mkdirSync(laneDir, { recursive: true })
    writeFileSync(join(procRoot, '101', 'cmdline'), `node\0/opt/toolbox/wt-lane.mjs\0--worker\0--dir=${laneDir}\0`)
    agePath(join(procRoot, '101', 'cmdline'))
    agePath(join(procRoot, '101'))
    agePath(procRoot)
    agePath(cwd)

    expect(blockText(runHook(payload, { ...env, WT_QUEUE_GATE_PROC_ROOT: procRoot }))).toContain('open work remains')
  })

  it('does not let a process in a prefix-sibling directory silence the gate', () => {
    const { env, payload, stateDir, cwd } = scaffold('prefix-sibling-process')
    const laneDir = join(`${cwd}-sibling`, 'lane')
    const procRoot = join(cwd, 'fake-proc')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    mkdirSync(join(procRoot, '101'), { recursive: true })
    mkdirSync(laneDir, { recursive: true })
    writeFileSync(join(procRoot, '101', 'cmdline'), `node\0/opt/toolbox/wt-lane.mjs\0--dir\0${laneDir}\0`)
    agePath(join(procRoot, '101', 'cmdline'))
    agePath(join(procRoot, '101'))
    agePath(procRoot)
    agePath(cwd)

    expect(blockText(runHook(payload, { ...env, WT_QUEUE_GATE_PROC_ROOT: procRoot }))).toContain('open work remains')
  })

  it('matches a real-path process directory when the hook cwd is a symlink', () => {
    const { env, payload, stateDir, cwd } = scaffold('symlinked-cwd-process')
    const alias = `${cwd}-alias`
    const laneDir = join(cwd, 'lane')
    const procRoot = join(cwd, 'fake-proc')
    symlinkSync(cwd, alias, 'dir')
    writeSnapshot(stateDir, alias, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    mkdirSync(join(procRoot, '101'), { recursive: true })
    mkdirSync(laneDir, { recursive: true })
    writeFileSync(join(procRoot, '101', 'cmdline'), `node\0/opt/toolbox/wt-lane.mjs\0--dir\0${laneDir}\0`)
    agePath(join(procRoot, '101', 'cmdline'))
    agePath(join(procRoot, '101'))
    agePath(procRoot)
    agePath(laneDir)
    agePath(cwd)

    const aliasedPayload = { ...(payload as Record<string, unknown>), cwd: alias }
    expect(blockText(runHook(aliasedPayload, { ...env, WT_QUEUE_GATE_PROC_ROOT: procRoot }))).toBe('')
  })

  it('keeps the existing idle verdict when /proc has no matching lane process', () => {
    const { env, payload, stateDir, cwd } = scaffold('no-live-external-lane')
    const procRoot = join(cwd, 'fake-proc')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    mkdirSync(join(procRoot, '101'), { recursive: true })
    writeFileSync(join(procRoot, '101', 'cmdline'), 'node\0worker.mjs\0')
    agePath(join(procRoot, '101', 'cmdline'))
    agePath(join(procRoot, '101'))
    agePath(procRoot)
    agePath(cwd)

    const r = runHook(payload, { ...env, WT_QUEUE_GATE_PROC_ROOT: procRoot })
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('no recent worktree activity')
  })

  it('names process inspection as unknown when it is unavailable', () => {
    const { env, payload, stateDir, cwd } = scaffold('live-external-lane-unavailable')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    agePath(cwd)

    const r = runHook(payload, { ...env, WT_QUEUE_GATE_PROC_ROOT: join(cwd, 'unreadable-proc') })
    expect(r.code).toBe(0)
    expect(blockText(r)).toContain('detached-runner /proc scan unavailable')
  })

  it('blocks despite a live shell background task and explains why it was not counted', () => {
    const { env, payload, stateDir, cwd } = scaffold('running-background-task')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    agePath(cwd)

    const r = runHook({
      ...(payload as Record<string, unknown>),
      background_tasks: [{ id: 'task-1', type: 'shell', status: 'running', name: 'quota monitor' }],
    }, env)
    const text = blockText(r)
    expect(text).toContain('open work remains')
    expect(text).toContain('1 harness background task is live')
    expect(text).toContain('Monitors and background jobs are indistinguishable in the Stop payload')
  })

  it('still blocks when the worktree is stale and no recent activity exists', () => {
    const { env, payload, stateDir, cwd } = scaffold('stale-worktree-idle')
    writeSnapshot(stateDir, cwd, { open: 6, at: Date.now(), next: 'CARD-6 idle item' })
    const staleFile = join(cwd, 'old-output.txt')
    writeFileSync(staleFile, 'old write', 'utf8')
    const staleDate = new Date(Date.now() - 15 * 60_000)
    utimesSync(staleFile, staleDate, staleDate)

    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    const text = blockText(r)
    expect(text).toContain('open work remains')
    expect(text).toContain('no recent worktree activity')
  })

  it('distinguishes observed idle, no git root, and a bounded-out activity scan', () => {
    const messages: Record<string, string> = {}

    const idle = scaffold('activity-status-idle')
    writeSnapshot(idle.stateDir, idle.cwd, { open: 6, at: Date.now(), next: 'activity item' })
    agePath(idle.cwd)
    messages.idle = blockText(runHook(idle.payload, idle.env))

    const noRoot = scaffold('activity-status-no-root')
    rmSync(join(noRoot.cwd, '.git'), { recursive: true, force: true })
    writeSnapshot(noRoot.stateDir, noRoot.cwd, { open: 6, at: Date.now(), next: 'activity item' })
    messages['no-root'] = blockText(runHook(noRoot.payload, noRoot.env))

    const bounded = scaffold('activity-status-bounded')
    writeSnapshot(bounded.stateDir, bounded.cwd, { open: 6, at: Date.now(), next: 'activity item' })
    for (let i = 0; i <= 4000; i += 1) {
      const path = join(bounded.cwd, `old-${i}.txt`)
      writeFileSync(path, 'old', 'utf8')
      agePath(path)
    }
    agePath(bounded.cwd)
    messages.bounded = blockText(runHook(bounded.payload, bounded.env))

    expect.soft(messages.idle).toContain('no recent worktree activity')
    expect.soft(messages['no-root']).toContain('Worktree activity is unknown — no git root resolved')
    expect.soft(messages.bounded).toContain('Worktree activity is unknown — scan bounded out')
    expect.soft(new Set(Object.values(messages)).size).toBe(3)
  })

  it('does not treat recent node_modules writes as in-flight worktree activity', () => {
    const { env, payload, stateDir, cwd } = scaffold('skip-node-modules')
    writeSnapshot(stateDir, cwd, { open: 8, at: Date.now(), next: 'CARD-8 real work item' })
    const recentDependencyFile = join(cwd, 'node_modules', 'pkg', 'index.js')
    mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(recentDependencyFile, 'dependency churn', 'utf8')

    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    const text = blockText(r)
    expect(text).toContain('open work remains')
    expect(text).toContain('no recent worktree activity')
    expect(text).toContain('8 open')
  })

  it('does not let a sibling worktree under an umbrella root silence this session', () => {
    const root = mkRoot('umbrella-neighbor-activity')
    const stateDir = join(root, 'queue-gate-state')
    const procRoot = join(root, 'fake-proc')
    const umbrella = join(root, 'umbrella')
    const driven = join(umbrella, 'worktrees', 'this-session')
    const sibling = join(umbrella, 'worktrees', 'other-session')
    const transcriptPath = join(root, 'transcript.jsonl')
    mkdirSync(driven, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    mkdirSync(procRoot)
    writeFileSync(join(driven, '.git'), 'gitdir: /dev/null\n', 'utf8')
    writeFileSync(join(sibling, '.git'), 'gitdir: /dev/null\n', 'utf8')
    writeFileSync(transcriptPath, '')
    writeSnapshot(stateDir, umbrella, { open: 5, at: Date.now(), next: 'CARD-5 scoped item' })
    writeFileSync(join(sibling, 'lane-output.txt'), 'neighbor session write', 'utf8')

    const r = runHook({
      hook_event_name: 'Stop',
      session_id: 'session-umbrella-neighbor-activity',
      cwd: umbrella,
      transcript_path: transcriptPath,
    }, {
      ...process.env,
      WT_QUEUE_GATE_DIR: stateDir,
      WT_QUEUE_GATE_PROC_ROOT: procRoot,
      HOME: root,
    })

    expect(r.code).toBe(0)
    const text = blockText(r)
    expect(text).toContain('open work remains')
    expect(text).toContain('Worktree activity is unknown — no git root resolved')
    expect(text).toContain('5 open')
  })

  it.skipIf(process.platform !== 'linux')('discovers live work in suite worktrees when cwd is a non-git umbrella [fixture supplies Linux /proc]', () => {
    const root = mkRoot('umbrella-live-lane')
    const stateDir = join(root, 'queue-gate-state')
    const procRoot = join(root, 'fake-proc')
    const umbrella = join(root, 'suite')
    const lane = join(umbrella, '.claude', 'worktrees', 'active-lane')
    const transcriptPath = join(root, 'transcript.jsonl')
    mkdirSync(lane, { recursive: true })
    mkdirSync(join(procRoot, '404'), { recursive: true })
    expect(spawnSync('git', ['init', '--quiet'], { cwd: lane }).status).toBe(0)
    writeFileSync(transcriptPath, '')
    writeSnapshot(stateDir, umbrella, { open: 5, at: Date.now(), next: 'CARD-5 scoped item' })
    writeFileSync(join(procRoot, '404', 'cmdline'), `node\0/opt/toolbox/wt-pilot-runner.mjs\0--dir\0${lane}\0`)
    agePath(join(procRoot, '404', 'cmdline'))
    agePath(join(procRoot, '404'))
    agePath(procRoot)
    agePath(lane)

    const r = runHook({
      hook_event_name: 'Stop',
      session_id: 'session-umbrella-live-lane',
      cwd: umbrella,
      transcript_path: transcriptPath,
    }, {
      ...process.env,
      WT_QUEUE_GATE_DIR: stateDir,
      WT_QUEUE_GATE_PROC_ROOT: procRoot,
      HOME: root,
    })

    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('suppresses an identical decision within 45 minutes and re-fires after that window', () => {
    const { env, payload, stateDir, cwd } = scaffold('identical-decision')
    const idlePayload = { ...(payload as Record<string, unknown>), background_tasks: [] }
    agePath(cwd)
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 first item' })

    expect(blockText(runHook(idlePayload, env))).toContain('4 open')
    const stateFile = join(stateDir, `session-identical-decision-${slug(cwd)}.json`)
    const emittedAt = (JSON.parse(readFileSync(stateFile, 'utf8')) as { lastBlockedAt: number }).lastBlockedAt
    expect(blockText(runHook(idlePayload, env))).toBe('')
    expect((JSON.parse(readFileSync(stateFile, 'utf8')) as { lastBlockedAt: number }).lastBlockedAt).toBe(emittedAt)

    const prior = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>
    writeFileSync(stateFile, JSON.stringify({ ...prior, lastBlockedAt: Date.now() - 46 * 60_000 }))
    expect(blockText(runHook(idlePayload, env))).toContain('4 open')

    writeSnapshot(stateDir, cwd, { open: 3, at: Date.now(), next: 'CARD-5 changed item' })
    expect(blockText(runHook(idlePayload, env))).toContain('3 open')
  })

  it('the emitted additionalContext is at most 6 lines', () => {
    const { env, payload, stateDir, cwd } = scaffold('length-lock')
    writeSnapshot(stateDir, cwd, { open: 5, at: Date.now(), next: 'CARD-2 length lock item' })
    const r = runHook(payload, env)
    const text = blockText(r)
    expect(text).not.toBe('')
    // ⚠ RED PROOF, run once by hand before this assertion was accepted (per the card's own
    // test-lock requirement): reverting the emission edit and re-running this file against the
    // OLD stderr message (12+ lines) fails this assertion — the lock is not decorative.
    expect(text.split('\n').length).toBeLessThanOrEqual(6)
  })

  it('the block still fires with an UNKNOWN (stale) snapshot, message included', () => {
    const { env, payload, stateDir, cwd } = scaffold('unknown-state')
    // No snapshot written at all ⇒ hook has nothing wired ⇒ silent (see hook header, "NO
    // TRACKER"). Write a STALE one instead so the UNKNOWN branch of the message is exercised.
    writeSnapshot(stateDir, cwd, { open: 2, at: Date.now() - 3 * 60 * 60 * 1000, next: '' })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    const text = blockText(r)
    expect(text).toContain('Queue size is unknown')
  })

  // Card 1837879927592977538: STALE and MALFORMED used to share the identical text ("Queue size
  // is unknown (stale snapshot)"), even when the marker was corrupt rather than merely old — two
  // different remedies (repair a broken write vs. just re-read the queue) hidden behind one
  // word. The lock below asserts the INVARIANT — every distinct queue status this hook computes
  // produces a message distinct from every other status' message — over the whole set the code
  // defines, not a hard-coded pair, so a status added later that forgets to differentiate its
  // text fails this test rather than silently joining the collapse it was meant to prevent.
  it('every distinct queue status produces a message distinct from every other status', () => {
    // Each fixture writer produces ONE way of reaching its status. 'malformed' has TWO
    // independent producers (corrupt JSON text; well-formed JSON with a wrong field shape) —
    // both must land on the SAME message as each other (same status), while STALE must land on
    // a DIFFERENT message than either (different status). This is the invariant, checked over
    // the whole set the code defines — not a hard-coded pair — so a status added later that
    // forgets to differentiate its text fails here instead of silently rejoining the collapse.
    const fixtures: Record<string, (stateDir: string, cwd: string) => void> = {
      stale: (stateDir, cwd) =>
        writeSnapshot(stateDir, cwd, { open: 2, at: Date.now() - 3 * 60 * 60 * 1000, next: '' }),
      'malformed (corrupt JSON)': (stateDir, cwd) => {
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(join(stateDir, `queue-${slug(cwd)}.json`), '{not json', 'utf8')
      },
      'malformed (wrong field types)': (stateDir, cwd) =>
        writeSnapshot(stateDir, cwd, { open: 'lots', at: Date.now(), next: '' }),
    }

    const byLabel: Record<string, string> = {}
    for (const [label, write] of Object.entries(fixtures)) {
      const { env, payload, stateDir, cwd } = scaffold(`status-${label.replace(/\W+/g, '-')}`)
      write(stateDir, cwd)
      const r = runHook(payload, env)
      expect(r.code).toBe(0)
      const text = blockText(r)
      expect(text).not.toBe('') // every fixture here is expected to block
      byLabel[label] = text
    }

    const stale = byLabel.stale
    const malformedA = byLabel['malformed (corrupt JSON)']
    const malformedB = byLabel['malformed (wrong field types)']
    expect(malformedA).toBe(malformedB) // same STATUS ⇒ same text, regardless of producer
    expect(stale).not.toBe(malformedA) // different STATUS ⇒ different text — the fix itself
    expect(stale).toContain('stale')
    expect(malformedA).toContain('unreadable/malformed')
    expect(stale).not.toContain('unreadable/malformed')
    expect(malformedA).not.toContain('stale')
  })

  it('names the companion help file, and that file exists on disk', () => {
    const { env, payload, stateDir, cwd } = scaffold('help-pointer')
    writeSnapshot(stateDir, cwd, { open: 1, at: Date.now(), next: '' })
    const r = runHook(payload, env)
    const text = blockText(r)
    expect(text).toContain('wt-queue-not-empty-gate-hook.help.md')
    expect(existsSync(HELP_FILE)).toBe(true)
    expect(readFileSync(HELP_FILE, 'utf8').length).toBeGreaterThan(0)
  })

  it('stays silent when the queue is genuinely empty', () => {
    const { env, payload, stateDir, cwd } = scaffold('empty-queue')
    writeSnapshot(stateDir, cwd, { open: 0, at: Date.now(), next: '' })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('stays silent with no snapshot ever written (no tracker wired)', () => {
    const { env, payload } = scaffold('no-tracker')
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })
})

describe('plugin manifest wiring', () => {
  it('registers wt-queue-not-empty-gate-hook.mjs on Stop, alongside wt-actionable-gate-hook.mjs (register-not-retire)', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8'),
    ) as { hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> } }
    const commands = (manifest.hooks?.Stop ?? [])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? '')
    expect(commands.some((c) => c.includes('wt-queue-not-empty-gate-hook.mjs'))).toBe(true)
    expect(commands.some((c) => c.includes('wt-actionable-gate-hook.mjs'))).toBe(true)
  })
})
