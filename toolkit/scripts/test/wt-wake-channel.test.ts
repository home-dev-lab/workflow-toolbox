import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface JsonRpcMessage {
  jsonrpc: string
  id?: number
  method?: string
  result?: unknown
  error?: { code: number; message: string }
  params?: { content?: string }
}

const serverScript = fileURLToPath(
  new URL('../../../plugin/bin/wt-wake-channel.mjs', import.meta.url),
)
const processes: ChildProcessWithoutNullStreams[] = []
const tempDirs: string[] = []
const messageWaiters = new WeakMap<JsonRpcMessage[], Set<() => void>>()
let barrierId = 10_000
const POST_INITIALIZATION_POLL_MS = 100
const POST_INITIALIZATION_DELIVERY_MARGIN_MS = 45_000
const POST_INITIALIZATION_DELIVERY_BOUND_MS = POST_INITIALIZATION_POLL_MS + POST_INITIALIZATION_DELIVERY_MARGIN_MS
// Above one runnable task per available CPU, process startup and pipe service have no fixed wall bound.
const HOST_OVERLOADED = loadavg()[0] > availableParallelism()

afterEach(async () => {
  const children = processes.splice(0)
  for (const child of children) child.kill('SIGTERM')
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ])
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await exited
    }
  }))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ⚠ `pollMs` is a parameter and not a constant for one reason worth stating, because it decides
// what the suite can see: every test here pinned a 20 ms poll, so every assertion was satisfied by
// POLLING and the event watch was exercised by nothing. Disabling the watch entirely left all
// three tests green — a control that could not fail for the reason it appeared to test. A test
// that means to observe the watch must therefore set a poll LONGER than its own patience, so that
// the poll cannot be the thing that answers.
function startServer(pollMs = '20', aliasSpool = false): {
  child: ChildProcessWithoutNullStreams
  spool: string
  watchTarget: string
  messages: JsonRpcMessage[]
  stderr: () => string
} {
  const root = mkdtempSync(join(tmpdir(), 'wt-wake-channel-'))
  const spool = join(root, 'inbox')
  tempDirs.push(root)
  if (aliasSpool) {
    mkdirSync(join(root, 'canonical-inbox'))
    symlinkSync(join(root, 'canonical-inbox'), spool, 'dir')
  }
  const watchTarget = aliasSpool ? realpathSync.native(spool) : spool

  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      WT_WAKE_SPOOL: spool,
      WT_WAKE_POLL_MS: pollMs,
      ...(aliasSpool ? { WT_WAKE_DEBUG: '1' } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  processes.push(child)

  const messages: JsonRpcMessage[] = []
  messageWaiters.set(messages, new Set())
  let stdout = ''
  let errors = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    const lines = stdout.split('\n')
    stdout = lines.pop() ?? ''
    for (const line of lines) {
      if (line) {
        messages.push(JSON.parse(line) as JsonRpcMessage)
        for (const notify of messageWaiters.get(messages) ?? []) notify()
      }
    }
  })
  child.stderr.on('data', (chunk: string) => {
    errors += chunk
  })

  return { child, spool, watchTarget, messages, stderr: () => errors }
}

function send(child: ChildProcessWithoutNullStreams, message: object): void {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

async function waitForMessage(messages: JsonRpcMessage[], predicate: (message: JsonRpcMessage) => boolean, patienceMs = 45_000): Promise<JsonRpcMessage> {
  const existing = messages.find(predicate)
  if (existing) return existing
  return new Promise((resolve, reject) => {
    const waiters = messageWaiters.get(messages)!
    let settled = false
    const timer = setTimeout(() => {
      // An expired timer runs before poll callbacks. Give already-buffered child output that poll
      // turn before declaring the fixture silent; this changes ordering, not the deadline.
      setImmediate(() => {
        inspect()
        if (settled) return
        settled = true
        waiters.delete(inspect)
        reject(new Error('timed out waiting for wake-channel output'))
      })
    }, patienceMs)
    const inspect = () => {
      if (settled) return
      const message = messages.find(predicate)
      if (!message) return
      settled = true
      clearTimeout(timer)
      waiters.delete(inspect)
      resolve(message)
    }
    waiters.add(inspect)
  })
}

async function sync(child: ChildProcessWithoutNullStreams, messages: JsonRpcMessage[]): Promise<void> {
  const id = barrierId++
  send(child, { jsonrpc: '2.0', id, method: 'tools/list', params: {} })
  const response = await waitForMessage(messages, (message) => message.id === id)
  messages.splice(messages.indexOf(response), 1)
}

async function waitForPostInitDelivery(
  child: ChildProcessWithoutNullStreams,
  messages: JsonRpcMessage[],
  patienceMs = 45_000,
): Promise<JsonRpcMessage> {
  // A wall-clock delivery bound is meaningful only after the child has run since the deposit.
  await sync(child, messages)
  return waitForMessage(
    messages,
    (message) => message.method === 'notifications/claude/channel',
    patienceMs,
  )
}

async function initialize(child: ChildProcessWithoutNullStreams, messages: JsonRpcMessage[]): Promise<void> {
  send(child, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })
  await waitForMessage(messages, (message) => message.id === 1)
  send(child, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  await sync(child, messages)
}

function channelMessages(messages: JsonRpcMessage[]): JsonRpcMessage[] {
  return messages.filter((message) => message.method === 'notifications/claude/channel')
}

describe('wt-wake-channel MCP server', () => {
  it.skipIf(HOST_OVERLOADED)('accepts output already queued in the poll phase when its wall-clock deadline expires', async () => {
    const messages: JsonRpcMessage[] = []
    messageWaiters.set(messages, new Set())
    const response = waitForMessage(messages, (message) => message.id === 1, 50)

    const fixture = spawn(process.execPath, ['-e', 'process.stdout.write(`{"jsonrpc":"2.0","id":1,"result":{}}\\n`)'])
    processes.push(fixture)
    fixture.stdout.setEncoding('utf8')
    fixture.stdout.once('data', (line: string) => {
      messages.push(JSON.parse(line) as JsonRpcMessage)
      for (const notify of messageWaiters.get(messages) ?? []) notify()
    })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)

    await expect(response).resolves.toMatchObject({ id: 1 })
  })

  it('answers the MCP handshake and requests while an empty spool emits no channel notification', async () => {
    const { child, messages, stderr } = startServer()
    await initialize(child, messages)
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    send(child, { jsonrpc: '2.0', id: 3, method: 'unknown/request', params: {} })
    send(child, { jsonrpc: '2.0', method: 'unknown/notification', params: {} })
    await waitForMessage(messages, (message) => message.id === 3)

    expect(messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
          serverInfo: { name: 'wt-wake-channel', version: '0.1.0' },
        },
      },
      { jsonrpc: '2.0', id: 2, result: { tools: [] } },
      {
        jsonrpc: '2.0',
        id: 3,
        error: { code: -32601, message: 'Method not found' },
      },
    ])
    expect(channelMessages(messages)).toHaveLength(0)
    expect(stderr()).toBe('')
  })

  it.skipIf(process.platform === 'win32')('does not emit before initialized, then moves and emits one deposited message exactly once [requires reliable fs.watch directory delivery]', async () => {
    const { child, spool, messages, stderr } = startServer()
    mkdirSync(spool, { recursive: true })
    writeFileSync(join(spool, 'wake.txt'), '  inspect the finished run  \n', 'utf8')
    await sync(child, messages)
    expect(messages).toEqual([])

    await initialize(child, messages)
    await waitForMessage(messages, (message) => message.method === 'notifications/claude/channel')
    await sync(child, messages)

    expect(channelMessages(messages)).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: {
          content: '<observer source="wt-wake-channel">inspect the finished run</observer>',
        },
      },
    ])
    expect(existsSync(join(spool, 'wake.txt'))).toBe(false)
    expect(readFileSync(join(spool, 'consumed', 'wake.txt'), 'utf8')).toBe(
      '  inspect the finished run  \n',
    )
    expect(stderr()).toBe('')
  })

  it.skipIf(process.platform === 'win32')('silently consumes empty files and skips malformed entries without blocking later messages [requires reliable fs.watch directory delivery]', async () => {
    const { child, spool, messages, stderr } = startServer()
    await initialize(child, messages)
    mkdirSync(join(spool, 'a-malformed.txt'))
    writeFileSync(join(spool, 'b-empty.txt'), ' \n\t', 'utf8')
    writeFileSync(join(spool, 'c-valid.txt'), 'later wake', 'utf8')

    await waitForMessage(messages, (message) => message.method === 'notifications/claude/channel')
    await sync(child, messages)

    expect(channelMessages(messages).map((message) => message.params?.content)).toEqual([
      '<observer source="wt-wake-channel">later wake</observer>',
    ])
    expect(readFileSync(join(spool, 'consumed', 'b-empty.txt'), 'utf8')).toBe(' \n\t')
    expect(readFileSync(join(spool, 'consumed', 'c-valid.txt'), 'utf8')).toBe('later wake')
    expect(existsSync(join(spool, 'a-malformed.txt'))).toBe(true)
    expect(stderr()).toBe('')
  }, 60_000)

  // Linux cannot produce a Windows 8.3 short name, so a symlink is its honest path-alias stand-in.
  // Keep polling beyond the test's patience: only the watcher can deliver this message.
  it.skipIf(process.platform !== 'linux' || HOST_OVERLOADED)('canonicalises an aliased spool before watching and delivers post-init through the configured alias', async () => {
    const { child, spool, watchTarget, messages, stderr } = startServer('60_000', true)
    await initialize(child, messages)

    expect(spool).not.toBe(watchTarget)
    expect(stderr()).toBe(`[wt-wake-channel] watching ${watchTarget}\n`)
    writeFileSync(join(spool, 'aliased.txt'), 'alias wake', 'utf8')

    await waitForPostInitDelivery(child, messages)
      .catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; child exit=${child.exitCode ?? child.signalCode ?? 'running'}; stderr=${stderr() || '<empty>'}`)
      })
    expect(channelMessages(messages).map((message) => message.params?.content)).toEqual([
      '<observer source="wt-wake-channel">alias wake</observer>',
    ])
    expect(readFileSync(join(spool, 'consumed', 'aliased.txt'), 'utf8')).toBe('alias wake')
  }, 47_000)

  // The channel promises fs.watch as a fast path and polling as the delivery backstop. This locks
  // the latter, so a host that drops watch events remains a valid test environment.
  it.skipIf(HOST_OVERLOADED)('delivers a message deposited AFTER initialization within the configured poll interval plus margin', async () => {
    expect(readFileSync(serverScript, 'utf8')).toContain('setInterval(drain, pollMs)')
    const { child, spool, messages, stderr } = startServer(String(POST_INITIALIZATION_POLL_MS))
    await initialize(child, messages)
    expect(channelMessages(messages)).toEqual([])

    writeFileSync(join(spool, 'post-init.txt'), 'the observer speaks', 'utf8')

    await waitForPostInitDelivery(child, messages, POST_INITIALIZATION_DELIVERY_BOUND_MS)
      .catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; child exit=${child.exitCode ?? child.signalCode ?? 'running'}; stderr=${stderr() || '<empty>'}`)
      })
    expect(channelMessages(messages).map((message) => message.params?.content)).toEqual([
      '<observer source="wt-wake-channel">the observer speaks</observer>',
    ])
    expect(existsSync(join(spool, 'post-init.txt'))).toBe(false)
    expect(stderr()).toBe('')
  }, POST_INITIALIZATION_DELIVERY_BOUND_MS + 2_000)

  it.skipIf(process.platform === 'win32' || HOST_OVERLOADED)('does not charge child scheduler starvation against post-init delivery', async () => {
    const { child, spool, messages } = startServer()
    await initialize(child, messages)

    child.kill('SIGSTOP')
    writeFileSync(join(spool, 'starved.txt'), 'delayed by scheduler starvation', 'utf8')
    const resume = setTimeout(() => child.kill('SIGCONT'), 250)
    try {
      await waitForPostInitDelivery(child, messages, 100)
    } finally {
      clearTimeout(resume)
      child.kill('SIGCONT')
    }

    expect(channelMessages(messages).map((message) => message.params?.content)).toEqual([
      '<observer source="wt-wake-channel">delayed by scheduler starvation</observer>',
    ])
  })
})
