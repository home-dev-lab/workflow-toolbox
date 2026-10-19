import { createHash } from 'node:crypto'
import net from 'node:net'
import { join } from 'node:path'

// The product only launches brokers in the Linux sandbox; it has no Windows address builder.
// Keep the test transport in one place: pathname sockets on POSIX, named pipes on Windows.
export function suiteBrokerAddress(root: string, name = 'broker.sock', platform = process.platform) {
  const id = createHash('sha256').update(join(root, name)).digest('hex').slice(0, 24)
  return platform === 'win32' ? `\\\\.\\pipe\\wt-suite-test-${id}` : join(root, name)
}

export function suiteBrokerFixture(server: net.Server) {
  const sockets = new Set<net.Socket>()
  server.prependListener('connection', (socket: net.Socket) => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  })
  const close = async () => {
    const ended = [...sockets].map((socket) => new Promise<void>((resolve) => {
      socket.once('close', () => resolve()); socket.destroy()
    }))
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) reject(error)
      else resolve()
    }))
    await Promise.all(ended)
  }
  const listen = async (address: string) => {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(address, () => { server.off('error', reject); resolve() })
      })
    } catch (error) { await close(); throw error }
  }
  return { listen, close, sockets }
}

export function renewBrokerFixture(socket: net.Socket, grantMs = 2350, tickMs = 100) {
  const write = (line: string) => writeBrokerFixtureLine(socket, line)
  const timer = setInterval(() => write('renew 1 3 1\n'), tickMs)
  const done = setTimeout(() => { clearInterval(timer); write('granted renewed\n') }, grantMs)
  const stop = stopBrokerFixtureTimers(socket, timer, done)
  write('progress 1 3 1\n')
  return stop
}

export function writeBrokerFixtureLine(socket: net.Socket, line: string) {
  if (!socket.destroyed && !socket.writableEnded && !socket.readableEnded) socket.write(line)
}

export function stopBrokerFixtureTimers(socket: net.Socket, ...timers: NodeJS.Timeout[]) {
  const stop = () => { for (const timer of timers) clearTimeout(timer) }
  socket.once('end', stop)
  socket.once('close', stop)
  socket.once('error', () => { stop(); socket.destroy() })
  return stop
}
