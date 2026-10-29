import path from 'node:path'
import { lifecycleDeliveryHost } from './host/lifecycle-delivery.mjs'

// Receipt formats can represent these names; admission uses the repository's current declaration.
export const LIFECYCLE_GATE_NAMES = Object.freeze(['typecheck', 'lint', 'quality', 'test'])

export function resolveLifecycleGates(root) {
  let scripts
  try { scripts = JSON.parse(lifecycleDeliveryHost.readText(path.join(root, 'toolkit', 'package.json'))).scripts } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const quality = typeof scripts?.quality === 'string' && scripts.quality.trim().length > 0
  return new Set(LIFECYCLE_GATE_NAMES.filter((name) => name !== 'quality' || quality))
}

export function focusedLifecycleGateHint(root) {
  const names = ['targeted tests', ...[...resolveLifecycleGates(root)].filter((name) => name !== 'test')]
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
}
