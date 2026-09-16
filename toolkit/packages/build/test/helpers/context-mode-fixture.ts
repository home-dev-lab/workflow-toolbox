import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function prepareContextModeFixture() {
  const configured = process.env.WT_CONTEXT_MODE_ROOT
  if (configured && existsSync(join(configured, '.claude-plugin', 'plugin.json')) && existsSync(join(configured, 'hooks', 'hooks.json'))) {
    process.env.WT_LSP_TYPESCRIPT_SERVER = join(configured, 'missing-typescript-language-server')
    return configured
  }

  const root = mkdtempSync(join(tmpdir(), 'wt-context-mode-'))
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  mkdirSync(join(root, 'hooks'))
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{}\n')
  writeFileSync(join(root, 'hooks', 'hooks.json'), '{}\n')
  process.env.WT_CONTEXT_MODE_ROOT = root
  process.env.WT_LSP_TYPESCRIPT_SERVER = join(root, 'missing-typescript-language-server')
  return root
}
