// standing-authorizations.mjs — deterministic reader for an adopted project's owner-granted acts.

const LINE = /^-\s+(.+?)\s+—\s+when\s+(.+?)\s+—\s+never\s+(.+?)\s+—\s+given\s+(.+?)\s*$/i

/** Parse complete, attributable authorization lines and refuse incomplete prose. */
export function parseAuthorizations(text) {
  if (typeof text !== 'string') return []
  const list = []
  for (const raw of text.split(/\r?\n/)) {
    const match = LINE.exec(raw)
    if (!match) continue
    const [, act, condition, exclusion, given] = match
    if (!act || !condition || !exclusion || !given) continue
    list.push({ act, condition, exclusion, given, raw })
  }
  return list
}

function words(text) {
  return String(text).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** Return the first authorization whose act words all occur in the supplied description. */
export function findAuthorization(list, description) {
  if (!Array.isArray(list) || typeof description !== 'string') return null
  const descriptionWords = new Set(words(description))
  return list.find(({ act }) => {
    const actWords = words(act)
    return actWords.length > 0 && actWords.every((word) => descriptionWords.has(word))
  }) ?? null
}
