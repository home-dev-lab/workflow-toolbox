import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

// Reuse the synchronous resolver off the listener thread, including its bounded diagnostic commands.
// Each retry owns one short-lived worker; startup still detects before accepting connections.
export function detectTailnetInWorker(port) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { artifactTailnetPort: port } })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => reject(new Error(`tailnet detection worker exited without a result (${code})`)))
  })
}

if (!isMainThread && workerData?.artifactTailnetPort) {
  const { detectTailscale } = await import(new URL('./artifact-server.mjs', import.meta.url))
  parentPort.postMessage(detectTailscale(workerData.artifactTailnetPort))
}

function tailnetHost(host) {
  if (typeof host !== 'string') return false
  const hostname = host.toLowerCase().split(':', 1)[0]
  if (/^[a-z0-9.-]+\.ts\.net$/.test(hostname)) return true
  const octets = hostname.split('.').map(Number)
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
}

// The first eligible request retries immediately, even just after startup. Charge the attempt before
// detection, so failed attempts and concurrent requests cannot exceed one per minute.
export function createTailnetRetry({ detect, now = Date.now }) {
  let nextAttempt = -Infinity
  let inFlight = false
  return (tailscale, port, host) => {
    if (tailscale.dnsName || inFlight || !tailnetHost(host)) return null
    const at = now()
    if (at < nextAttempt) return null
    nextAttempt = at + 60_000
    inFlight = true
    return Promise.resolve().then(() => detect(port)).finally(() => { inFlight = false })
  }
}

export function formatTailnetStatus(state) {
  const detection = state.tailnetDetection
  const reason = detection?.reason ? ` (${detection.reason})` : ''
  const tailnet = detection ? `${detection.status}${reason}` : 'unknown (server predates tailnet detection status)'
  const via = typeof state.tailnetVia === 'string' ? state.tailnetVia : 'unknown'
  const binary = state.tailnetBinary ?? 'unknown'
  const routeKnown = state.tailnetServeUrl || /^https:\/\//.test(state.remoteUrl)
  const warning = detection?.status === 'unavailable' && routeKnown
    ? '\nremote links will fail (421): a Tailscale Serve route targets this port, but tailnet Host detection is unavailable'
    : ''
  return `tailnetDetection: ${tailnet}\ntailnetVia: ${via}\ntailnetBinary: ${binary}${warning}`
}
