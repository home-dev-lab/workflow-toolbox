import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { quoteRemedyWord } from '../../../../plugin/bin/lib/remedy-quote.mjs'

// Reload the helper under a simulated Windows host, without passing a platform to the policy.
async function quoteOnWindows(value: string): Promise<string> {
  vi.resetModules()
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
  try {
    // @ts-expect-error runtime .mjs helper under plugin/bin/lib/
    const { quoteRemedyWord: quote } = await import('../../../../plugin/bin/lib/remedy-quote.mjs')
    return quote(value)
  } finally {
    vi.unstubAllGlobals()
    vi.resetModules()
  }
}

// Independent, hand-written expectations (including characters the safe set retains).
describe('quoteRemedyWord', () => {
  it.each([
    ['C:\\Users\\me\\repo', "'C:\\Users\\me\\repo'"],
    ['C:\\my dir\\', "'C:\\my dir\\'"],
    ['C:/$(echo X)/repo', "'C:/$(echo X)/repo'"],
    ['C:/`echo X`/repo', "'C:/`echo X`/repo'"],
    ['%X%', '%X%'],
    ['a!b', "'a!b'"],
    ['a^b', "'a^b'"],
    ["it's a repo", `'it'"'"'s a repo'`],
    ['', "''"],
    ['/home/me/repo', '/home/me/repo'],
    ['/home/me/dir\\', "'/home/me/dir\\'"],
  ])('prints %s as a POSIX-style word', (value, expected) => {
    expect(quoteRemedyWord(value)).toBe(expected)
  })

  it.each([
    ['C:\\Users\\me\\repo', "'C:\\Users\\me\\repo'"],
    ['C:\\my dir\\', "'C:\\my dir\\'"],
    ['C:/$(echo X)/repo', "'C:/$(echo X)/repo'"],
    ['C:/`echo X`/repo', "'C:/`echo X`/repo'"],
    ["it's a repo", `'it'"'"'s a repo'`],
  ])('prints %s the same way when the host reports win32', async (value, expected) => {
    expect(await quoteOnWindows(value)).toBe(expected)
  })

  it('keeps the older always-quoted remedy mode', () => {
    expect(quoteRemedyWord('/home/me/repo', true)).toBe("'/home/me/repo'")
    expect(quoteRemedyWord('C:\\repo', true)).toBe("'C:\\repo'")
  })

  it.skipIf(process.platform === 'win32' || !existsSync('/bin/sh'))('round-trips hostile words through sh (requires /bin/sh on a POSIX host)', async () => {
    for (const value of ['C:/$(printf WRONG)/repo', 'C:/`printf WRONG`/repo', "it's a repo", 'C:\\Users\\me\\repo', 'a b', '%X%', 'a!b', 'C:\\my dir\\']) {
      const quoted = await quoteOnWindows(value)
      const printed = execFileSync('sh', ['-c', `printf "%s\\n" ${quoted}`], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      })
      expect(printed).toBe(`${value}\n`)
    }
  })
})
