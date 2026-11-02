import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const root = process.env.WT_TSLS_IDLE_TEST_ROOT ?? fileURLToPath(new URL('../../../../plugin/', import.meta.url))
const moduleUrl = (name: string) => pathToFileURL(join(root, `bin/lib/host/${name}.mjs`)).href
const managed = await import(moduleUrl('ts-idle-session'))
const priority = await import(moduleUrl('ts-priority'))
const frame = (value: object) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...value })
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
type Message = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown }
function messages(stream: PassThrough) {
  let buffer = Buffer.alloc(0)
  const result: Message[] = []
  stream.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1])
      if (buffer.length < end + 4 + size) return
      result.push(JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString()))
      buffer = buffer.subarray(end + 4 + size)
    }
  })
  return result
}
const disposals: Array<() => void> = []
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.restoreAllMocks(); vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers()
  const input = new PassThrough(), output = new PassThrough(), stderr = new PassThrough()
  const received = messages(output), exit = vi.fn(), exitSignal = vi.fn()
  const children: ReturnType<typeof child>[] = []
  function child() {
    const backend = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
    const sent = messages(backend.stdin)
    const close = () => { backend.exitCode = 0; backend.emit('exit', 0, null); backend.emit('close', 0, null) }
    return { backend, sent, close, answer: (id: string | number, result: unknown = null) => backend.stdout.write(frame({ id, result })) }
  }
  const start = vi.fn(() => { const run = child(); children.push(run); return run.backend })
  managed.runTsIdleSession({ input, output, stderr, exit, exitSignal, idleMs: 1000, stopMs: 100,
    select: () => ({ status: 'launch', backend: 'typescript-language-server', command: '/fake', args: [] }), start })
  const send = (message: object) => input.write(frame(message))
  const spawn = () => children.at(-1)!.backend.emit('spawn')
  const initialize = () => {
    send({ id: 1, method: 'initialize', params: { rootUri: 'file:///workspace', capabilities: {} } })
    spawn(); children[0]!.answer(1, { capabilities: { hoverProvider: true } }); send({ method: 'initialized', params: {} })
  }
  disposals.push(() => { for (const run of children) { run.close(); for (const s of [run.backend.stdin, run.backend.stdout, run.backend.stderr]) s.destroy() }; input.destroy(); output.destroy(); stderr.destroy() })
  return { input, output, children, start, received, exit, send, spawn, initialize }
}

it('sets and verifies the lowest priority before descendants can inherit it', () => {
  const set = vi.fn(), get = vi.fn(() => 19)
  expect(priority.lowerTsPriority({ set, get, stderr: new PassThrough() })).toEqual({ status: 'lowered', priority: 19 })
  expect(set).toHaveBeenCalledExactlyOnceWith(0, 19)
  expect(get).toHaveBeenCalledExactlyOnceWith(0)
})

it('lowers a real wrapper process and its subsequently spawned backend', () => {
  const code = `import { lowerTsPriority } from ${JSON.stringify(moduleUrl('ts-priority'))};
    import os, { getPriority } from 'node:os'; import { spawnSync } from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    let calls = 0; const original = os.setPriority; os.setPriority = (...args) => { calls++; return original(...args) }; syncBuiltinESMExports();
    lowerTsPriority(); const child = spawnSync(process.execPath, ['-e', 'console.log(require("node:os").getPriority())'], { encoding: 'utf8' });
    console.log(JSON.stringify({ parent: getPriority(), child: Number(child.stdout.trim()), status: child.status, calls }));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ parent: 19, child: 19, status: 0, calls: 1 })
})

it('applies lowest priority in the shipped executable before receiving requests', () => {
  const observe = 'data:text/javascript,import os from "node:os";import{syncBuiltinESMExports}from"node:module";const original=os.setPriority;os.setPriority=(...args)=>{process.stderr.write("set-priority="+args);return original(...args)};syncBuiltinESMExports();process.on("exit",()=>process.stderr.write("priority="+os.getPriority()))'
  const result = spawnSync(process.execPath, ['--import', observe, join(root, 'bin/wt-tsls.mjs')], {
    input: frame({ method: 'exit' }), encoding: 'utf8', timeout: 30_000,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('priority=19')
  expect(result.stderr).toContain('set-priority=0,19')
})

it.each(['throws', 'mismatch'])('reports priority as unknown when the OS %s', (failure) => {
  const stderr = new PassThrough(), text: Buffer[] = []
  stderr.on('data', (chunk: Buffer) => text.push(chunk))
  const result = priority.lowerTsPriority({ set: () => { if (failure === 'throws') throw new Error('denied') }, get: () => 0, stderr })
  expect(result.status).toBe('unavailable')
  expect(Buffer.concat(text).toString()).toContain('priority unavailable')
})

it('stops observing initialize output immediately after its answer', () => {
  const run = fixture()
  run.initialize()
  // The only data listener left is the protocol pipe, not an endless JSON observer.
  expect(run.children[0]!.backend.stdout.listenerCount('data')).toBe(1)
})

it('retires an idle backend using shutdown/exit and leaves the client connected', async () => {
  const run = fixture(); run.initialize()
  const first = run.children[0]!
  await vi.advanceTimersByTimeAsync(999)
  expect(first.sent.some(m => m.method === 'shutdown')).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(first.sent.at(-1)?.method, 'idle backend must receive shutdown').toBe('shutdown')
  first.answer(first.sent.at(-1)!.id!)
  expect(first.sent.at(-1)?.method).toBe('exit')
  first.close()
  expect(run.exit).not.toHaveBeenCalled()
  expect(run.received).toHaveLength(1)
  expect(first.backend.kill).not.toHaveBeenCalled()
})

async function sleepBackend(run: ReturnType<typeof fixture>) {
  await vi.advanceTimersByTimeAsync(1000)
  const first = run.children[0]!
  const shutdown = first.sent.find(m => m.method === 'shutdown')
  expect(shutdown, 'idle shutdown must exist before replay can be tested').toBeDefined()
  first.answer(shutdown!.id!); first.close()
  await vi.advanceTimersByTimeAsync(0)
}

it('wakes only on a request and replays current documents/configuration before hover', async () => {
  const run = fixture(); run.initialize()
  run.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///workspace/a.ts', languageId: 'typescript', version: 1, text: 'const x = 1\n' } } })
  await sleepBackend(run)
  run.send({ method: 'workspace/didChangeConfiguration', params: { settings: { quote: 'single' } } })
  run.send({ method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///workspace/a.ts', version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, text: '42' }] } })
  expect(run.start).toHaveBeenCalledTimes(1)
  run.send({ id: 2, method: 'textDocument/hover', params: { textDocument: { uri: 'file:///workspace/a.ts' }, position: { line: 0, character: 6 } } })
  expect(run.start).toHaveBeenCalledTimes(2)
  run.spawn()
  const second = run.children[1]!
  expect(second.sent.map(m => m.method)).toEqual(['initialize'])
  second.answer(1, { capabilities: { hoverProvider: true } })
  expect(second.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'workspace/didChangeConfiguration', 'textDocument/didOpen', 'textDocument/hover'])
  expect(second.sent[3]!.params).toEqual({ textDocument: { uri: 'file:///workspace/a.ts', languageId: 'typescript', version: 2, text: 'const x = 42\n' } })
  second.answer(2, { contents: 'const x: 42' })
  expect(run.received.map(m => m.id)).toEqual([1, 2])
  expect(run.received[1]!.result).toEqual({ contents: 'const x: 42' })
})

it('never idles across an unanswered client or server request', async () => {
  const run = fixture(); run.initialize()
  run.send({ id: 2, method: 'textDocument/definition', params: {} })
  await vi.advanceTimersByTimeAsync(2000)
  expect(run.children[0]!.sent.some(m => m.method === 'shutdown')).toBe(false)
  run.children[0]!.answer(2)
  run.children[0]!.backend.stdout.write(frame({ id: 'config', method: 'workspace/configuration', params: {} }))
  await vi.advanceTimersByTimeAsync(2000)
  expect(run.children[0]!.sent.some(m => m.method === 'shutdown')).toBe(false)
  run.send({ id: 'config', result: [] })
  await vi.advanceTimersByTimeAsync(1000)
  expect(run.children[0]!.sent.at(-1)?.method).toBe('shutdown')
})

it('answers shutdown while asleep without spawning another backend', async () => {
  const run = fixture(); run.initialize(); await sleepBackend(run)
  run.send({ id: 9, method: 'shutdown' })
  expect(run.received.at(-1)).toMatchObject({ id: 9, result: null })
  expect(run.start).toHaveBeenCalledTimes(1)
  run.send({ method: 'exit' })
  await vi.advanceTimersByTimeAsync(0)
  expect(run.exit).toHaveBeenCalledExactlyOnceWith(0)
})

it('queues a request arriving during retirement until the old child has closed', async () => {
  const run = fixture(); run.initialize()
  await vi.advanceTimersByTimeAsync(1000)
  run.send({ id: 2, method: 'workspace/symbol', params: { query: 'x' } })
  expect(run.start).toHaveBeenCalledTimes(1)
  const first = run.children[0]!
  expect(first.sent.at(-1)?.method).toBe('shutdown')
  first.answer(first.sent.at(-1)!.id!); first.close()
  await vi.advanceTimersByTimeAsync(0)
  expect(run.start).toHaveBeenCalledTimes(2)
})

it('bounds a non-cooperative idle shutdown by signalling only its own child handle', async () => {
  const run = fixture(); run.initialize()
  await vi.advanceTimersByTimeAsync(1100)
  expect(run.children[0]!.backend.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  await vi.advanceTimersByTimeAsync(1000)
  expect(run.children[0]!.backend.kill).toHaveBeenLastCalledWith('SIGKILL')
})

it('preserves notification order while a replacement initializes', async () => {
  const run = fixture(); run.initialize()
  run.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///workspace/a.ts', languageId: 'typescript', version: 1, text: 'before' } } })
  await sleepBackend(run)
  run.send({ id: 2, method: 'textDocument/hover', params: {} })
  run.send({ method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///workspace/a.ts', version: 2 }, contentChanges: [{ text: 'after' }] } })
  run.send({ id: 3, method: 'textDocument/hover', params: {} })
  run.spawn(); run.children[1]!.answer(1, { capabilities: {} })
  const sent = run.children[1]!.sent
  expect(sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'textDocument/didOpen', 'textDocument/hover', 'textDocument/didChange', 'textDocument/hover'])
  expect(sent.filter(m => m.method === 'textDocument/hover').map(m => m.id)).toEqual([2, 3])
  expect(sent[2]!.params).toMatchObject({ textDocument: { text: 'before' } })
})

it('does not replay closed documents and retains UTF-16 incremental edits', async () => {
  const run = fixture(); run.initialize()
  for (const name of ['a', 'b']) run.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: `file:///workspace/${name}.ts`, languageId: 'typescript', version: 1, text: '😀x\r\nnext' } } })
  run.send({ method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///workspace/a.ts', version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 2 }, end: { line: 1, character: 4 } }, text: 'saved' }] } })
  run.send({ method: 'textDocument/didClose', params: { textDocument: { uri: 'file:///workspace/b.ts' } } })
  await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn(); run.children[1]!.answer(1, { capabilities: {} })
  const opened = run.children[1]!.sent.filter(m => m.method === 'textDocument/didOpen')
  expect(opened).toHaveLength(1)
  expect(opened[0]!.params).toMatchObject({ textDocument: { uri: 'file:///workspace/a.ts', version: 2, text: '😀saved' } })
})

it('cleans up the idle deadline on client EOF and mirrors a normal backend exit', async () => {
  const run = fixture(); run.initialize()
  run.input.end()
  await vi.advanceTimersByTimeAsync(0)
  run.children[0]!.close()
  await vi.advanceTimersByTimeAsync(0)
  expect(run.exit).toHaveBeenCalledExactlyOnceWith(0)
  await vi.advanceTimersByTimeAsync(2000)
  expect(run.children[0]!.sent.some(m => m.method === 'shutdown')).toBe(false)
})

it('does not let diagnostic output or file notifications extend the no-request deadline', async () => {
  const run = fixture(); run.initialize()
  await vi.advanceTimersByTimeAsync(900)
  run.children[0]!.backend.stdout.write(frame({ method: 'textDocument/publishDiagnostics', params: { diagnostics: [] } }))
  run.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///workspace/a.ts', version: 1, languageId: 'typescript', text: 'const x = 1' } } })
  await vi.advanceTimersByTimeAsync(100)
  expect(run.children[0]!.sent.at(-1)?.method).toBe('shutdown')
})

it('unregisters accepted dynamic capabilities before discarding their backend', async () => {
  const run = fixture(); run.initialize()
  run.children[0]!.backend.stdout.write(frame({ id: 'register', method: 'client/registerCapability', params: { registrations: [{ id: 'watch-old', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [] } }] } }))
  run.send({ id: 'register', result: null })
  await vi.advanceTimersByTimeAsync(1000)
  const unregister = run.received.find(m => m.method === 'client/unregisterCapability')
  expect(unregister, 'retired backend must release its client-side registrations').toBeDefined()
  expect(unregister!.params).toEqual({ unregisterations: [{ id: 'watch-old', method: 'workspace/didChangeWatchedFiles' }] })
  const sent = run.children[0]!.sent.length
  run.send({ id: unregister!.id!, result: null })
  expect(run.children[0]!.sent).toHaveLength(sent)
})

it('handles a UTF-8 initialize split at every byte boundary', () => {
  const run = fixture()
  const bytes = frame({ id: 1, method: 'initialize', params: { rootUri: 'file:///workspace/é', capabilities: {} } })
  for (const byte of bytes.subarray(0, -1)) run.input.write(Buffer.from([byte]))
  expect(run.start).not.toHaveBeenCalled()
  run.input.write(bytes.subarray(-1))
  expect(run.start).toHaveBeenCalledTimes(1)
  run.spawn()
  expect(run.children[0]!.sent[0]!.params).toMatchObject({ rootUri: 'file:///workspace/é' })
})

it('forwards fragmented diagnostic payloads with linear copying after initialize', () => {
  const run = fixture(); run.initialize()
  const text = 'é'.repeat(128 * 1024)
  const bytes = frame({ method: 'textDocument/publishDiagnostics', params: { diagnostics: [{ message: text }] } })
  let copied = 0
  const concat = Buffer.concat
  vi.spyOn(Buffer, 'concat').mockImplementation((list, size) => {
    copied += size ?? list.reduce((sum, item) => sum + item.length, 0)
    return concat(list, size)
  })
  for (let i = 0; i < bytes.length; i += 1024) run.children[0]!.backend.stdout.write(bytes.subarray(i, i + 1024))
  expect(run.received.at(-1)!.params).toEqual({ diagnostics: [{ message: text }] })
  expect(copied, 'relay copying must stay linear in diagnostic bytes').toBeLessThanOrEqual(bytes.length * 4)
})

it('rejects oversized protocol frames before allocating their bodies or spawning', async () => {
  const run = fixture()
  run.input.write(Buffer.from('Content-Length: 999999999\r\n\r\n'))
  await vi.advanceTimersByTimeAsync(0)
  expect(run.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(run.start).not.toHaveBeenCalled()
})

it('does not write exit twice when shutdown is acknowledged but the child stays alive', async () => {
  const write = PassThrough.prototype.write
  let afterEnd = 0
  vi.spyOn(PassThrough.prototype, 'write').mockImplementation(function (this: PassThrough, ...args: Parameters<typeof write>) {
    if (this.writableEnded) { afterEnd++; return false }
    return Reflect.apply(write, this, args)
  })
  const run = fixture(); run.initialize()
  await vi.advanceTimersByTimeAsync(1000)
  const first = run.children[0]!
  first.answer(first.sent.at(-1)!.id!)
  await vi.advanceTimersByTimeAsync(100)
  expect(afterEnd, 'idle exit must be idempotent after shutdown acknowledgement').toBe(0)
  expect(first.backend.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
})

it('keeps supervising its retiring backend when the client sends exit', async () => {
  const run = fixture(); run.initialize()
  await vi.advanceTimersByTimeAsync(1000)
  run.send({ method: 'exit' }); await vi.advanceTimersByTimeAsync(0)
  expect(run.exit, 'client exit must wait for backend close').not.toHaveBeenCalled()
  run.children[0]!.close(); await vi.advanceTimersByTimeAsync(0)
  expect(run.exit).toHaveBeenCalledExactlyOnceWith(0)
})
