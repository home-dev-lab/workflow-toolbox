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

export function isIndependentRuleFile(target, checkedStaticPaths) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return false
    const realTarget = fs.realpathSync(target)
    return !checkedStaticPaths.some((file) => {
      try { return fs.realpathSync(file) === realTarget } catch { return false }
    })
  } catch {
    return false
  }
}
