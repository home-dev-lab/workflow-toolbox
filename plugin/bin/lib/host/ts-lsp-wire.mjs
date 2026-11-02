const LIMIT = 16 * 1024 * 1024

export function tsFrame(message) {
  const body = JSON.stringify(message)
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

function frameLength(buffer) {
  const end = buffer.indexOf('\r\n\r\n')
  if (end < 0) {
    if (buffer.length > 8192) throw new Error('LSP header exceeds the size limit')
    return undefined
  }
  const lengths = buffer.subarray(0, end).toString('latin1').split('\r\n').filter(line => /^Content-Length:/i.test(line))
  if (lengths.length !== 1 || !/^Content-Length:\s*\d+\s*$/i.test(lengths[0])) throw new Error('malformed LSP header')
  const length = Number(lengths[0].split(':')[1])
  if (!Number.isSafeInteger(length) || length > LIMIT) throw new Error('LSP frame exceeds the size limit')
  return { end, length, total: end + 4 + length }
}

// Keep incomplete bodies as chunks rather than repeatedly copying an expanding
// buffer. A large diagnostic frame split into small writes stays linear work.
export function tsFrameReader(receive) {
  let header = Buffer.alloc(0), pending, chunks = [], size = 0
  const emit = () => {
    const message = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('malformed LSP message')
    pending = undefined; chunks = []; size = 0
    receive(message)
  }
  return (chunk) => {
    let bytes = chunk
    while (bytes.length) {
      if (!pending) {
        const joined = header.length ? Buffer.concat([header, bytes]) : bytes
        pending = frameLength(joined)
        if (!pending) { header = joined; return }
        bytes = joined.subarray(pending.end + 4); header = Buffer.alloc(0)
      }
      const take = Math.min(pending.length - size, bytes.length)
      chunks.push(bytes.subarray(0, take)); size += take; bytes = bytes.subarray(take)
      if (size === pending.length) emit()
    }
  }
}
