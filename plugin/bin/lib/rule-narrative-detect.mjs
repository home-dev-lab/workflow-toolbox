// Pure detection; line-multiset subtraction intentionally ignores reordering and
// fence/comment removal. Line numbers refer to the original replacement text,
// concatenated in edit order for MultiEdit, not the filtered set of new lines.
const ALLOW_MARKER = '<!-- rule-lint: allow -->'
const DMY = /\b(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])(?:\/\d{2,4})?\b/g
const ISO = /\b\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g
const PEOPLE = ['Frederic', 'Frédéric']
const NARRATIVE = ['standing instruction from', 'stated by', 'his own preference',
  'that evening', 'one evening', 'the night of']
const MONTHS_EN = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const MONTHS_FR = 'janv(?:ier)?|f[ée]vr?(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|sept(?:embre)?|oct(?:obre)?|nov(?:embre)?|d[ée]c(?:embre)?'
const MONTH = `(?:${MONTHS_EN}|${MONTHS_FR})`
const DAY = '(?:[12]\\d|3[01]|0?[1-9])(?:st|nd|rd|th|er)?'
const MONTH_DATE = new RegExp(`(?<![\\p{L}\\d])(?:${DAY}\\s+${MONTH}\\.?(?:\\s+\\d{4})?|${MONTH}\\.?\\s+\\d{4}|${MONTH}\\.?\\s+${DAY}(?:,?\\s+\\d{4})?)(?![\\p{L}\\d])`, 'giu')
const MESSAGE_ID = /(?<![\w&/#:])#[1-9]\d{2,4}(?![\w-])/g
const PAREN = /\([^()\n]*(?:\)|$)/g
const TIME = /\b(?:[01]?\d|2[0-3])[:h][0-5]\d\b/i
const YEAR = /\b(?:19|20)\d{2}\b/
const ATTRIBUTION = /\b(?:said|asked|decided|reported)\b/i
const INCIDENT = /\b(?:measured here|it happened|field case|last night|yesterday|earlier today|this morning|hier|ce matin|cette nuit|cas fondateur)\b/giu

function textChunks(tool, input, currentText) {
  if (tool === 'Edit') return [{ text: input?.new_string, old: input?.old_string }]
  if (tool === 'Write') return [{ text: input?.content, old: currentText }]
  if (tool !== 'MultiEdit' || !Array.isArray(input?.edits)) return []
  return input.edits.map((edit) => ({ text: edit?.new_string, old: edit?.old_string }))
}

function subtractLines(chunk, offset) {
  const old = new Map()
  if (typeof chunk.old === 'string') {
    for (const line of chunk.old.split(/\r?\n/)) old.set(line, (old.get(line) ?? 0) + 1)
  }
  const source = chunk.text.split(/\r?\n/)
  const lines = []
  for (const [index, text] of source.entries()) {
    const count = old.get(text) ?? 0
    if (count > 0) { old.set(text, count - 1); continue }
    lines.push({ text, lineNumber: offset + index + 1,
      context: [source[index - 1], source[index + 1]].filter((line) => line !== undefined) })
  }
  return { lines, length: source.length }
}

export function addedLines({ tool, input, currentText = null }) {
  let offset = 0
  const lines = []
  for (const chunk of textChunks(tool, input, currentText)) {
    if (typeof chunk.text !== 'string') continue
    const result = subtractLines(chunk, offset)
    for (const line of result.lines) lines.push(line)
    offset += result.length
  }
  return lines
}

function lineSnippet(line) {
  return line.slice(0, 90)
}

function pushRegexViolations(violations, detector, regex, line, lineNumber) {
  regex.lastIndex = 0
  for (const match of line.matchAll(regex)) {
    violations.push({ detector, match: match[0], lineNumber, snippet: lineSnippet(line) })
  }
}

function pushPhraseViolations(violations, detector, phrases, line, lineNumber) {
  for (const phrase of phrases) {
    let start = 0
    while (start < line.length) {
      const index = line.indexOf(phrase, start)
      if (index === -1) break
      violations.push({ detector, match: phrase, lineNumber, snippet: lineSnippet(line) })
      start = index + phrase.length
    }
  }
}

function isWordChar(char) {
  return typeof char === 'string' && /[\p{L}\p{N}_]/u.test(char)
}

function pushWordViolations(violations, detector, phrases, line, lineNumber) {
  for (const phrase of phrases) {
    let start = 0
    while (start < line.length) {
      const index = line.indexOf(phrase, start)
      if (index === -1) break
      const before = index === 0 ? '' : line[index - 1]
      const after = index + phrase.length >= line.length ? '' : line[index + phrase.length]
      if (!isWordChar(before) && !isWordChar(after)) {
        violations.push({ detector, match: phrase, lineNumber, snippet: lineSnippet(line) })
      }
      start = index + phrase.length
    }
  }
}

function denyFindings(line, lineNumber, honorMarker) {
  const violations = []
  if (honorMarker && line.includes(ALLOW_MARKER)) return violations
  pushRegexViolations(violations, 'DATE (DMY)', DMY, line, lineNumber)
  pushRegexViolations(violations, 'DATE (ISO)', ISO, line, lineNumber)
  pushWordViolations(violations, 'PEOPLE', PEOPLE, line, lineNumber)
  pushPhraseViolations(violations, 'NARRATIVE', NARRATIVE, line, lineNumber)
  return violations.map((finding) => ({ ...finding, tier: 'deny' }))
}

function datedAttributions(violations, line, lineNumber) {
  for (const match of line.matchAll(PAREN)) {
    MONTH_DATE.lastIndex = 0
    if (TIME.test(match[0]) || YEAR.test(match[0]) || MONTH_DATE.test(match[0])) {
      violations.push({ detector: 'DATED ATTRIBUTION', match: match[0], lineNumber, snippet: lineSnippet(line) })
    }
  }
  if (TIME.test(line) && ATTRIBUTION.test(line) && !violations.some((finding) => finding.detector === 'DATED ATTRIBUTION')) {
    violations.push({ detector: 'DATED ATTRIBUTION', match: line, lineNumber, snippet: lineSnippet(line) })
  }
}

function warnFindings(line, lineNumber) {
  const violations = []
  pushRegexViolations(violations, 'DATE (MONTH)', MONTH_DATE, line, lineNumber)
  pushRegexViolations(violations, 'MESSAGE ID', MESSAGE_ID, line, lineNumber)
  datedAttributions(violations, line, lineNumber)
  pushRegexViolations(violations, 'INCIDENT', INCIDENT, line, lineNumber)
  return violations.map((finding) => ({ ...finding, tier: 'warn' }))
}

export function detectNarrative(lines, { honorMarker = true } = {}) {
  const findings = []
  for (const { text, lineNumber } of lines) {
    if (!text) continue
    for (const finding of denyFindings(text, lineNumber, honorMarker)) findings.push(finding)
    for (const finding of warnFindings(text, lineNumber)) findings.push(finding)
  }
  return findings
}
