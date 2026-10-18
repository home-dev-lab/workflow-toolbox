import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
// `Date.now() - <name>` is a wall-clock offset (a file age, a seeded stamp), not a measured interval, for these names.
const OFFSET_NAMES = new Set(['shift', 'ageMs', 'reclaimAgeMs', 'now'])
const ELAPSED = /Date\.now\(\)\s*-\s*([A-Za-z_]\w*)/g

function elapsedWallClockUses(file: string): string[] {
  const hits: string[] = []
  readFileSync(join(here, file), 'utf8').split('\n').forEach((line, index) => {
    for (const match of line.matchAll(ELAPSED)) {
      if (!OFFSET_NAMES.has(match[1] ?? '')) hits.push(`${file}:${index + 1}: ${line.trim()}`)
    }
  })
  return hits
}

it('suite-lock tests measure elapsed intervals on the monotonic clock', () => {
  const files = readdirSync(here).filter((name) => /^suite-lock.*\.test\.ts$/.test(name) && name !== 'suite-lock-clock.test.ts')
  expect(files.length).toBeGreaterThan(3)
  // A wall clock can step back mid-window (NTP, VM resume): a Date.now() difference then reads shorter than the real wait.
  expect(files.flatMap(elapsedWallClockUses)).toEqual([])
})

it('the monotonic clock ignores a wall-clock step back that shrinks a Date.now() interval', () => {
  const realNow = Date.now
  const startWall = realNow(); const startMono = performance.now()
  Date.now = () => realNow() - 900
  try {
    expect(Date.now() - startWall).toBeLessThan(0)
    expect(performance.now() - startMono).toBeGreaterThanOrEqual(0)
  } finally { Date.now = realNow }
}, 5000)
