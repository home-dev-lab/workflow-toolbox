import { describePackContract } from './helpers/pack-contract.js'

describePackContract({
  pack: 'kotlin',
  extensions: ['.kt', '.kts'],
  files: ['build.gradle.kts', 'settings.gradle.kts'],
  declaration: {
    command: 'kotlin-language-server',
    args: [],
    extensionToLanguage: { '.kt': 'kotlin', '.kts': 'kotlin' },
    diagnostics: true,
    startupTimeout: 60000,
  },
})
