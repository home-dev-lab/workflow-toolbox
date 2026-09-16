import js from '@eslint/js'
import sonarjs from 'eslint-plugin-sonarjs'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const qualityFiles = [
  'packages/*/src/**/*.ts',
  '../plugin/**/*.mjs',
  '../plugin/**/*.js',
  'toolkit/packages/*/src/**/*.ts',
  'plugin/**/*.mjs',
  'plugin/**/*.js',
]
const sonarRules = Object.fromEntries(
  Object.entries(sonarjs.configs.recommended.rules)
    .filter(([, setting]) => setting !== 'off' && setting !== 0)
    .map(([rule, setting]) => [rule, Array.isArray(setting) ? ['warn', ...setting.slice(1)] : 'warn']),
)
const jsRecommendedWarnings = Object.fromEntries(
  Object.keys(js.configs.recommended.rules).map((rule) => [rule, 'warn']),
)

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/dist-electron/**', '**/node_modules/**', '**/*.js', '**/*.cjs'],
  },
  {
    ignores: [
      '!plugin/**/*.js',
      '!../plugin/**/*.js',
      'plugin/hooks/snapshot-program.js',
      '../plugin/hooks/snapshot-program.js',
      'plugin/**/fixtures/**',
      '../plugin/**/fixtures/**',
    ],
  },
  {
    files: ['../plugin/**/*.mjs', '../plugin/**/*.js', 'plugin/**/*.mjs', 'plugin/**/*.js'],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node },
    rules: {
      ...jsRecommendedWarnings,
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: qualityFiles,
    plugins: { sonarjs },
    rules: {
      ...sonarRules,
      // ratchet 2026-09-16: worst=127 in plugin/bin/lib/lifecycle-launch.mjs:170
      complexity: ['error', 127],
      // ratchet 2026-09-16: worst=2729 in plugin/bin/wt-observe.mjs:5
      'max-lines': ['error', { max: 2729, skipBlankLines: true, skipComments: true }],
      // ratchet 2026-09-16: worst=709 in plugin/bin/lib/lifecycle-state-machine.mjs:278
      'max-lines-per-function': ['error', { max: 709, skipBlankLines: true, skipComments: true }],
      // ratchet 2026-09-16: worst=7 in plugin/bin/wt-observe.mjs:1927
      'max-depth': ['error', 7],
      // ratchet 2026-09-16: worst=7 in plugin/bin/wt-actionable-gate-hook.mjs:326
      'max-params': ['error', 7],
      // ratchet 2026-09-16: worst=282 in plugin/bin/lib/pilot-runner-core.mjs:194
      'sonarjs/cognitive-complexity': ['warn', 282],
    },
  },
  {
    files: ['packages/*/src/**/*.ts', 'toolkit/packages/*/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
