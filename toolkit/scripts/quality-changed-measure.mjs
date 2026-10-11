const patterns = {
  complexity: /^(.*?) has a complexity of (\d+)/,
  'max-lines-per-function': /^(.*?) has too many lines \((\d+)\)/,
}
function labelValue(message) {
  if (message.ruleId === '@typescript-eslint/no-explicit-any') return ['any', 'any', '1']
  const match = patterns[message.ruleId].exec(message.message)
  if (!match) throw new Error(`cannot measure ${message.message}`)
  return match
}
export function measure(results, file, text) {
  const rules = Object.create(null), fatal = []
  const lines = text.split(/\r\n|[\r\n\u2028\u2029]/)
  for (const result of results) for (const message of result.messages) {
    if (message.fatal) { fatal.push(`${file}: parse error: ${message.message}`); continue }
    if (!['complexity', 'max-lines-per-function', '@typescript-eslint/no-explicit-any'].includes(message.ruleId)) continue
    const match = labelValue(message)
    const line = lines[message.line - 1].trim().replace(/\s+/g, ' ')
    const identity = JSON.stringify([match[1], line])
    const labels = rules[message.ruleId] ??= Object.create(null)
    ;(labels[identity] ??= []).push(Number(match[2]))
  }
  for (const labels of Object.values(rules)) for (const values of Object.values(labels)) values.sort((a, b) => b - a)
  return { rules, fatal }
}
export const dominated = (subject, base) => subject.length <= base.length && subject.every((value, i) => value <= base[i])
export function regressions(file, subject, base) {
  const problems = []
  for (const [rule, labels] of Object.entries(subject)) for (const [identity, values] of Object.entries(labels)) {
    const allowed = base[rule]?.[identity] ?? []
    if (!dominated(values, allowed)) problems.push(`${file}: ${rule} ${identity} values=${JSON.stringify(values)} base=${JSON.stringify(allowed)}`)
  }
  return problems
}
