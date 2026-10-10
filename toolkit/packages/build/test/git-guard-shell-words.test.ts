import { describe, expect, it } from 'vitest'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { shellWords as mergeChainWords } from '../../../../plugin/bin/wt-merge-chain-guard-hook.mjs'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { shellWords as mergeTargetWords } from '../../../../plugin/bin/wt-merge-target-guard-hook.mjs'

// Inside double quotes bash removes a backslash only before $, `, ", \ or a newline; any other
// backslash stays in the word. A quoted native Windows path therefore keeps its separators.
const CASES: Array<[string, string, string[]]> = [
  ['quoted Windows git path keeps its backslashes', '"C:\\Program Files\\Git\\bin\\git.exe" commit', ['C:\\Program Files\\Git\\bin\\git.exe', 'commit']],
  ['quoted Windows interpreter path keeps its backslashes', '"C:\\nodejs\\node.exe" check.mjs', ['C:\\nodejs\\node.exe', 'check.mjs']],
  ['escaped double quote is consumed inside double quotes', '-C "a\\"b" commit', ['-C', 'a"b', 'commit']],
  ['escaped backslash is consumed inside double quotes', '-C "a\\\\" commit', ['-C', 'a\\', 'commit']],
  ['escaped dollar is consumed inside double quotes', '"a\\$b"', ['a$b']],
  ['escaped backtick is consumed inside double quotes', '"a\\`b"', ['a`b']],
  ['unquoted escape is still consumed', 'a\\ b c', ['a b', 'c']],
  ['single quotes keep every backslash', "'a\\b' c", ['a\\b', 'c']],
]

describe.each([
  ['merge-chain', mergeChainWords],
  ['merge-target', mergeTargetWords],
])('%s guard splits words like bash', (_guard, split) => {
  it.each(CASES)('%s', (_name, segment, expected) => {
    expect(split(segment)).toEqual(expected)
  })
})
