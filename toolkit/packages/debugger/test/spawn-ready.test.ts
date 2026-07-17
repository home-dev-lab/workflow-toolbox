// spawn-ready.test.ts — TEST-LOCKS for card #1820935029484684499:
// (1) `wt-observe start` with port 0 must health-check the port the child
//     ACTUALLY bound (parsed from its log banner), never the literal 0;
// (2) after a readiness FAILURE the still-alive child must be reaped (killed
//     by precise PID), never left as an orphan.
// TDD: written RED before spawn-ready.ts existed.

import { describe, it, expect } from 'vitest'
import { parseAnnouncedPort, awaitSpawnedServerReady } from '../src/spawn-ready.js'
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

describe('spawn-ready banner contract (cross-repo drift gate)', () => {
  it.skipIf(!existsSync(DEV_API))(
    'the observatory dev-api still prints the banner parseAnnouncedPort matches',
    () => {
      const src = readFileSync(DEV_API, 'utf8')
      expect(src).toContain('app + run discovery on http://127.0.0.1:')
    },
  )
})
