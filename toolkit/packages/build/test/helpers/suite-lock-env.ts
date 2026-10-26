// @ts-expect-error runtime JavaScript under plugin/
import { acquireSuiteLock } from '../../../../../plugin/bin/lib/suite-lock.mjs'

// Clone and scrub the whole lock family before applying deliberate fixture overrides.
export function suiteLockEnv(root?: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^WT_SUITE_(?:LOCK(?:_|$)|LEASE(?:_|$))/i.test(key)) delete env[key]
  }
  return { ...env, WT_SUITE_LOCK_DIR: root, ...extra }
}

// Explicit environments still exercise the real API unchanged; defaults use the same sealed env as children.
export function acquireTestSuiteLock(options: Record<string, unknown>) {
  return acquireSuiteLock({ ...options, env: options.env ?? suiteLockEnv() })
}
