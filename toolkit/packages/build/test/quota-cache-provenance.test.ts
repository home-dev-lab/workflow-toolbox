// quota-cache-provenance.test.ts — a cache entry describing a DIFFERENT config dir must
// never be read (or persisted) as a valid measurement.
//
// WHAT THIS PROTECTS: `<configDir>/.quota-cache.json` is a fixed, predictable path any
// process on the machine can write — another profile's own hook/watcher, or a test
// fixture. Observed 2026-08-04: an entry carrying `configDir: "/fake"` was read and
// relayed by the watcher as a real quota drop (5h 12%/7d 30% vs a live 44%/41%). This
// locks the fix at both ends: `readQuotaCache` refuses to READ a foreign entry, and
// `writeQuotaCacheAtomic` refuses to PERSIST one.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { readQuotaCache, writeQuotaCacheAtomic } from '../../../../plugin/bin/lib/quota-cache.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-quota-cache-provenance-'))
  roots.push(root)
  return root
}

function writeRawCache(cachePath: string, at: number, data: unknown) {
  writeFileSync(cachePath, JSON.stringify({ at, data }))
}

const OWN_CONFIG_DIR = '/home/example/.claude'
const FOREIGN_CONFIG_DIR = '/fake'

describe('readQuotaCache — provenance', () => {
  it('rejects an entry naming a DIFFERENT config dir — the exact poisoned-entry shape observed 2026-08-04', async () => {
    const root = mkRoot()
    const cachePath = join(root, '.quota-cache.json')
    writeRawCache(cachePath, Date.now(), {
      configDir: FOREIGN_CONFIG_DIR,
      five_hour: { pct: 12 },
      seven_day: { pct: 30 },
    })

    const result = await readQuotaCache(cachePath, 300_000, OWN_CONFIG_DIR)
    expect(result).toBeNull()
  })

  it('rejects an entry with NO configDir field (written before the field existed) — unknown provenance, same treatment', async () => {
    const root = mkRoot()
    const cachePath = join(root, '.quota-cache.json')
    writeRawCache(cachePath, Date.now(), { five_hour: { pct: 12 }, seven_day: { pct: 30 } })

    const result = await readQuotaCache(cachePath, 300_000, OWN_CONFIG_DIR)
    expect(result).toBeNull()
  })

  it('accepts an entry naming the CALLER\'S OWN config dir — the control that makes the two rejections above meaningful', async () => {
    const root = mkRoot()
    const cachePath = join(root, '.quota-cache.json')
    writeRawCache(cachePath, Date.now(), {
      configDir: OWN_CONFIG_DIR,
      five_hour: { pct: 44 },
      seven_day: { pct: 41 },
    })

    const result = await readQuotaCache(cachePath, 300_000, OWN_CONFIG_DIR)
    expect(result).not.toBeNull()
    expect(result?.data).toMatchObject({ configDir: OWN_CONFIG_DIR })
  })

  it('accepts the SAME directory spelled with a trailing slash — normalization, not raw string equality', async () => {
    const root = mkRoot()
    const cachePath = join(root, '.quota-cache.json')
    writeRawCache(cachePath, Date.now(), { configDir: `${OWN_CONFIG_DIR}/`, five_hour: { pct: 1 }, seven_day: { pct: 1 } })

    const result = await readQuotaCache(cachePath, 300_000, OWN_CONFIG_DIR)
    expect(result).not.toBeNull()
  })

  it('still rejects a genuinely DIFFERENT sibling directory (normalization must not over-match)', async () => {
    const root = mkRoot()
    const cachePath = join(root, '.quota-cache.json')
    writeRawCache(cachePath, Date.now(), { configDir: `${OWN_CONFIG_DIR}-other`, five_hour: { pct: 1 }, seven_day: { pct: 1 } })

    const result = await readQuotaCache(cachePath, 300_000, OWN_CONFIG_DIR)
    expect(result).toBeNull()
  })

  it('requires expectedConfigDir — a call site that forgets it cannot silently skip the check', async () => {
    const root = mkRoot()
    const cachePath = join(root, '.quota-cache.json')
    writeRawCache(cachePath, Date.now(), { configDir: OWN_CONFIG_DIR, five_hour: { pct: 1 }, seven_day: { pct: 1 } })

    // Deliberately omitting the required third argument — untyped .mjs import, so TS
    // does not itself flag the missing arg; the runtime throw is what this test locks.
    await expect(readQuotaCache(cachePath, 300_000)).rejects.toThrow(/expectedConfigDir is required/)
  })
})

describe('writeQuotaCacheAtomic — provenance', () => {
  it('refuses to persist a reading whose configDir does not match the caller\'s own', async () => {
    const root = mkRoot()
    const cachePath = join(root, '.quota-cache.json')

    await expect(
      writeQuotaCacheAtomic(cachePath, { configDir: FOREIGN_CONFIG_DIR, five_hour: { pct: 1 }, seven_day: { pct: 1 } }, OWN_CONFIG_DIR),
    ).rejects.toThrow(/refusing to persist/)
  })

  it('persists a reading whose configDir matches the caller\'s own', async () => {
    const root = mkRoot()
    const cachePath = join(root, '.quota-cache.json')

    await writeQuotaCacheAtomic(cachePath, { configDir: OWN_CONFIG_DIR, five_hour: { pct: 44 }, seven_day: { pct: 41 } }, OWN_CONFIG_DIR)

    const onDisk = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(onDisk.data.configDir).toBe(OWN_CONFIG_DIR)
  })

  it('requires expectedConfigDir on write too', async () => {
    const root = mkRoot()
    const cachePath = join(root, '.quota-cache.json')

    // Deliberately omitting the required third argument — see the note above.
    await expect(writeQuotaCacheAtomic(cachePath, { configDir: OWN_CONFIG_DIR })).rejects.toThrow(/expectedConfigDir is required/)
  })
})
