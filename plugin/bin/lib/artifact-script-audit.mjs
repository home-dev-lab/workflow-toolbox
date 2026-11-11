// Textual diagnostics only: the response CSP remains the authority.
export function htmlModeOf(text) {
  const prefix = new TextDecoder().decode(new TextEncoder().encode(text.slice(0, 256)).subarray(0, 256))
  return /^\s*<!--\s*wt-artifact-server:\s*(rich|annotatable|interactive)\s*-->/i.exec(prefix)?.[1].toLowerCase() ?? 'raw'
}

// A doubled slash or backslash is protocol-relative to the browser's URL parser.
const ABSOLUTE_URL = /^(?:https?:|data:|blob:|[\\/]{2})/i
// HTML's JavaScript MIME types, plus `module` and the empty type; any other type is a data block.
const EXECUTABLE_TYPE = /^(?:|module|(?:text|application)\/(?:x-)?(?:javascript|ecmascript)|text\/javascript1\.[0-5]|text\/(?:jscript|livescript))$/i
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"`])([^'"`\r\n]*)\1/g
const STATIC_IMPORT = /\b(?:from\s*|import\s*)(['"`])([^'"`\r\n]*)\1/g
const MERMAID_KIND = 'Mermaid diagram renderings (the diagrams show as source text)'

// `allowedOrigins` holds the origin of the URL being handed out: CSP 'self' is that document's origin only.
function blockedUrl(specifier, mode, allowedOrigins) {
  if (mode !== 'interactive') return true
  if (!ABSOLUTE_URL.test(specifier)) return false
  try {
    // Protocol-relative URLs inherit the origin's scheme.
    return !allowedOrigins.some((origin) => new URL(specifier, origin).origin === origin)
  } catch { return true }
}

function addFinding(audit, kind, sample) {
  const previous = audit.findings.find((finding) => finding.kind === kind)
  if (previous) previous.count += 1
  else audit.findings.push({ kind, count: 1, sample: sample.slice(0, 120) })
}

function auditImports(audit, text, pattern) {
  for (const match of text.matchAll(pattern)) {
    const specifier = match[2].trim()
    if (blockedUrl(specifier, audit.mode, audit.allowedOrigins)) addFinding(audit, 'imports', specifier)
  }
}

// HTML attribute tokens: a name, then an optional double-quoted, single-quoted or unquoted value.
const ATTRIBUTE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g

// Attribute names lower-cased to their first value, the way the HTML parser keeps the first duplicate.
function attributesOf(text) {
  const attributes = new Map()
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase()
    if (!attributes.has(name)) attributes.set(name, (match[2] ?? match[3] ?? match[4] ?? '').trim())
  }
  return attributes
}

function auditScript(audit, attributeText, body) {
  const attributes = attributesOf(attributeText)
  if (attributes.has('type') && !EXECUTABLE_TYPE.test(attributes.get('type'))) return
  if (attributes.has('src')) {
    const src = attributes.get('src')
    if (blockedUrl(src, audit.mode, audit.allowedOrigins)) addFinding(audit, 'script sources', src)
    return
  }
  if (audit.mode === 'raw' || audit.mode === 'annotatable') addFinding(audit, 'inline scripts', body)
  // A static import is a SyntaxError outside a module script, so only a module's text can hold one.
  if (/^module$/i.test(attributes.get('type') ?? '')) auditImports(audit, body, STATIC_IMPORT)
  auditImports(audit, body, DYNAMIC_IMPORT)
}

// Attribute values that run as script: event handlers, and javascript: URLs in URL attributes.
function executableAttribute(name, value) {
  return name.startsWith('on') || (/^(?:href|src|action|formaction)$/.test(name) && /^\s*javascript:/i.test(value))
}

// Any other start tag: executable attributes can import; a mermaid class token marks a diagram.
function auditTag(audit, tag) {
  const attributes = attributesOf(tag.replace(/^[^\s/>]*/, ''))
  for (const [name, value] of attributes) {
    if (executableAttribute(name, value)) auditImports(audit, value, DYNAMIC_IMPORT)
  }
  if (/(?:^|\s)mermaid(?:\s|$)/.test(attributes.get('class') ?? '')) audit.diagrams += 1
}

// Returns the position after the script element opened at `tagEnd`; its body runs to `</script` or the end.
function scanScript(audit, html, tag, tagEnd) {
  const closing = /<\/script\b/gi
  closing.lastIndex = tagEnd + 1
  const end = closing.exec(html)?.index ?? html.length
  auditScript(audit, tag.slice('script'.length), html.slice(tagEnd + 1, end))
  const close = html.indexOf('>', end)
  return close === -1 ? html.length : close + 1
}

// One left-to-right pass: a comment (`<!-->` included) hides what it holds, script text is never markup.
function scanDocument(audit, html) {
  let position = 0
  for (let lt = html.indexOf('<'); lt !== -1; lt = html.indexOf('<', position)) {
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 2)
      if (end === -1) return
      position = end + 3
      continue
    }
    // A '<' not followed by a letter, '/' or '!' opens no tag: the browser keeps it as text.
    if (!/[A-Za-z/!]/.test(html[lt + 1] ?? '')) { position = lt + 1; continue }
    const tagEnd = html.indexOf('>', lt + 1)
    if (tagEnd === -1) return
    const tag = html.slice(lt + 1, tagEnd)
    if (/^script(?=[\s/]|$)/i.test(tag)) position = scanScript(audit, html, tag, tagEnd)
    else { auditTag(audit, tag); position = tagEnd + 1 }
  }
}

export function blockedScriptFindings(html, mode, { allowedOrigins = [] } = {}) {
  const audit = { mode, allowedOrigins, findings: [], diagrams: 0 }
  scanDocument(audit, html)
  if (audit.findings.length && audit.diagrams) {
    audit.findings.push({ kind: MERMAID_KIND, count: audit.diagrams, sample: 'mermaid' })
  }
  return audit.findings
}

export function scriptWarning(basename, mode, finding) {
  const remedy = mode === 'interactive'
    ? 'Self-host scripts under a registered root; the bundled Mermaid URL is __wt-artifact-server/mermaid.min.js (<!-- wt-artifact-server: interactive --> permits same-origin scripts).'
    : 'For a page you wrote and trust, put <!-- wt-artifact-server: interactive --> on its first line, or <!-- wt-artifact-server: rich --> for inline scripts only.'
  return `warning: ${basename} is served in ${mode} mode; its CSP blocks ${finding.count} ${finding.kind}. ${remedy} (Best-effort text check: the CSP header decides.)`
}
