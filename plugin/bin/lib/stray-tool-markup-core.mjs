// Pure line detector. Only a closed fence grants an exemption.
const TAGS = [
  [/^<\/(?:[A-Za-z_][\w-]*:)?content>$/, 'content-close'],
  [/^<\/(?:[A-Za-z_][\w-]*:)?invoke>$/, 'invoke-close'],
  [/^<(?:[A-Za-z_][\w-]*:)?parameter name=/, 'parameter-open'],
]

function trimMarkupLine(text) {
  let end = text.length
  while (end > 0 && ' \t\r'.includes(text[end - 1])) end--
  return text.slice(0, end)
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

// A closing line: same fence character, at least as long as the opening run,
// at most three spaces of indentation, nothing after it but whitespace.
function closesFence(line, opening) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(line)
  return Boolean(match) && match[1][0] === opening[0] && match[1].length >= opening.length
}

function closedFenceLines(lines) {
  const exempt = new Set()
  let opening = null
  for (let i = 0; i < lines.length; i++) {
    if (!opening) {
      const match = FENCE_OPEN.exec(lines[i])
      if (match) opening = { line: i, token: match[1] }
    } else if (closesFence(lines[i], opening.token)) {
      for (let j = opening.line; j <= i; j++) exempt.add(j)
      opening = null
    }
  }
  return exempt
}

export function findStrayToolMarkup(text) {
  if (typeof text !== 'string') return []
  const lines = text.split('\n')
  const exempt = closedFenceLines(lines)
  return lines.flatMap((raw, index) => {
    if (exempt.has(index)) return []
    const line = trimMarkupLine(raw)
    const tag = TAGS.find(([pattern]) => pattern.test(line))
    return tag ? [{ line: index + 1, kind: tag[1] }] : []
  })
}
