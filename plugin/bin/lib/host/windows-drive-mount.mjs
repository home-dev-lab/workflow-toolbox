import { readFileSync } from 'node:fs'

const unescapeMountPoint = (value) => value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)))
const defaultReader = () => readFileSync('/proc/self/mountinfo', 'utf8')

/** @knipTestSeam Computed import in lane-sandbox.test.ts. */
export function windowsDriveMountPredicate(mountinfo) {
  // Stable length sorting after reversal puts the last record first for duplicate points.
  const mounts = String(mountinfo).split('\n').flatMap((line) => {
    const separator = line.indexOf(' - ')
    if (separator < 0) return []
    const mountPoint = line.slice(0, separator).split(' ')[4]
    const [type, , options = ''] = line.slice(separator + 3).split(' ')
    if (!mountPoint?.startsWith('/')) return []
    return [{ point: unescapeMountPoint(mountPoint), windows: type === 'drvfs' || (type === '9p' && /(?:^|[,;])aname=drvfs(?:[,;]|$)/.test(options)) }]
  }).reverse().sort((a, b) => b.point.length - a.point.length)
  return (realPath) => mounts.find(({ point }) => point === '/' || realPath === point || realPath.startsWith(`${point}/`))?.windows ?? false
}

export function isWindowsDriveMount(realPath, readMountinfo = defaultReader) {
  if (process.platform !== 'linux') return false
  let mountinfo = ''
  try { mountinfo = readMountinfo() } catch { /* unknown mount for this call: keep the candidate */ }
  return windowsDriveMountPredicate(mountinfo)(realPath)
}
