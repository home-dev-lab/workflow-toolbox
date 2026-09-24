import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CONFIG = join(REPO_ROOT, 'toolkit/eslint.config.mjs')
const RULE = 'workflow-toolbox/no-dynamic-replace'

function checker() {
  return new ESLint({ cwd: REPO_ROOT, overrideConfigFile: CONFIG })
}

describe('no dynamic String.replace replacements', () => {
  it('reports the verbatim old bench expression', async () => {
    const fixture = readFileSync(join(REPO_ROOT, 'toolkit/scripts/fixtures/dynamic-replace-old-bench.mjs.txt'), 'utf8')
    const [result] = await checker().lintText(fixture, { filePath: join(REPO_ROOT, 'plugin/old-bench-fixture.mjs') })
    const messages = result!.messages.filter((message) => message.ruleId === RULE)

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toBe('To comply, wrap it as () => value or pass an inline function so String.replace does not expand $ replacement patterns.')
  })

  it('accepts literal constants, capture syntax, and replacement functions', async () => {
    const source = [
      "text.replace(/x/, 'literal')",
      "text.replace(/(x)/, '$1')",
      'text.replace(/x/, `constant`)',
      'text.replace(/x/, () => replacement)',
      'text.replaceAll(/x/g, function () { return replacement })',
    ].join('\n')
    const [result] = await checker().lintText(source, { filePath: join(REPO_ROOT, 'plugin/safe-replacements.mjs') })
    expect(result!.messages.filter((message) => message.ruleId === RULE)).toEqual([])
  })

  it('also rejects a dynamic replacement in published package source', async () => {
    const [result] = await checker().lintText('text.replace(/x/, replacement)\n', {
      filePath: join(REPO_ROOT, 'toolkit/packages/build/src/dynamic-replacement-fixture.ts'),
    })
    expect(result!.messages.filter((message) => message.ruleId === RULE)).toHaveLength(1)
  })

  it('rejects spread calls and constant computed method names', async () => {
    const source = [
      'text.replace(...args)',
      'text[`replace`](/x/, replacement)',
      "text['replaceAll'](/x/g, replacement)",
    ].join('\n')
    const [result] = await checker().lintText(source, { filePath: join(REPO_ROOT, 'plugin/replace-bypasses.mjs') })
    expect(result!.messages.filter((message) => message.ruleId === RULE)).toHaveLength(3)
  })

  it('rejects replace bind aliases wherever they are used', async () => {
    const source = [
      'const replace = text.replace.bind(text)',
      'consume(text.replaceAll.bind(text))',
    ].join('\n')
    const [result] = await checker().lintText(source, { filePath: join(REPO_ROOT, 'plugin/replace-bind.mjs') })
    expect(result!.messages.filter((message) => message.ruleId === RULE)).toHaveLength(2)
  })

  it('covers plugin TypeScript sources', async () => {
    const [result] = await checker().lintText('text.replace(/x/, replacement)\n', {
      filePath: join(REPO_ROOT, 'plugin/dynamic-replacement-fixture.ts'),
    })
    expect(result!.messages.filter((message) => message.ruleId === RULE)).toHaveLength(1)
  })

  it('tells named-function callers how to comply with the strict rule', async () => {
    const [result] = await checker().lintText("const replacer = () => '$&'\ntext.replace(/x/, replacer)\n", {
      filePath: join(REPO_ROOT, 'plugin/named-replacer.mjs'),
    })
    const messages = result!.messages.filter((message) => message.ruleId === RULE)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('wrap it as () => value or pass an inline function')
  })
})
