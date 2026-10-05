import { afterAll, describe, expect, it } from 'vitest'
import { sealRuleNarrativeFile } from '../../../test-support/rule-narrative-stub.js'
import '../../../../plugin/bin/wt-rule-convention-guard-hook.mjs'
import { addedLines, detectNarrative } from '../../../../plugin/bin/lib/rule-narrative-detect.mjs'

const detect = (text: string) => detectNarrative(addedLines({ tool: 'Write', input: { content: text } }))
const fileSeal = sealRuleNarrativeFile()
afterAll(fileSeal.restore)

describe('rule narrative detection', () => {
  it.each([
    ['DATE (MONTH)', 'Alice, 28 Sept 2026', 'Use the September release.'],
    ['DATE (MONTH)', '1er oct. 16h50', 'Record today\'s count.'],
    ['DATE (MONTH)', 'July 1, 2026', 'Use July releases.'],
    ['DATE (MONTH)', 'octobre 2026', 'Use October releases.'],
    ['DATED ATTRIBUTION', '(Alice 1 Oct 23:47)', '(Alice chose retries)'],
    ['DATED ATTRIBUTION', '(Alice, 2026, remote', '(budget 1826)'],
    ['DATED ATTRIBUTION', 'Alice said at 16h50 to retry.', 'Run at 16h50.'],
    ['DATED ATTRIBUTION', 'At 11:45 Alice reported failures.', 'Run at 11:45.'],
    ['MESSAGE ID', 'See #5797.', 'Use color #123456, #000000, :#123 or #0123.'],
    ['INCIDENT', 'Measured here: retries failed.', 'Record today\'s count.'],
    ['INCIDENT', 'It happened twice.', 'It can happen.'],
    ['INCIDENT', 'A field case broke retries yesterday.', 'Handle every case.'],
    ['INCIDENT', 'Last night, earlier today, this morning.', 'Run nightly.'],
    ['INCIDENT', 'Hier, ce matin, cette nuit, cas fondateur.', 'Run every morning.'],
  ])('%s warns on %s and is silent on its near miss', (detector, text, quiet) => {
    expect(detect(text)).toEqual(expect.arrayContaining([expect.objectContaining({ detector, tier: 'warn' })]))
    expect(detect(quiet).filter((finding: { tier: string }) => finding.tier === 'warn')).toEqual([])
  })

  it('does not duplicate inherited deny phrases as incident warnings', () => {
    expect(detect('that evening, one evening, the night of')).toHaveLength(3)
    expect(detect('that evening').map((finding: { tier: string }) => finding.tier)).toEqual(['deny'])
  })

  it('keeps legacy escape semantics while warning on marked attributions', () => {
    const found = detect('Alice (2026 02:30) 2026-10-01 <!-- rule-lint: allow -->')
    expect(found.every((finding: { tier: string }) => finding.tier === 'warn')).toBe(true)
    expect(found.some((finding: { detector: string }) => finding.detector === 'DATED ATTRIBUTION')).toBe(true)
    expect(detect('Quote 27/07 <!-- rule-lint: allow -->')).toEqual([])
  })

  it('does not add a warning for an ISO date in a command example', () => {
    expect(detect('find . -newermt 2026-10-01').map((finding: { tier: string }) => finding.tier)).toEqual(['deny'])
  })

  it('subtracts a multiset while retaining original line numbers and context', () => {
    const lines = addedLines({ tool: 'Edit', input: {
      old_string: 'legacy 2026-10-01\nkeep', new_string: 'legacy 2026-10-01\nkeep\nkeep\nAlice (02:30)',
    } })
    expect(lines.map(({ text, lineNumber }: { text: string; lineNumber: number }) => [lineNumber, text])).toEqual([
      [3, 'keep'], [4, 'Alice (02:30)'],
    ])
    expect(detectNarrative(lines)[0]?.lineNumber).toBe(4)
  })

  it('compares Write with the supplied current file and handles MultiEdit per edit', () => {
    expect(addedLines({ tool: 'Write', input: { content: 'legacy 2026-10-01\nkeep' }, currentText: 'legacy 2026-10-01' })
      .map(({ text }: { text: string }) => text)).toEqual(['keep'])
    expect(addedLines({ tool: 'MultiEdit', input: { edits: [
      { old_string: 'a', new_string: 'a\nb' }, { old_string: 'b', new_string: 'b\nc' },
    ] } }).map(({ lineNumber, text }: { lineNumber: number; text: string }) => [lineNumber, text])).toEqual([[2, 'b'], [4, 'c']])
  })
})
