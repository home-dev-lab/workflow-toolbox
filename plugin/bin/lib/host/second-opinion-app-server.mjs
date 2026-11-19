// Minimal client for Codex's public newline-delimited app-server JSON-RPC protocol.
// Inlined into the sandbox bridge: no companion implementation/API is imported.
export async function openAppServer(notify, dependencies = {}) {
  const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = await import('node:child_process')
  const { spawn = defaultSpawn, spawnSync = defaultSpawnSync, platform = process.platform, env = process.env } = dependencies
  const { createInterface } = await import('node:readline')
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    shell: platform === 'win32' ? (env.SHELL || true) : false })
  let stopped = false
  // A raw PID can be reused after exit: stop at most once, and never an exited child.
  const stop = () => {
    if (stopped || child.exitCode != null || child.signalCode != null) return
    stopped = true
    stopAppServer(child, platform, spawnSync)
  }
  process.once('exit', stop)
  process.once('SIGTERM', stop)
  const pending = new Map()
  let nextId = 0
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const closed = new Promise((resolve) => child.once('close', () => {
    process.removeListener('exit', stop)
    process.removeListener('SIGTERM', stop)
    resolve()
  }))
  const fail = (error) => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    notify({ method: 'wt/transport-error', error })
  }
  child.once('error', fail)
  child.once('exit', () => fail(new Error('app-server exited before completion')))
  child.stdin.on('error', fail)
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return } // Diagnostics are never completion evidence.
    dispatchAppServerMessage(message, pending, send, notify)
  })
  return {
    request(method, params) {
      const id = ++nextId
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ id, method, params }) })
    },
    send,
    async close() { child.stdin.end(); stop(); await closed },
  }
}

function stopAppServer(child, platform, spawnSync) {
  if (platform !== 'win32') { child.kill('SIGTERM'); return }
  // The shell is the direct child on Windows; killing it alone leaves Codex alive.
  if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}

function dispatchAppServerMessage(message, pending, send, notify) {
  if (!message || typeof message !== 'object') return
  if (message.method) {
    // Read-only turns must never approve server-initiated execution requests.
    if (Object.hasOwn(message, 'id')) send({ id: message.id, error: { code: -32601, message: 'second-opinion is read-only' } })
    else notify(message)
    return
  }
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
}

function terminalTurnCollector() {
  const queued = []
  const state = { threadId: null, turnId: null, answer: '', failed: false, error: null, done: false }
  let resolve, reject
  const completion = new Promise((yes, no) => { resolve = yes; reject = no })
  // A transport failure can precede the first awaited request.
  completion.catch(() => {})
  const observe = (message) => {
    if (state.done) return
    if (message.method === 'wt/transport-error') { state.done = true; reject(message.error); return }
    if (!state.turnId) { queued.push(message); return }
    applyTerminalNotification(state, message, resolve)
  }
  return { completion, observe, start(threadId, turnId) {
    if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId) throw new Error('app-server turn identity unavailable')
    state.threadId = threadId
    state.turnId = turnId
    for (const message of queued.splice(0)) observe(message)
  } }
}

function finalAnswer(item) {
  return item?.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string' ? item.text : null
}

function applyTerminalNotification(state, message, resolve) {
  const params = message.params
  if (params?.threadId !== state.threadId) return
  if (message.method === 'turn/completed') {
    if (params.turn?.id !== state.turnId) return
    completeTerminalTurn(state, params.turn, resolve)
    return
  }
  if (params.turnId !== state.turnId) return
  if (message.method === 'error') {
    state.failed = true
    state.error = params.error
  }
  if (message.method === 'item/completed') state.answer = finalAnswer(params.item) ?? state.answer
}

function completeTerminalTurn(state, turn, resolve) {
  for (const item of turn.items ?? []) state.answer = finalAnswer(item) ?? state.answer
  state.done = true
  resolve({ turn, answer: state.answer, failed: state.failed, error: state.error })
}

function requireCleanTerminal(terminal) {
  if (terminal.failed || terminal.turn.error != null || terminal.turn.status !== 'completed'
    || !terminal.answer.trim()) throw Object.assign(
    new Error(`Astra turn error: ${JSON.stringify(terminal.error ?? terminal.turn.error ?? terminal.turn.status)}`), { answer: terminal.answer })
}

export async function publicAstraTurn(effort, prompt) {
  const collector = terminalTurnCollector()
  const client = await openAppServer(collector.observe)
  try {
    await client.request('initialize', { clientInfo: { name: 'workflow-toolbox', version: '1' }, capabilities: {} })
    client.send({ method: 'initialized', params: {} })
    const thread = await client.request('thread/start', {
      cwd: process.cwd(), model: 'gpt-6-astra', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false,
    })
    const result = await client.request('turn/start', {
      threadId: thread?.thread?.id, model: 'gpt-6-astra', effort,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    })
    collector.start(thread?.thread?.id, result?.turn?.id)
    const terminal = await collector.completion
    requireCleanTerminal(terminal)
    return terminal.answer
  } finally {
    await client.close()
  }
}

export const appServerSource = [openAppServer, stopAppServer, dispatchAppServerMessage, terminalTurnCollector,
  finalAnswer, applyTerminalNotification, completeTerminalTurn, requireCleanTerminal, publicAstraTurn].map((fn) => fn.toString()).join('\n')
