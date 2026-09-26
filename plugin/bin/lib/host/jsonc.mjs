// JSON with comments and trailing commas (the OpenCode config format). String-aware: a comment
// marker or a comma inside a string literal (a URL, typically) is content. Returns null on any parse
// failure, never throws: callers treat an unreadable config as "names nothing". Characters are
// compared by code: these are grammar tokens of JSONC, not path separators.

const QUOTE = 0x22
const ESCAPE = 0x5c
const SLASH = 0x2f
const STAR = 0x2a
const NEWLINE = 0x0a
const COMMA = 0x2c
const CLOSERS = /^\s*[}\]]/
const SUBSTITUTION = /^\{(?:env|file):/
const BYTE_ORDER_MARK = 0xfeff

// One pass: strings are copied whole, comments dropped, and a comma followed only by whitespace and
// a closing brace or bracket dropped.
function toJson(text) {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    const next = text.charCodeAt(cursor + 1)
    if (code === QUOTE) {
      let end = cursor + 1
      while (end < text.length && text.charCodeAt(end) !== QUOTE) end += text.charCodeAt(end) === ESCAPE ? 2 : 1
      out += text.slice(cursor, end + 1)
      cursor = end + 1
    } else if (SUBSTITUTION.test(text.slice(cursor, cursor + 7))) {
      // An UNQUOTED {env:VAR} or {file:path} is legal for OpenCode, which substitutes text before
      // parsing; its value is unknown here, so it reads as null (never a host, never a model).
      const end = text.indexOf('}', cursor)
      out += 'null'
      cursor = end < 0 ? text.length : end + 1
    } else if (code === SLASH && next === SLASH) {
      while (cursor < text.length && text.charCodeAt(cursor) !== NEWLINE) cursor += 1
    } else if (code === SLASH && next === STAR) {
      cursor += 2
      while (cursor < text.length && !(text.charCodeAt(cursor) === STAR && text.charCodeAt(cursor + 1) === SLASH)) cursor += 1
      cursor += 2
    } else {
      if (!(code === COMMA && CLOSERS.test(stripLeadingComments(text.slice(cursor + 1))))) out += text[cursor]
      cursor += 1
    }
  }
  return out
}

// Comments between a trailing comma and its closer (`, // note\n}`) must not hide the closer.
function stripLeadingComments(rest) {
  const trimmed = rest.trimStart()
  if (trimmed.charCodeAt(0) !== SLASH) return trimmed
  if (trimmed.charCodeAt(1) === SLASH) {
    const newline = trimmed.indexOf('\n')
    return newline < 0 ? '' : stripLeadingComments(trimmed.slice(newline))
  }
  if (trimmed.charCodeAt(1) === STAR) {
    const end = trimmed.indexOf(String.fromCharCode(STAR, SLASH), 2)
    return end < 0 ? '' : stripLeadingComments(trimmed.slice(end + 2))
  }
  return trimmed
}

export function parseJsonc(text) {
  if (typeof text !== 'string') return null
  const body = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text
  try { return JSON.parse(toJson(body)) } catch { return null }
}
