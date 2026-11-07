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
const sessionState = await import(moduleUrl('ts-session-state'))
const stop = await import(moduleUrl('ts-idle-stop'))
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

function fixture(overrides: Record<string, unknown> = {}) {
  vi.useFakeTimers()
  const input = new PassThrough(), output = new PassThrough(), stderr = new PassThrough()
  const received = messages(output), exit = vi.fn(), exitSignal = vi.fn()
  const children: ReturnType<typeof child>[] = []
  function child() {
    const backend = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn<(signal?: string) => boolean>(() => true) })
    const sent = messages(backend.stdin)
    const close = (code: number | null = 0, signal: string | null = null) => { backend.exitCode = code; backend.emit('exit', code, signal); backend.emit('close', code, signal) }
    return { backend, sent, close, answer: (id: string | number, result: unknown = null) => backend.stdout.write(frame({ id, result })) }
  }
  const start = vi.fn(() => { const run = child(); children.push(run); return run.backend })
  const signals = new EventEmitter()
  managed.runTsIdleSession({ input, output, stderr, exit, exitSignal, idleMs: 1000, stopMs: 100,
    platform: 'linux',
    signalSource: signals,
    groupOwnership: (backend: { child: { exitCode: number | null } }) => backend.child.exitCode === null ? 'ours' : 'empty',
    killGroup: (_pid: number, signal: string) => children.at(-1)!.backend.kill(signal),
    select: () => ({ status: 'launch', backend: 'typescript-language-server', command: '/fake', args: [] }), start, ...overrides })
  const send = (message: object) => input.write(frame(message))
  const spawn = () => children.at(-1)!.backend.emit('spawn')
  const initialize = () => {
    send({ id: 1, method: 'initialize', params: { rootUri: 'file:///workspace', capabilities: {} } })
    spawn(); children[0]!.answer(1, { capabilities: { hoverProvider: true } }); send({ method: 'initialized', params: {} })
  }
  disposals.push(() => { for (const run of children) { run.close(); for (const s of [run.backend.stdin, run.backend.stdout, run.backend.stderr]) s.destroy() }; input.destroy(); output.destroy(); stderr.destroy() })
  return { input, output, stderr, children, start, received, exit, exitSignal, send, spawn, initialize, signals }
}

it('routes server replies and exit during replacement initialization', async () => {
  const run = fixture(); run.initialize(); await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn()
  const second = run.children[1]!
  second.backend.stdout.write(frame({ id: 'config', method: 'workspace/configuration', params: {} }))
  run.send({ id: run.received.at(-1)!.id!, result: [] })
  expect(second.sent.at(-1), 'replacement initialize must receive client replies immediately').toMatchObject({ id: 'config', result: [] })
  run.send({ method: 'exit' })
  expect(second.sent.at(-1)?.method, 'exit must bypass replacement initialize').toBe('exit')
})

it('bounds unanswered requests and ignores server traffic for the idle deadline', async () => {
  const run = fixture(); run.initialize()
  run.send({ id: 2, method: 'workspace/symbol', params: {} })
  await vi.advanceTimersByTimeAsync(999)
  run.children[0]!.backend.stdout.write(frame({ id: 'config', method: 'workspace/configuration', params: {} }))
  run.send({ id: run.received.at(-1)!.id!, result: [] })
  await vi.advanceTimersByTimeAsync(1001)
  expect(run.children[0]!.sent.some(m => m.method === 'shutdown'), 'unanswered requests must have a finite retirement ceiling').toBe(true)
  expect(run.received).toContainEqual(expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32800 }) }))
})

it('does not reset the no-client-request deadline for a server request reply', async () => {
  const run = fixture(); run.initialize(); await vi.advanceTimersByTimeAsync(900)
  run.children[0]!.backend.stdout.write(frame({ id: 'config', method: 'workspace/configuration', params: {} }))
  run.send({ id: run.received.at(-1)!.id!, result: [] })
  await vi.advanceTimersByTimeAsync(100)
  expect(run.children[0]!.sent.at(-1)?.method, 'server request replies must not reset the client-origin deadline').toBe('shutdown')
})

it('starts the request deadline when forwarded to the ready replacement', async () => {
  const run = fixture(); run.initialize(); await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn()
  await vi.advanceTimersByTimeAsync(500)
  run.children[1]!.answer(1, { capabilities: { hoverProvider: true } }); run.children[1]!.answer(2)
  await vi.advanceTimersByTimeAsync(500)
  expect(run.children[1]!.sent.some(m => m.method === 'shutdown'), 'replacement overhead must not consume the request clock').toBe(false)
  await vi.advanceTimersByTimeAsync(500)
  expect(run.children[1]!.sent.at(-1)?.method).toBe('shutdown')
})

it('rejects changed replacement capabilities before replaying requests', async () => {
  const run = fixture(); run.initialize(); await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn()
  run.children[1]!.answer(1, { capabilities: { hoverProvider: true, positionEncoding: 'utf-8' } })
  await vi.advanceTimersByTimeAsync(0)
  expect(run.exit, 'changed position encoding must fail closed').toHaveBeenCalledWith(1)
  expect(run.children[1]!.sent.some(m => m.id === 2)).toBe(false)
})

it('answers shutdown during retirement without a replacement', async () => {
  const run = fixture(); run.initialize(); await vi.advanceTimersByTimeAsync(1000)
  run.send({ id: 9, method: 'shutdown' })
  expect(run.received.at(-1), 'shutdown must be answered locally during retirement').toMatchObject({ id: 9, result: null })
  run.children[0]!.close()
  expect(run.start).toHaveBeenCalledTimes(1)
})

it('forwards final progress output while stopping', async () => {
  const run = fixture(); run.initialize(); await vi.advanceTimersByTimeAsync(1000)
  run.children[0]!.backend.stdout.write(frame({ method: '$/progress', params: { token: 'work', value: { kind: 'end' } } }))
  expect(run.received.at(-1), 'retirement must preserve final progress').toMatchObject({ method: '$/progress' })
})

it('does not replay after client EOF during replacement initialization', async () => {
  const run = fixture(); run.initialize(); await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn()
  const write = PassThrough.prototype.write
  let afterEnd = 0
  vi.spyOn(PassThrough.prototype, 'write').mockImplementation(function (this: PassThrough, ...args: Parameters<typeof write>) {
    if (this.writableEnded) { afterEnd++; return false }
    return Reflect.apply(write, this, args)
  })
  run.input.end(); await vi.advanceTimersByTimeAsync(0)
  run.children[1]!.answer(1, { capabilities: { hoverProvider: true } })
  await vi.advanceTimersByTimeAsync(0)
  expect(run.children[1]!.sent.some(m => m.method === 'initialized'), 'EOF must prevent replay to an ended backend input').toBe(false)
  expect(afterEnd, 'EOF must prevent all writes to ended backend streams').toBe(0)
})

it.each([{ text: 'a\rb', character: 0, line: 1, expected: 'a\rXb' }, { text: 'a\r\nb', character: 99, line: 0, expected: 'aX\r\nb' }, { text: 'a\n', character: 0, line: 1, expected: 'a\nX' }])('replays edits with correct line endings: $expected', async ({ text, character, line, expected }) => {
  const run = fixture(); run.initialize()
  run.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///a.ts', text, version: 1 } } })
  const position = { line, character }
  run.send({ method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///a.ts', version: 2 }, contentChanges: [{ range: { start: position, end: position }, text: 'X' }] } })
  await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn(); run.children[1]!.answer(1, { capabilities: { hoverProvider: true } })
  expect(run.children[1]!.sent.find(m => m.method === 'textDocument/didOpen')!.params).toMatchObject({ textDocument: { text: expected } })
})

it('freezes workspace folders before queued requests and preserves rootUri fallback', async () => {
  const run = fixture(); run.initialize(); await vi.advanceTimersByTimeAsync(1000)
  run.send({ id: 2, method: 'workspace/symbol', params: {} })
  run.send({ method: 'workspace/didChangeWorkspaceFolders', params: { event: { removed: [], added: [{ uri: 'file:///extra', name: 'extra' }] } } })
  run.children[0]!.answer(run.children[0]!.sent.find(m => m.method === 'shutdown')!.id!); run.children[0]!.close(); await vi.advanceTimersByTimeAsync(0); run.spawn()
  expect(run.children[1]!.sent[0]!.params?.workspaceFolders, 'folder changes must not overtake queued requests').toBeUndefined()
  run.children[1]!.answer(1, { capabilities: { hoverProvider: true } })
  expect(run.children[1]!.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'workspace/symbol', 'workspace/didChangeWorkspaceFolders'])
})

it('resumes client input when a backpressured backend is retired', async () => {
  const run = fixture(); run.initialize()
  const write = PassThrough.prototype.write
  const blocked = vi.spyOn(PassThrough.prototype, 'write').mockImplementation(function (this: PassThrough, ...args: Parameters<typeof write>) {
    const result = Reflect.apply(write, this, args)
    return this !== run.input && args[0].toString().includes('blocked') ? false : result
  })
  run.send({ method: 'blocked' })
  expect(run.input.isPaused()).toBe(true)
  blocked.mockRestore()
  await vi.advanceTimersByTimeAsync(2100)
  expect(run.input.isPaused(), 'closed backends must release client backpressure').toBe(false)
  run.send({ id: 2, method: 'workspace/symbol', params: {} })
  expect(run.start).toHaveBeenCalledTimes(2)
})

it('namespaces dynamic registrations so late cleanup cannot remove a replacement registration', async () => {
  const run = fixture(); run.initialize()
  const registration = { id: 'same', method: 'workspace/didChangeWatchedFiles' }
  run.children[0]!.backend.stdout.write(frame({ id: 'r1', method: 'client/registerCapability', params: { registrations: [registration] } }))
  const old = (run.received.at(-1)!.params!.registrations as Array<{ id: string }>)[0]!.id
  run.send({ id: run.received.at(-1)!.id!, result: null }); await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn()
  run.children[1]!.backend.stdout.write(frame({ id: 'r2', method: 'client/registerCapability', params: { registrations: [registration] } }))
  const next = (run.received.at(-1)!.params!.registrations as Array<{ id: string }>)[0]!.id
  expect(next, 'registration ids must be unique across backend generations').not.toBe(old)
})

it('never routes a stale server-request reply into a new generation with the same backend id', async () => {
  const run = fixture(); run.initialize()
  run.children[0]!.backend.stdout.write(frame({ id: 'same', method: 'workspace/configuration', params: {} }))
  const oldId = run.received.at(-1)!.id!
  await vi.advanceTimersByTimeAsync(2000)
  const shutdown = run.children[0]!.sent.find(m => m.method === 'shutdown')!
  run.children[0]!.answer(shutdown.id!); run.children[0]!.close(); await vi.advanceTimersByTimeAsync(0)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn()
  run.children[1]!.backend.stdout.write(frame({ id: 'same', method: 'workspace/configuration', params: {} }))
  const newId = run.received.at(-1)!.id!
  expect(newId).not.toBe(oldId)
  run.send({ id: oldId, result: ['stale'] })
  expect(run.children[1]!.sent.some(m => m.id === 'same'), 'stale replies must not satisfy a new server request').toBe(false)
  run.send({ id: newId, result: ['current'] })
  expect(run.children[1]!.sent.at(-1)).toMatchObject({ id: 'same', result: ['current'] })
})

it('accepts a didOpen larger than the initialization frame budget', () => {
  const run = fixture(); run.initialize()
  run.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///big.ts', text: 'x'.repeat(17 * 1024 * 1024), version: 1 } } })
  expect(run.children[0]!.sent.at(-1)?.method, 'large document notifications must reach the backend').toBe('textDocument/didOpen')
})

it('copies fragmented initialize responses only linearly', () => {
  const run = fixture()
  run.send({ id: 1, method: 'initialize', params: {} }); run.spawn()
  const bytes = frame({ id: 1, result: { capabilities: {}, serverInfo: { name: 'x'.repeat(256 * 1024) } } })
  let copied = 0
  const concat = Buffer.concat
  vi.spyOn(Buffer, 'concat').mockImplementation((list, size) => {
    copied += size ?? list.reduce((sum, item) => sum + item.length, 0)
    return concat(list, size)
  })
  for (let i = 0; i < bytes.length; i += 1024) run.children[0]!.backend.stdout.write(bytes.subarray(i, i + 1024))
  expect(copied, 'initialize observer copying must be linear').toBeLessThan(bytes.length * 6)
})

it('does not copy untouched document text once per incremental edit', () => {
  const state = { documents: new Map() }
  const uri = 'file:///large.ts'
  sessionState.rememberTsState(state, { method: 'textDocument/didOpen', params: { textDocument: { uri, text: 'short\n' + 'x'.repeat(1024 * 1024), version: 1 } } })
  const slice = String.prototype.slice
  let copied = 0
  vi.spyOn(String.prototype, 'slice').mockImplementation(function (this: string, start, end) {
    const result = Reflect.apply(slice, this, [start, end]); copied += result.length; return result
  })
  for (let i = 0; i < 20; i++) sessionState.rememberTsState(state, { method: 'textDocument/didChange', params: { textDocument: { uri, version: i + 2 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'a' }] } })
  expect(copied, 'edits must not copy the untouched megabyte tail').toBeLessThan(1024 * 1024)
})

it('retains rootUri as an initial workspace folder when workspaceFolders is null', () => {
  const state = { documents: new Map(), initialize: { params: { rootUri: 'file:///root', workspaceFolders: null as unknown } } }
  sessionState.rememberTsState(state, { method: 'workspace/didChangeWorkspaceFolders', params: { event: { removed: [], added: [{ uri: 'file:///extra', name: 'extra' }] } } })
  expect(state.initialize.params.workspaceFolders, 'null workspaceFolders must not discard rootUri').toEqual([{ uri: 'file:///root', name: 'root' }, { uri: 'file:///extra', name: 'extra' }])
})

it('bounds initialization when a replacement never answers', async () => {
  const run = fixture(); run.initialize(); await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn()
  await vi.advanceTimersByTimeAsync(2000)
  expect(run.exit, 'an unanswered initialize must have a finite lifetime').toHaveBeenCalledWith(1)
})

it('keeps the initialization ceiling armed across server requests and client replies', async () => {
  const run = fixture(); run.initialize(); await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn()
  run.children[1]!.backend.stdout.write(frame({ id: 'config', method: 'workspace/configuration', params: {} }))
  run.send({ id: run.received.at(-1)!.id!, result: [] })
  await vi.advanceTimersByTimeAsync(2000)
  expect(run.exit, 'init server traffic must not cancel the initialization ceiling').toHaveBeenCalledWith(1)
})

it('applies successive multi-line piece edits exactly before replay', () => {
  const state = { documents: new Map() }, uri = 'file:///a.ts'
  sessionState.rememberTsState(state, { method: 'textDocument/didOpen', params: { textDocument: { uri, text: 'one\r\ntwo\rthree\nfour', version: 1 } } })
  const changes = [
    { range: { start: { line: 0, character: 1 }, end: { line: 1, character: 2 } }, text: 'A\nB' },
    { range: { start: { line: 1, character: 1 }, end: { line: 2, character: 3 } }, text: '😀' },
  ]
  sessionState.rememberTsState(state, { method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: changes } })
  expect(sessionState.tsReplayState(state)[1].params.textDocument.text).toBe('oA\nB😀ee\nfour')
})

it('clears the EOF deadline immediately before backend close', async () => {
  const run = fixture(), scheduled = vi.spyOn(globalThis, 'setTimeout')
  run.initialize()
  const idle = scheduled.mock.results.at(-1)!.value
  const clear = vi.spyOn(globalThis, 'clearTimeout')
  run.input.end(); await vi.advanceTimersByTimeAsync(0)
  expect(clear, 'EOF must cancel the actual scheduled idle timer').toHaveBeenCalledWith(idle)
})

it('consumes cleanup replies after the replacement is active', async () => {
  const run = fixture(); run.initialize()
  run.children[0]!.backend.stdout.write(frame({ id: 'r', method: 'client/registerCapability', params: { registrations: [{ id: 'watch', method: 'workspace/didChangeWatchedFiles' }] } }))
  run.send({ id: run.received.at(-1)!.id!, result: null }); await sleepBackend(run)
  const cleanup = run.received.find(m => m.method === 'client/unregisterCapability')!
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn(); run.children[1]!.answer(1, { capabilities: { hoverProvider: true } })
  let diagnostic = ''
  run.stderr.on('data', chunk => { diagnostic += chunk.toString() })
  run.send({ id: cleanup.id!, error: { code: -1, message: 'refused' } })
  await vi.advanceTimersByTimeAsync(0)
  expect(run.children[1]!.sent.some(m => m.id === cleanup.id), 'cleanup replies must never leak into a replacement').toBe(false)
  expect(diagnostic, 'cleanup failures must be consumed and diagnosed').toContain('client refused idle capability cleanup')
})

it('replays didSave text and ordered cancellation during restart', async () => {
  const run = fixture(); run.initialize()
  run.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///a.ts', text: 'old', version: 1 } } })
  run.send({ method: 'textDocument/didSave', params: { textDocument: { uri: 'file:///a.ts' }, text: 'saved' } })
  await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} })
  run.send({ method: '$/cancelRequest', params: { id: 2 } }); run.spawn(); run.children[1]!.answer(1, { capabilities: { hoverProvider: true } })
  expect(run.children[1]!.sent[2]!.params).toMatchObject({ textDocument: { text: 'saved' } })
  expect(run.children[1]!.sent.slice(-2).map(m => m.method)).toEqual(['workspace/symbol', '$/cancelRequest'])
})

it('sets and verifies the lowest priority before descendants can inherit it', () => {
  const set = vi.fn(), get = vi.fn(() => 19)
  expect(priority.lowerTsPriority({ set, get, threads: () => [], stderr: new PassThrough() })).toEqual({ status: 'lowered', priority: 19 })
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
  expect(JSON.parse(result.stdout)).toMatchObject({ parent: 19, child: 19, status: 0 })
  expect(JSON.parse(result.stdout).calls).toBeGreaterThanOrEqual(1)
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

it('allows one idle interval of grace for unanswered requests', async () => {
  const run = fixture(); run.initialize()
  run.send({ id: 2, method: 'textDocument/definition', params: {} })
  await vi.advanceTimersByTimeAsync(1500)
  expect(run.children[0]!.sent.some(m => m.method === 'shutdown')).toBe(false)
  run.children[0]!.answer(2)
  run.children[0]!.backend.stdout.write(frame({ id: 'config', method: 'workspace/configuration', params: {} }))
  await vi.advanceTimersByTimeAsync(499)
  expect(run.children[0]!.sent.some(m => m.method === 'shutdown')).toBe(false)
  run.send({ id: run.received.at(-1)!.id!, result: [] })
  await vi.advanceTimersByTimeAsync(1)
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
  run.spawn(); run.children[1]!.answer(1, { capabilities: { hoverProvider: true } })
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
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn(); run.children[1]!.answer(1, { capabilities: { hoverProvider: true } })
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
  run.send({ id: run.received.at(-1)!.id!, result: null })
  await vi.advanceTimersByTimeAsync(1000)
  const unregister = run.received.find(m => m.method === 'client/unregisterCapability')
  expect(unregister, 'retired backend must release its client-side registrations').toBeDefined()
  expect(unregister!.params).toEqual({ unregisterations: [{ id: expect.stringContaining('-1-watch-old'), method: 'workspace/didChangeWatchedFiles' }] })
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
  run.input.write(Buffer.from('Content-Length: 9999999999999999999\r\n\r\n'))
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
  await vi.advanceTimersByTimeAsync(1100)
  expect(run.exit).toHaveBeenCalledExactlyOnceWith(0)
})

it('bounds an unanswered client shutdown by two idle intervals', async () => {
  const run = fixture(); run.initialize()
  run.send({ id: 7, method: 'shutdown' })
  await vi.advanceTimersByTimeAsync(2000)
  expect(run.received, 'shutdown must retain the unanswered-request ceiling').toContainEqual(expect.objectContaining({ id: 7, error: expect.objectContaining({ code: -32800 }) }))
})

it('cleans up a late registration success after retirement and replacement', async () => {
  const run = fixture(); run.initialize()
  run.children[0]!.backend.stdout.write(frame({ id: 'late', method: 'client/registerCapability', params: { registrations: [{ id: 'watch', method: 'workspace/didChangeWatchedFiles' }] } }))
  const pending = run.received.at(-1)!
  await vi.advanceTimersByTimeAsync(2000)
  run.children[0]!.close(); await vi.advanceTimersByTimeAsync(0)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn()
  run.children[1]!.answer(1, { capabilities: { hoverProvider: true } })
  run.send({ id: pending.id!, result: null })
  expect(run.received.at(-1), 'late accepted registrations must be unregistered').toMatchObject({ method: 'client/unregisterCapability', params: { unregisterations: pending.params!.registrations } })
  expect(run.children[1]!.sent.some(m => m.id === 'late')).toBe(false)
})

it.each(['textDocument/didClose', 'textDocument/didChange'])('drops stale diagnostics during retirement after %s', async method => {
  const run = fixture(); run.initialize()
  await vi.advanceTimersByTimeAsync(1000)
  run.send({ method, params: { textDocument: { uri: 'file:///a.ts' }, contentChanges: [{ text: 'new' }] } })
  run.children[0]!.backend.stdout.write(frame({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a.ts', diagnostics: [{ message: 'stale' }] } }))
  expect(run.received.some(m => m.method === 'textDocument/publishDiagnostics'), 'stopping backends must not publish diagnostics').toBe(false)
})

it('supervises SIGHUP through the same bounded stop path', async () => {
  const run = fixture(); run.initialize()
  run.signals.emit('SIGHUP')
  await vi.advanceTimersByTimeAsync(1100)
  expect(run.exitSignal, 'SIGHUP must supervise backend termination').toHaveBeenCalledWith('SIGHUP')
})

it('skips KILL when backend group ownership no longer matches', async () => {
  let ownership = 'ours'
  const killGroup = vi.fn()
  const run = fixture({ groupOwnership: () => ownership, killGroup }); run.initialize()
  await vi.advanceTimersByTimeAsync(1100)
  ownership = 'unknown'
  await vi.advanceTimersByTimeAsync(1000)
  expect(killGroup, 'a mismatched birth identity must never receive a group KILL').not.toHaveBeenCalledWith(-123, 'SIGKILL')
})

it('still reaches an uncooperative leader through the child when ownership is unknown (darwin)', async () => {
  const killGroup = vi.fn()
  const run = fixture({ platform: 'darwin', groupOwnership: () => 'unknown', killGroup }); run.initialize()
  await vi.advanceTimersByTimeAsync(1100)
  await vi.advanceTimersByTimeAsync(1000)
  expect(run.children[0]!.backend.kill.mock.calls.map(call => call[0]), 'leader must get TERM then KILL through the ChildProcess').toEqual(['SIGTERM', 'SIGKILL'])
  expect(killGroup, 'an unverified group must never be signalled').not.toHaveBeenCalled()
})

it('signals a surviving owned group after normal backend close', async () => {
  const run = fixture({ groupOwnership: () => 'ours' }); run.initialize()
  await vi.advanceTimersByTimeAsync(1000)
  run.children[0]!.close()
  await vi.advanceTimersByTimeAsync(0)
  expect(run.children[0]!.backend.kill, 'normal close must TERM surviving owned descendants').toHaveBeenCalledWith('SIGTERM')
  await vi.advanceTimersByTimeAsync(1000)
  expect(run.children[0]!.backend.kill).toHaveBeenCalledWith('SIGKILL')
})

it('reports unknown ownership without signalling an unverified group', () => {
  const stderr = new PassThrough(); let text = ''
  stderr.on('data', chunk => { text += chunk.toString() })
  const killGroup = vi.fn(), kill = vi.fn()
  stop.signalTsBackend({ options: { platform: 'linux', groupOwnership: () => 'unknown', killGroup }, streams: { stderr } }, { child: { pid: 123, kill } }, 'SIGKILL')
  expect(killGroup, 'unknown ownership must suppress the group signal').not.toHaveBeenCalled()
  expect(kill, 'the leader is still signalled through its ChildProcess').toHaveBeenCalledExactlyOnceWith('SIGKILL')
  expect(text).toContain('unknown')
})

it.each([
  { name: 'exit code', code: 3 as number | null, signal: null as string | null },
  { name: 'signal', code: null, signal: 'SIGSEGV' },
])('preserves unexpected close status ($name) while cleaning surviving descendants', async ({ code, signal }) => {
  const run = fixture({ groupOwnership: () => 'ours' }); run.initialize()
  run.children[0]!.close(code, signal); await vi.advanceTimersByTimeAsync(0)
  expect(run.exit).not.toHaveBeenCalled(); expect(run.exitSignal).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  if (signal) expect(run.exitSignal, 'the saved signal must surface, not the forced completion').toHaveBeenCalledExactlyOnceWith(signal)
  else expect(run.exit, 'the saved exit code must surface, not the forced completion').toHaveBeenCalledExactlyOnceWith(code)
  expect(run.children[0]!.sent.some(m => m.method === 'shutdown')).toBe(false)
})

it('allows the full unanswered ceiling after slow replacement initialization', async () => {
  const run = fixture(); run.initialize(); await sleepBackend(run)
  run.send({ id: 2, method: 'workspace/symbol', params: {} }); run.spawn()
  await vi.advanceTimersByTimeAsync(1900)
  run.children[1]!.answer(1, { capabilities: { hoverProvider: true } })
  await vi.advanceTimersByTimeAsync(1999)
  expect(run.children[1]!.sent.some(m => m.method === 'shutdown'), 'queued requests need two full idle intervals after forwarding').toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(run.received).toContainEqual(expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32800 }) }))
})

it('bounds retired server request IDs and diagnoses unanswered registrations', async () => {
  const run = fixture(); run.initialize(); let diagnostic = ''
  run.stderr.on('data', chunk => { diagnostic += chunk.toString() })
  run.children[0]!.backend.stdout.write(frame({ id: 'lost', method: 'client/registerCapability', params: { registrations: [{ id: 'watch', method: 'workspace/didChangeWatchedFiles' }] } }))
  const id = run.received.at(-1)!.id!
  await vi.advanceTimersByTimeAsync(4000)
  expect(diagnostic, 'unanswered retired registrations must have a stated bound').toContain('retired registration response deadline expired')
  run.send({ id, result: null })
  expect(run.received.some(m => m.method === 'client/unregisterCapability')).toBe(false)
})

it('preserves a rootPath-only workspace when adding folders', () => {
  const state = { documents: new Map(), initialize: { params: { rootPath: '/root', workspaceFolders: null as unknown } } }
  sessionState.rememberTsState(state, { method: 'workspace/didChangeWorkspaceFolders', params: { event: { removed: [], added: [{ uri: 'file:///extra', name: 'extra' }] } } })
  expect(state.initialize.params.workspaceFolders, 'rootPath fallback must retain the original root').toEqual([{ uri: pathToFileURL('/root').href, name: 'root' }, { uri: 'file:///extra', name: 'extra' }])
})

function editState(text: string) {
  const state = { documents: new Map<string, { lines: unknown[] }>() }, uri = 'file:///edit.ts'
  sessionState.rememberTsState(state, { method: 'textDocument/didOpen', params: { textDocument: { uri, text, version: 1 } } })
  const edit = (start: { line: number; character: number }, end: typeof start, text: string) => {
    sessionState.rememberTsState(state, { method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start, end }, text }] } })
  }
  return { state, edit, text: () => sessionState.tsReplayState(state)[1].params.textDocument.text as string, count: () => state.documents.get(uri)!.lines.length }
}

it('normalizes the reviewer CR insertion sequence before the next edit', () => {
  const run = editState('a\nb')
  run.edit({ line: 0, character: 1 }, { line: 0, character: 1 }, '\r')
  run.edit({ line: 1, character: 0 }, { line: 1, character: 0 }, 'X')
  expect(run.text(), 'CRLF formed across an edit boundary must remain one ending').toBe('a\r\nXb')
})

function randomPosition(text: string, random: () => number) {
  const lines = text.split(/\r\n|\r|\n/), line = random() % lines.length
  const character = random() % (lines[line]!.length + 1)
  const endings = [...text.matchAll(/\r\n|\r|\n/g)]
  const offset = line ? endings[line - 1]!.index! + endings[line - 1]![0].length : 0
  return { position: { line, character }, offset: offset + character }
}

it('matches a flat UTF-16 oracle for seeded CR LF CRLF incremental edits', () => {
  const seed = 0x43a912ef; let value = seed
  const random = () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value }
  const tokens = ['a', 'xy', '😀', '\r', '\n', '\r\n', '']
  const text = () => Array.from({ length: random() % 12 }, () => tokens[random() % tokens.length]).join('')
  for (let sample = 0; sample < 600; sample++) {
    let oracle = text(); const run = editState(oracle)
    for (let step = 0; step < 8; step++) {
      const points = [randomPosition(oracle, random), randomPosition(oracle, random)].sort((a, b) => a.offset - b.offset)
      const [start, end] = points, insertion = text()
      run.edit(start!.position, end!.position, insertion)
      oracle = oracle.slice(0, start!.offset) + insertion + oracle.slice(end!.offset)
      const context = `seed=${seed} sample=${sample} step=${step}`
      expect(run.text(), context).toBe(oracle)
      expect(run.count(), context).toBe(oracle.split(/\r\n|\r|\n/).length)
    }
  }
})
