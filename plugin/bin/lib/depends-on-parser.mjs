// The default dependency convention for projects without a local parser, and the one
// triage rule the actionability gate and the what-next skill share.
// Table rows are deliberately excluded: their leading | is not decoration.
const DECORATION_RUN = /^(?:[`*_>#-]+\s*)+/

function declaringLines(description) {
  return String(description || '').split(/\r?\n/)
    .map((line) => ({ original: line.trim(), text: line.trim().replace(DECORATION_RUN, '') }))
    .filter(({ text }) => /^depends-on:/i.test(text))
}

export function hasDependsOnLine(description) {
  return declaringLines(description).length > 0
}

// Per comma segment: every `#<4+ digits>` outside parentheses; failing that, the first bare
// 4+-digit run outside parentheses (a board may write the id without `#`). A parenthesised title
// such as "(fix #2222 regression)" or "(title 2024)" never contributes an id.
function outsideParentheses(text) {
  let depth = 0
  let out = ''
  for (const char of text) {
    if (char === '(') depth += 1
    else if (char === ')' && depth > 0) depth -= 1
    else if (depth === 0) out += char
  }
  return out
}

// Takes a segment whose parenthesised text is already removed.
function segmentIds(segment) {
  const hashed = [...segment.matchAll(/#(\d{4,})/g)].map((match) => match[1])
  if (hashed.length > 0) return hashed
  const bare = segment.match(/(\d{4,})/)
  return bare ? [bare[1]] : []
}

export function parseDependsOn(description) {
  const ids = new Set()
  const unparseable = []
  for (const { original, text } of declaringLines(description)) {
    // `**Depends-on:** none` leaves the closing emphasis in front of the value.
    const remainder = text.slice('Depends-on:'.length).replace(/^[\s`*_]+/, '')
    if (/^none\b/i.test(remainder)) continue
    let found = false
    // Parentheses go first: a comma inside a title must never split it into a segment of its own.
    for (const segment of outsideParentheses(remainder).split(',')) {
      for (const id of segmentIds(segment)) { ids.add(id); found = true }
    }
    if (!found) unparseable.push(original)
  }
  return { ids: [...ids], unparseable }
}

// A card with no declaring line is a blind spot: it goes to notChecked, never dropped and never
// recommended. `Depends-on: none`, or every named dependency in doneIds, is recommendable.
// resolveDeps lets a project's own parser supply the ids; the declaring-line check stays shipped.
export function triageCardDependencies(cards, doneIds, resolveDeps = parseDependsOn) {
  const done = doneIds instanceof Set ? doneIds : new Set(doneIds)
  const recommendable = []
  const notChecked = []
  const blocked = []
  for (const card of cards) {
    if (!hasDependsOnLine(card.description)) {
      notChecked.push(card)
      continue
    }
    const { ids, unparseable } = resolveDeps(card.description || '')
    if (unparseable.length === 0 && ids.every((id) => done.has(id))) recommendable.push(card)
    else blocked.push(card)
  }
  return { recommendable, notChecked, blocked }
}
