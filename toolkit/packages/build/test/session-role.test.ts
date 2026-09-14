import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HELPER = pathToFileURL(`${ROOT}/plugin/bin/lib/session-role.mjs`).href

function readRole(value: string | undefined): { role: string; line: string | null } {
  const env = value === undefined ? {} : { WT_SESSION_ROLE: value }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { sessionRole, relaySkipLine } from ${JSON.stringify(HELPER)}
    const env = ${JSON.stringify(env)}
    process.stdout.write(JSON.stringify({ role: sessionRole(env), line: relaySkipLine('TEST WATCH', env) }))
  `], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout) as { role: string; line: string | null }
}

describe('session role', () => {
  it.each([
    [undefined, 'principal'],
    ['relay', 'relay'],
    ['RELAY', 'relay'],
    [' relay ', 'relay'],
    ['principal', 'principal'],
    ['main', 'principal'],
    ['', 'principal'],
  ])('classifies %j as %s', (value, expected) => {
    expect(readRole(value).role).toBe(expected)
  })

  it('returns the exact relay skip line only for relay sessions', () => {
    expect(readRole('relay').line).toBe("TEST WATCH NOT ARMED: relay session (WT_SESSION_ROLE=relay) — this session only relays; it cannot act on this watcher's events")
    expect(readRole('principal').line).toBeNull()
  })
})
