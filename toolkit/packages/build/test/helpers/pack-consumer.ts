import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Locates the private `wt-rules-on-demand` consumer that serves a pack's rules on `Edit`/`Write`.
 * Three candidate homes, first hit wins: `WT_PACK_CONSUMERS_DIR` (explicit), the config dir's
 * `plugins/`, and a `.claude/plugins/` directory found by walking up from the repository root (the
 * suite layout, where the toolbox is a checkout or a worktree under the suite). Measured
 * 2026-09-12: the config-dir candidate alone never existed on the machine that hosts the consumer,
 * so every pack test's consumer assertion had been skipping — a guard that could not fire.
 */
export function rulesOnDemandHookPath(repoRoot: string): string | undefined {
  const candidates: string[] = []
  if (process.env.WT_PACK_CONSUMERS_DIR) candidates.push(path.join(process.env.WT_PACK_CONSUMERS_DIR, 'wt-rules-on-demand'))
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  candidates.push(path.join(configDir, 'plugins', 'wt-rules-on-demand'))
  let current = path.resolve(repoRoot)
  for (let depth = 0; depth < 5; depth += 1) {
    candidates.push(path.join(current, '.claude', 'plugins', 'wt-rules-on-demand'))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const candidate of candidates) {
    const hook = path.join(candidate, 'hooks', 'hooks.js')
    if (fs.existsSync(hook)) return hook
  }
  return undefined
}
