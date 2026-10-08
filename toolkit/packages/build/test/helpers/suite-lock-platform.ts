// Platform seam for the suite-lock tests that assert a POSIX-only contract.
//
// Root cause (plugin/bin/lib/suite-lock.mjs, holderIsStale and the head budget in acquireSuiteLock): on Windows a holder
// whose PID is signalable is judged stale by AGE (the lock.d mtime) against the waiter's own --stale-s, and a head
// waiter's budget is max(--wait-s, --stale-s). A live holder is always at least as old as the waiter's elapsed wait,
// so a Windows head waiter with a non-zero wait reaches the age bound and reclaims the live holder instead of exiting 75.
// The tests below are about the queue budget, the lease chain and the reclaim critical section, not about Windows
// staleness, so they pin the POSIX rule (library calls) or fail fast (spawned CLI, which has no platform option).

/** The staleness rule these tests exercise: a signalable PID is live, whatever the lock directory's age (spread into acquireSuiteLock). */
export const POSIX_STALENESS = { platform: 'linux' } as const

export interface CompetitorWait {
  /** Seconds the competing CLI waits on POSIX (`--wait-s`). Omit to leave the flag unset. */
  waitS?: number
  /** Seconds of the CLI's stale bound on POSIX (`--stale-s`). Omit to keep the default bound. */
  staleS?: number
}

/**
 * Arguments of a CLI competitor that must time out behind a live holder (exit 75). POSIX keeps the given wait and stale bound.
 * On win32 the competitor fails fast (`--wait-s 0`) and keeps the default stale bound, so the live holder is never old enough to reclaim.
 */
export function competitorArgs({ waitS, staleS }: CompetitorWait, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return waitS === undefined ? [] : ['--wait-s', '0']
  return [...(waitS === undefined ? [] : ['--wait-s', String(waitS)]), ...(staleS === undefined ? [] : ['--stale-s', String(staleS)])]
}

/** The environment wait override of such a competitor: the given wait on POSIX, `0` (fail fast) on win32. */
export function competitorWaitEnv(waitS: number, platform: NodeJS.Platform = process.platform): { WT_SUITE_LOCK_WAIT_S: string } {
  return { WT_SUITE_LOCK_WAIT_S: platform === 'win32' ? '0' : String(waitS) }
}
