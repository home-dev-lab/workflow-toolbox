import { mkdirSync, readdirSync, readFileSync, renameSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const spool =
  process.env.WT_WAKE_SPOOL ||
  join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'wt-wake-channel',
    'inbox',
  )
const consumed = join(spool, 'consumed')
// ⚠ 60s, not 5s, and the number changed because the ROLE changed. While polling was the only
// way a message was noticed, the cadence WAS the latency. Now `fs.watch` carries the normal case
// and this interval is only the floor under a dropped event, so a short cadence would buy almost
// nothing and cost a wakeup twelve times a minute for a session's entire life.
const configuredPollMs = Number(process.env.WT_WAKE_POLL_MS || 60_000)
const pollMs = Number.isFinite(configuredPollMs) && configuredPollMs > 0 ? configuredPollMs : 60_000
const debugEnabled = Boolean(process.env.WT_WAKE_DEBUG)

let initialized = false
let input = Buffer.alloc(0)

function debug(error) {
  if (!debugEnabled) return
  try {
    process.stderr.write(`[wt-wake-channel] ${error instanceof Error ? error.message : String(error)}\n`)
  } catch {
    // Diagnostics must never become another way for the supervision channel to fail.
  }
}

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch (error) {
    debug(error)
  }
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function methodNotFound(id) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found' },
  })
}

function drain() {
  if (!initialized) return

  let names
  try {
    mkdirSync(consumed, { recursive: true })
    names = readdirSync(spool)
      .filter((name) => name.endsWith('.txt'))
      .sort()
  } catch (error) {
    // A broken spool is deliberately silent: supervision must never take down its host session.
    debug(error)
    return
  }

  for (const name of names) {
    const source = join(spool, name)
    const destination = join(consumed, name)
    let body
    try {
      body = readFileSync(source, 'utf8')
      // Move before emitting: losing one wake is preferable to replaying it after a crash.
      renameSync(source, destination)
    } catch (error) {
      debug(error)
      continue
    }

    const content = body.trim()
    if (!content) continue
    send({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: {
        content: `<observer source="wt-wake-channel">${content}</observer>`,
      },
    })
  }
}

function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return

  const isRequest = Object.prototype.hasOwnProperty.call(message, 'id')
  if (message.method === 'initialize' && isRequest) {
    reply(message.id, {
      protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      serverInfo: { name: 'wt-wake-channel', version: '0.1.0' },
    })
    return
  }

  if (message.method === 'notifications/initialized' && !isRequest) {
    initialized = true
    drain()
    return
  }

  if (message.method === 'tools/list' && isRequest) {
    reply(message.id, { tools: [] })
    return
  }

  if (typeof message.method === 'string' && isRequest) methodNotFound(message.id)
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  while (true) {
    const newline = input.indexOf('\n')
    if (newline === -1) break
    const line = input.toString('utf8', 0, newline).replace(/\r$/, '')
    input = input.subarray(newline + 1)
    try {
      handleMessage(JSON.parse(line))
    } catch (error) {
      debug(error)
    }
  }
})

process.stdin.on('error', debug)
process.stdout.on('error', debug)

try {
  mkdirSync(consumed, { recursive: true })
} catch (error) {
  // A broken spool is deliberately silent: supervision must never take down its host session.
  debug(error)
}

// Event-driven first, slow poll as a BACKSTOP — not the other way round.
//
// A five-second poll was the original design and it is the wrong instrument twice over: it adds
// up to five seconds of latency to every wake, and it burns a wakeup every five seconds for the
// overwhelming majority of a session's life, during which the spool is empty.
//
// ⚠ `fs.watch` cannot simply REPLACE it, and the reason is the cross-platform verdict this repo
// requires. The three platforms this ships to do not agree:
//   Linux   — inotify. Reliable for this use, but the watch is lost if the directory is
//             replaced (deleted and recreated) rather than written into.
//   macOS   — FSEvents. Coalesces rapid events; a burst can surface as one.
//   Windows — ReadDirectoryChangesW. Documented to drop events under load, and rename
//             semantics differ.
// On every one of them a missed event is SILENT — indistinguishable from an empty spool, which
// is the failure shape this whole channel exists to avoid. So the poll stays, at a cadence where
// it costs nothing (default 60s) and serves only as the floor under a watch that may miss.
//
// The result: a normal wake arrives in milliseconds via the watch; a wake whose event was
// dropped still arrives, at worst one backstop period late, instead of never.
let watcher = null
try {
  watcher = watch(spool, { persistent: false }, () => {
    try {
      drain()
    } catch (error) {
      debug(error)
    }
  })
  watcher.on('error', (error) => {
    // A watch that dies must not take the backstop with it — the interval below keeps running,
    // so the channel degrades to the old polling behaviour rather than going deaf.
    debug(error)
  })
} catch (error) {
  // No watch available (the spool may not exist yet, or the platform refused): the backstop alone
  // is a correct, slower channel. Never fatal.
  debug(error)
}

setInterval(drain, pollMs).unref?.()
