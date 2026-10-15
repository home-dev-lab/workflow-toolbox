import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnNeedsShell } from '../suite-lock.mjs'

// Resolve the required entry on the target BEFORE the candidate can change it.
export function integrationQualityDirectory(root) {
  for (const directory of [path.join(root, 'toolkit'), root]) {
    const manifest = path.join(directory, 'package.json')
    if (!existsSync(manifest)) continue
    const { scripts } = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof scripts?.quality === 'string' && scripts.quality.trim()) return directory
  }
  return null
}
export function certifyIntegration(options, runner, base) {
  if (!options.qualityDirectory) return
  const result = runner('pnpm', ['run', 'quality'], { cwd: options.qualityDirectory,
    encoding: 'utf8', maxBuffer: 1 << 28, shell: spawnNeedsShell('pnpm'),
    env: { ...process.env, WT_QUALITY_CHANGED: undefined, WT_QUALITY_BASE: base } })
  if (result.status === 0 && !result.error) return
  const detail = String(result.stdout ?? '') + String(result.stderr ?? result.error?.message ?? '')
  throw new Error(`integration quality refused; run pnpm --dir ${JSON.stringify(options.qualityDirectory)} quality with WT_QUALITY_BASE=${base}\n${detail}`)
}
