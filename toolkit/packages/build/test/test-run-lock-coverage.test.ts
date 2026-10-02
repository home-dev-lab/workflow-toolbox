import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM module without type declarations
import { lockCoverage, parseTestRunStart, parseTestRunStarts, runnersOutsideLock, worstCoverage } from '../../../../plugin/bin/lib/test-run-lock-coverage.mjs'

const LEASED_CONFIG = "export default { test: { globalSetup: ['./test-support/suite-lease.global-setup.mjs'] } }"
const PLAIN_CONFIG = "export default { test: { globalSetup: ['./setup.ts'] } }"

function fakeFiles(files: Record<string, string>) {
  return (file: string) => (Object.hasOwn(files, file) ? files[file] : null)
}

describe('parseTestRunStart', () => {
  it.each([
    'pnpm exec vitest --version',
    'vitest run --help',
    'pnpm vitest -v',
    'cd /x/toolkit && pnpm exec vitest --version < /dev/null > /tmp/probe.log 2>&1',
  ])('a version or help query is not a test run: %s', (command) => {
    expect(parseTestRunStart(command)).toBeNull()
  })

  it('ignores mentions that are not command heads', () => {
    expect(parseTestRunStart('grep vitest README.md')).toBeNull()
    expect(parseTestRunStart("echo 'pnpm vitest run a.test.ts'")).toBeNull()
  })

  it('resolves the directory from a literal cd before the runner head', () => {
    const start = parseTestRunStart('cd /x/toolkit && pnpm vitest run a.test.ts > /tmp/a.log 2>&1')
    expect(start).toMatchObject({ kind: 'vitest', dir: '/x/toolkit', bypass: false })
    expect(start.head).toBe('pnpm vitest run a.test.ts > /tmp/a.log 2>&1')
  })

  it('expands a variable assigned literally earlier in the same command', () => {
    expect(parseTestRunStart('W=/x; cd $W/toolkit && pnpm vitest run a')).toMatchObject({ dir: '/x/toolkit' })
    expect(parseTestRunStart('W=/x; cd ${W}/toolkit; vitest run a')).toMatchObject({ dir: '/x/toolkit' })
  })

  it('resolves a relative cd against the payload cwd and a later cd against the earlier one', () => {
    expect(parseTestRunStart('cd toolkit && pnpm test', '/repo')).toMatchObject({ kind: 'pnpm-test', dir: '/repo/toolkit' })
    expect(parseTestRunStart('cd /repo && cd toolkit && pnpm test')).toMatchObject({ dir: '/repo/toolkit' })
  })

  it('leaves the directory unresolved when the cd target is not literal', () => {
    expect(parseTestRunStart('cd "$X" && vitest run a')).toMatchObject({ dir: null })
    expect(parseTestRunStart('cd $(git rev-parse --show-toplevel) && vitest run a')).toMatchObject({ dir: null })
  })

  it('reads pnpm -C / --dir as the run directory', () => {
    expect(parseTestRunStart('pnpm -C /y test')).toMatchObject({ kind: 'pnpm-test', dir: '/y' })
    expect(parseTestRunStart('pnpm --dir /y vitest run a')).toMatchObject({ kind: 'vitest', dir: '/y' })
  })

  it('marks WT_SUITE_LOCK=0 on the runner statement as a bypass', () => {
    expect(parseTestRunStart('WT_SUITE_LOCK=0 pnpm vitest run a')).toMatchObject({ bypass: true })
    expect(parseTestRunStart('WT_SUITE_LOCK=1 pnpm vitest run a')).toMatchObject({ bypass: false })
  })

  it('marks a recursive pnpm test, an explicit config or root, and a watch run', () => {
    expect(parseTestRunStart('pnpm -r test')).toMatchObject({ kind: 'pnpm-recursive-test' })
    expect(parseTestRunStart('vitest run --config other.config.ts')).toMatchObject({ explicitConfig: true })
    expect(parseTestRunStart('pnpm vitest --root ../other')).toMatchObject({ explicitConfig: true })
    expect(parseTestRunStart('pnpm vitest --watch a')).toMatchObject({ watch: true })
    expect(parseTestRunStart('pnpm exec vitest watch')).toMatchObject({ watch: true })
    expect(parseTestRunStart('vitest run a')).toMatchObject({ watch: false, explicitConfig: false })
  })

  it('returns every start in the command, each with its own directory', () => {
    const starts = parseTestRunStarts('cd /a && pnpm vitest run x; cd /b && pnpm test')
    expect(starts.map((start: { kind: string, dir: string }) => [start.kind, start.dir])).toEqual([['vitest', '/a'], ['pnpm-test', '/b']])
  })

  it('a cd inside a subshell or group does not move the directory of what follows it', () => {
    expect(parseTestRunStart('(cd /elsewhere && make) && pnpm vitest run a', '/home')).toMatchObject({ dir: '/home' })
    expect(parseTestRunStart('{ cd /elsewhere; } ; pnpm vitest run a', '/home')).toMatchObject({ dir: '/home' })
    expect(parseTestRunStart('(cd /inside && pnpm vitest run a)', '/home')).toMatchObject({ dir: '/inside' })
  })

  it('pushd and cd - leave the directory unresolved', () => {
    expect(parseTestRunStart('pushd /a && pnpm vitest run x', '/home')).toMatchObject({ dir: null })
    expect(parseTestRunStart('cd - && pnpm vitest run x', '/home')).toMatchObject({ dir: null })
  })

  it('an exported WT_SUITE_LOCK=0 earlier in the command is a bypass', () => {
    expect(parseTestRunStart('export WT_SUITE_LOCK=0; pnpm vitest run a')).toMatchObject({ bypass: true })
  })

  it.each(['WT_SUITE_LOCK_DIR=/tmp/iso', 'WT_SUITE_LEASE=x', 'WT_SUITE_LOCK_BROKER=x', 'HOME=/tmp/h', 'XDG_STATE_HOME=/tmp/x', 'LOCALAPPDATA=C:/x', 'USERPROFILE=C:/x', 'WT_SUITE_LOCK="0"', 'env HOME=/tmp/h', 'sudo WT_SUITE_LEASE=x'])(
    'treats a runner assignment as a bypass: %s', (prefix) => {
      const start = parseTestRunStart(`${prefix} pnpm vitest run x`, '/r')
      expect(lockCoverage({ ...start, readText: fakeFiles({ '/r/vitest.config.mts': LEASED_CONFIG }), env: {} })).toBe('bypassed')
    },
  )

  it.each(['WT_SUITE_LOCK_DIR=/tmp/iso', 'HOME=/tmp/h', 'WT_SUITE_LEASE=x'])(
    'treats earlier exports as bypasses: %s', (assignment) => {
      const start = parseTestRunStart(`export ${assignment}; pnpm vitest run x`, '/r')
      expect(lockCoverage({ ...start, readText: fakeFiles({ '/r/vitest.config.mts': LEASED_CONFIG }), env: {} })).toBe('bypassed')
    },
  )

  it.each(["WT_SUITE_LOCK=''", 'WT_SUITE_LOCK=""', 'WT_SUITE_LOCK=$VALUE'])(
    'treats an unresolved lock setting as unknown: %s', (assignment) => {
      const start = parseTestRunStart(`${assignment} pnpm vitest run x`, '/r')
      expect(lockCoverage({ ...start, readText: fakeFiles({ '/r/vitest.config.mts': LEASED_CONFIG }), env: {} })).toBe('unknown')
    },
  )

  it.each(['then', 'do', 'else', 'elif', 'if', 'while', 'until', 'command', 'time', '!'])(
    'recognises a runner after the %s prefix', (prefix) => {
      expect(parseTestRunStart(`${prefix} pnpm test`)).toMatchObject({ kind: 'pnpm-test' })
    },
  )

  it.each(['env pnpm test', 'sudo pnpm test', 'pnpm test -- -v'])(
    'recognises %s as a start', (command) => {
      expect(parseTestRunStart(command)).toMatchObject({ kind: 'pnpm-test' })
    },
  )

  it('recognises assignments following shell prefixes', () => {
    const start = parseTestRunStart('then env HOME=/tmp/h pnpm vitest run x', '/r')
    expect(lockCoverage({ ...start, readText: fakeFiles({ '/r/vitest.config.mts': LEASED_CONFIG }), env: {} })).toBe('bypassed')
  })

  it('splits background runs and ignores comments but preserves redirects', () => {
    expect(parseTestRunStarts('pnpm test & pnpm vitest run x # vitest run y\npnpm test')).toHaveLength(3)
    expect(parseTestRunStarts('pnpm test 2>&1 &> out')).toHaveLength(1)
    expect(parseTestRunStarts('# pnpm test\npnpm test')).toHaveLength(1)
    expect(parseTestRunStarts('pnpm vitest run a#b && pnpm test')).toHaveLength(2)
    expect(parseTestRunStarts('n=$#; pnpm test')).toHaveLength(1)
  })
})

describe('lockCoverage', () => {
  it('a vitest run under a config that takes the suite lease is covered', () => {
    const readText = fakeFiles({ '/r/toolkit/vitest.config.mts': LEASED_CONFIG })
    expect(lockCoverage({ dir: '/r/toolkit/packages/build', kind: 'vitest', readText, env: {} })).toBe('lease-config')
  })

  it('a vitest run under a config without the lease is uncovered — the nearest config decides', () => {
    const readText = fakeFiles({ '/r/app/vitest.config.ts': PLAIN_CONFIG, '/r/vitest.config.mts': LEASED_CONFIG })
    expect(lockCoverage({ dir: '/r/app', kind: 'vitest', readText, env: {} })).toBe('uncovered')
  })

  it('a pnpm test whose script wraps the lease is covered; a plain script is not', () => {
    const wrapped = fakeFiles({ '/r/package.json': JSON.stringify({ scripts: { test: 'node scripts/with-suite-lease.mjs -- vitest run' } }) })
    const plain = fakeFiles({ '/r/package.json': JSON.stringify({ scripts: { test: 'node run-tests.mjs' } }) })
    expect(lockCoverage({ dir: '/r', kind: 'pnpm-test', readText: wrapped, env: {} })).toBe('lease-script')
    expect(lockCoverage({ dir: '/r', kind: 'pnpm-test', readText: plain, env: {} })).toBe('uncovered')
  })

  it('an inherited live lease marker covers the run', () => {
    expect(lockCoverage({ dir: '/nowhere', kind: 'vitest', readText: fakeFiles({}), env: { WT_SUITE_LEASE: 'fs|abc' } })).toBe('inherited-lease')
  })

  it('never claims coverage it cannot read: unresolved dir, explicit config, recursive test are unknown', () => {
    const readText = fakeFiles({ '/r/vitest.config.mts': LEASED_CONFIG })
    expect(lockCoverage({ dir: null, kind: 'vitest', readText, env: {} })).toBe('unknown')
    expect(lockCoverage({ dir: '/r', kind: 'vitest', explicitConfig: true, readText, env: {} })).toBe('unknown')
    expect(lockCoverage({ dir: '/r', kind: 'pnpm-recursive-test', readText, env: {} })).toBe('unknown')
  })

  it('a bypassed run is bypassed even under a leased config', () => {
    const readText = fakeFiles({ '/r/vitest.config.mts': LEASED_CONFIG })
    expect(lockCoverage({ dir: '/r', kind: 'vitest', bypass: true, readText, env: {} })).toBe('bypassed')
  })

  it('a watch run takes no lease; WT_SUITE_LOCK=0 in the environment bypasses', () => {
    const readText = fakeFiles({ '/r/vitest.config.mts': LEASED_CONFIG })
    expect(lockCoverage({ dir: '/r', kind: 'vitest', watch: true, readText, env: {} })).toBe('uncovered')
    expect(lockCoverage({ dir: '/r', kind: 'vitest', readText, env: { WT_SUITE_LOCK: '0' } })).toBe('bypassed')
  })

  it('follows Vitest: a vite.config in a nearer directory wins over a farther vitest.config', () => {
    const readText = fakeFiles({ '/r/app/vite.config.ts': PLAIN_CONFIG, '/r/vitest.config.mts': LEASED_CONFIG })
    expect(lockCoverage({ dir: '/r/app', kind: 'vitest', readText, env: {} })).toBe('uncovered')
    const sameDir = fakeFiles({ '/r/vite.config.ts': PLAIN_CONFIG, '/r/vitest.config.mts': LEASED_CONFIG })
    expect(lockCoverage({ dir: '/r', kind: 'vitest', readText: sameDir, env: {} })).toBe('lease-config')
  })

  it('a package test script that runs bare vitest is judged by the config vitest will load', () => {
    const readText = fakeFiles({
      '/r/pkg/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/r/vitest.config.mts': LEASED_CONFIG,
    })
    expect(lockCoverage({ dir: '/r/pkg', kind: 'pnpm-test', readText, env: {} })).toBe('lease-config')
  })

  it('a vitest run with no config anywhere is uncovered', () => {
    expect(lockCoverage({ dir: '/r/a', kind: 'vitest', readText: fakeFiles({}), env: {} })).toBe('uncovered')
  })
})

describe('worstCoverage', () => {
  it('the least covered start decides', () => {
    expect(worstCoverage(['lease-config', 'uncovered'])).toBe('uncovered')
    expect(worstCoverage(['lease-script', 'unknown'])).toBe('unknown')
    expect(worstCoverage(['lease-config', 'bypassed', 'uncovered'])).toBe('bypassed')
    expect(worstCoverage(['lease-config'])).toBe('lease-config')
  })
})

describe('runnersOutsideLock', () => {
  const parents = new Map([[11, 10], [12, 1], [13, 99]])
  const parentOf = (pid: number) => parents.get(pid) ?? 0

  it('a runner is inside only when it or an ancestor holds or waits for the lock', () => {
    expect(runnersOutsideLock([{ pid: 11 }, { pid: 12 }, { pid: 13 }], new Set([10, 12]), parentOf)).toBe(1)
  })

  it('an unreadable lock places no runner inside', () => {
    expect(runnersOutsideLock([{ pid: 11 }, { pid: 12 }], null, parentOf)).toBe(2)
  })
})
