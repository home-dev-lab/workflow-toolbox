import fs from 'node:fs'

/** Read a regular registry/manifest file without opening a FIFO in blocking mode. */
export function boundedJson(file, budget, io = fs) {
  let fd
  try {
    fd = io.openSync(file, io.constants.O_RDONLY | (io.constants.O_NONBLOCK ?? 0))
    const stat = io.fstatSync(fd)
    if (!stat.isFile() || stat.size > 1048576) throw Error('registry/manifest size or budget')
    if (budget.bytes + stat.size > budget.maxBytes) { budget.exhausted = 'bytes'; throw Error('registry/manifest budget') }
    const buffer = Buffer.allocUnsafe(Math.min(1048577, Math.max(0, budget.maxBytes - budget.bytes) + 1))
    const count = io.readSync(fd, buffer, 0, buffer.length, 0)
    budget.bytes += count
    if (budget.bytes > budget.maxBytes) { budget.exhausted = 'bytes'; throw Error('registry/manifest budget') }
    if (count > 1048576) throw Error('oversized registry/manifest')
    return JSON.parse(buffer.toString('utf8', 0, count))
  } finally { if (fd !== undefined) io.closeSync(fd) }
}
