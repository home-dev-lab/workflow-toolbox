import { ESLint } from 'eslint'
import { join, resolve } from 'node:path'
import tseslint from 'typescript-eslint'
import { measure } from './quality-changed-measure.mjs'
import { functionEvidence } from './quality-changed-functions.mjs'

export const ownerRules = {
  complexity: ['error', 10],
  'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true, IIFEs: true }],
  '@typescript-eslint/no-explicit-any': 'error',
}
export function createLinter(root) {
  return new ESLint({ cwd: root, overrideConfigFile: true,
    ignore: false, allowInlineConfig: false,
    overrideConfig: [{ files: ['**/*.{mjs,cjs,jsx,js,tsx,ts,mts,cts}'],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { '@typescript-eslint': tseslint.plugin, owner: { rules: { function: functionEvidence } } },
      rules: { ...ownerRules, 'owner/function': 'warn' } }] })
}
export async function lintText(eslint, root, file, text) {
  const absolute = join(root, file)
  const config = await eslint.calculateConfigForFile(absolute)
  for (const [rule, setting] of Object.entries(ownerRules)) {
    const expected = Array.isArray(setting) ? [2, ...setting.slice(1)] : [2]
    if (JSON.stringify(config?.rules[rule]) !== JSON.stringify(expected)) throw new Error(`owner config missing for ${file}: ${rule}`)
  }
  const results = await eslint.lintText(text, { filePath: absolute })
  if (!results.some((result) => resolve(result.filePath) === absolute) || results.some((result) => result.messages.some((message) => /^File ignored/.test(message.message)))) {
    throw new Error(`eslint did not lint ${file}`)
  }
  return measure(results, file, text)
}
