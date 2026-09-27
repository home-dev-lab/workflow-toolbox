import path from 'node:path'

/** The pack contract drives the engine checked out beside the toolkit. */
export function rulesOnDemandHookPath(repoRoot: string): string {
  return path.resolve(repoRoot, 'plugins', 'wt-rules-on-demand', 'hooks', 'hooks.js')
}
