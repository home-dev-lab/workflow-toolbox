import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const shimSource = process.env.WT_SHIM_QUALITY_SOURCE ?? `${root}/plugin/bin/lib/host/adopted-script-shim.mjs`
const { renderScriptShim } = await import(pathToFileURL(shimSource).href)
const installer = readFileSync(`${root}/plugin/skills/adopt/scripts/install.mjs`, 'utf8')
const scripts = installer.match(/scripts: \{ kind: 'scripts'.*resolveItems:.*\n/)![0]
const names = [...scripts.matchAll(/file: '([^']+)'/g)].map((match) => match[1]!)
if (!names.length) throw new Error('installer scripts set must expose its launcher names')
const eslint = new ESLint({ overrideConfigFile: true, allowInlineConfig: false,
  overrideConfig: { rules: { complexity: ['error', 10],
    'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true }] } } })

it.each(names)('rendered %s meets owner limits', async (name) => {
  const results = await eslint.lintText(renderScriptShim(name), { filePath: 'launcher.mjs' })
  expect(results.flatMap((result) => result.messages)).toEqual([])
})
it('shim source meets owner limits', async () => {
  const source = readFileSync(shimSource, 'utf8')
  expect((await eslint.lintText(source, { filePath: 'source.mjs' })).flatMap((result) => result.messages)).toEqual([])
})
