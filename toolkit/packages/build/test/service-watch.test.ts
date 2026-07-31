// service-watch.test.ts — behavior gates for plugin/bin/wt-service-watch.mjs,
// plugin/bin/lib/service-flag.mjs, and the flag-consulting change in
// plugin/bin/wt-arc-watch.mjs.
//
// WHAT THIS PROTECTS. During a real Anthropic outage every other monitor keeps
// running (they are scripts, nothing stops them), and their events become
// noise the session cannot reason about. wt-service-watch.mjs maintains a
// flag file the other monitors consult to fall silent meanwhile. The single
// most dangerous failure mode is the inverse of the feature: a PROBE failure
// (network down, bad JSON, HTTP error) must never be read as an outage, or a
// transient blip would blind every monitor on the machine. That is why "probe
// failure never writes/deletes the flag" gets as much coverage below as the
// happy path.
//
// Every case drives the REAL scripts as child processes (spawnSync), never
// the network — payloads are injected via `--fixture <path>` (wt-service-watch.mjs
// reads a local JSON file instead of fetching). `--once` runs a single poll
// iteration and exits, so transitions are tested by chaining several `--once`
// invocations against the same `--flag` path, exactly the way the real
// process would see them across successive polls.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SERVICE_WATCH = join(REPO_ROOT, 'plugin/bin/wt-service-watch.mjs')
const ARC_WATCH = join(REPO_ROOT, 'plugin/bin/wt-arc-watch.mjs')
const MONITORS_JSON = join(REPO_ROOT, 'plugin/monitors/monitors.json')
const SERVICE_FLAG_LIB = join(REPO_ROOT, 'plugin/bin/lib/service-flag.mjs')
const QUOTA_WATCH = join(REPO_ROOT, 'plugin/bin/wt-quota-watch.mjs')
const QUOTA_CACHE_LIB = join(REPO_ROOT, 'plugin/bin/lib/quota-cache.mjs')
const QUOTA_BACKOFF_LIB = join(REPO_ROOT, 'plugin/bin/lib/quota-backoff.mjs')

// Vite's own module resolution intercepts a direct dynamic `import()` of a
// path outside the toolkit project root (it tries to resolve it as a
// project-relative id and fails, file:// URL or not). Driving a real `node`
// child process sidesteps Vite entirely — and matches this file's own
// house rule of exercising the REAL script, not a bundler's view of it.
function readDegradedViaChildProcess(flagPath: string): unknown {
  const res = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { isServiceDegraded } from ${JSON.stringify(pathToFileURL(SERVICE_FLAG_LIB).href)};
       const r = await isServiceDegraded(${JSON.stringify(flagPath)});
       process.stdout.write(JSON.stringify(r === false ? false : r));`,
    ],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) throw new Error(`probe child failed: ${res.stderr}`)
  return JSON.parse(res.stdout)
}

// Same Vite-external-path rationale as readDegradedViaChildProcess above, applied to the
// two quota-watch helper libs.
function readQuotaCacheViaChildProcess(cachePath: string, ttlMs?: number): unknown {
  const res = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { readQuotaCache } from ${JSON.stringify(pathToFileURL(QUOTA_CACHE_LIB).href)};
       const r = await readQuotaCache(${JSON.stringify(cachePath)}${ttlMs !== undefined ? `, ${ttlMs}` : ''});
       process.stdout.write(JSON.stringify(r));`,
    ],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) throw new Error(`quota-cache read child failed: ${res.stderr}`)
  return JSON.parse(res.stdout)
}

function writeQuotaCacheViaChildProcess(cachePath: string, data: unknown): void {
  const res = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { writeQuotaCacheAtomic } from ${JSON.stringify(pathToFileURL(QUOTA_CACHE_LIB).href)};
       await writeQuotaCacheAtomic(${JSON.stringify(cachePath)}, ${JSON.stringify(data)});`,
    ],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) throw new Error(`quota-cache write child failed: ${res.stderr}`)
}

function computeBackoffViaChildProcess(pollSeconds: number, consecutiveFailures: number): number {
  const res = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { computeBackoffMs } from ${JSON.stringify(pathToFileURL(QUOTA_BACKOFF_LIB).href)};
       process.stdout.write(JSON.stringify(computeBackoffMs(${pollSeconds}, ${consecutiveFailures})));`,
    ],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) throw new Error(`backoff child failed: ${res.stderr}`)
  return JSON.parse(res.stdout)
}

// Real OS-level concurrency (not just interleaved promises in one event loop) — the
// property under test is whether several independent PROCESSES writing the same cache
// path can ever leave a reader with a torn/partial file, which an in-process Promise.all
// would not exercise faithfully (one process, one fs driver, naturally serialized syscalls).
function writeQuotaCacheAsync(cachePath: string, data: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `import { writeQuotaCacheAtomic } from ${JSON.stringify(pathToFileURL(QUOTA_CACHE_LIB).href)};
       await writeQuotaCacheAtomic(${JSON.stringify(cachePath)}, ${JSON.stringify(data)});`,
    ])
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`concurrent writer failed: ${stderr}`))
    })
  })
}

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function writeFixture(dir: string, name: string, payload: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, typeof payload === 'string' ? payload : JSON.stringify(payload))
  return p
}

function operationalPayload() {
  return {
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [
      { name: 'Claude API (api.anthropic.com)', status: 'operational' },
      { name: 'Claude Code', status: 'operational' },
      { name: 'claude.ai', status: 'operational' },
    ],
    incidents: [],
  }
}

function degradedApiPayload() {
  return {
    status: { indicator: 'major', description: 'Major Service Outage' },
    components: [
      { name: 'Claude API (api.anthropic.com)', status: 'major_outage' },
      { name: 'Claude Code', status: 'operational' },
      { name: 'claude.ai', status: 'operational' },
    ],
    incidents: [
      {
        name: 'Elevated errors on the API',
        impact: 'major',
        status: 'investigating',
        started_at: '2026-07-30T00:00:00Z',
        incident_updates: [{ body: 'We are investigating elevated error rates.' }],
      },
    ],
  }
}

function claudeAiOnlyDegradedPayload() {
  return {
    status: { indicator: 'minor', description: 'Minor Service Outage' },
    components: [
      { name: 'Claude API (api.anthropic.com)', status: 'operational' },
      { name: 'Claude Code', status: 'operational' },
      { name: 'claude.ai', status: 'partial_outage' },
    ],
    incidents: [],
  }
}

function missingGatedComponentsPayload() {
  return {
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [{ name: 'claude.ai', status: 'operational' }],
    incidents: [],
  }
}

function runOnce(args: string[], env: Record<string, string | undefined> = {}) {
  const res = spawnSync(process.execPath, [SERVICE_WATCH, '--once', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  })
  return { stdout: res.stdout, stderr: res.stderr, status: res.status }
}

function readFlag(flagPath: string) {
  return JSON.parse(readFileSync(flagPath, 'utf8'))
}

describe('wt-service-watch: writes the flag on real degradation', () => {
  it('a degraded API component writes the flag with the right shape', () => {
    const dir = tmpRoot('wt-service-watch-')
    const fixture = writeFixture(dir, 'payload.json', degradedApiPayload())
    const flagPath = join(dir, 'flag.json')
    const r = runOnce(['--fixture', fixture, '--flag', flagPath])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SERVICE DEGRADED')
    expect(r.stdout).toContain('Claude API (api.anthropic.com)')
    expect(existsSync(flagPath)).toBe(true)
    const flag = readFlag(flagPath)
    expect(flag.since).toBeTruthy()
    expect(flag.expiresAt).toBeTruthy()
    expect(flag.indicator).toBe('major')
    expect(flag.components).toContain('Claude API (api.anthropic.com)')
    expect(flag.incident?.update).toContain('investigating')
    expect(typeof flag.writtenBy).toBe('number')
    expect(flag.writtenAt).toBeTruthy()
  })

  it('an operational payload does not write a flag', () => {
    const dir = tmpRoot('wt-service-watch-')
    const fixture = writeFixture(dir, 'payload.json', operationalPayload())
    const flagPath = join(dir, 'flag.json')
    const r = runOnce(['--fixture', fixture, '--flag', flagPath])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(existsSync(flagPath)).toBe(false)
  })
})

describe('wt-service-watch: invariant 2 — only the gated components count', () => {
  it('claude.ai degraded ALONE does not write a flag', () => {
    const dir = tmpRoot('wt-service-watch-')
    const fixture = writeFixture(dir, 'payload.json', claudeAiOnlyDegradedPayload())
    const flagPath = join(dir, 'flag.json')
    const r = runOnce(['--fixture', fixture, '--flag', flagPath])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(existsSync(flagPath)).toBe(false)
  })

  it('a payload missing BOTH gated components is a probe failure, not all-clear', () => {
    const dir = tmpRoot('wt-service-watch-')
    const fixture = writeFixture(dir, 'payload.json', missingGatedComponentsPayload())
    const flagPath = join(dir, 'flag.json')
    const r = runOnce(['--fixture', fixture, '--flag', flagPath])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('') // no DEGRADED / RECOVERED transition line
    expect(r.stderr).toContain('SERVICE WATCH PROBE FAILED')
    expect(existsSync(flagPath)).toBe(false)
  })
})

describe('wt-service-watch: invariant 1 — a failed probe is never an outage', () => {
  it('an unreadable fixture (network-failure stand-in) does not write a flag', () => {
    const dir = tmpRoot('wt-service-watch-')
    const flagPath = join(dir, 'flag.json')
    const r = runOnce(['--fixture', join(dir, 'does-not-exist.json'), '--flag', flagPath])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('SERVICE WATCH PROBE FAILED')
    expect(existsSync(flagPath)).toBe(false)
  })

  it('malformed JSON does not write a flag', () => {
    const dir = tmpRoot('wt-service-watch-')
    const fixture = writeFixture(dir, 'payload.json', '{ not valid json')
    const flagPath = join(dir, 'flag.json')
    const r = runOnce(['--fixture', fixture, '--flag', flagPath])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('SERVICE WATCH PROBE FAILED')
    expect(existsSync(flagPath)).toBe(false)
  })

  it('a probe failure does NOT delete an already-live flag', () => {
    const dir = tmpRoot('wt-service-watch-')
    const flagPath = join(dir, 'flag.json')
    // First poll: real degradation, flag gets written.
    const fixtureDegraded = writeFixture(dir, 'degraded.json', degradedApiPayload())
    const r1 = runOnce(['--fixture', fixtureDegraded, '--flag', flagPath])
    expect(existsSync(flagPath)).toBe(true)
    const before = readFlag(flagPath)

    // Second poll: probe fails (fixture removed/unreadable). Flag must survive untouched.
    const r2 = runOnce(['--fixture', join(dir, 'does-not-exist.json'), '--flag', flagPath])
    expect(r2.stderr).toContain('SERVICE WATCH PROBE FAILED')
    expect(existsSync(flagPath)).toBe(true)
    const after = readFlag(flagPath)
    expect(after).toEqual(before)
    void r1
  })
})

describe('wt-service-watch: invariant 3 — the flag fails open and expires', () => {
  it('an EXPIRED flag reads as not-degraded via the shared reader', async () => {
    const dir = tmpRoot('wt-service-watch-')
    const flagPath = join(dir, 'flag.json')
    writeFileSync(
      flagPath,
      JSON.stringify({
        since: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        indicator: 'major',
        components: ['Claude API (api.anthropic.com)'],
        incident: null,
        writtenBy: 1,
        writtenAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    )
    expect(readDegradedViaChildProcess(flagPath)).toBe(false)
  })

  it('a malformed / truncated flag file reads as not-degraded', async () => {
    const dir = tmpRoot('wt-service-watch-')
    const flagPath = join(dir, 'flag.json')
    writeFileSync(flagPath, '{ "since": "2026-01-01T00:00:00Z", "expi')
    expect(readDegradedViaChildProcess(flagPath)).toBe(false)
  })

  it('a missing flag file reads as not-degraded', async () => {
    const dir = tmpRoot('wt-service-watch-')
    expect(readDegradedViaChildProcess(join(dir, 'nope.json'))).toBe(false)
  })

  it('a live (non-expired) flag reads as degraded and carries its payload', async () => {
    const dir = tmpRoot('wt-service-watch-')
    const flagPath = join(dir, 'flag.json')
    writeFileSync(
      flagPath,
      JSON.stringify({
        since: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        indicator: 'major',
        components: ['Claude Code'],
        incident: null,
        writtenBy: 1,
        writtenAt: new Date().toISOString(),
      }),
    )
    const flag = readDegradedViaChildProcess(flagPath)
    expect(flag).not.toBe(false)
    expect((flag as { components: string[] }).components).toEqual(['Claude Code'])
  })
})

describe('wt-service-watch: transitions emit exactly once, steady state emits nothing', () => {
  it('healthy → degraded → degraded (steady) → healthy, chained across --once polls', () => {
    const dir = tmpRoot('wt-service-watch-')
    const flagPath = join(dir, 'flag.json')
    const opFixture = writeFixture(dir, 'op.json', operationalPayload())
    const degFixture = writeFixture(dir, 'deg.json', degradedApiPayload())

    // Poll 1: healthy, nothing was ever degraded → silence.
    const p1 = runOnce(['--fixture', opFixture, '--flag', flagPath])
    expect(p1.stdout).toBe('')
    expect(existsSync(flagPath)).toBe(false)

    // Poll 2: transition to degraded → exactly one DEGRADED line.
    const p2 = runOnce(['--fixture', degFixture, '--flag', flagPath])
    expect(p2.stdout).toContain('SERVICE DEGRADED')
    expect(existsSync(flagPath)).toBe(true)
    const firstSince = readFlag(flagPath).since

    // Poll 3: still degraded (steady state) → no new DEGRADED line, but the
    // flag refreshes (expiresAt moves, `since` is preserved).
    const p3 = runOnce(['--fixture', degFixture, '--flag', flagPath])
    expect(p3.stdout).toBe('')
    expect(readFlag(flagPath).since).toBe(firstSince)

    // Poll 4: transition back to healthy → exactly one RECOVERED line, flag removed.
    const p4 = runOnce(['--fixture', opFixture, '--flag', flagPath])
    expect(p4.stdout).toContain('SERVICE RECOVERED')
    expect(existsSync(flagPath)).toBe(false)

    // Poll 5: healthy (steady state) → silence again.
    const p5 = runOnce(['--fixture', opFixture, '--flag', flagPath])
    expect(p5.stdout).toBe('')
  })
})

describe('wt-service-watch: flag write is atomic (no partial JSON)', () => {
  it('the flag file, once present, always parses — no .tmp leftovers', () => {
    const dir = tmpRoot('wt-service-watch-')
    const flagPath = join(dir, 'flag.json')
    const degFixture = writeFixture(dir, 'deg.json', degradedApiPayload())
    runOnce(['--fixture', degFixture, '--flag', flagPath])
    expect(() => readFlag(flagPath)).not.toThrow()
    const leftovers = readdirSync(dir).filter((f: string) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('wt-service-watch: --help documents the cadence knobs', () => {
  it('prints the flags and their defaults, exit 0', () => {
    const res = spawnSync(process.execPath, [SERVICE_WATCH, '--help'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('--poll-healthy')
    expect(res.stdout).toContain('--poll-degraded')
    expect(res.stdout).toContain('--expiry')
  })
})

describe('wt-arc-watch: suppresses emission while the service flag is live, resumes without backlog', () => {
  function projectDir(): string {
    return tmpRoot('wt-arc-watch-project-')
  }

  function configDirWithFlag(project: string, degraded: boolean): string {
    const configDir = join(project, '.claude-config')
    mkdirSync(configDir, { recursive: true })
    if (degraded) {
      writeFileSync(
        join(configDir, '.wt-service-degraded.json'),
        JSON.stringify({
          since: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          indicator: 'major',
          components: ['Claude API (api.anthropic.com)'],
          incident: null,
          writtenBy: 1,
          writtenAt: new Date().toISOString(),
        }),
      )
    }
    return configDir
  }

  function projectSlug(dir: string): string {
    return dir.replace(/[^A-Za-z0-9-]/g, '-')
  }

  // These tests exercise the SERVICE-FLAG suppression path, not arc-watch's
  // own delegation gate (see the dedicated describe block below) — so they
  // must not inherit whatever CLAUDE_CODE_SESSION_ID happens to be set in the
  // env this test process itself runs under. Running the suite from inside a
  // live Claude Code session (as opposed to plain CI) leaks a real session id
  // into spawnSync's `...process.env`, and that id has no matching subagents
  // dir under the fresh tmp configDir here — the gate would then hold the
  // watcher silent for the whole sampling window, and the assertions below
  // would fail for a reason unrelated to what they test. Stripping the var
  // restores the "no session id known → arm immediately" fallback.
  function envWithoutSessionId(configDir: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir }
    delete env.CLAUDE_CODE_SESSION_ID
    return env
  }

  function makeStaleTranscript(configDir: string, project: string, sessionId: string, agentFile: string) {
    const dir = join(configDir, 'projects', projectSlug(project), sessionId, 'subagents')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, agentFile)
    writeFileSync(file, '{}')
    // Push the mtime into the past so it is already "stale" at arming — this
    // keeps the baseline-suppression logic out of the way; the test cares
    // about service-flag suppression, not arc-watch's own baseline rules.
    const old = new Date(Date.now() - 20 * 60_000)
    utimesSync(file, old, old)
    return file
  }

  it('a live flag suppresses ALL stdout (including the ARMED banner)', () => {
    const project = projectDir()
    const configDir = configDirWithFlag(project, true)
    makeStaleTranscript(configDir, project, 'sess-1', 'agent-a.jsonl')

    const res = spawnSync(process.execPath, [ARC_WATCH, '--project', project, '--poll', '5', '--stale', '1'], {
      encoding: 'utf8',
      env: envWithoutSessionId(configDir),
      timeout: 8_000, // the watcher loops forever; we only sample its early output
    })
    // spawnSync with a timeout kills the process; stdout collected up to the kill is what we check.
    expect(res.stdout).toBe('')
  })

  it('once the flag clears, the watcher resumes and reports only NEW state, not a backlog', () => {
    const project = projectDir()
    const configDir = configDirWithFlag(project, false) // starts clear
    const agentFile = makeStaleTranscript(configDir, project, 'sess-1', 'agent-a.jsonl')
    void agentFile

    // No flag at all: normal operation, ARMED line must appear promptly.
    const res = spawnSync(process.execPath, [ARC_WATCH, '--project', project, '--poll', '5', '--stale', '1'], {
      encoding: 'utf8',
      env: envWithoutSessionId(configDir),
      timeout: 3_000,
    })
    expect(res.stdout).toContain('ARC WATCH ARMED')
    // The already-stale transcript is baseline (arc-watch's own rule, not
    // service-flag-related) so it should NOT be individually reported as a
    // fresh STALE event — confirming the baseline sweep, not a backlog dump.
    expect(res.stdout).not.toContain('STALE: sess-1/agent-a.jsonl')
  })
})

describe('wt-arc-watch: gated on THIS session\'s own first delegation, not on process start', () => {
  // What this protects: 2026-07-30, a read-only relay (front desk) armed
  // delegated-arc-watch and received a STALE analysis it had no way to act
  // on, BEFORE it had even received its own role. The manifest can only say
  // `"when": "always"` (Claude Code's monitor schema has no other trigger —
  // see the header comment in plugin/bin/wt-arc-watch.mjs), so the fix lives
  // inside the script: withhold every line, including the ARMED banner,
  // until THIS session (identified by CLAUDE_CODE_SESSION_ID) has itself
  // spawned at least one subagent. A session that never delegates then never
  // emits anything, for its whole lifetime — while a session that DOES
  // delegate must still always end up covered, however late.

  function projectDir(): string {
    return tmpRoot('wt-arc-watch-gate-project-')
  }

  function freshConfigDir(project: string): string {
    const configDir = join(project, '.claude-config')
    mkdirSync(configDir, { recursive: true })
    return configDir
  }

  function projectSlug(dir: string): string {
    return dir.replace(/[^A-Za-z0-9-]/g, '-')
  }

  it('a session with a known id and no delegation yet stays fully silent', () => {
    const project = projectDir()
    const configDir = freshConfigDir(project)

    const res = spawnSync(process.execPath, [ARC_WATCH, '--project', project, '--poll', '5', '--stale', '1'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_SESSION_ID: 'relay-session-under-test' },
      timeout: 3_000, // the watcher loops forever; sampling confirms silence, not exit
    })
    expect(res.stdout).toBe('')
  })

  it('the SAME session delegating mid-run opens the gate and arms live — coverage is never lost', () => {
    // Real wall-clock time: the gate polls at 5s (the script's own poll-second
    // minimum), and this test waits out two such polls plus slack.
    const project = projectDir()
    const configDir = freshConfigDir(project)
    const sessionId = 'main-session-under-test'
    const subagentsDir = join(configDir, 'projects', projectSlug(project), sessionId, 'subagents')

    // Start silent — the session has not delegated yet.
    // Then, while the SAME watcher process is still running its gate-poll
    // loop, create the session's own first transcript. `--poll 5` bounds the
    // gate's own check interval (min(pollSeconds, 30s) per the script), so a
    // watcher started now must observe the delegation and arm within a few
    // polls — not require a restart.
    mkdirSync(subagentsDir, { recursive: true })
    const res = spawnSync(
      process.execPath,
      ['-e', `
        const { spawn } = require('node:child_process')
        const child = spawn(process.execPath, [${JSON.stringify(ARC_WATCH)}, '--project', ${JSON.stringify(project)}, '--poll', '5', '--stale', '1'], {
          env: { ...process.env, CLAUDE_CONFIG_DIR: ${JSON.stringify(configDir)}, CLAUDE_CODE_SESSION_ID: ${JSON.stringify(sessionId)} },
        })
        let out = ''
        child.stdout.on('data', (d) => { out += d })
        setTimeout(() => {
          require('node:fs').writeFileSync(${JSON.stringify(join(subagentsDir, 'agent-live.jsonl'))}, '{}')
        }, 500)
        setTimeout(() => {
          child.kill()
          process.stdout.write(out)
          process.exit(0)
        }, 11_000)
      `],
      { encoding: 'utf8', timeout: 14_000 },
    )
    expect(res.stdout).toContain('ARC WATCH ARMED')
  }, 18_000)
})

describe('monitors.json registers the new monitor', () => {
  it('lists service-status-watch pointing at wt-service-watch.mjs', () => {
    const monitors = JSON.parse(readFileSync(MONITORS_JSON, 'utf8'))
    const entry = monitors.find((m: { name: string }) => m.name === 'service-status-watch')
    expect(entry).toBeTruthy()
    expect(entry.command).toContain('wt-service-watch.mjs')
    expect(entry.when).toBe('always')
  })

  it('lists quota-watch pointing at wt-quota-watch.mjs, armed unconditionally', () => {
    // Unlike delegated-arc-watch, quota concerns EVERY session unconditionally
    // (not just ones that delegate), so it keeps "when": "always" rather than
    // gaining a gate — see the card decision recorded 2026-07-30.
    const monitors = JSON.parse(readFileSync(MONITORS_JSON, 'utf8'))
    const entry = monitors.find((m: { name: string }) => m.name === 'quota-watch')
    expect(entry).toBeTruthy()
    expect(entry.command).toContain('wt-quota-watch.mjs')
    expect(entry.when).toBe('always')
  })

  it('wt-quota-watch.mjs fails loud, not silently, when an explicit --probe is missing', () => {
    const QUOTA_WATCH = join(REPO_ROOT, 'plugin/bin/wt-quota-watch.mjs')
    const res = spawnSync(process.execPath, [QUOTA_WATCH, '--probe', join(tmpRoot('wt-quota-watch-'), 'does-not-exist.mjs')], {
      encoding: 'utf8',
      timeout: 3_000,
    })
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('QUOTA WATCH FAILED')
    expect(res.stdout).toContain('--probe override')
    expect(res.stdout).toContain('quota is NOT being watched')
  })

  // The watcher now resolves its probe through THREE levels. The level that matters is the
  // one nobody exercises by hand: with no user probe, it must land on the BUNDLED file — and
  // that file must actually be there. A rename or a missed package include would otherwise
  // surface only at run time, on a user's machine, as a watcher that arms and never reports.
  it('ships the bundled probe the watcher falls back to', () => {
    const BUNDLED = join(REPO_ROOT, 'plugin/bin/wt-quota-probe.mjs')
    expect(existsSync(BUNDLED)).toBe(true)
    const src = readFileSync(BUNDLED, 'utf8')
    // Shipped surface: no author-machine paths, and no author-locale date formatting.
    expect(src).not.toMatch(/\/home\/[a-z]/i)
    expect(src).not.toContain("'fr-FR'")
  })

  it('falls back to the bundled probe when the config dir has none', () => {
    const emptyConfig = tmpRoot('wt-quota-empty-config-')
    const res = spawnSync(process.execPath, [join(REPO_ROOT, 'plugin/bin/wt-quota-watch.mjs'), '--poll', '5', '--timeout', '1'], {
      encoding: 'utf8',
      timeout: 8_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: emptyConfig },
      killSignal: 'SIGKILL',
    })
    // It must ARM on the bundled probe — never exit 1 "probe not found", which is what the
    // old `<configDir>/scripts/quota-usage.mjs`-only default did for every adopter.
    expect(res.stdout).toContain('QUOTA WATCH ARMED')
    expect(res.stdout).toContain('source=bundled probe')
    expect(res.stdout).not.toContain('QUOTA WATCH FAILED')
  })

  it('prefers a user probe over the bundled one when both exist', () => {
    const cfg = tmpRoot('wt-quota-user-probe-')
    mkdirSync(join(cfg, 'scripts'), { recursive: true })
    writeFileSync(join(cfg, 'scripts', 'quota-usage.mjs'), 'process.exit(2)\n')
    const res = spawnSync(process.execPath, [join(REPO_ROOT, 'plugin/bin/wt-quota-watch.mjs'), '--poll', '5', '--timeout', '1'], {
      encoding: 'utf8',
      timeout: 8_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
      killSignal: 'SIGKILL',
    })
    expect(res.stdout).toContain('source=user config probe')
  })
})

// -----------------------------------------------------------------------------------
// quota-cache.mjs / quota-backoff.mjs — root-caused a live HTTP 429 (2026-07-31): every
// watcher hit the usage endpoint live on every poll, with no coordination with the
// per-turn hook's own cache or with other watchers/sessions on the same account. See the
// header comments in plugin/bin/wt-quota-watch.mjs and plugin/bin/lib/quota-cache.mjs for
// the full rationale. Unit tests below exercise the two libs directly (fast, no
// wall-clock); the wt-quota-watch.mjs describe block below that drives the real watcher
// end-to-end against fake probes, never the live network.
// -----------------------------------------------------------------------------------

describe('quota-cache: fail-open on anything but a fresh, structurally valid reading', () => {
  it('a missing file is a cache miss, not a crash', () => {
    const dir = tmpRoot('wt-quota-cache-')
    expect(readQuotaCacheViaChildProcess(join(dir, 'nope.json'))).toBeNull()
  })

  it('corrupt / truncated JSON is a cache miss', () => {
    const dir = tmpRoot('wt-quota-cache-')
    const cachePath = join(dir, '.quota-cache.json')
    writeFileSync(cachePath, '{ "at": 123, "dat')
    expect(readQuotaCacheViaChildProcess(cachePath)).toBeNull()
  })

  it.each([
    ['missing at', { data: { five_hour: { pct: 1 } } }],
    ['at not a number', { at: 'now', data: { five_hour: { pct: 1 } } }],
    ['missing data', { at: Date.now() }],
    ['data is an array', { at: Date.now(), data: [] }],
    ['data is null', { at: Date.now(), data: null }],
    ['top-level array', [1, 2, 3]],
  ])('a foreign/malformed shape (%s) is a cache miss, never a fabricated reading', (_label, payload) => {
    const dir = tmpRoot('wt-quota-cache-')
    const cachePath = join(dir, '.quota-cache.json')
    writeFileSync(cachePath, JSON.stringify(payload))
    expect(readQuotaCacheViaChildProcess(cachePath)).toBeNull()
  })

  it('a fresh, valid write is readable back with the same data — the hook/watcher share format', () => {
    const dir = tmpRoot('wt-quota-cache-')
    const cachePath = join(dir, '.quota-cache.json')
    const data = { configDir: dir, five_hour: { pct: 33, reset_local: '12:30' }, seven_day: { pct: 12 } }
    writeQuotaCacheViaChildProcess(cachePath, data)
    const read = readQuotaCacheViaChildProcess(cachePath) as { data: unknown; at: number; fresh: boolean }
    expect(read).not.toBeNull()
    expect(read.data).toEqual(data)
    expect(read.fresh).toBe(true)
    expect(typeof read.at).toBe('number')
  })

  it('a reading older than the TTL is returned but marked NOT fresh', () => {
    const dir = tmpRoot('wt-quota-cache-')
    const cachePath = join(dir, '.quota-cache.json')
    writeFileSync(cachePath, JSON.stringify({ at: Date.now() - 10_000, data: { five_hour: { pct: 1 } } }))
    const read = readQuotaCacheViaChildProcess(cachePath, 5_000) as { fresh: boolean } // 5s TTL, 10s old
    expect(read).not.toBeNull()
    expect(read.fresh).toBe(false)
  })

  it('write is atomic: no .tmp leftovers, and the file always parses once present', () => {
    const dir = tmpRoot('wt-quota-cache-')
    const cachePath = join(dir, '.quota-cache.json')
    writeQuotaCacheViaChildProcess(cachePath, { five_hour: { pct: 1 } })
    expect(() => JSON.parse(readFileSync(cachePath, 'utf8'))).not.toThrow()
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('concurrent writers never leave a torn/partial file readable', async () => {
    const dir = tmpRoot('wt-quota-cache-')
    const cachePath = join(dir, '.quota-cache.json')
    const WRITERS = 24
    // Distinct, sizeable payloads (padding varies per writer) so a naive non-atomic
    // implementation (write-in-place instead of tmp+rename) would have a real chance of
    // interleaving two writers' bytes into one unparseable file.
    const writes = Array.from({ length: WRITERS }, (_, i) =>
      writeQuotaCacheAsync(cachePath, { writer: i, pad: 'x'.repeat(200 + i * 37), five_hour: { pct: i } }),
    )

    // Sample the file WHILE writers are racing: every non-empty read must parse and must
    // be a WHOLE writer's payload, never a mix of two.
    let sawAny = false
    const sampler = (async () => {
      for (let i = 0; i < 150; i += 1) {
        if (existsSync(cachePath)) {
          let raw: string
          try {
            raw = readFileSync(cachePath, 'utf8')
          } catch {
            continue // ENOENT mid-rename race is fine — the file simply isn't there yet
          }
          if (raw.length > 0) {
            sawAny = true
            const parsed = JSON.parse(raw) // throws (test failure) on a torn read
            expect(typeof parsed.at).toBe('number')
            expect(typeof parsed.data.writer).toBe('number')
            expect(parsed.data.pad.length).toBe(200 + parsed.data.writer * 37)
          }
        }
        await new Promise((r) => setTimeout(r, 5))
      }
    })()

    await Promise.all([...writes, sampler])

    // Final state: still a single, whole, valid reading from exactly one writer.
    const final = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(typeof final.data.writer).toBe('number')
    expect(final.data.writer).toBeGreaterThanOrEqual(0)
    expect(final.data.writer).toBeLessThan(WRITERS)
    expect(sawAny).toBe(true)
  })
})

describe('quota-backoff: grows on failure, capped, immediate at zero failures', () => {
  it('zero (or invalid) consecutive failures means the normal poll cadence', () => {
    expect(computeBackoffViaChildProcess(300, 0)).toBe(300_000)
    expect(computeBackoffViaChildProcess(300, -5)).toBe(300_000)
  })

  it('doubles per failure up to the 8x cap', () => {
    expect(computeBackoffViaChildProcess(300, 1)).toBe(600_000) // 2x
    expect(computeBackoffViaChildProcess(300, 2)).toBe(1_200_000) // 4x
    expect(computeBackoffViaChildProcess(300, 3)).toBe(2_400_000) // 8x — cap reached
  })

  it('INVARIANT: monotonic non-decreasing and never exceeds 8x the poll, for any failure count', () => {
    const pollSeconds = 300
    let previous = 0
    for (let failures = 0; failures <= 12; failures += 1) {
      const ms = computeBackoffViaChildProcess(pollSeconds, failures)
      expect(ms).toBeGreaterThanOrEqual(previous)
      expect(ms).toBeLessThanOrEqual(pollSeconds * 1000 * 8)
      previous = ms
    }
  })
})

describe('wt-quota-watch.mjs: cache-first probing (the actual 429 fix)', () => {
  function writeCounterProbe(cfg: string, counterPath: string, behavior: 'always-fail' | 'always-succeed' | 'fail-once-then-succeed') {
    mkdirSync(join(cfg, 'scripts'), { recursive: true })
    const body = `
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const counterPath = ${JSON.stringify(counterPath)}
let n = 0
if (existsSync(counterPath)) n = Number(readFileSync(counterPath, 'utf8')) || 0
n += 1
writeFileSync(counterPath, String(n))
const ok = () => process.stdout.write(JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR, five_hour: { pct: 99, reset_local: '12:00' }, seven_day: { pct: 5, reset_local: 'sam. 01/08 00:00' } }))
const fail = () => { process.stderr.write('usage endpoint failed: HTTP 429'); process.exit(1) }
${
  behavior === 'always-fail'
    ? 'fail()'
    : behavior === 'always-succeed'
      ? 'ok()'
      : 'if (n === 1) fail(); else ok()'
}
`
    writeFileSync(join(cfg, 'scripts', 'quota-usage.mjs'), body)
  }

  function readCounter(counterPath: string): number {
    if (!existsSync(counterPath)) return 0
    return Number(readFileSync(counterPath, 'utf8')) || 0
  }

  // DETERMINISTIC on purpose — no wall-clock racing. An earlier version of these tests
  // spawned the real watcher, waited a fixed number of milliseconds, SIGKILLed it, and
  // counted how many probe invocations happened in that window. That flaked (2026-07-31):
  // green alone, red once under the contention of the FULL suite (159 files' worth of
  // concurrent child processes), green again on a re-run — a setTimeout racing a SIGKILL
  // deadline under arbitrary system load, not a defect in the watcher. The window itself
  // was never provably wrong, which is exactly the failure mode this file's own header
  // warns about: an intermittent test nobody believes, including the day it is right.
  //
  // Fix: the watcher's `sleep()` has a test-only seam (see its header comment in
  // wt-quota-watch.mjs) — WT_QUOTA_WATCH_TEST_SLEEP_LOG makes it log the millisecond value
  // it was asked to wait (the REAL backoff/poll math it computed) instead of waiting it
  // out, and WT_QUOTA_WATCH_TEST_MAX_CYCLES bounds the run to an exact number of loop
  // iterations before a clean `process.exit(0)`. Tests below await process EXIT (a real
  // signal) instead of a delay, then assert on the logged durations directly. The safety
  // timeout in runWatcher is a backstop against a genuine hang, never the pass/fail signal
  // — under correct operation the process always exits on its own, fast.
  function runWatcher(
    cfg: string,
    opts: { maxCycles?: number; sleepLogPath?: string; extraEnv?: Record<string, string> },
    safetyTimeoutMs = 10_000,
  ): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: cfg, ...opts.extraEnv }
      if (opts.maxCycles !== undefined) env.WT_QUOTA_WATCH_TEST_MAX_CYCLES = String(opts.maxCycles)
      if (opts.sleepLogPath !== undefined) env.WT_QUOTA_WATCH_TEST_SLEEP_LOG = opts.sleepLogPath
      const child = spawn(process.execPath, [QUOTA_WATCH, '--poll', '5', '--timeout', '1'], { env })
      let stdout = ''
      child.stdout.on('data', (d) => {
        stdout += d
      })
      // Backstop only: a healthy run exits on its own once WT_QUOTA_WATCH_TEST_MAX_CYCLES
      // is reached. If this fires, the watcher genuinely hung — that IS a test failure,
      // just reported honestly instead of silently resolving with a truncated stdout.
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`wt-quota-watch.mjs did not self-exit within ${safetyTimeoutMs}ms (maxCycles=${opts.maxCycles})`))
      }, safetyTimeoutMs)
      child.on('close', () => {
        clearTimeout(timer)
        resolve({ stdout })
      })
    })
  }

  function readSleepLog(path: string): number[] {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map(Number)
  }

  it('a fresh cache suppresses the live probe entirely', async () => {
    const cfg = tmpRoot('wt-quota-watch-cache-')
    const counterPath = join(cfg, 'counter.txt')
    writeCounterProbe(cfg, counterPath, 'always-succeed')
    // Pre-seed a fresh, valid cache the watcher should use instead of the probe.
    writeFileSync(join(cfg, '.quota-cache.json'), JSON.stringify({ at: Date.now(), data: { configDir: cfg, five_hour: { pct: 1 }, seven_day: { pct: 1 } } }))

    await runWatcher(cfg, { maxCycles: 2, sleepLogPath: join(cfg, 'sleeps.log') })

    expect(readCounter(counterPath)).toBe(0)
  })

  it('a live probe refills the shared cache in the format the per-turn hook reads', async () => {
    const cfg = tmpRoot('wt-quota-watch-cache-')
    const counterPath = join(cfg, 'counter.txt')
    writeCounterProbe(cfg, counterPath, 'always-succeed')
    // No pre-existing cache — the first poll must go live and then write one.

    await runWatcher(cfg, { maxCycles: 1, sleepLogPath: join(cfg, 'sleeps.log') })

    expect(readCounter(counterPath)).toBeGreaterThanOrEqual(1)
    const cache = JSON.parse(readFileSync(join(cfg, '.quota-cache.json'), 'utf8'))
    expect(typeof cache.at).toBe('number')
    expect(cache.data.five_hour.pct).toBe(99)
  })

  it('a corrupt pre-existing cache degrades to a direct probe instead of crashing or hanging', async () => {
    const cfg = tmpRoot('wt-quota-watch-cache-')
    const counterPath = join(cfg, 'counter.txt')
    writeCounterProbe(cfg, counterPath, 'always-succeed')
    writeFileSync(join(cfg, '.quota-cache.json'), '{ not valid json')

    const res = await runWatcher(cfg, { maxCycles: 1, sleepLogPath: join(cfg, 'sleeps.log') })

    expect(res.stdout).toContain('QUOTA WATCH ARMED')
    expect(readCounter(counterPath)).toBeGreaterThanOrEqual(1)
  })

  it('a rate-limited probe backs off with the EXACT growing, capped schedule — deterministically', async () => {
    const cfg = tmpRoot('wt-quota-watch-backoff-')
    const counterPath = join(cfg, 'counter.txt')
    const sleepLogPath = join(cfg, 'sleeps.log')
    writeCounterProbe(cfg, counterPath, 'always-fail')

    // 3 cycles, always failing: consecutiveFailures goes 1, 2, 3 → backoff (poll=5s) goes
    // 10s, 20s, 40s(capped at 8x). This is the SAME math the quota-backoff unit tests
    // check in isolation; here it asserts the watcher actually WIRES computeBackoffMs into
    // its failure path, end to end, against the real cache-miss + probe-failure code path.
    await runWatcher(cfg, { maxCycles: 3, sleepLogPath })

    expect(readCounter(counterPath)).toBe(3) // no cache ever gets written on an always-failing probe
    expect(readSleepLog(sleepLogPath)).toEqual([10_000, 20_000, 40_000])
  })

  it('recovers automatically after a transient failure, and resets to the NORMAL cadence — deterministically', async () => {
    const cfg = tmpRoot('wt-quota-watch-recover-')
    const counterPath = join(cfg, 'counter.txt')
    const sleepLogPath = join(cfg, 'sleeps.log')
    writeCounterProbe(cfg, counterPath, 'fail-once-then-succeed')

    // Cycle 1 fails → backoff (10s, logged but not waited). Cycle 2 succeeds → reset to
    // the plain poll cadence (5s, logged). The SECOND value proves the "resets to normal
    // cadence on success" half of the invariant, not just "eventually recovers".
    const res = await runWatcher(cfg, { maxCycles: 2, sleepLogPath })

    expect(res.stdout).toContain('QUOTA WATCH DEGRADED')
    expect(res.stdout).toContain('QUOTA STATUS')
    expect(res.stdout).toContain('5h 99%')
    expect(readSleepLog(sleepLogPath)).toEqual([10_000, 5_000])
  })
})
