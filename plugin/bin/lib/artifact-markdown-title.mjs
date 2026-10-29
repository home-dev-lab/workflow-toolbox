const INLINE_TOKEN = /\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]|`+|!?\[([^\]\n]*)\](?:\((?:[^()\n]|\([^()\n]*\))*\)|\[[^\]\n]*\])|\*+|_+/g

// Index whole backtick runs once: unmatched long runs must not trigger repeated searches.
function inlineTokens(value) {
  const tokens = [...value.matchAll(INLINE_TOKEN)]
  const next = new Map()
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]
    if (token[0][0] !== '`') continue
    token.close = next.get(token[0])
    next.set(token[0], i)
  }
  return tokens
}

function emphasisEdges(value, token) {
  const before = value[token.index - 1] ?? ''
  const after = value[token.index + token[0].length] ?? ''
  if (token[0][0] === '_' && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return [false, false]
  return [/\S/.test(after), /\S/.test(before)]
}

function appendEmphasis(value, token, output, open) {
  const [canOpen, canClose] = emphasisEdges(value, token)
  const previous = open.get(token[0])
  const index = output.length
  output.push(token[0])
  if (canClose && previous !== undefined) {
    output[previous] = ''
    output[index] = ''
    open.delete(token[0])
  } else if (canOpen) open.set(token[0], index)
}

function appendInline(value, token, output, open) {
  if (/^\\/.test(token[0])) output.push(token[0].slice(1))
  else if (token[1] !== undefined) output.push(plainInline(token[1]))
  else if (token[0][0] === '`') output.push(token[0])
  else appendEmphasis(value, token, output, open)
}

function plainInline(value) {
  const tokens = inlineTokens(value), output = [], open = new Map()
  let offset = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    output.push(value.slice(offset, token.index))
    if (token.close !== undefined) {
      const closing = tokens[token.close]
      output.push(value.slice(token.index + token[0].length, closing.index))
      i = token.close
      offset = closing.index + closing[0].length
    } else {
      appendInline(value, token, output, open)
      offset = token.index + token[0].length
    }
  }
  output.push(value.slice(offset))
  return output.join('')
}

function closesFence(marker, fence) {
  return marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === ''
}

function opensFence(marker) {
  if (!marker) return false
  return marker[1][0] !== '`' || !marker[2].includes('`')
}

export function markdownTitle(source, fallback) {
  let fence = null
  for (const line of source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (closesFence(marker, fence)) fence = null
      continue
    }
    if (opensFence(marker)) { fence = marker[1]; continue }
    const heading = /^ {0,3}#{1,6}(?:[\t ]+(.*)|$)/.exec(line)
    if (heading) {
      const text = plainInline((heading[1] ?? '').replace(/(?:^|\s)#+\s*$/, '')).trim()
      if (text) return [...text].slice(0, 120).join('')
    }
  }
  return fallback
}
