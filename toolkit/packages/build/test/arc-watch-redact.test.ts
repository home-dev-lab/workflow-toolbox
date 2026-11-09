// arc-watch-redact.test.ts — locks for redact() in plugin/bin/wt-arc-watch.mjs.
//
// redact() scrubs credential-looking text from every line the watcher prints, so a
// token never lands in a session transcript. The script runs its main loop at import
// time, so the function is extracted from the shipped source and evaluated alone
// (the same pattern as what-is-running.test.ts): the test reads the real file, never
// a copy.
//
// The differential table pins the exact output of the original implementation. The
// two regexes were rewritten to remove super-linear backtracking; the table proves the
// rewrite redacts the same set, and the timing locks prove the backtracking is gone.

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const ARC_WATCH_SOURCE = new URL('../../../../plugin/bin/wt-arc-watch.mjs', import.meta.url)

function loadRedact(): (text: unknown) => string {
  const source = readFileSync(ARC_WATCH_SOURCE, 'utf8')
  const body = source.match(/^function redact\(text\) \{[\s\S]*?\n\}/m)?.[0]
  if (!body) throw new Error('function redact(text) not found in wt-arc-watch.mjs')
  return vm.runInNewContext(`${body}; redact`, { String }) as (text: unknown) => string
}

const redact = loadRedact()

// Expected values were produced by the original implementation, before the rewrite.
const DIFFERENTIAL: Array<[string, string]> = [
  ['', ''],
  ['tokenabc', 'token <redacted>'],
  ['token: x', 'token <redacted>'],
  ['-'.repeat(30) + 'abc123def456ghi', '-'.repeat(30) + 'abc123def456ghi'],
  ['-'.repeat(30) + 'abc123def456ghij', '<redacted>'],
  ['12345678901234567890', '12345678901234567890'],
  ['abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'],
  ['abc123def456ghij', '<redacted>'],
  // A run longer than any bounded quantifier whose digit sits only at its end: catches a run regex capped at {16,N}.
  ['a'.repeat(30) + '1', '<redacted>'],
  ['abc123def456ghi', 'abc123def456ghi'],
  ['a1.b2-c3_d4.e5-f6', '<redacted>'],
  ['_'.repeat(20), '_'.repeat(20)],
  ['/home/user/.config/abcd1234efgh5678ijkl/file', '/home/user/.config/<redacted>/file'],
  ['Bearer abc123', 'Bearer <redacted>'],
  ['api key=abc123', 'api key <redacted>'],
  ['apikey=1', 'apikey <redacted>'],
  ['API_KEY: x', 'API_KEY <redacted>'],
  ['line one\nsecret = hunter2\r\nlast', 'line one secret <redacted> last'],
  ['authorization:\nBasic xyz', 'authorization <redacted> xyz'],
  ['tokens', 'token <redacted>'],
  ['mytoken=abc', 'mytoken <redacted>'],
  ['token:', 'token <redacted>'],
  ['token=', 'token <redacted>'],
  ['token : ', 'token <redacted> '],
  ['token   ', 'token   '],
]

describe('wt-arc-watch redact(): same redaction set as the original implementation', () => {
  it.each(DIFFERENTIAL)('redact(%j) === %j', (input, expected) => {
    expect(redact(input)).toBe(expected)
  })
})

describe('wt-arc-watch redact(): the run regex (long alphanumeric runs)', () => {
  it('keeps a run whose alphanumerics all sit in its last 15 characters, redacts one with 16', () => {
    expect(redact('-'.repeat(30) + 'abc123def456ghi')).toBe('-'.repeat(30) + 'abc123def456ghi')
    expect(redact('-'.repeat(30) + 'abc123def456ghij')).toBe('<redacted>')
  })

  it('finishes a 50 000-character run with no alphanumeric in under 50 ms', () => {
    const line = '-'.repeat(50_000)
    const started = performance.now()
    const result = redact(line)
    const elapsed = performance.now() - started
    expect(result).toBe(line)
    expect(elapsed).toBeLessThan(50)
  })
})

describe('wt-arc-watch redact(): the keyword regex (bearer, token, api key, ...)', () => {
  it('redacts a keyword with no separator or a bare separator, keeps one followed only by blanks', () => {
    expect(redact('tokenabc')).toBe('token <redacted>')
    expect(redact('token: x')).toBe('token <redacted>')
    expect(redact('token : ')).toBe('token <redacted> ')
    expect(redact('token   ')).toBe('token   ')
  })

  it('finishes a keyword followed by 50 000 blanks in under 50 ms', () => {
    const line = 'token' + ' '.repeat(49_995)
    const started = performance.now()
    const result = redact(line)
    const elapsed = performance.now() - started
    expect(result).toBe(line)
    expect(elapsed).toBeLessThan(50)
  })
})
