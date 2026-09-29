import fs from 'node:fs'
import path from 'node:path'

export function isOnDemandDir(dir) {
  let target = path.resolve(dir)
  try {
    target = fs.realpathSync(target)
  } catch {
    // A new directory has no realpath yet; its resolved name is still usable.
  }
  const name = path.basename(target)
  return process.platform === 'win32' || process.platform === 'darwin'
    ? name.toLowerCase() === 'rules-on-demand'
    : name === 'rules-on-demand'
}
