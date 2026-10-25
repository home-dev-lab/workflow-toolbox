import { chmodSync, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

function readonlyMode(file, stat, root) {
  if (!stat.isDirectory()) return 0o444
  return file === root ? 0o500 : 0o555
}

function permissions(file, readonly, writable, root) {
  if (file === writable) return
  const stat = lstatSync(file)
  // Never chmod a link: chmod follows it, including links into live caller files.
  if (stat.isSymbolicLink()) return
  if (!readonly) chmodSync(file, stat.isDirectory() ? 0o700 : 0o600)
  if (stat.isDirectory()) {
    for (const name of readdirSync(file)) permissions(path.join(file, name), readonly, writable, root)
  }
  if (readonly) chmodSync(file, readonlyMode(file, stat, root))
}

export function protectSnapshot(root, writable) {
  permissions(root, true, writable, root)
}

export function removeSnapshot(root) {
  if (!existsSync(root)) return
  permissions(root, false)
  rmSync(root, { recursive: true, force: true })
}
