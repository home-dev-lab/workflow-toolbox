// pilot-card-reconcile.test.ts — card 1827494361110152853: a card whose pilot dies before its
// own intake stays claimed on the board while nobody works it, and nothing detects it. Drives the
// real script as a child process (closest-to-real, same style as outbound-guard-hooks.test.ts).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const RECONCILE = join(REPO_ROOT, 'plugin/bin/wt-pilot-card-reconcile.mjs')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function mkRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `wt-reconcile-${tag}-`))
  roots.push(r)
  return r
}
function run(args: string[], env: NodeJS.ProcessEnv): { stdout: string; stderr: string; code: number | null } {
  const res = spawnSync(process.execPath, [RECONCILE, ...args], { encoding: 'utf8', env })
  return { stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim(), code: res.status }
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

// POSITIVE CONTROL FIRST, per this card's own closure criterion: "avoir vu le comparateur
// signaler un vrai cas, fabriqué exprès" — prove the comparator CAN detect the failure before
// trusting any "silent" result below.
describe('wt-pilot-card-reconcile — POSITIVE CONTROL: the discriminating case this card exists for', () => {
  it('flags a card claimed 10 min ago whose pilot never shows up in the registry at all (pilot died before spawn was even recorded)', () => {
    const dir = mkRoot('dead-before-spawn')
    const cardsPath = join(dir, 'cards.json')
    writeFileSync(cardsPath, JSON.stringify([
      { cardId: 'card-999', title: 'orphaned card', list: 'InProgress', claimedAt: minutesAgo(10) },
    ]))
    writeFileSync(join(dir, 'sess.jsonl'), '') // registry exists but has NOTHING for this card
    const r = run(['--cards', cardsPath, '--session', 'sess', '--tolerance-min', '5', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code, `expected a mismatch; stdout: ${r.stdout}`).toBe(1)
    const parsed = JSON.parse(r.stdout) as { mismatches: Array<{ kind: string; cardId?: string }> }
    expect(parsed.mismatches.some((m) => m.kind === 'card-claimed-no-live-pilot' && m.cardId === 'card-999')).toBe(true)
  })

  it('flags a card claimed 10 min ago whose pilot WAS spawned but already died (spawn record present, no stop needed — no stop makes it MORE alive here, so use a stopped pilot as the "died and gave up" case is out of scope; this proves the pure spawn-with-no-name-match case)', () => {
    const dir = mkRoot('spawned-wrong-purpose')
    const cardsPath = join(dir, 'cards.json')
    writeFileSync(cardsPath, JSON.stringify([
      { cardId: 'card-777', title: 'claimed but unmatched', list: 'InProgress', claimedAt: minutesAgo(10) },
    ]))
    writeFileSync(
      join(dir, 'sess.jsonl'),
      JSON.stringify({
        t: 'spawn', parentName: '(main-loop)', child: 'achild-unrelated', childName: 'unrelated-pilot', name: 'unrelated-pilot',
        purpose: 'working on something else entirely', at: minutesAgo(10),
      }) + '\n'
    )
    const r = run(['--cards', cardsPath, '--session', 'sess', '--tolerance-min', '5', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(1)
    const parsed = JSON.parse(r.stdout) as { mismatches: Array<{ kind: string; cardId?: string; pilotName?: string }> }
    expect(parsed.mismatches.some((m) => m.kind === 'card-claimed-no-live-pilot' && m.cardId === 'card-777')).toBe(true)
    // the unrelated-but-alive pilot is ALSO flagged: it references no card in the given set
    expect(parsed.mismatches.some((m) => m.kind === 'live-pilot-no-claimed-card' && m.pilotName === 'unrelated-pilot')).toBe(true)
  })
})

describe('wt-pilot-card-reconcile — stays silent during a normal intake window', () => {
  it('does NOT flag a card claimed 1 min ago (inside the default 5-min tolerance) even with no pilot yet', () => {
    const dir = mkRoot('intake-window')
    const cardsPath = join(dir, 'cards.json')
    writeFileSync(cardsPath, JSON.stringify([
      { cardId: 'card-111', title: 'just spawned', list: 'Next', claimedAt: minutesAgo(1) },
    ]))
    writeFileSync(join(dir, 'sess.jsonl'), '')
    const r = run(['--cards', cardsPath, '--session', 'sess', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code, `expected NO mismatch inside tolerance; stdout: ${r.stdout}`).toBe(0)
    const parsed = JSON.parse(r.stdout) as { mismatches: unknown[] }
    expect(parsed.mismatches).toHaveLength(0)
  })

  it('does NOT flag a card whose pilot IS alive and references the card id in its spawn purpose', () => {
    const dir = mkRoot('matched-pilot')
    const cardsPath = join(dir, 'cards.json')
    writeFileSync(cardsPath, JSON.stringify([
      { cardId: 'card-222', title: 'being worked', list: 'InProgress', claimedAt: minutesAgo(30) },
    ]))
    writeFileSync(
      join(dir, 'sess.jsonl'),
      JSON.stringify({
        t: 'spawn', parentName: '(main-loop)', child: 'achild-worker', childName: 'worker-222', name: 'worker-222',
        purpose: 'Pilot card-222 through the dev loop', at: minutesAgo(30),
      }) + '\n'
    )
    const r = run(['--cards', cardsPath, '--session', 'sess', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code, `expected no mismatch; stdout: ${r.stdout}`).toBe(0)
    const parsed = JSON.parse(r.stdout) as { mismatches: unknown[]; pilotsAlive: string[] }
    expect(parsed.mismatches).toHaveLength(0)
    expect(parsed.pilotsAlive).toContain('worker-222')
  })

  it('a card whose pilot already STOPPED (finished normally) does not count as a live-pilot match — it correctly still flags as unmatched, proving "alive" is checked, not merely "was ever spawned"', () => {
    const dir = mkRoot('pilot-already-stopped')
    const cardsPath = join(dir, 'cards.json')
    writeFileSync(cardsPath, JSON.stringify([
      { cardId: 'card-333', title: 'pilot finished, card still claimed', list: 'InProgress', claimedAt: minutesAgo(30) },
    ]))
    writeFileSync(
      join(dir, 'sess.jsonl'),
      [
        JSON.stringify({
          t: 'spawn', parentName: '(main-loop)', child: 'achild-333', childName: 'worker-333', name: 'worker-333',
          purpose: 'Pilot card-333 through the dev loop', at: minutesAgo(30),
        }),
        JSON.stringify({ t: 'stop', agentId: 'achild-333', name: 'worker-333', event: 'SubagentStop', at: minutesAgo(20) }),
      ].join('\n') + '\n'
    )
    const r = run(['--cards', cardsPath, '--session', 'sess', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code, `expected a mismatch; stdout: ${r.stdout}`).toBe(1)
    const parsed = JSON.parse(r.stdout) as { mismatches: Array<{ kind: string; cardId?: string }> }
    expect(parsed.mismatches.some((m) => m.kind === 'card-claimed-no-live-pilot' && m.cardId === 'card-333')).toBe(true)
  })
})

describe('wt-pilot-card-reconcile — names both sets it compared, never a bare count', () => {
  it('--json output lists cardsChecked and pilotsAlive explicitly', () => {
    const dir = mkRoot('named-sets')
    const cardsPath = join(dir, 'cards.json')
    writeFileSync(cardsPath, JSON.stringify([{ cardId: 'card-abc', list: 'InProgress', claimedAt: minutesAgo(1) }]))
    writeFileSync(join(dir, 'sess.jsonl'), '')
    const r = run(['--cards', cardsPath, '--session', 'sess', '--json'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    const parsed = JSON.parse(r.stdout) as { cardsChecked: string[]; pilotsAlive: string[] }
    expect(parsed.cardsChecked).toEqual(['card-abc'])
    expect(Array.isArray(parsed.pilotsAlive)).toBe(true)
  })

  it('human-text mode names both sets, not just a count', () => {
    const dir = mkRoot('named-sets-text')
    const cardsPath = join(dir, 'cards.json')
    writeFileSync(cardsPath, JSON.stringify([{ cardId: 'card-xyz', list: 'InProgress', claimedAt: minutesAgo(1) }]))
    writeFileSync(join(dir, 'sess.jsonl'), '')
    const r = run(['--cards', cardsPath, '--session', 'sess'], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.stdout).toContain('Cards checked')
    expect(r.stdout).toContain('card-xyz')
    expect(r.stdout).toContain('Pilots alive')
  })
})

describe('wt-pilot-card-reconcile — degrades safely', () => {
  it('exits 2 with no registry directory', () => {
    const dir = join(mkRoot('no-registry'), 'nonexistent')
    const cardsPath = join(mkRoot('no-registry-cards'), 'cards.json')
    writeFileSync(cardsPath, '[]')
    const r = run(['--cards', cardsPath], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(2)
  })

  it('exits 2 when --cards is missing', () => {
    const dir = mkRoot('no-cards-flag')
    const r = run([], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--cards')
  })

  it('exits 2 with a clear message when --cards points at unparseable JSON', () => {
    const dir = mkRoot('bad-cards-json')
    const cardsPath = join(dir, 'cards.json')
    writeFileSync(cardsPath, 'not json')
    const r = run(['--cards', cardsPath], { ...process.env, WT_OUTBOUND_GUARD_DIR: dir })
    expect(r.code).toBe(2)
  })
})
