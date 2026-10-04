const PLAN_SHAPE = Object.freeze({
  adrHeading: 'ADR',
  adrTerms: Object.freeze(['Decision', 'Rejected']),
  tasksHeading: 'Tasks',
  taskDodLabels: Object.freeze(['DoD', 'Definition of done']),
  gatesHeading: 'Gates',
  acceptanceHeading: 'Acceptance',
  cardTermsHeading: 'Card terms: reading chosen',
})

export const CARD_TERMS_HEADING = PLAN_SHAPE.cardTermsHeading

export const PLAN_SHAPE_DESCRIPTION = `a \`## ${PLAN_SHAPE.adrHeading}\` section containing ${PLAN_SHAPE.adrTerms.join(' and ')}, a \`## ${PLAN_SHAPE.tasksHeading}\` section whose every item (a column-0 \`- \` / \`1. \` line, or a \`### \` heading with no such line under it) has ${PLAN_SHAPE.taskDodLabels.map((label) => `\`${label}:\``).join(' or ')}, a \`## ${PLAN_SHAPE.gatesHeading}\` section, a \`## ${PLAN_SHAPE.acceptanceHeading}\` section quoting every folded card Definition-of-done criterion exactly with a following \`Proof:\` line naming a task, test, e2e, test file, or gate, and a mandatory \`## ${PLAN_SHAPE.cardTermsHeading}\` section with one \`- <card term, verbatim>: <the reading this plan chose>\` line for each card Definition-of-done term open to more than one reading (write \`- none: every term has one reading\` when none is)`

function planSection(content, heading) {
  return new RegExp(`(?:^|\\n)## ${heading}\\b[\\s\\S]*?(?=\\n## |$)`, 'i').exec(content)?.[0] ?? ''
}

export function acceptanceSection(content) {
  return /(?:^|\n)## Acceptance[ \t]*\r?\n[\s\S]*?(?=\r?\n#{1,6}(?:[ \t]+|$)|$)/i.exec(content)?.[0] ?? ''
}

function unfencedPlan(content) {
  let fence = null
  return content.split(/\r?\n/).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      return ''
    }
    if (!marker) return line
    fence = marker[1]
    return ''
  }).join('\n')
}

function planTaskItems(content) {
  const lines = planSection(unfencedPlan(content), PLAN_SHAPE.tasksHeading).split(/\r?\n/)
  // A column-0 `- ` / `1. ` line is a task. A `### ` heading is a task only when no such line sits under
  // it before the next heading; otherwise it groups the list tasks beneath it.
  const isListItem = (line) => /^(?:- |\d+\. )/.test(line)
  const taskIndexes = lines
    .map((line, index) => {
      if (isListItem(line)) return index
      if (!/^### /.test(line)) return -1
      const next = lines.findIndex((other, j) => j > index && /^#{1,3} /.test(other))
      return lines.slice(index + 1, next === -1 ? lines.length : next).some(isListItem) ? -1 : index
    })
    .filter((index) => index >= 0)
  return { lines, taskIndexes }
}

function taskId(line) {
  const id = /^(\d+)\. /.exec(line)?.[1] ??
    /^- ([A-Za-z]+\d+)(?=\s|:|$)/.exec(line)?.[1] ??
    /^### (?:Task (\d+)|([A-Za-z]+\d+))(?=\s|:|$)/i.exec(line)?.slice(1).find(Boolean)
  return id?.length <= 32 ? id : null
}

export function planTasks(content) {
  const { lines, taskIndexes } = planTaskItems(content)
  return taskIndexes.map((index) => ({ line: lines[index], id: taskId(lines[index]) }))
}

export function planTaskIds(content) {
  const ids = planTasks(content).map((task) => task.id).filter(Boolean)
  return [...new Set(ids)]
}

export function containsPlanShape(content, requireAcceptance) {
  const adr = planSection(content, PLAN_SHAPE.adrHeading)
  const { lines, taskIndexes } = planTaskItems(content)
  return (
    PLAN_SHAPE.adrTerms.every((term) => new RegExp(term, 'i').test(adr)) &&
    taskIndexes.length > 0 &&
    taskIndexes.every(
      (start, i) =>
        new RegExp(`\\b(?:${PLAN_SHAPE.taskDodLabels.join('|')}):`, 'i').test(lines[start]) ||
        lines
          .slice(start + 1, taskIndexes[i + 1] ?? lines.length)
          .some((line) => new RegExp(`^\\s*(?:${PLAN_SHAPE.taskDodLabels.join('|')}):`, 'i').test(line)),
    ) &&
    Boolean(planSection(content, PLAN_SHAPE.gatesHeading)) &&
    (!requireAcceptance || (Boolean(planSection(content, PLAN_SHAPE.cardTermsHeading)) && Boolean(acceptanceSection(content))))
  )
}
