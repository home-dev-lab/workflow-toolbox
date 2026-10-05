// Ownership declarations, not every tracker reference in a pilot's brief.
//
// Fences follow CommonMark: an opener is indented at most three spaces, and a backtick opener's
// info string holds no backtick (so a one-line ```code``` span opens nothing). A closer is a bare
// run of the opener's character, at least as long; anything else inside the fence is content.
const OPENER = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

function outsideFences(prompt) {
  if (typeof prompt !== 'string') return ''
  let fence = null
  return prompt.split(/\r?\n/).map(line => {
    if (fence) {
      const closer = CLOSER.exec(line)?.[1]
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) fence = null
      return ''
    }
    const opener = OPENER.exec(line)
    if (opener && !(opener[1][0] === '`' && opener[2].includes('`'))) {
      fence = opener[1]
      return ''
    }
    return line
  }).join('\n')
}

function declarations(text, prefix) {
  return text.split('\n').filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).trim())
}

export function pilotCardIds(prompt) {
  const text = outsideFences(prompt)
  const explicit = text.split('\n').flatMap(line => /^PILOT-CARDS?:\s*(.+)$/.exec(line)?.[1] || [])
    .flatMap(line => line.match(/(?<!\d)\d{19}(?!\d)/g) || [])
  if (explicit.length) return [...new Set(explicit)]
  const assignment = /\bpilot\s+for\b[^\n]{0,80}?\bcards?\b\D{0,20}?(?<!\d)(\d{19})(?!\d)/i.exec(text.slice(0, 400))
  return assignment ? [assignment[1]] : []
}

export function respawnOf(prompt) {
  return [...new Set(declarations(outsideFences(prompt), 'RESPAWN-OF:').flatMap(line => line.split(/[\s,]+/)).filter(Boolean))]
}

export function isPilotType(type) {
  return typeof type === 'string' && /(?:^|:)pilot(?:-lean)?$/.test(type)
}
