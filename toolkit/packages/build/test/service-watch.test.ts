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

import { spawnSync } from 'node:child_process'
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

  it('wt-quota-watch.mjs fails loud, not silently, when its probe is missing', () => {
    const QUOTA_WATCH = join(REPO_ROOT, 'plugin/bin/wt-quota-watch.mjs')
    const res = spawnSync(process.execPath, [QUOTA_WATCH, '--probe', join(tmpRoot('wt-quota-watch-'), 'does-not-exist.mjs')], {
      encoding: 'utf8',
      timeout: 3_000,
    })
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('QUOTA WATCH FAILED')
    expect(res.stdout).toContain('quota is NOT being watched')
  })
})
