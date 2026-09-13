import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const SDK = '@anthropic-ai/claude-agent-sdk'
const INSTALL = 'pnpm install --offline --frozen-lockfile'

export function resolveAgentSdkRequire({ ownBases = [], fallbackBases = [] }) {
  const candidates = [...ownBases, ...fallbackBases]
  for (const base of candidates) {
    const require = createRequire(base)
    try {
      require.resolve(SDK)
      return require
    } catch {
      // A manifest alone is insufficient: the SDK must resolve from this install.
    }
  }
  const installDir = dirname(candidates[0] ?? process.cwd())
  throw new Error(`${SDK} is not installed for ${installDir}; run: ${INSTALL}`)
}
