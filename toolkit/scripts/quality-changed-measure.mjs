import { enclosingIdentity, functionCorrespondence, allowanceIdentity } from './quality-changed-functions.mjs'

const patterns = {
  complexity: /^(.*?) has a complexity of (\d+)/,
  'max-lines-per-function': /^(.*?) has too many lines \((\d+)\)/,
}
const identityLabel = (scope, label) => scope.length ? '' : label
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
    const scope = enclosingIdentity(result.messages, message)
    const identity = JSON.stringify([scope.key, identityLabel(scope.key, match[1]), scope.key.length ? '' : line, scope.ordinal])
    const labels = rules[message.ruleId] ??= Object.create(null)
    ;(labels[identity] ??= []).push(Number(match[2]))
  }
  for (const labels of Object.values(rules)) for (const values of Object.values(labels)) values.sort((a, b) => b - a)
  const functions = results.flatMap((result) => result.messages.filter((message) => message.ruleId === 'owner/function')
    .map((message) => JSON.parse(message.message)))
  return { rules, fatal, functions }
}
export const dominated = (subject, base) => subject.length <= base.length && subject.every((value, i) => value <= base[i])
export function regressions(file, subject, base, currentFunctions, baseFunctions) {
  const problems = []
  const correspondence = functionCorrespondence(currentFunctions, baseFunctions)
  for (const [rule, labels] of Object.entries(subject)) for (const [identity, values] of Object.entries(labels)) {
    const allowed = base[rule]?.[allowanceIdentity(identity, correspondence)] ?? []
    if (!dominated(values, allowed)) problems.push(`${file}: ${rule} ${identity} values=${JSON.stringify(values)} base=${JSON.stringify(allowed)}`)
  }
  return problems
}
