import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import './network-seal.mjs'

let server

function write(value) {
  const body = JSON.stringify(value)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

function frames(consume) {
  let bytes = Buffer.alloc(0)
  return (chunk) => {
    bytes = Buffer.concat([bytes, chunk])
    for (;;) {
      const end = bytes.indexOf('\r\n\r\n')
      if (end < 0) return
      const size = Number(/Content-Length: (\d+)/i.exec(bytes.subarray(0, end).toString())?.[1])
      if (bytes.length < end + 4 + size) return
      consume(JSON.parse(bytes.subarray(end + 4, end + 4 + size).toString()))
      bytes = bytes.subarray(end + 4 + size)
    }
  }
}

function initialize(message) {
  // This is a local TLS protocol stand-in: only the transport is synthetic; the
  // server, project loading, navigation, diagnostics and kernel watches are real.
  const entry = message.params.initializationOptions.tsserver.path
  const sealFile = fileURLToPath(new URL('./network-seal.mjs', import.meta.url))
  const seal = pathToFileURL(sealFile).href
  const eventsFile = fileURLToPath(new URL('./watch-events.mjs', import.meta.url))
  const events = pathToFileURL(eventsFile).href
  server = spawn(process.execPath, ['--import', seal, '--import', events, entry, '--disableAutomaticTypingAcquisition', '--useInferredProjectPerProjectRoot'], { stdio: ['pipe', 'pipe', 'pipe'] })
  server.stdout.on('data', frames((reply) => write({ jsonrpc: '2.0', method: '$/tsserver', params: reply })))
  server.stderr.pipe(process.stderr)
  server.once('close', () => process.exit(0))
  write({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
  write({ jsonrpc: '2.0', method: '$/tsserverPid', params: { pid: server.pid } })
}

function receive(message) {
  if (message.method === 'initialize') initialize(message)
  else if (message.method === '$/tsserver') server.stdin.write(`${JSON.stringify(message.params)}\n`)
  else if (message.method === 'exit') server.stdin.end()
}

process.stdin.on('data', frames(receive))
process.stdin.on('end', () => server?.stdin.end())
process.on('SIGTERM', () => { if (server) server.kill(); else process.exit(0) })
