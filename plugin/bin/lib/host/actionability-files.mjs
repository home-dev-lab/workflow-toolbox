import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function pathExists(path) {
  return existsSync(path)
}

export function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// Unique siblings make each publication whole even with multiple producer processes.
export function atomicWriteJson(path, value, beforeRename = () => {}) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' })
    beforeRename()
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
