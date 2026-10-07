const { resolve } = require('node:path')
const { listGitIgnoredPaths, pathsRegexSource } = require('./scripts/git-ignored-inputs.mjs')
const root = resolve(__dirname, '..')
const ignoredSource = pathsRegexSource(listGitIgnoredPaths(root).paths, root, __dirname)

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'plugin-does-not-import-toolkit',
      severity: 'error',
      from: { path: '^\\.\\./plugin/' },
      to: { path: '^(?:packages|scripts|examples|workflows)/' },
    },
  ],
  options: {
    ...(ignoredSource ? { exclude: { path: ignoredSource } } : {}),
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'types', 'default'] },
  },
}
