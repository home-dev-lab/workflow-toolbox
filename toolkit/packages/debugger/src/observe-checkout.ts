import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Locate the dir that directly contains apps/observe-ui/server/dev-api.ts.
 * DWT_OBSERVE_ROOT wins; otherwise probe ancestors and their observatory sibling. */
export function findObserveRoot(cwd: string, env: Record<string, string | undefined>): string | null {
  const isObserveApp = (dir: string): boolean => {
    try {
      const pkg: unknown = JSON.parse(readFileSync(join(dir, 'apps', 'observe-ui', 'package.json'), 'utf8'))
      return typeof pkg === 'object' && pkg !== null && (pkg as Record<string, unknown>)['name'] === '@workflow-toolbox/observe-ui'
    } catch {
      return false
    }
  }
  const hasServer = (dir: string): boolean =>
    existsSync(join(dir, 'apps', 'observe-ui', 'server', 'dev-api.ts')) && isObserveApp(dir)
  const probe = (dir: string): string | null =>
    hasServer(dir) ? dir : hasServer(join(dir, 'toolkit')) ? join(dir, 'toolkit') : null

  const forced = env['DWT_OBSERVE_ROOT']
  if (forced !== undefined && forced.length > 0) return probe(forced)

  let dir = cwd
  for (let depth = 0; depth < 64; depth++) {
    const hit = probe(dir) ?? probe(join(dir, 'workflow-observatory'))
    if (hit !== null) return hit
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}
