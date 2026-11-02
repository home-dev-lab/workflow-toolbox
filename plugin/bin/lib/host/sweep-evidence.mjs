import { statSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { createProcfs } from './procfs.mjs'

export function platformCanonicalPath(value, platform) {
  if (platform === 'darwin') return value.replace(/^\/var(?=\/|$)/, '/private/var').toLowerCase()
  return platform === 'win32' ? value.toLowerCase() : value
}

export function pathContains(root, target, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const normalize = value => platform === 'linux' ? paths.resolve(value) : paths.resolve(value).toLowerCase()
  const a = normalize(root)
  const b = normalize(target)
  return a === b || b.startsWith(a.endsWith(paths.sep) ? a : `${a}${paths.sep}`)
}

export function sweepMounts({ procfs = createProcfs(), platform = process.platform } = {}) {
  // Device checks alone cannot prove the absence of same-device mount boundaries.
  if (platform !== 'linux') return { status: 'unknown', reason: `mount boundary unavailable on ${platform}` }
  try {
    const mounts = procfs.readMountInfo('utf8').trim().split('\n').filter(Boolean).map(line => {
      const fields = line.split(' ')
      if (fields.length < 10 || !fields.includes('-')) throw new Error('invalid mountinfo')
      return fields[4].replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)))
    })
    if (!mounts.includes('/')) throw new Error('mountinfo root witness unavailable')
    return { status: 'known', mounts }
  } catch (error) { return { status: 'unknown', reason: `mountinfo unreadable: ${error.code ?? error.message}` } }
}

export function observe(reader) {
  try { return { value: reader() } } catch (error) { return { error: error.code ?? 'read-failed' } }
}

export function canonicalReference(value) {
  const target = value.replace(/ \(deleted\)$/, '')
  try { return realpathSync(target) } catch { return path.resolve(target) }
}

export function checkedReference(value, magicStat, { statPath = statSync, sourceDevice } = {}) {
  if (!value.startsWith('/')) return { skip: true }
  const target = value.replace(/ \(deleted\)$/, '')
  const ordinary = observe(() => statPath(target, { bigint: true }))
  const kernel = observe(() => magicStat({ bigint: true }))
  if (ordinary.error || kernel.error) return { unknown: true }
  if (String(ordinary.value.dev) === String(kernel.value.dev) && String(ordinary.value.ino) === String(kernel.value.ino)) {
    return { path: canonicalReference(value) }
  }
  if (sourceDevice !== undefined && String(kernel.value.dev) !== String(sourceDevice)) return { mismatchExcluded: true }
  return { unknown: true }
}
