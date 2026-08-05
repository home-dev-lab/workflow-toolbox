// spawn-ready.test.ts — TEST-LOCKS for card #1820935029484684499:
// (1) `wt-observe start` with port 0 must health-check the port the child
//     ACTUALLY bound (parsed from its log banner), never the literal 0;
// (2) after a readiness FAILURE the still-alive child must be reaped (killed
//     by precise PID), never left as an orphan.
// TDD: written RED before spawn-ready.ts existed.

import { describe, it, expect } from 'vitest'
import { parseAnnouncedPort, awaitSpawnedServerReady, resolveHealthTimeoutMs, HEALTH_TIMEOUT_DEFAULT_MS, HEALTH_TIMEOUT_CEILING_MS } from '../src/spawn-ready.js'
import type { SpawnReadyDeps } from '../src/spawn-ready.js'

// ---------------------------------------------------------------------------
// parseAnnouncedPort — the banner parser (log opens in APPEND mode, so the
// caller feeds only the slice written AFTER this spawn; still, the parser
// takes the LAST banner in its input).
// ---------------------------------------------------------------------------

const BANNER = (port: number, suffix = ''): string =>
  `[observe-ui] app + run discovery on http://127.0.0.1:${port}${suffix}\n`

describe('parseAnnouncedPort', () => {
  it('extracts the port from the single-source banner', () => {
    expect(parseAnnouncedPort(BANNER(5174, ' (config dir: /home/x/.claude)'))).toBe(5174)
  })

  it('extracts the port from the hub banner (no config-dir suffix)', () => {
    expect(parseAnnouncedPort(BANNER(43121))).toBe(43121)
  })

  it('takes the LAST banner when several are present', () => {
    expect(parseAnnouncedPort(BANNER(1111) + 'noise\n' + BANNER(2222))).toBe(2222)
  })

  it('returns null when no banner is present', () => {
    expect(parseAnnouncedPort('tsx starting…\nsome other line\n')).toBeNull()
  })

  it('returns null on an out-of-range port', () => {
    expect(parseAnnouncedPort(BANNER(999999))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// awaitSpawnedServerReady — the readiness loop, fully injected.
// ---------------------------------------------------------------------------

interface Ready { port: number }

function makeDeps(overrides: Partial<SpawnReadyDeps<Ready>> = {}): {
  deps: SpawnReadyDeps<Ready>
  probed: number[]
  kills: number[]
} {
  const probed: number[] = []
  const kills: number[] = []
  let clock = 0
  const deps: SpawnReadyDeps<Ready> = {
    requestedPort: 5174,
    timeoutMs: 10_000,
    readLogSlice: () => '',
    probe: async (port: number) => {
      probed.push(port)
      return { port }
    },
    isReady: (v: unknown): v is Ready =>
      typeof v === 'object' && v !== null && typeof (v as Ready).port === 'number',
    spawnState: () => ({ error: null, exited: null }),
    kill: () => { kills.push(1) },
    now: () => clock,
    sleep: async (ms: number) => { clock += ms },
    logTail: () => 'log tail (fake)',
    ...overrides,
  }
  return { deps, probed, kills }
}

describe('awaitSpawnedServerReady', () => {
  it('probes the REQUESTED port directly when it is non-zero', async () => {
    const { deps, probed } = makeDeps()
    const h = await awaitSpawnedServerReady(deps)
    expect(h.port).toBe(5174)
    expect(probed).toEqual([5174])
  })

  it('with port 0, probes the ANNOUNCED port from the log — NEVER the literal 0 (test-lock 1)', async () => {
    let sliceCalls = 0
    const { deps, probed } = makeDeps({
      requestedPort: 0,
      // The banner appears only from the 3rd poll on — before that the child
      // is still booting and the log slice has no announcement yet.
      readLogSlice: () => (++sliceCalls >= 3 ? BANNER(43121) : 'tsx booting…\n'),
    })
    const h = await awaitSpawnedServerReady(deps)
    expect(h.port).toBe(43121)
    expect(probed).toEqual([43121])
    expect(probed).not.toContain(0)
  })

  it('kills the still-alive child EXACTLY ONCE on readiness timeout (test-lock 2), claiming only a BEST-EFFORT reap', async () => {
    const { deps, kills } = makeDeps({
      requestedPort: 5174,
      probe: async (port: number) => {
        void port
        return 'no-listener'
      },
      isReady: (v: unknown): v is Ready => typeof v === 'object' && v !== null,
    })
    // The message must not overclaim ("no orphan left") — the kill is one
    // best-effort SIGTERM whose delivery is not verified (review finding).
    await expect(awaitSpawnedServerReady(deps)).rejects.toThrow(/did not become healthy.*best-effort reap/s)
    expect(kills).toEqual([1])
  })

  it('kills the child on timeout when port 0 never gets announced, and names the gap', async () => {
    const { deps, kills, probed } = makeDeps({
      requestedPort: 0,
      readLogSlice: () => 'no banner ever\n',
    })
    await expect(awaitSpawnedServerReady(deps)).rejects.toThrow(/never announced/)
    expect(kills).toEqual([1])
    expect(probed).toEqual([])
  })

  it('does NOT kill when the child already exited (nothing to reap) and reports the exit', async () => {
    const { deps, kills } = makeDeps({
      spawnState: () => ({ error: null, exited: { code: 1, signal: null } }),
    })
    await expect(awaitSpawnedServerReady(deps)).rejects.toThrow(/exited immediately/)
    expect(kills).toEqual([])
  })

  it('does NOT kill on a spawn error (the child never ran)', async () => {
    const { deps, kills } = makeDeps({
      spawnState: () => ({ error: new Error('ENOENT'), exited: null }),
    })
    await expect(awaitSpawnedServerReady(deps)).rejects.toThrow(/failed to spawn/)
    expect(kills).toEqual([])
  })

  it('keeps polling until the probe answers ready', async () => {
    let calls = 0
    const seen: number[] = []
    const { deps } = makeDeps({
      probe: async (port: number) => {
        seen.push(port)
        return ++calls >= 3 ? { port } : 'no-listener'
      },
    })
    const h = await awaitSpawnedServerReady(deps)
    expect(h.port).toBe(5174)
    expect(seen).toEqual([5174, 5174, 5174])
  })
})

// ---------------------------------------------------------------------------
// Cross-repo banner contract — best-effort LOCAL drift gate (review finding:
// the port-banner regex is coupled to the observatory's log format with only
// a comment). The observatory is a SEPARATE private repo; its checkout is not
// present in this repo's CI, so this gate runs wherever the sibling checkout
// (or DWT_OBSERVE_ROOT) exists — exactly the machines where `wt-observe
// start` actually runs — and skips elsewhere.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OBSERVE_ROOT = process.env['DWT_OBSERVE_ROOT'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../workflow-observatory')
const DEV_API = resolve(OBSERVE_ROOT, 'apps/observe-ui/server/dev-api.ts')

// ---------------------------------------------------------------------------
// resolveHealthTimeoutMs — card #1826653906575295552's "make the window configurable"
// knob (candidate fix 2). Mirrors launch-body.ts's resolveLaunchTimeoutMs test shape
// (same flag/env precedence + sanitization contract), plus the NEW ceiling-clamp this
// knob adds (launch-body.ts's twin has no ceiling — this one deliberately does, per
// deliberate: keep the safe default, make the override explicit AND bounded).
// ---------------------------------------------------------------------------

describe('resolveHealthTimeoutMs', () => {
  it('defaults to 90s (HEALTH_TIMEOUT_DEFAULT_MS) with neither flag nor env', () => {
    expect(resolveHealthTimeoutMs(undefined, undefined)).toEqual({ ms: HEALTH_TIMEOUT_DEFAULT_MS, clampedFrom: null })
    expect(resolveHealthTimeoutMs(undefined, undefined).ms).toBe(90_000)
  })

  it('the --health-timeout flag (SECONDS) wins over the env (MILLISECONDS)', () => {
    expect(resolveHealthTimeoutMs('120', undefined)).toEqual({ ms: 120_000, clampedFrom: null })
    expect(resolveHealthTimeoutMs('120', '5000')).toEqual({ ms: 120_000, clampedFrom: null }) // flag beats env
  })

  it('the env alone is honored when no flag is given', () => {
    expect(resolveHealthTimeoutMs(undefined, '120000')).toEqual({ ms: 120_000, clampedFrom: null })
  })

  it('a non-numeric or non-positive value in EITHER channel is ignored, never a 0/NaN timeout', () => {
    expect(resolveHealthTimeoutMs('0', undefined).ms).toBe(90_000)
    expect(resolveHealthTimeoutMs('-5', undefined).ms).toBe(90_000)
    expect(resolveHealthTimeoutMs('abc', undefined).ms).toBe(90_000)
    expect(resolveHealthTimeoutMs('abc', '60000').ms).toBe(60_000) // a bad flag still lets the env through
    expect(resolveHealthTimeoutMs(undefined, '0').ms).toBe(90_000)
    expect(resolveHealthTimeoutMs(undefined, 'nope').ms).toBe(90_000)
  })

  it('a value ABOVE the ceiling is CLAMPED, not silently honored — clampedFrom names the requested value', () => {
    expect(resolveHealthTimeoutMs(String(HEALTH_TIMEOUT_CEILING_MS / 1000 + 60), undefined)).toEqual({
      ms: HEALTH_TIMEOUT_CEILING_MS,
      clampedFrom: HEALTH_TIMEOUT_CEILING_MS + 60_000,
    })
    expect(resolveHealthTimeoutMs(undefined, String(HEALTH_TIMEOUT_CEILING_MS + 1))).toEqual({
      ms: HEALTH_TIMEOUT_CEILING_MS,
      clampedFrom: HEALTH_TIMEOUT_CEILING_MS + 1,
    })
  })

  it('a value exactly AT the ceiling is honored unclamped (boundary)', () => {
    expect(resolveHealthTimeoutMs(String(HEALTH_TIMEOUT_CEILING_MS / 1000), undefined)).toEqual({
      ms: HEALTH_TIMEOUT_CEILING_MS,
      clampedFrom: null,
    })
  })
})

// ---------------------------------------------------------------------------
// The timeout failure message names the knob — TEST-LOCK for the "or at minimum say
// in the error…" half of card #1826653906575295552's candidate fix 3, applied to the
// window itself: a real progress signal computed on a possibly-saturated event loop
// cannot be trusted to gate the SIGTERM decision (it would report "fine" precisely when
// it is not), so this repo names the operator's actual escape hatches instead — a
// configurable window and a way to skip resuming this boot — rather than adding an
// unverifiable "run in progress" guard.
// ---------------------------------------------------------------------------

describe('awaitSpawnedServerReady — timeout message names the knob (card #1826653906575295552)', () => {
  it('the timeout error names --health-timeout, WT_OBSERVE_HEALTH_TIMEOUT_MS, its ceiling, and --no-resume', async () => {
    const deps: SpawnReadyDeps<{ ok: true }> = {
      requestedPort: 5174,
      timeoutMs: 10,
      readLogSlice: () => '',
      probe: async () => 'timeout',
      // Never ready — mirrors the repo's own isReady shape (line ~106): 'timeout' (a string)
      // never satisfies `typeof v === 'object'`, so this reaches the readiness-timeout path
      // exactly like a real never-answering server would.
      isReady: (v): v is { ok: true } => typeof v === 'object',
      spawnState: () => ({ error: null, exited: null }),
      kill: () => {},
      now: () => Date.now(),
      sleep: async () => {},
      logTail: () => '',
    }
    await expect(awaitSpawnedServerReady(deps)).rejects.toThrow(
      new RegExp(`--health-timeout.*WT_OBSERVE_HEALTH_TIMEOUT_MS.*${HEALTH_TIMEOUT_CEILING_MS}.*--no-resume`, 's'),
    )
  })
})

describe('spawn-ready banner contract (cross-repo drift gate)', () => {
  it.skipIf(!existsSync(DEV_API))(
    'the observatory dev-api still prints the banner parseAnnouncedPort matches',
    () => {
      const src = readFileSync(DEV_API, 'utf8')
      expect(src).toContain('app + run discovery on http://127.0.0.1:')
    },
  )
})
