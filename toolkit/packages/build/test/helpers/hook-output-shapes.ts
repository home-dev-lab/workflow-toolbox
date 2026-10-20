import ts from 'typescript'

// A known object with no event is distinct from an opaque spread that may overwrite it.
export interface Shape { event?: ts.Expression; opaque: boolean }
const unknownShape = (): Shape[] => [{ opaque: true }]

export function propertyName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text
  if (ts.isComputedPropertyName(node)) return accessName(node.expression)
  return undefined
}

export function accessName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isIdentifier(node)) {
    const initializer = localDeclaration(node)?.initializer
    if (initializer && ts.isStringLiteralLike(initializer)) return initializer.text
  }
  return undefined
}

function scope(node: ts.Node): ts.Node {
  let current = node.parent
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent
  return current
}

export function localDeclaration(node: ts.Identifier): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = node.parent
  while (current) {
    const statements = ts.isBlock(current) || ts.isSourceFile(current) ? current.statements : []
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement) || statement.pos >= node.pos) continue
      const found = statement.declarationList.declarations.find((declaration) => propertyName(declaration.name) === node.text)
      if (found) return found
    }
    if (ts.isFunctionLike(current)) break
    current = current.parent
  }
  return undefined
}

function merge(left: Shape, right: Shape): Shape {
  if (right.event || right.opaque) return right
  return left
}

function member(node: ts.Expression): { owner: ts.Expression; key?: string } | undefined {
  if (ts.isPropertyAccessExpression(node)) return { owner: node.expression, key: node.name.text }
  if (ts.isElementAccessExpression(node)) return { owner: node.expression, key: accessName(node.argumentExpression) }
  return undefined
}

function writesIdentifier(node: ts.Expression, name: string): boolean {
  const target = ts.isIdentifier(node) ? node : member(node)?.owner
  return !!target && ts.isIdentifier(target) && target.text === name
}

function definitelyExecuted(write: ts.Node, use: ts.Node): boolean {
  let parent = write.parent
  while (parent && parent !== scope(use)) {
    if (ts.isIfStatement(parent) || ts.isIterationStatement(parent, false) || ts.isConditionalExpression(parent)) return false
    if (isConditionalEvaluation(parent)) return false
    parent = parent.parent
  }
  return true
}

const conditionalOperators = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
])

function isConditionalEvaluation(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node) && conditionalOperators.has(node.operatorToken.kind)) return true
  return ts.isSwitchStatement(node) || ts.isCatchClause(node) || !!(node as ts.CallExpression).questionDotToken
}

function laterWrites(identifier: ts.Identifier, declaration: ts.VariableDeclaration): ts.BinaryExpression[] {
  const writes: ts.BinaryExpression[] = []
  const ownerScope = scope(identifier)
  const visit = (node: ts.Node) => {
    if (node !== ownerScope && ts.isFunctionLike(node)) return
    if (node.pos >= identifier.pos) return
    if (ts.isBinaryExpression(node) && node.pos > declaration.end && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (writesIdentifier(node.left, identifier.text)) writes.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(ownerScope)
  return writes
}

function identifierShapes(node: ts.Identifier, depth: number): Shape[] {
  const declaration = localDeclaration(node)
  if (!declaration?.initializer) return unknownShape()
  let result = shapes(declaration.initializer, depth + 1)
  for (const write of laterWrites(node, declaration)) {
    if (ts.isIdentifier(write.left)) {
      result = definitelyExecuted(write, node) ? shapes(write.right, depth + 1) : unknownShape()
      continue
    }
    const key = member(write.left)?.key
    if (key === 'hookEventName') result = definitelyExecuted(write, node) ? [{ event: write.right, opaque: false }] : unknownShape()
    else if (key === undefined) result = unknownShape()
  }
  return result
}

function objectShapes(node: ts.ObjectLiteralExpression, depth: number): Shape[] {
  if (node.properties.some((property) => propertyName(property.name) === 'toJSON')) return unknownShape()
  let result: Shape[] = [{ opaque: false }]
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = shapes(property.expression, depth + 1)
      result = result.flatMap((left) => spread.map((right) => merge(left, right)))
    } else if (propertyName(property.name) === 'hookEventName') {
      const event = ts.isPropertyAssignment(property) ? property.initializer : undefined
      result = [{ event, opaque: !event }]
    } else if (ts.isComputedPropertyName(property.name)) {
      if (!ts.isStringLiteralLike(property.name.expression)) result = unknownShape()
    }
  }
  return result
}

export function shapes(node: ts.Expression, depth = 0): Shape[] {
  if (depth > 12) return unknownShape()
  if (ts.isParenthesizedExpression(node)) return shapes(node.expression, depth + 1)
  if (ts.isConditionalExpression(node)) return [...shapes(node.whenTrue, depth + 1), ...shapes(node.whenFalse, depth + 1)]
  if (ts.isObjectLiteralExpression(node)) return objectShapes(node, depth)
  if (ts.isIdentifier(node)) return identifierShapes(node, depth)
  return unknownShape()
}
