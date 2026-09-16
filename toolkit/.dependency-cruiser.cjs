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
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'types', 'default'] },
  },
}
