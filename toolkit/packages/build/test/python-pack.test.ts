import { describePackContract } from './helpers/pack-contract.js'

describePackContract({
  pack: 'python',
  extensions: ['.py', '.pyi'],
  consumerTrigger: '/\\.(?:py|pyi)$/i.test(editPath(e))',
  declaration: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
    diagnostics: true,
    startupTimeout: 10000,
  },
})
