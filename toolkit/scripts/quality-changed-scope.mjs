import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { LINT_SCOPE_EXCLUSIONS } from '../eslint.config.mjs'

// Use ESLint's own glob implementation, including brace expansion and dotfiles.
const require = createRequire(import.meta.url)
const { minimatch } = createRequire(require.resolve('eslint'))('minimatch')

export function createScopeCheck(root) {
  const eslint = new ESLint({ cwd: root,
    overrideConfigFile: fileURLToPath(new URL('../eslint.config.mjs', import.meta.url)),
    // Distinguish global ignores from extensions absent from the normal lint targets.
    overrideConfig: [{ files: ['**/*.{mjs,cjs,jsx,js,tsx,ts,mts,cts,MJS,CJS,JSX,JS,TSX,TS,MTS,CTS}', '**/!(*.*)'] }] })
  return async (file) => {
    const exclusion = LINT_SCOPE_EXCLUSIONS.find(({ glob }) => minimatch(file, glob, { dot: true }))
    if (exclusion) return exclusion.reason
    if (await eslint.isPathIgnored(join(root, file))) return 'Ignored by repository ESLint configuration.'
    return undefined
  }
}

export async function selectChangedScope(root, files) {
  const reasonFor = createScopeCheck(root), selected = [], skipped = []
  for (const file of files) {
    const reason = await reasonFor(file.path)
    if (reason) skipped.push({ path: file.path, reason })
    else selected.push(file)
  }
  return { selected, skipped }
}
