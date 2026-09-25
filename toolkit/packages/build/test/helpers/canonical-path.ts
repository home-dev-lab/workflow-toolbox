// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { hostAdapter } from '../../../../../plugin/bin/lib/host/adapter.mjs'

export function canonicalPath(path: string) {
  const resolved = hostAdapter.resolveCanonicalPath(path)
  if (resolved.status !== 'resolved') throw new Error(`canonical path unavailable for ${path}: ${resolved.reason ?? resolved.status}`)
  return resolved.path
}
