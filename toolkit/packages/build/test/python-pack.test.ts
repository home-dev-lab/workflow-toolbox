import { describePackContract } from './helpers/pack-contract.js'

describePackContract({
  pack: 'python',
  extensions: ['.py', '.pyi'],
  consumerRules: ['python-lint-typecheck-build.md', 'tdd-pytest.md'],
  declaration: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
    diagnostics: true,
    startupTimeout: 10000,
  },
})
