import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const readText = (file) => readFileSync(file, 'utf8')
export function* readLines(file, chunkSize = 64 * 1024) {
  const fd = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(chunkSize)
  let pending = Buffer.alloc(0)
  try {
    let count
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const chunk = buffer.subarray(0, count)
      let start = 0
      for (let i = 0; i < count; i++) {
        if (chunk[i] !== 10) continue
        const part = chunk.subarray(start, i)
        const line = pending.length ? Buffer.concat([pending, part]) : part
        yield line.toString('utf8').replace(/\r$/, '')
        pending = Buffer.alloc(0)
        start = i + 1
      }
      if (start < count) pending = pending.length ? Buffer.concat([pending, chunk.subarray(start)]) : Buffer.from(chunk.subarray(start))
    }
    if (pending.length) yield pending.toString('utf8').replace(/\r$/, '')
  } finally { closeSync(fd) }
}
export const entries = (directory, options) => readdirSync(directory, options)
export const readStdin = () => readFileSync(0, 'utf8')
export function appendWarnings(log, report, text) {
  appendFileSync(log, text)
  if (existsSync(report)) appendFileSync(report, `\n${text}`)
}
export function expandHome(value) {
  if (typeof value !== 'string') return null
  return /^~[\\/]/.test(value) ? path.join(homedir(), value.slice(2)) : value
}
