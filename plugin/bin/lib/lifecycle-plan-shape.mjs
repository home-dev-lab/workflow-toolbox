export const PLAN_SHAPE = Object.freeze({
  adrHeading: 'ADR',
  adrTerms: Object.freeze(['Decision', 'Rejected']),
  tasksHeading: 'Tasks',
  taskDodLabels: Object.freeze(['DoD', 'Definition of done']),
  gatesHeading: 'Gates',
  acceptanceHeading: 'Acceptance',
  cardTermsHeading: 'Card terms: reading chosen',
  qualityHeading: 'Quality coverage',
  qualityLabels: Object.freeze(['Changed artefacts', 'Seams']),
  stateHeading: 'State and recovery',
  stateLabels: Object.freeze(['Ownership', 'Writers', 'Terminal paths', 'Published data']),
})

export const CARD_TERMS_HEADING = PLAN_SHAPE.cardTermsHeading

function describedLabels(labels, separator) {
  return labels.map((label) => `\`${label}:\``).join(separator)
}

export const PLAN_SHAPE_DESCRIPTION = `a \`## ${PLAN_SHAPE.adrHeading}\` section containing ${PLAN_SHAPE.adrTerms.join(' and ')}, a \`## ${PLAN_SHAPE.tasksHeading}\` section whose every item (a column-0 \`- \` / \`1. \` line, or a \`### \` heading with no such line under it) has ${describedLabels(PLAN_SHAPE.taskDodLabels, ' or ')}, a non-empty \`## ${PLAN_SHAPE.gatesHeading}\` section, a \`## ${PLAN_SHAPE.qualityHeading}\` section with non-empty ${describedLabels(PLAN_SHAPE.qualityLabels, ' and ')} lines (\`${PLAN_SHAPE.qualityLabels[1]}: none: <reason>\` is allowed), a \`## ${PLAN_SHAPE.stateHeading}\` section with non-empty ${describedLabels(PLAN_SHAPE.stateLabels, ', ')} lines (\`${PLAN_SHAPE.stateLabels[3]}: N/A: <reason>\` is allowed), or only \`N/A: <reason>\` when no state or data boundary is touched, a \`## ${PLAN_SHAPE.acceptanceHeading}\` section quoting every folded card Definition-of-done criterion exactly with a following \`Proof:\` line naming a task, test, e2e, test file, or gate, and a mandatory \`## ${PLAN_SHAPE.cardTermsHeading}\` section with one \`- <card term, verbatim>: <the reading this plan chose>\` line for each card Definition-of-done term open to more than one reading (write \`- none: every term has one reading\` when none is); the ${PLAN_SHAPE.qualityHeading}, ${PLAN_SHAPE.gatesHeading}, ${PLAN_SHAPE.stateHeading} and card-terms headings are exact (case-insensitive, optional trailing colon or spaces), labels may be bulleted (\`-\`, \`*\`, \`+\`) or bold, fence lines alone are empty, and bare \`N/A\` without a reason is empty`

function planSection(content, heading) {
  return new RegExp(`(?:^|\\n)## ${heading}\\b[\\s\\S]*?(?=\\n## |$)`, 'i').exec(content)?.[0] ?? ''
}

export function acceptanceSection(content) {
  const heading = /(?:^|\n)## Acceptance[ \t]*\r?\n/i.exec(content)
  if (!heading) return ''
  const body = content.slice(heading.index + heading[0].length)
  const end = body.search(/\r?\n#{1,6}(?:[ \t]+|$)/)
  return heading[0] + (end === -1 ? body : body.slice(0, end))
}

function taskIndexesIn(lines) {
  // A column-0 `- ` / `1. ` line is a task. A `### ` heading is a task only when no such line sits under
  // it before the next heading; otherwise it groups the list tasks beneath it.
  const isListItem = (line) => /^(?:- |\d+\. )/.test(line)
  return lines
    .map((line, index) => {
      if (isListItem(line)) return index
      if (!/^### /.test(line)) return -1
      const next = lines.findIndex((other, j) => j > index && /^#{1,3} /.test(other))
      const end = next === -1 ? lines.length : next
      return lines.slice(index + 1, end).some(isListItem) ? -1 : index
    })
    .filter((index) => index >= 0)
}

function legacyShapeProblem(content, requireAcceptance) {
  const adr = planSection(content, PLAN_SHAPE.adrHeading)
  if (!PLAN_SHAPE.adrTerms.every((term) => new RegExp(term, 'i').test(adr)))
    return `Missing or incomplete ## ${PLAN_SHAPE.adrHeading}; example: Decision: <choice>; Rejected: <alternative>.`
  const lines = planSection(content, PLAN_SHAPE.tasksHeading).split(/\r?\n/)
  const taskIndexes = taskIndexesIn(lines)
  const complete = taskIndexes.length > 0 && taskIndexes.every(
    (start, i) =>
      new RegExp(`\\b(?:${PLAN_SHAPE.taskDodLabels.join('|')}):`, 'i').test(lines[start]) ||
      lines
        .slice(start + 1, taskIndexes[i + 1] ?? lines.length)
        .some((line) => new RegExp(`^\\s*(?:${PLAN_SHAPE.taskDodLabels.join('|')}):`, 'i').test(line)),
  )
  if (!complete) return `Missing or incomplete ## ${PLAN_SHAPE.tasksHeading}; example: - task; DoD: <proof>.`
  if (requireAcceptance && !acceptanceSection(content))
    return `Missing ## ${PLAN_SHAPE.acceptanceHeading}; example: - <card criterion> followed by Proof: <test>.`
  return null
}

function checkedHeading(line, heading) {
  if (heading === CARD_TERMS_HEADING) {
    const trimmed = line.trim()
    const title = trimmed.startsWith('##') ? trimmed.slice(2).trim() : undefined
    return title !== undefined && new RegExp(`^(?:\\*\\*)?${CARD_TERMS_HEADING.replace(': ', ':[ \\t]*')}(?:\\*\\*)?:?$`, 'i').test(title)
  }
  const title = /^ {0,3}## (.*)$/.exec(line)?.[1]
  return title?.trimEnd().replace(/:$/, '').trimEnd().toLowerCase() === heading.toLowerCase()
}

// Level-1/2 headings delimit sections only outside fences. Fenced examples are
// body content, but their labels never stand in for real answers.
function checkedSections(content, headings) {
  const sections = new Map()
  let current = null
  let fence = null
  for (const line of content.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const closing = marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()
      current?.push({ line, fenced: true, delimiter: Boolean(closing) })
      if (closing) fence = null
      continue
    }
    if (marker) {
      fence = marker[1]
      current?.push({ line, fenced: true, delimiter: true })
      continue
    }
    const heading = headings.find((name) => checkedHeading(line, name))
    if (heading || /^ {0,3}#{1,2}(?:[ \t]+|$)/.test(line)) {
      current = null
      if (heading && !sections.has(heading)) {
        current = []
        sections.set(heading, current)
      }
    } else current?.push({ line, fenced: false })
  }
  return sections
}

function contentLines(body) {
  return body.filter(({ line, fenced, delimiter }) => line.trim() && !delimiter && (fenced || !/^ {0,3}#{3,}(?:[ \t]+|$)/.test(line)))
}

function unstyled(line) {
  return line.trim().replace(/^[-*+][ \t]+/, '').replaceAll('**', '').trim()
}

function bareNotApplicable(text) {
  return /^N\/A(?:\s*[:—-])?$/i.test(unstyled(text))
}

function notApplicableWithReason(text) {
  return /^N\/A\s*[:—-]\s*\S/i.test(unstyled(text))
}

function labelledProblem(body, heading, labels) {
  for (const label of labels) {
    const entry = body.find(({ line, fenced }) => !fenced && unstyled(line).toLowerCase().startsWith(`${label.toLowerCase()}:`))
    const value = entry ? unstyled(entry.line).slice(label.length + 1).trim() : ''
    if (!value || bareNotApplicable(value)) return `Missing or empty ${label}: in ## ${heading}; example: ${label}: <answer or N/A: reason>.`
  }
  return null
}

function sectionExample(heading) {
  if (heading === PLAN_SHAPE.qualityHeading)
    return `${PLAN_SHAPE.qualityLabels[0]}: <changed artefacts and quality rules>; ${PLAN_SHAPE.qualityLabels[1]}: none: <reason>`
  if (heading === PLAN_SHAPE.stateHeading) return 'N/A: <reason no state or data boundary is touched>'
  if (heading === CARD_TERMS_HEADING) return '- <card term>: <chosen reading>'
  return '- <repository gate>: exit 0'
}

function hasTermReading({ line, fenced }) {
  if (fenced || !/^-[ \t]/.test(line)) return false
  const entry = line.slice(2).replaceAll('**', '')
  const colon = entry.indexOf(':')
  const term = entry.slice(0, colon).trim()
  const reading = entry.slice(colon + 1).trim()
  return colon > 0 && Boolean(term && reading && !bareNotApplicable(reading))
}

function sectionProblem(body, heading) {
  const example = `## ${heading} followed by ${sectionExample(heading)}`
  if (!body) return `Missing ## ${heading}; example: ${example}.`
  const content = contentLines(body)
  if (content.length === 0 || content.every(({ line }) => bareNotApplicable(line)))
    return `Empty ## ${heading}; example: ${example}.`
  if (heading === PLAN_SHAPE.qualityHeading) return labelledProblem(body, heading, PLAN_SHAPE.qualityLabels)
  if (heading === PLAN_SHAPE.stateHeading) {
    if (content.length === 1 && !content[0].fenced && notApplicableWithReason(content[0].line)) return null
    return labelledProblem(body, heading, PLAN_SHAPE.stateLabels)
  }
  if (heading === CARD_TERMS_HEADING && !body.some(hasTermReading))
    return `Empty ## ${heading}; example: - <card term>: <chosen reading>.`
  return null
}

export function planShapeProblem(content, requireAcceptance) {
  const headings = [PLAN_SHAPE.qualityHeading, PLAN_SHAPE.gatesHeading, PLAN_SHAPE.stateHeading, CARD_TERMS_HEADING]
  const sections = checkedSections(content, headings)
  const required = requireAcceptance ? headings : headings.slice(0, -1)
  for (const heading of required) {
    const problem = sectionProblem(sections.get(heading), heading)
    if (problem) return problem
  }
  return legacyShapeProblem(content, requireAcceptance)
}

export function containsPlanShape(content, requireAcceptance) {
  return planShapeProblem(content, requireAcceptance) === null
}
