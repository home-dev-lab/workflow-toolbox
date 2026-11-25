import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

// Resolve only after the fixture directory exists, preserving setup order.
export function linkFixtureDependency(directory, name, resolveTarget) {
  mkdirSync(directory, { recursive: true })
  const target = resolveTarget()
  symlinkSync(target, join(directory, name), 'junction')
}
