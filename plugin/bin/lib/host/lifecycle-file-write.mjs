import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

// Never follow a lane-created symlink at a runner-owned publication path.
export function writeLaneRegularFile(file, content, options = {}) {
  try { if (!fs.lstatSync(file).isFile()) fs.rmSync(file, { recursive: true, force: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (options.flag === 'wx') return fs.writeFileSync(file, content, options)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, content, { ...options, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}
