// Function coordinates and lexical ancestry travel alongside ESLint's owner measurements.
// Unlike report-line identities, enclosing scopes cannot exchange debt allowances.
import { createHash } from 'node:crypto'

const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const scopeTypes = new Set([...functionTypes, 'ClassDeclaration', 'ClassExpression', 'ObjectExpression', 'TSModuleDeclaration'])
const propertyTypes = new Set(['Property', 'MethodDefinition', 'PropertyDefinition'])
const callTypes = new Set(['CallExpression', 'NewExpression'])
const compact = (node, source) => source.getTokens(node).map((token) => token.value).join('')
const bindingLabel = (node, source) => node.type === 'Identifier' ? node.name : compact(node, source)
const calleeLabel = (node, parent, source) => parent.callee === node ? 'IIFE' : compact(parent.callee, source)
function diagnosticStart(node) {
  const parent = node.parent
  if (parent?.type === 'VariableDeclarator' && parent.init === node) return parent.loc.start
  return propertyTypes.has(parent?.type) && parent.value === node ? parent.loc.start : node.loc.start
}
function heading(node, source) {
  const parent = node.parent
  const binding = { VariableDeclarator: 'id', AssignmentExpression: 'left' }[parent?.type]
  if (binding) return `binding:${parent.type}:${bindingLabel(parent[binding], source)}:${node.id?.name ?? ''}`
  if (propertyTypes.has(parent?.type)) {
    return JSON.stringify([parent.type, parent.kind, parent.static, compact(parent.key, source)])
  }
  if (node.id) return `${node.type}:${node.id.name}`
  if (!callTypes.has(parent?.type)) return node.type
  const argument = parent.arguments.indexOf(node)
  const labels = parent.arguments.slice(0, argument).filter((arg) => arg.type === 'Literal').map((arg) => arg.value)
  return JSON.stringify([calleeLabel(node, parent, source), argument, labels])
}
export const functionEvidence = {
  meta: { schema: [] },
  create(context) {
    const source = context.sourceCode
    const occurrences = new Map()
    function record(node) {
      const scopes = source.getAncestors(node).filter((ancestor) => scopeTypes.has(ancestor.type))
      const key = [...scopes, node].map((scope) => heading(scope, source))
      const group = JSON.stringify(key), ordinal = occurrences.get(group) ?? 0
      occurrences.set(group, ordinal + 1)
      const id = JSON.stringify([key, ordinal])
      const hash = createHash('sha256').update(source.getText(node.body)).digest('hex')
      context.report({ node, message: JSON.stringify({ key, group, ordinal, id, hash, start: diagnosticStart(node), end: node.loc.end }) })
    }
    return Object.fromEntries([...functionTypes].map((type) => [type, record]))
  },
}
export function enclosingIdentity(messages, message) {
  const contains = ({ start, end }) => (start.line < message.line || (start.line === message.line && start.column < message.column))
    && (end.line > message.line || (end.line === message.line && end.column >= message.column))
  return messages.filter((entry) => entry.ruleId === 'owner/function').map((entry) => JSON.parse(entry.message))
    .filter(contains).sort((a, b) => b.start.line - a.start.line || b.start.column - a.start.column)[0] ?? { key: [], ordinal: 0 }
}
function movedIdentities(current = [], before = []) {
  const positions = new Map(before.map((key, index) => [key, index]))
  const shared = current.filter((key) => positions.has(key)), moved = new Set()
  // Added/deleted functions do not shift an unchanged function's identity. A reversal
  // between surviving functions is a move, and neither side can lend its old debt.
  for (let i = 0; i < shared.length; i++) for (let j = i + 1; j < shared.length; j++) {
    if (positions.get(shared[i]) > positions.get(shared[j])) {
      moved.add(shared[i]); moved.add(shared[j])
    }
  }
  return moved
}
function pairPass(current, pairs, remaining, select) {
  for (const entry of current) {
    if (pairs.has(entry.id)) continue
    const match = select(entry)
    if (!match) continue
    pairs.set(entry.id, match.id)
    remaining.delete(match.id)
  }
}
export function functionCorrespondence(current = [], before = []) {
  const remaining = new Map(before.map((entry) => [entry.id, entry])), pairs = new Map()
  // Body hashes first anchor unchanged functions without ordinal drift. Pair
  // remaining edits within their lexical group in source order. A body moved
  // between same-header callbacks then reverses those pairings and loses debt.
  pairPass(current, pairs, remaining, (entry) => [...remaining.values()].find((old) => old.group === entry.group && old.hash === entry.hash))
  pairPass(current, pairs, remaining, (entry) => [...remaining.values()].find((old) => old.group === entry.group))
  const order = current.map((entry) => pairs.get(entry.id)).filter(Boolean)
  return { pairs, moved: movedIdentities(order, before.map((entry) => entry.id)) }
}
export function allowanceIdentity(identity, correspondence) {
  const [scope, label, line, ordinal] = JSON.parse(identity)
  if (!scope.length) return identity
  const original = correspondence.pairs.get(JSON.stringify([scope, ordinal]))
  if (!original || correspondence.moved.has(original)) return undefined
  const [oldScope, oldOrdinal] = JSON.parse(original)
  return JSON.stringify([oldScope, label, line, oldOrdinal])
}
