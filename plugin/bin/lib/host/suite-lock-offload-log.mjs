import { closeSync, openSync, readSync } from 'node:fs'

export function offloadFrame(socket, requestId, type, fields = {}) {
  if (!socket.destroyed) socket.write(`offload ${JSON.stringify({ version: 1, requestId, type, ...fields })}\n`)
}

/** Bounded reads and socket buffering; log bytes never enter the line protocol unescaped. */
export function relayOffloadLog(socket, requestId, logPath, deadlineAt) {
  const fd = openSync(logPath, 'r')
  const buffer = Buffer.alloc(32 * 1024)
  let position = 0
  let closed = false
  const pump = () => {
    if (closed || socket.destroyed || socket.writableLength > 128 * 1024) return false
    const count = readSync(fd, buffer, 0, buffer.length, position)
    position += count
    if (count) offloadFrame(socket, requestId, 'log', { data: buffer.subarray(0, count).toString('base64') })
    return count > 0
  }
  const timer = setInterval(pump, 25)
  const close = () => {
    if (closed) return
    closed = true; clearInterval(timer); closeSync(fd)
  }
  const finish = async () => {
    try {
      while (!closed && !socket.destroyed) {
        if (Date.now() >= deadlineAt) throw new Error('offload log delivery deadline passed')
        if (socket.writableLength > 128 * 1024) await new Promise((resolve) => setTimeout(resolve, 25))
        else if (!pump()) break
      }
    } finally { close() }
  }
  return { close, finish }
}
