import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { journalFixture } from './fixtures/work-journal.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import * as api from '../../../../plugin/bin/lib/work-journal.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { sessionStart } from '../../../../plugin/bin/lib/work-journal-lifecycle.mjs'

type Row = { ts?: string; fileDay?: string; subject?: string; kind?: string; text?: string }
const fixtures: ReturnType<typeof journalFixture>[] = []
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.cleanup() })
// Local noon: day boundaries are computed in the runner's own time zone, so a UTC instant would
// land on another calendar day east or west of UTC.
function fixture(now = '2026-06-02T12:00:00') {
  const f = journalFixture(); f.env.WT_WORK_JOURNAL_NOW = now; fixtures.push(f)
  return f
}
function context(f: ReturnType<typeof fixture>) { return api.resolveJournal({}, f.env) }
function row(day: string, extra: Partial<Row> = {}): Row { return { ts: `${day}T12:00:00Z`, subject: 'feature', kind: 'commit', text: 'Change', ...extra } }
// Bypass makeAct deliberately: the reader must bound fields even from externally built, hash-valid lines.
function seed(f: ReturnType<typeof fixture>, rows: Row[]) {
  const ctx = context(f)
  let prev = '0'.repeat(64)
  const files = new Map<string, string[]>()
  for (const [index, { fileDay, ...value }] of rows.entries()) {
    const day = fileDay || value.ts?.slice(0, 10) || '2026-06-02'
    const line = { v: 1, id: index.toString(16).padStart(16, '0'), link: 'journal:detail', ...value, prev }
    prev = api.hashLine(line)
    files.set(day, [...(files.get(day) || []), JSON.stringify({ ...line, hash: prev })])
  }
  for (const root of [ctx.store, ctx.archive]) {
    mkdirSync(join(root, 'days'), { recursive: true })
    for (const [day, lines] of files) writeFileSync(join(root, 'days', `${day}.ndjson`), `${lines.join('\n')}\n`)
  }
  writeFileSync(join(ctx.store, 'head.json'), JSON.stringify({ day: [...files.keys()].at(-1), hash: prev, count: rows.length }))
  return ctx
}
function detailed(digest: string) { return digest.split('\n').filter((line) => /^Work journal \d/.test(line)).map((line) => line.slice(13)) }
function condensed(digest: string) { return digest.split('\n').filter((line) => /^\d{4}-\d{2}-\d{2} · /.test(line)) }
function wellFormed(text: string) { return (text as string & { isWellFormed(): boolean }).isWellFormed() }
function windowRows(subjects = 5, text = 'Change') {
  const rows: Row[] = []
  for (let offset = 0; offset < 14; offset++) {
    const day = api.dayOf(new Date(2026, 4, 20 + offset, 12))
    for (let subject = 0; subject < subjects; subject++) rows.push(row(day, { subject: `topic-${subject}`, text }))
  }
  return rows
}
function expectShapes(digest: string) {
  const shapes = [
    /^Work journal — detail \d{4}-\d{2}-\d{2}(, \d{4}-\d{2}-\d{2})?; earlier days of the last 14 condensed \(full day: wt-work-journal\.mjs show --date YYYY-MM-DD\)$/,
    /^Earlier:$/, /^\d{4}-\d{2}-\d{2} · \d+ acts · .+( \(\+\d+ subjects\))?$/,
    /^Work journal \d{4}-\d{2}-\d{2}$/, /^.* — \d+ acts \(.*\), last \d{2}:\d{2} .*$/,
    /^\+\d+ more subjects — show --date \d{4}-\d{2}-\d{2}$/,
    /^digest trimmed to fit — wt-work-journal\.mjs show --date \d{4}-\d{2}-\d{2} for any day above$/,
  ]
  expect(wellFormed(digest)).toBe(true)
  for (const line of digest.split('\n')) expect(shapes.some((shape) => shape.test(line)), `unknown line: ${JSON.stringify(line)}`).toBe(true)
}

it('worked days: details D-5 and D-2, not calendar yesterday or empty today', () => {
  const f = fixture()
  const ctx = seed(f, [row('2026-05-28'), row('2026-05-31')])
  expect(detailed(api.digestJournal(ctx))).toEqual(['2026-05-28', '2026-05-31'])
})

it('weekend: details Friday and Monday across an empty Sunday boundary', () => {
  const f = fixture('2026-06-01T12:00:00Z')
  const ctx = seed(f, [row('2026-05-29'), row('2026-06-01')])
  for (const root of [ctx.store, ctx.archive]) writeFileSync(join(root, 'days', '2026-05-31.ndjson'), '')
  expect(detailed(api.digestJournal(ctx))).toEqual(['2026-05-29', '2026-06-01'])
})

it('idle: retains two worked days older than the fourteen-day window', () => {
  const f = fixture()
  const ctx = seed(f, [row('2026-05-12'), row('2026-05-13')])
  writeFileSync(join(ctx.store, 'days', '2026-06-02.ndjson'), '')
  const digest: string = api.digestJournal(ctx)
  expect(detailed(digest)).toEqual(['2026-05-12', '2026-05-13'])
  expect(condensed(digest)).toEqual([])
  expect(digest).not.toContain('No activity.')
})

it('condensed: eight older worked days, chronological, top three counts and omitted subjects', () => {
  const f = fixture()
  const rows: Row[] = []
  for (let offset = 0; offset < 10; offset++) {
    const day = api.dayOf(new Date(2026, 4, 24 + offset, 12))
    for (const [subject, count] of [['alpha', 4], ['beta', 3], ['gamma', 2], ['delta', 1], ['epsilon', 1]] as const) {
      for (let i = 0; i < count; i++) rows.push(row(day, { subject }))
    }
  }
  const digest: string = api.digestJournal(seed(f, rows))
  expect(condensed(digest)).toEqual(Array.from({ length: 8 }, (_, i) => `${api.dayOf(new Date(2026, 4, 24 + i, 12))} · 11 acts · alpha 4, beta 3, gamma 2 (+2 subjects)`))
  expect(detailed(digest)).toEqual(['2026-06-01', '2026-06-02'])
  expect(digest).toContain('full day: wt-work-journal.mjs show --date YYYY-MM-DD')
})

it('window edge: excludes D-14 but includes D-13 in condensed history', () => {
  const f = fixture()
  const digest = api.digestJournal(seed(f, ['2026-05-19', '2026-05-20', '2026-06-01', '2026-06-02'].map((day) => row(day))))
  expect(condensed(digest).map((line) => line.slice(0, 10))).toEqual(['2026-05-20'])
})

it('within-day rollback: details last stored act even when its timestamp decreases', () => {
  const f = fixture()
  const ctx = seed(f, [row('2026-06-02', { text: 'First act' }), row('2026-06-02', { ts: '2026-06-02T11:00:00Z', text: 'Clock rolled back' })])
  expect(api.digestJournal(ctx)).toContain('feature — 2 acts (commit), last 11:00 Clock rolled back')
})

it('bound sweep: reserves the trim marker at below, equal and above whole-line budgets', () => {
  const f = fixture()
  const ctx = seed(f, windowRows(5, 'x'.repeat(100)))
  const full: string = api.digestJournal(ctx, { budget: 7000 })
  expect(full).not.toContain('digest trimmed to fit')
  for (let budget = full.length - 240; budget <= full.length + 40; budget++) {
    const digest: string = api.digestJournal(ctx, { budget })
    expect(digest.length, `budget ${budget}`).toBeLessThanOrEqual(budget)
    expect(digest.includes('digest trimmed to fit'), `budget ${budget}`).toBe(budget < full.length)
    expectShapes(digest)
  }
})

it('adversarial bound: caps direct-chain emoji, CJK, combining, controls, kinds and missing timestamps', () => {
  const f = fixture()
  const hostile = '😀'.repeat(40) + '😀中e\u0301\ud800\n\r\t\u0000\u0085\u2028\u2029'.repeat(80)
  const rows = windowRows(30, hostile).map((value, index) => ({ ...value, subject: `${value.subject}-${hostile}`, kind: `k${index % 5}${hostile}` }))
  rows.push({ fileDay: '2026-06-02', subject: 'missing-ts', kind: 'commit', text: 'must be skipped' })
  const ctx = seed(f, rows)
  for (const budget of [500, 800, 1500, 3499, 6999, 7000]) {
    const digest: string = api.digestJournal(ctx, { budget })
    expect(digest.length).toBeLessThanOrEqual(budget)
    expectShapes(digest)
    expect(digest).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/)
    expect(digest).not.toContain('must be skipped')
    expect(digest).toContain('digest trimmed to fit')
  }
})

it('field limits: twelve subjects, three kinds plus count, code-point subject and text limits', () => {
  const f = fixture()
  const rows = Array.from({ length: 13 }, (_, i) => row('2026-06-02', { subject: `s${i}-${'😀'.repeat(60)}`, text: '中'.repeat(120) }))
  for (const kind of ['merge', 'done', 'tag', 'push']) rows.push({ ...rows[0]!, kind })
  const digest: string = api.digestJournal(seed(f, rows))
  const detail = digest.split('\n').filter((line) => line.includes(' acts ('))
  expect(detail).toHaveLength(12)
  expect(digest).toMatch(/5 acts \([^)]*\+2\)/)
  expect(digest).toContain('+1 more subjects — show --date 2026-06-02')
  for (const line of detail) {
    expect(Array.from(line.split(' — ')[0]!).length).toBeLessThanOrEqual(48)
    expect(Array.from(line.split('last 12:00 ')[1]!).length).toBeLessThanOrEqual(100)
  }
})

it('session total: bounds worst-case notices and emits the digest last', () => {
  const f = fixture(); f.board()
  const ctx = seed(f, [...windowRows(30, '😀中e\u0301'.repeat(100)), row('2026-06-02', { kind: 'unsynced', subject: 'board' })])
  for (const day of Array.from({ length: 9 }, (_, i) => api.dayOf(new Date(2026, 4, 20 + i, 12)))) writeFileSync(join(ctx.archive, 'days', `${day}.ndjson`), '')
  writeFileSync(join(f.project, '.claude', 'progress.md'), '# Tasks')
  mkdirSync(join(ctx.store, 'lock'))
  writeFileSync(join(ctx.store, 'lock', 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'held' }))
  mkdirSync(join(ctx.store, 'pending'))
  writeFileSync(join(ctx.store, 'pending', 'old.json'), '{}')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200000)
  vi.spyOn(api, 'verifyJournal').mockReturnValue({ ...api.verifyJournal(ctx), errors: Array.from({ length: 9 }, (_, i) => `error-${i} ${'😀\n'.repeat(2000)}`) })
  vi.spyOn(api, 'withJournalLock').mockImplementation(() => { throw new Error('busy; act queued') })
  const message: string = sessionStart(ctx, {}, { warnings: Array.from({ length: 8 }, (_, i) => `warning-${i} ${'😀\n'.repeat(2000)}`) })
  expect(message.length).toBeLessThanOrEqual(9500)
  expect(wellFormed(message)).toBe(true)
  expect(message).not.toContain('warning-5')
  const start = message.indexOf('Work journal — detail')
  expect(start).toBeGreaterThan(message.indexOf('retire-progress'))
  expect(start).toBeGreaterThan(message.indexOf('journal busy'))
  expect(start).toBeGreaterThan(message.indexOf('pending journal acts'))
  expect(start).toBeGreaterThan(message.indexOf('more integrity errors'))
  expect(start).toBeGreaterThan(message.indexOf('unsynced entries'))
  expect(message.slice(start)).not.toContain('LOUD:')
  expectShapes(message.slice(start))
})

it('refusal: rejects a forged line inside the selected window', () => {
  const f = fixture()
  const ctx = seed(f, windowRows())
  const file = join(ctx.store, 'days', '2026-05-20.ndjson')
  writeFileSync(file, readFileSync(file, 'utf8').replace('Change', 'Forged'))
  expect(() => api.digestJournal(ctx)).toThrow('digest refused: live chain broken')
})

it('anchored read: old corruption outside the selected contiguous range leaves digest unchanged', () => {
  const f = fixture()
  const ctx = seed(f, [row('2026-05-01'), ...windowRows()])
  const before = api.digestJournal(ctx)
  writeFileSync(join(ctx.store, 'days', '2026-05-01.ndjson'), 'corrupted\n')
  expect(api.digestJournal(ctx)).toBe(before)
  expect(api.verifyJournal(ctx).ok).toBe(false)
})

it('determinism: identical bytes, timestamp ties use subject order and now is read once', () => {
  const f = fixture()
  const ctx = seed(f, ['é', 'a', 'Z'].map((subject) => row('2026-06-02', { subject })))
  let reads = 0
  Object.defineProperty(ctx, 'now', { get() { reads++; return new Date('2026-06-02T12:00:00Z') } })
  const first: string = api.digestJournal(ctx)
  expect(reads).toBe(1)
  expect(first.split('\n').filter((line) => line.includes(' acts (')).map((line) => line.split(' — ')[0])).toEqual(['Z', 'a', 'é'])
  expect(api.digestJournal(ctx)).toBe(first)
  expect(reads).toBe(2)
})

it('folding: combines short and full card subjects, displays longest id without changing stored bytes', () => {
  const f = fixture()
  const ctx = seed(f, [row('2026-06-02', { subject: 'card:1234567890' }), row('2026-06-02', { subject: 'card:1234567890123456789', kind: 'done' }), row('2026-06-02', { subject: 'card:1234567891' })])
  const file = join(ctx.store, 'days', '2026-06-02.ndjson')
  const before = readFileSync(file)
  const digest = api.digestJournal(ctx)
  expect(digest).toContain('card:1234567890123456789 — 2 acts')
  expect(digest).not.toContain('card:1234567890 — ')
  expect(digest).toContain('card:1234567891 — 1 acts')
  expect(readFileSync(file)).toEqual(before)
})

it('folding: never merges two different full card ids that share their first ten digits', () => {
  const f = fixture()
  const ctx = seed(f, [
    row('2026-06-02', { subject: 'card:1234567890' }),
    row('2026-06-02', { subject: 'card:1234567890123456789' }),
    row('2026-06-02', { subject: 'card:1234567890987654321' }),
  ])
  const digest: string = api.digestJournal(ctx)
  expect(digest).toContain('card:1234567890123456789 — 1 acts')
  expect(digest).toContain('card:1234567890987654321 — 1 acts')
  expect(digest).toContain('card:1234567890 — 1 acts')
})

// Splits a digest into its condensed lines and, per detail day, its subject rows.
function sections(digest: string) {
  const days = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of digest.split('\n')) {
    const header = /^Work journal (\d{4}-\d{2}-\d{2})$/.exec(line)
    if (header) { current = []; days.set(header[1], current) } else if (current && line.includes(' acts (')) current.push(line)
  }
  return { condensed: condensed(digest), days }
}
function isPrefix(part: string[], whole: string[]) { return part.every((line, index) => line === whole[index]) }
function isSuffix(part: string[], whole: string[]) { return isPrefix([...part].reverse(), [...whole].reverse()) }
function expectDropOrder(trimmed: ReturnType<typeof sections>, full: ReturnType<typeof sections>, label: string) {
  const [older, newer] = [...full.days.keys()]
  const keptOlder = trimmed.days.get(older) || []
  const keptNewer = trimmed.days.get(newer) || []
  expect(isSuffix(trimmed.condensed, full.condensed), `${label}: oldest condensed days go first`).toBe(true)
  expect(isPrefix(keptOlder, full.days.get(older) || []), `${label}: least recent older-day subjects go first`).toBe(true)
  expect(isPrefix(keptNewer, full.days.get(newer) || []), `${label}: least recent newer-day subjects go first`).toBe(true)
  if (keptOlder.length < (full.days.get(older) || []).length) expect(trimmed.condensed, `${label}: condensed days before detail`).toEqual([])
  if (keptNewer.length < (full.days.get(newer) || []).length) expect(keptOlder, `${label}: older day before newer day`).toEqual([])
}

it('drop order: oldest condensed days, then the older detail day, then the newer one, at every budget', () => {
  const f = fixture()
  const ctx = seed(f, windowRows(6, 'y'.repeat(60)))
  const full = sections(api.digestJournal(ctx, { budget: 7000 }))
  expect(full.condensed.length).toBeGreaterThan(3)
  for (let budget = 7000; budget >= 400; budget -= 37) {
    const digest: string = api.digestJournal(ctx, { budget })
    expect(digest.length, `budget ${budget}`).toBeLessThanOrEqual(budget)
    expectDropOrder(sections(digest), full, `budget ${budget}`)
  }
})

it('CLI digest: still prints the warning and the digest when verification itself throws', () => {
  const f = fixture()
  const ctx = seed(f, [row('2026-06-02')])
  writeFileSync(join(ctx.store, 'head.json'), '{')
  const result = f.cli(['digest'])
  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^LOUD: work journal: journal did not verify; run wt-work-journal\.mjs verify\nWork journal — detail /)
})

it('CLI digest: prepends a LOUD verification line even when the selected live chain is intact', () => {
  const f = fixture()
  const ctx = seed(f, [row('2026-06-02')])
  writeFileSync(join(ctx.store, 'head.json'), '{}')
  const result = f.cli(['digest'])
  expect(result.stdout).toMatch(/^LOUD: work journal: journal did not verify; run wt-work-journal\.mjs verify\nWork journal — detail /)
})

it('CLI digest: warns before refusing a broken live chain', () => {
  const f = fixture()
  const ctx = seed(f, [row('2026-06-02')])
  const file = join(ctx.store, 'days', '2026-06-02.ndjson')
  writeFileSync(file, readFileSync(file, 'utf8').replace('Change', 'Forged'))
  const result = f.cli(['digest'])
  expect(result.status).toBe(1)
  expect(result.stdout).toMatch(/^LOUD: work journal: journal did not verify;/)
  expect(result.stderr).toContain('digest refused: live chain broken')
})

it('empty journal: has one explicit no-acts line', () => {
  expect(api.digestJournal(context(fixture()))).toBe('Work journal: no acts recorded yet.')
})
