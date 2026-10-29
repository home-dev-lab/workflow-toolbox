import { ESLint } from 'eslint'
import { extname, join, resolve } from 'node:path'
import tseslint from 'typescript-eslint'
import { measure } from './quality-changed-measure.mjs'
import { functionEvidence } from './quality-changed-functions.mjs'

export const ownerRules = {
  complexity: ['error', 10],
  'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true, IIFEs: true }],
  '@typescript-eslint/no-explicit-any': 'error',
}
const requiredOwnerRules = {
  complexity: [2, 10],
  'max-lines-per-function': [2, { max: 40, skipBlankLines: true, skipComments: true, IIFEs: true }],
  '@typescript-eslint/no-explicit-any': [2],
}
export function createLinter(root) {
  return new ESLint({ cwd: root, overrideConfigFile: true,
    ignore: false, allowInlineConfig: false,
    overrideConfig: [{ files: ['**/*.{mjs,cjs,jsx,js,tsx,ts,mts,cts}', '**/!(*.*)'],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { '@typescript-eslint': tseslint.plugin, owner: { rules: { function: functionEvidence } } },
      rules: { ...ownerRules, 'owner/function': 'warn' } }] })
}
export async function lintText(eslint, root, file, text) {
  const absolute = join(root, file)
  const suffix = extname(file)
  const lintPath = suffix ? absolute.slice(0, -suffix.length) + suffix.toLowerCase() : absolute
  const config = await eslint.calculateConfigForFile(lintPath)
  for (const [rule, expected] of Object.entries(requiredOwnerRules)) {
    if (JSON.stringify(config?.rules[rule]) !== JSON.stringify(expected)) throw new Error(`owner config missing for ${file}: ${rule}`)
  }
  const results = await eslint.lintText(text, { filePath: lintPath })
  if (!results.some((result) => resolve(result.filePath) === lintPath) || results.some((result) => result.messages.some((message) => /^File ignored/.test(message.message)))) {
    throw new Error(`eslint did not lint ${file}`)
  }
  return measure(results, file, text)
}
