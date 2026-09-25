import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createGitInspectionIsolation(parentDirectory) {
  mkdirSync(parentDirectory, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(parentDirectory, 'git-inspection-'))
  const globalConfig = join(root, 'global.config')
  const hooks = join(root, 'hooks')
  writeFileSync(globalConfig, '', { mode: 0o600 })
  mkdirSync(hooks, { mode: 0o700 })
  return {
    globalConfig,
    hooks,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
