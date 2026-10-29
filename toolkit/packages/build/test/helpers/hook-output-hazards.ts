import ts from 'typescript'
import { accessName, localDeclaration, propertyName } from './hook-output-shapes.js'

export interface Hazard { node: ts.Node; message: string }

function memberName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) return accessName(node.argumentExpression)
  return undefined
}

function validEventAssignment(node: ts.BinaryExpression, events?: Set<string>): boolean {
  return node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isStringLiteralLike(node.right)
    && (!events || events.has(node.right.text))
}

function eventMutation(node: ts.Node, events?: Set<string>): Hazard | undefined {
  if (ts.isDeleteExpression(node) && memberName(node.expression) === 'hookEventName') {
    return { node, message: 'deleting hookEventName is outside the serialized-output contract' }
  }
  if (!ts.isBinaryExpression(node) || memberName(node.left) !== 'hookEventName') return undefined
  const operator = node.operatorToken.kind
  if (operator < ts.SyntaxKind.FirstAssignment || operator > ts.SyntaxKind.LastAssignment) return undefined
  if (validEventAssignment(node, events)) return undefined
  return { node, message: 'hookEventName assignment requires a registered string literal' }
}

function serializedObjects(node: ts.Node, found: Set<ts.ObjectLiteralExpression>, seen = new Set<ts.Node>()) {
  if (seen.has(node) || ts.isFunctionLike(node)) return
  seen.add(node)
  if (ts.isObjectLiteralExpression(node)) found.add(node)
  if (ts.isIdentifier(node)) {
    const initializer = localDeclaration(node)?.initializer
    if (initializer) serializedObjects(initializer, found, seen)
  }
  ts.forEachChild(node, (child) => serializedObjects(child, found, seen))
}

function isWriter(node: ts.CallExpression): boolean {
  const callee = node.expression.getText()
  return ['write', 'process.stdout.write', 'console.log', 'emitGuardNotice'].includes(callee)
}

function objectHazards(node: ts.ObjectLiteralExpression, serialized: boolean): Hazard[] {
  const envelope = node.properties.some((property) => propertyName(property.name) === 'hookSpecificOutput')
  const problems: Hazard[] = []
  for (const property of node.properties) {
    if (serialized && property.name && ts.isComputedPropertyName(property.name)) {
      problems.push({ node: property, message: 'computed serialized property requires a reason and serialized-output contract proof' })
    }
    if ((serialized || envelope) && propertyName(property.name) === 'toJSON') {
      problems.push({ node: property, message: 'envelope toJSON requires a reason and serialized-output contract proof' })
    }
  }
  return problems
}

export function serializationHazards(source: ts.SourceFile, events?: Set<string>): Hazard[] {
  const found = new Set<ts.ObjectLiteralExpression>()
  const objects = new Set<ts.ObjectLiteralExpression>()
  const problems: Hazard[] = []
  const visit = (node: ts.Node) => {
    const mutation = eventMutation(node, events)
    if (mutation) problems.push(mutation)
    if (ts.isObjectLiteralExpression(node)) objects.add(node)
    if (ts.isCallExpression(node) && isWriter(node)) {
      for (const argument of node.arguments) serializedObjects(argument, found)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const object of objects) problems.push(...objectHazards(object, found.has(object)))
  return problems
}
