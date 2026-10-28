import { createHash } from 'node:crypto'

export const MERMAID_PATH = '/__wt-artifact-server/mermaid.min.js'
export const MERMAID_FILE = new URL('../../skills/artifact-server/assets/mermaid/mermaid.min.js', import.meta.url)
const MERMAID_INIT = "mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'strict' });"
const INIT_HASH = createHash('sha256').update(MERMAID_INIT).digest('base64')

export function markdownFenceTag(line, fence) {
  if (fence.open) {
    fence.open = false
    return fence.mermaid ? '</pre>' : '</code></pre>'
  }
  fence.open = true
  fence.mermaid = line === '```mermaid'
  fence.hasMermaid ||= fence.mermaid
  return fence.mermaid ? '<pre class="mermaid">' : '<pre><code>'
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
