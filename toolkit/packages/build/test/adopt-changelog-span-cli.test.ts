// adopt-changelog-span-cli.test.ts — CLI-level lock for the `adopt --check` changelog
// span (card 1836356654). Drives the REAL install.mjs as a child process, the same
// technique as adopt-installer.test.ts, so this exercises the wiring — not just the pure
// changelogSpan() function adopt-changelog-span.test.ts already locks.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const RULE = 'wt-answer-first-reporting.md'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function mkDir(): string {
  const r = mkdtempSync(join(tmpdir(), 'wt-adopt-span-'))
  roots.push(r)
  return r
}
function run(args: string[], dir: string): string {
  const res = spawnSync(process.execPath, [SCRIPT, ...args, '--dir', dir], { encoding: 'utf8' })
  return (res.stdout ?? '') + (res.stderr ?? '')
}

/** Write a STALE-but-CLEAN rule copy at `version`, mirroring adopt-installer.test.ts's own
 *  `ageRuleCopy` fixture: a genuinely different body (so STALE tracks content, not just a
 *  version number) with a fingerprint that round-trips, so the copy classifies 'clean'. */
function ageRuleCopy(file: string, version: string): void {
  const body = readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8') + '\nA PARAGRAPH SINCE REWRITTEN UPSTREAM\n'
  const fp = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
  writeFileSync(
    file,
    `<!-- installed from workflow-toolbox v${version} · content sha256:${fp} by the adopt skill -->\n\n${body}`,
  )
}

describe('adopt --check — CHANGELOG span for a STALE rule copy', () => {
  it('a version WITHIN the recorded range shows entries, newest first, from the real plugin CHANGELOG.md', () => {
    const d = mkDir()
    mkdirSync(d, { recursive: true })
    ageRuleCopy(join(d, RULE), '0.140.0')
    const out = run(['--check'], d)
    expect(out).toContain('STALE')
    expect(out).toMatch(/CHANGELOG v0\.140\.0 → v\d+\.\d+\.\d+/)
    // Not the unrecorded shape — this range IS inside the changelog's recorded span. Match
    // the exact SPAN-HEADER line shape, never a bare substring: the real plugin CHANGELOG
    // entry for THIS feature legitimately quotes the words "NO RECORD for this range" in its
    // own prose, so a naive .not.toContain() on that phrase is a false positive against the
    // live changelog it is reading.
    expect(out).not.toMatch(/CHANGELOG v0\.140\.0 → v[\d.]+: NO RECORD/)
  })

  // Regression lock for the arbiter-found defect: a version well ABOVE the file's oldest
  // heading (so the boundary guard alone would report recorded:true with no warning) can
  // still sit on the far side of a large INTERIOR gap. v0.70.0 lands inside the real,
  // permanent 61-minor gap this card's own invariant is built around (0.68..0.135ish carry
  // no heading) — the exact shape that used to render as a confident, complete-looking span.
  it('a version INSIDE a real interior gap gets an explicit COVERAGE: INCOMPLETE line, never a silent partial span', () => {
    const d = mkDir()
    mkdirSync(d, { recursive: true })
    ageRuleCopy(join(d, RULE), '0.70.0')
    const out = run(['--check'], d)
    expect(out).toContain('STALE')
    // Recorded (has entries) AND flagged incomplete — the two are not mutually exclusive,
    // which is the whole point: an empty span alone can't represent this case honestly.
    expect(out).toMatch(/CHANGELOG v0\.70\.0 → v[\d.]+ \(\d+ entr/)
    expect(out).toMatch(/COVERAGE: INCOMPLETE — approx\. \d+ version\(s\) between v0\.70\.0/)
  })

  it('a version whose range genuinely has every minor documented reports COVERAGE: complete', () => {
    const d = mkDir()
    mkdirSync(d, { recursive: true })
    // One minor behind current — the mechanical changelog gate guarantees every NEW release
    // (this one included) carries its own heading, so a one-step-behind copy's range can
    // never have an interior gap.
    const pluginJson = JSON.parse(
      readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8'),
    ) as { version: string }
    const parts = pluginJson.version.split('.').map(Number)
    const maj = parts[0] ?? 0
    const min = parts[1] ?? 0
    const patch = parts[2] ?? 0
    const oneMinorBehind = `${maj}.${min - 1}.${patch}`
    ageRuleCopy(join(d, RULE), oneMinorBehind)
    const out = run(['--check'], d)
    expect(out).toContain('STALE')
    expect(out).toMatch(new RegExp(`COVERAGE: complete — every version between v${oneMinorBehind.replace(/\./g, '\\.')}`))
    // Match the exact COVERAGE-line shape, never a bare substring: this very entry's own
    // changelog prose (below, in the real plugin/CHANGELOG.md) legitimately quotes the words
    // "COVERAGE: INCOMPLETE" describing the feature — the same self-referential collision
    // already fixed once above for "NO RECORD for this range".
    expect(out).not.toMatch(/^ {4}COVERAGE: INCOMPLETE/m)
  })

  it('a version BELOW every recorded heading gets the explicit "NO RECORD" shape, not a blank slice', () => {
    const d = mkDir()
    mkdirSync(d, { recursive: true })
    ageRuleCopy(join(d, RULE), '0.1.0')
    const out = run(['--check'], d)
    expect(out).toContain('STALE')
    expect(out).toContain('NO RECORD for this range')
    // The reassurance-shaped sentence must be visible right next to it, or the reader
    // still comes away thinking "0.1.0 → current" was quiet.
    expect(out).toContain('does NOT mean nothing changed')
  })

  it('UP-TO-DATE prints no span at all — the section is STALE-only, never a distraction elsewhere', () => {
    const d = mkDir()
    mkdirSync(d, { recursive: true })
    run(['--install'], d)
    const out = run(['--check'], d)
    expect(out).toContain('UP-TO-DATE')
    expect(out).not.toContain('CHANGELOG v')
  })

  it('ABSENT prints no span either — there is no installed version to slice from', () => {
    const d = mkDir()
    mkdirSync(d, { recursive: true })
    const out = run(['--check'], d)
    expect(out).toContain('ABSENT')
    expect(out).not.toContain('CHANGELOG v')
  })

  it('does not disturb --install\'s own STALE refresh behaviour (invariant: adds a section, restyles nothing)', () => {
    const d = mkDir()
    mkdirSync(d, { recursive: true })
    ageRuleCopy(join(d, RULE), '0.140.0')
    const out = run(['--install'], d)
    expect(out).toMatch(/REFRESHED v\d+\.\d+\.\d+/)
  })
})
