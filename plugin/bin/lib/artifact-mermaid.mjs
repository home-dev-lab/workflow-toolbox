import { createHash } from 'node:crypto'

export const MERMAID_PATH = '/__wt-artifact-server/mermaid.min.js'
export const MERMAID_FILE = new URL('../../skills/artifact-server/assets/mermaid/mermaid.min.js', import.meta.url)
const MERMAID_INIT = "mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'strict' });"
const INIT_HASH = createHash('sha256').update(MERMAID_INIT).digest('base64')

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

// CommonMark fences: a block closes only on the same character, at least as long, with nothing after it, so a
// Mermaid example quoted inside a longer or tilde fence stays text. Returns null when the line is not a boundary.
export function markdownFenceTag(line, fence) {
  const match = FENCE.exec(line)
  if (fence.open) {
    if (!match || match[1][0] !== fence.marker[0] || match[1].length < fence.marker.length || match[2].trim() !== '') return null
    return closeMarkdownFence(fence)
  }
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null
  fence.open = true
  fence.marker = match[1]
  fence.mermaid = line === '```mermaid'
  fence.hasMermaid ||= fence.mermaid
  return fence.mermaid ? '<pre class="mermaid">' : '<pre><code>'
}

export function closeMarkdownFence(fence) {
  fence.open = false
  return fence.mermaid ? '</pre>' : '</code></pre>'
}

export function markdownScripts({ html, hasMermaid }, { depth, generatedCsp }) {
  if (!hasMermaid) return { html, csp: generatedCsp }
  // 'self', not an exact host path: behind a path-mounted proxy (tailscale serve /artifacts) the browser sees a
  // prefixed path an exact path never matches. Rendered Markdown escapes HTML, so only these two tags run.
  const csp = `${generatedCsp}; script-src 'self' 'sha256-${INIT_HASH}'; connect-src 'none'; object-src 'none'; frame-ancestors 'none'`
  const source = `${'../'.repeat(depth)}${MERMAID_PATH.slice(1)}`
  const scripts = `<script src="${source}"></script><script>${MERMAID_INIT}</script>`
  return { html: html.replace('</body></html>', () => `${scripts}</body></html>`), csp }
}
