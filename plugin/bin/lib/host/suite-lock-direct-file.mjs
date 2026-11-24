import { statSync } from 'node:fs'
import { resolve } from 'node:path'

export function directRunTestFilename(file) {
  return typeof file === 'string' && !file.startsWith('-') && !/[^A-Za-z0-9_./-]/.test(file)
    && /\.(test|spec|selftest)\.[cm]?[jt]sx?$/.test(file)
}

export function directRunIsFile(file, cwd) {
  try { return statSync(resolve(cwd, file)).isFile() } catch { return false }
}

export function directRunNodeHead(head) {
  return head === 'node' || head === process.execPath || (process.platform === 'win32' && head === 'node.exe')
}
