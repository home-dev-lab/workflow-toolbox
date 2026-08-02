// stale-date-guard.test.ts — behavior gates for plugin/bin/wt-stale-date-guard.mjs
// and plugin/bin/lib/stale-date-guard-core.mjs.
//
// WHAT THIS PROTECTS (card #1832980806121817984): a rule carried a dead
// account-reset deadline ("29/07 à 13:59") for four days, read as current
// the whole time, because nothing distinguished an operational deadline from
// the far more common dated PROVENANCE fact ("mesuré le 31/07") — of the 47
// absolute dates counted in this project's rule files, 45 were provenance
// and only 2 were deadlines. A guard that cannot make that distinction
// either misses every real deadline (folds it into provenance) or floods
// itself with 45 false positives and gets disabled within a week — so the
// THREE cases below are the actual acceptance criterion, not a nice-to-have:
//   1. a FUTURE deadline stays silent
//   2. the SAME deadline, once past, gets flagged — proves the guard reads
//      time, not just the presence of a deadline-shaped phrase
//   3. a PROVENANCE date is never flagged, at any age
// All three are required; any one missing means the guard is not done.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'
// @ts-expect-error — plain runtime .mjs helper, no .d.ts (matches the other
// plugin/bin/lib/*.mjs modules this suite drives, e.g. quota-cache.mjs)
import { scanText } from '../../../../plugin/bin/lib/stale-date-guard-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GUARD_CLI = join(REPO_ROOT, 'plugin/bin/wt-stale-date-guard.mjs')

let tmpDirs: string[] = []
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-stale-date-guard-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  tmpDirs = []
})

const TODAY = { year: 2026, month: 8, day: 2 } // matches the card's "today"

interface Finding {
  line: number
  column: number
  raw: string
  date: { year: number; month: number; day: number }
  kind: 'deadline' | 'provenance' | 'unknown'
  stale: boolean
  window: string
}

describe('stale-date-guard-core: classification', () => {
  it('case 1 — a FUTURE deadline is not flagged as stale', () => {
    const text =
      "Le prochain compte utilisable après épuisement : le 29/08 à 13:59. Rien d'autre.\n"
    const findings = scanText(text, { today: TODAY })
    const deadlines = findings.filter((f: Finding) => f.kind === 'deadline')
    expect(deadlines.length).toBeGreaterThan(0)
    for (const d of deadlines) expect(d.stale).toBe(false)
  })

  it('case 2 — the SAME deadline phrase, once past, IS flagged stale (proves time, not pattern)', () => {
    const text =
      "Le prochain compte utilisable après épuisement : le 29/07 à 13:59. Rien d'autre.\n"
    const findings = scanText(text, { today: TODAY })
    const deadlines = findings.filter((f: Finding) => f.kind === 'deadline')
    expect(deadlines.length).toBeGreaterThan(0)
    expect(deadlines.every((d: Finding) => d.stale)).toBe(true)
  })

  it('case 3 — a dated PROVENANCE fact is never flagged, however old', () => {
    const text = 'Mesuré le 31/07 : une vérification indépendante a rendu B sur ce point.\n'
    const findings = scanText(text, { today: TODAY })
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) {
      expect(f.kind).toBe('provenance')
      expect(f.stale).toBe(false)
    }
  })

  it('case 3b — a very old provenance date (crossing years) is still never flagged', () => {
    // Provenance dates in this project omit the year (same-year convention);
    // an explicit older year must still classify as provenance, never as a
    // "deadline" just because it is numerically in the past.
    const text = 'Corrigé le 28/07/2020 — le mécanisme a été revu.\n'
    const findings = scanText(text, { today: TODAY })
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].kind).toBe('provenance')
    expect(findings[0].stale).toBe(false)
  })

  it('a parenthetical citation date ("(Frederic, 31/07)") classifies as provenance with no keyword', () => {
    const text = 'Le mot décide du comportement (Frederic, 31/07) : une porte se passe.\n'
    const findings = scanText(text, { today: TODAY })
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].kind).toBe('provenance')
  })

  it('a date with no deadline or provenance marker nearby is UNKNOWN, never silently dropped or mislabeled', () => {
    const text = 'The migration finished on 15/07 with no further note.\n'
    const findings = scanText(text, { today: TODAY })
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].kind).toBe('unknown')
  })

  it('a real GLM-style deadline ("service jusqu\'au ...") is flagged once past', () => {
    const text =
      "GLM RÉSILIÉ — service jusqu'au 2026-07-28 : après cette date, plus aucun routage.\n"
    const findings = scanText(text, { today: TODAY })
    const deadlines = findings.filter((f: Finding) => f.kind === 'deadline')
    expect(deadlines.length).toBe(1)
    expect(deadlines[0].stale).toBe(true)
  })

  it('regression: a generic use of "échéance" near a citation date is provenance, not a deadline', () => {
    // Real false positive hit scanning this project's own rules (card
    // #1832980806121817984): "annoncer le RANG et l'ÉCHÉANCE de la carte
    // (Frederic, 27/07)" talks ABOUT the concept of a deadline without
    // stating one for the 27/07 citation date itself.
    const text = "annoncer le RANG et l'ÉCHÉANCE de la carte (Frederic, 27/07)\n"
    const findings = scanText(text, { today: TODAY })
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].kind).toBe('provenance')
  })

  it('a future ISO deadline is not flagged', () => {
    const text = "Fenêtre GPT jusqu'à 2026-09-15, re-trancher alors.\n"
    const findings = scanText(text, { today: TODAY })
    const deadlines = findings.filter((f: Finding) => f.kind === 'deadline')
    expect(deadlines.length).toBe(1)
    expect(deadlines[0].stale).toBe(false)
  })
})

describe('wt-stale-date-guard.mjs CLI: exit codes are the ground truth', () => {
  it('exits 0 when no stale deadline is present (future deadline + provenance mixed in)', () => {
    const dir = makeTmpDir()
    writeFileSync(
      join(dir, 'rule.md'),
      "Mesuré le 31/07 : constat X.\nLe prochain compte utilisable est le 29/08 à 13:59.\n",
    )
    const res = spawnSync('node', [GUARD_CLI, '--path', dir, '--today', '2026-08-02', '--json'], {
      encoding: 'utf8',
    })
    expect(res.status).toBe(0)
    const report = JSON.parse(res.stdout)
    expect(report.staleDeadlines.length).toBe(0)
  })

  it('exits 1 when a stale deadline is present, and names the offending line', () => {
    const dir = makeTmpDir()
    writeFileSync(
      join(dir, 'rule.md'),
      "Le prochain compte utilisable après épuisement : le 29/07 à 13:59.\n",
    )
    const res = spawnSync('node', [GUARD_CLI, '--path', dir, '--today', '2026-08-02', '--json'], {
      encoding: 'utf8',
    })
    expect(res.status).toBe(1)
    const report = JSON.parse(res.stdout)
    expect(report.staleDeadlines.length).toBe(1)
    expect(report.staleDeadlines[0].file).toContain('rule.md')
  })

  it('does not fail the gate on unknowns by default, but still reports them', () => {
    const dir = makeTmpDir()
    writeFileSync(join(dir, 'rule.md'), 'Something happened on 10/06 with no marker nearby.\n')
    const res = spawnSync('node', [GUARD_CLI, '--path', dir, '--today', '2026-08-02', '--json'], {
      encoding: 'utf8',
    })
    expect(res.status).toBe(0)
    const report = JSON.parse(res.stdout)
    expect(report.unknowns.length).toBe(1)
  })

  it('--fail-on-unknown makes an unknown date fail the gate too', () => {
    const dir = makeTmpDir()
    writeFileSync(join(dir, 'rule.md'), 'Something happened on 10/06 with no marker nearby.\n')
    const res = spawnSync(
      'node',
      [GUARD_CLI, '--path', dir, '--today', '2026-08-02', '--json', '--fail-on-unknown'],
      { encoding: 'utf8' },
    )
    expect(res.status).toBe(1)
  })

  it('a directory with only provenance dates at scale (45-style) never flags anything', () => {
    const dir = makeTmpDir()
    const lines: string[] = []
    for (let i = 1; i <= 45; i++) {
      lines.push(`Mesuré le 0${(i % 9) + 1}/07 : observation numéro ${i}.`)
    }
    writeFileSync(join(dir, 'rules-bulk.md'), lines.join('\n') + '\n')
    const res = spawnSync('node', [GUARD_CLI, '--path', dir, '--today', '2026-08-02', '--json'], {
      encoding: 'utf8',
    })
    expect(res.status).toBe(0)
    const report = JSON.parse(res.stdout)
    expect(report.staleDeadlines.length).toBe(0)
    expect(report.provenance).toBe(45)
  })

  it('usage error (no --path) exits 2', () => {
    const res = spawnSync('node', [GUARD_CLI], { encoding: 'utf8' })
    expect(res.status).toBe(2)
  })
})
