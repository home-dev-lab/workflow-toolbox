import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { ancestorPids, isBatchLauncherRow, isOwnedSandboxRoot, ownedOpencodePids, unattributedTreeKey } from '../../../../plugin/bin/lib/lane-opencode-attribution.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { isTrueParent, laneDescendantPids } from '../../../../plugin/bin/lib/lane-live-scan.mjs'

type Row = { pid: number, ppid?: number, command: string, startIdentity?: number, startTime?: number }
const index = (rows: Row[]) => new Map(rows.map((row) => [row.pid, row]))
const OC = '/home/u/.opencode/bin/opencode run task --dir /p/scratch --format json -f /p/out/b1.task.md'

describe('lane opencode attribution from the process table', () => {
  it('recognises the envelope launcher on POSIX and Windows command lines, flags included', () => {
    expect(isBatchLauncherRow({ pid: 5, command: '/usr/bin/node /x/plugin/bin/wt-opencode-envelope.mjs tasks.json --dir /p' })).toBe(true)
    expect(isBatchLauncherRow({ pid: 5, command: 'node --max-old-space-size=4096 /x/wt-opencode-envelope.mjs t.json' })).toBe(true)
    expect(isBatchLauncherRow({ pid: 5, command: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\u\\plugin\\bin\\wt-opencode-envelope.mjs t.json' })).toBe(true)
    expect(isBatchLauncherRow({ pid: 5, command: 'grep wt-opencode-envelope.mjs log' })).toBe(false)
    expect(isBatchLauncherRow({ pid: 5, command: 'node /x/other.mjs wt-opencode-envelope.mjs' })).toBe(false)
    expect(isBatchLauncherRow({ pid: 5, command: 'node /x/wt-opencode-envelope.mjs.bak' })).toBe(false)
  })

  it('owns a sandbox root only when its live parent is the pid its runtime directory names', () => {
    const creator = { pid: 40, ppid: 1, command: 'node /x/pilot.mjs' }
    const bwrap = { pid: 41, ppid: 40, command: `/usr/bin/bwrap --die-with-parent --bind /run/user/1000/wt-lane-sandbox-40-ab12cd34/oc-share /x -- /bin/sh -c boot wt-lane-net ${OC}` }
    expect(isOwnedSandboxRoot(bwrap, index([creator, bwrap]))).toBe(true)
    expect(isOwnedSandboxRoot(bwrap, index([bwrap])), 'creator gone').toBe(false)
    expect(isOwnedSandboxRoot({ ...bwrap, ppid: 1 }, index([creator, bwrap])), 'reparented to init').toBe(false)
    expect(isOwnedSandboxRoot({ ...bwrap, command: bwrap.command.replace('sandbox-40-', 'sandbox-400-') }, index([creator, bwrap])), 'directory names another pid').toBe(false)
    expect(isOwnedSandboxRoot({ ...bwrap, command: `/bin/sh -c x wt-lane-sandbox-40-ab ${OC}` }, index([creator, bwrap])), 'not a bwrap').toBe(false)
    const reused = { ...creator, startTime: 2000 }
    expect(isOwnedSandboxRoot({ ...bwrap, startTime: 1000 }, index([reused, bwrap])), 'parent id reused by a younger process').toBe(false)
  })

  it('owns every descendant of a live launcher and nothing outside it', () => {
    const rows: Row[] = [
      { pid: 10, ppid: 2, command: 'node /x/wt-opencode-envelope.mjs t.json --dir /p' },
      { pid: 11, ppid: 10, command: `/usr/bin/bwrap --x -- ${OC}` },
      { pid: 12, ppid: 11, command: OC },
      { pid: 20, ppid: 2, command: 'node /x/other-batch.mjs' },
      { pid: 21, ppid: 20, command: OC },
      { pid: 30, ppid: 1, command: OC },
    ]
    expect([...ownedOpencodePids(rows)].sort((a, b) => a - b)).toEqual([10, 11, 12])
    expect([...ownedOpencodePids(rows.filter((row) => row.pid !== 10))]).toEqual([])
  })

  it('keys one notice per launcher tree, through sandbox plumbing only, and per chain without a live launcher', () => {
    const rows: Row[] = [
      { pid: 1, ppid: 0, command: '/sbin/init' },
      { pid: 2, ppid: 1, command: 'bash' },
      { pid: 20, ppid: 2, command: 'node /x/other-batch.mjs /w/bin/opencode /w', startIdentity: 777 },
      { pid: 21, ppid: 20, command: `/usr/bin/bwrap -- /bin/sh -c boot wt-lane-net ${OC}` },
      { pid: 22, ppid: 21, command: `/bin/sh -c boot wt-lane-net ${OC}` },
      { pid: 23, ppid: 22, command: OC },
      { pid: 24, ppid: 20, command: OC },
      { pid: 25, ppid: 2, command: `/bin/sh -c /bin/sh /w/bin/opencode run nested --dir /w; :`, startIdentity: 888 },
      { pid: 26, ppid: 25, command: '/bin/sh /w/bin/opencode run nested --dir /w' },
      { pid: 30, ppid: 1, command: `/usr/bin/bwrap -- ${OC}` },
      { pid: 31, ppid: 30, command: OC },
      { pid: 40, ppid: 1, command: OC },
      { pid: 50, ppid: 51, command: `/usr/bin/bwrap -- ${OC}` },
      { pid: 51, ppid: 50, command: `/usr/bin/bwrap -- ${OC}` },
      { pid: 52, ppid: 50, command: OC },
      { pid: 60, ppid: 61, command: OC, startTime: 1000 },
      { pid: 61, ppid: 2, command: 'node /x/young.mjs', startTime: 2000 },
    ]
    for (const pid of [21, 22, 23, 24]) expect(unattributedTreeKey(pid, rows), `pid ${pid}`).toBe('tree:20:777')
    expect(unattributedTreeKey(26, rows), 'a launcher whose command line names opencode is still the tree root').toBe('tree:25:888')
    expect(unattributedTreeKey(31, rows)).toBe('pid:30')
    expect(unattributedTreeKey(30, rows)).toBe('pid:30')
    expect(unattributedTreeKey(40, rows)).toBe('pid:40')
    expect(unattributedTreeKey(99, rows)).toBe('pid:99')
    expect(unattributedTreeKey(52, rows), 'a ppid cycle ends the walk').toMatch(/^pid:5[01]$/)
    expect(unattributedTreeKey(60, rows), 'a younger parent is a reused id').toBe('pid:60')
  })

  // An orphan is adopted by a reaper. Keying it on the reaper would make every later orphan share the first
  // one's notice, silenced for as long as the first one lives.
  it('never roots a tree at a reaper: pid 1, systemd, launchd, or an ancestor of the watcher', () => {
    const rows: Row[] = [
      { pid: 1, ppid: 0, command: '/sbin/init splash' },
      { pid: 700, ppid: 1, command: '/usr/lib/systemd/systemd --user', startIdentity: 5 },
      { pid: 701, ppid: 700, command: OC },
      { pid: 702, ppid: 700, command: `/usr/bin/bwrap -- ${OC}` },
      { pid: 703, ppid: 702, command: OC },
      { pid: 710, ppid: 1, command: '/sbin/launchd' },
      { pid: 711, ppid: 710, command: OC },
      { pid: 800, ppid: 1, command: 'claude', startIdentity: 9 },
      { pid: 801, ppid: 800, command: 'node /x/wt-lane-orphan-watch.mjs' },
      { pid: 802, ppid: 800, command: OC },
      { pid: 803, ppid: 1, command: OC },
    ]
    expect(unattributedTreeKey(701, rows)).toBe('pid:701')
    expect(unattributedTreeKey(703, rows)).toBe('pid:702')
    expect(unattributedTreeKey(711, rows)).toBe('pid:711')
    expect(unattributedTreeKey(803, rows)).toBe('pid:803')
    const reapers = ancestorPids(801, rows)
    expect([...reapers].sort((a: number, b: number) => a - b)).toEqual([800, 801])
    expect(unattributedTreeKey(802, rows, { reapers }), 'the session running the watcher adopts orphans').toBe('pid:802')
    expect(unattributedTreeKey(802, rows), 'without the watcher ancestry it is an ordinary launcher').toBe('tree:800:9')
  })

  it('follows a parent link only when the parent is not younger than the child', () => {
    expect(isTrueParent({ pid: 5, startTime: 100 }, { pid: 6, ppid: 5, startTime: 200 })).toBe(true)
    expect(isTrueParent({ pid: 5, startTime: 300 }, { pid: 6, ppid: 5, startTime: 200 })).toBe(false)
    expect(isTrueParent({ pid: 5 }, { pid: 6, ppid: 5, startTime: 200 })).toBe(true)
    expect(isTrueParent({ pid: 5 }, { pid: 6, ppid: 7 })).toBe(false)
    const rows = [{ pid: 10, ppid: 1, startTime: 500 }, { pid: 11, ppid: 10, startTime: 400 }, { pid: 12, ppid: 10, startTime: 600 }]
    expect([...laneDescendantPids([10], rows)].sort((a: number, b: number) => a - b)).toEqual([10, 12])
  })
})
