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
  return (tailscale, port, host) => {
    if (tailscale.detection?.status !== 'unavailable' || !tailnetHost(host)) return null
    const at = now()
    if (at < nextAttempt) return null
    nextAttempt = at + 60_000
    return detect(port)
  }
}

export function formatTailnetStatus(state) {
  const detection = state.tailnetDetection
  const reason = detection?.reason ? ` (${detection.reason})` : ''
  const tailnet = detection ? `${detection.status}${reason}` : 'unknown (server predates tailnet detection status)'
  const via = typeof state.tailnetVia === 'string' ? state.tailnetVia : 'unknown'
  const binary = state.tailnetBinary ?? 'unknown'
  const routeKnown = state.tailnetServeUrl || state.remoteUrl
  const warning = detection?.status === 'unavailable' && routeKnown
    ? '\nremote links will fail (421): a Tailscale Serve route targets this port, but tailnet Host detection is unavailable'
    : ''
  return `tailnetDetection: ${tailnet}\ntailnetVia: ${via}\ntailnetBinary: ${binary}${warning}`
}
