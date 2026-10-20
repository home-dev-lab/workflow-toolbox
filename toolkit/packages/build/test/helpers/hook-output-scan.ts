import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'
import { accessName, propertyName, shapes } from './hook-output-shapes.js'
import { scanManifest } from './hook-output-manifest.js'
import { serializationHazards } from './hook-output-hazards.js'

export type ContractProof = () => void | Promise<void>
export interface Justification { reason: string; prove: ContractProof }
export type Justifications = Map<string, Justification>
export interface ScanResult { emissions: number; problems: string[]; justified: Set<string> }
interface Context { file: string; source: ts.SourceFile; events?: Set<string>; exceptions: Justifications; result: ScanResult }
const extensions = new Set(['.mjs', '.js', '.cjs'])

function problem(context: Context, node: ts.Node, message: string) {
  const line = context.source.getLineAndCharacterOfPosition(node.getStart(context.source)).line + 1
  context.result.problems.push(`${context.file}:${line}: ${message}`)
}

function justified(context: Context, expression: ts.Node): boolean {
  const key = `${context.file}:${expression.getText(context.source)}`
  const entry = context.exceptions.get(key)
  if (!entry?.reason.trim() || typeof entry.prove !== 'function') return false
  context.result.justified.add(key)
  return true
}

function checkEnvelope(context: Context, value: ts.Expression) {
  context.result.emissions++
  for (const shape of shapes(value)) {
    if (!shape.event) {
      if (!justified(context, value)) problem(context, value, 'hookSpecificOutput requires a provable hookEventName after overriding spreads')
    } else if (ts.isStringLiteralLike(shape.event)) {
      if (context.events && !context.events.has(shape.event.text)) problem(context, shape.event, `hookEventName ${shape.event.text} is not a registered event`)
    } else if (!justified(context, shape.event)) {
      problem(context, shape.event, 'non-literal hookEventName requires a reason and serialized-output contract proof')
    }
  }
}

function checkJsonValue(context: Context, node: ts.Node, value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'hookSpecificOutput') {
      context.result.emissions++
      checkSerializedEvent(context, node, child)
    }
    checkJsonValue(context, node, child)
  }
}

function checkSerializedEvent(context: Context, node: ts.Node, child: unknown) {
  const event = child && typeof child === 'object' ? Reflect.get(child, 'hookEventName') : undefined
  if (typeof event !== 'string') problem(context, node, 'JSON hookSpecificOutput requires its own hookEventName')
  else if (context.events && !context.events.has(event)) problem(context, node, `hookEventName ${event} is not a registered event`)
}

function checkJson(context: Context, node: ts.StringLiteralLike) {
  if (!node.text.includes('"hookSpecificOutput"')) return
  try { checkJsonValue(context, node, JSON.parse(node.text)) } catch {
    problem(context, node, 'hookSpecificOutput JSON text cannot be resolved structurally')
  }
}

function assignmentValue(node: ts.BinaryExpression): ts.Expression | undefined {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined
  const target = node.left
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'hookSpecificOutput') return node.right
  if (ts.isElementAccessExpression(target) && accessName(target.argumentExpression) === 'hookSpecificOutput') return node.right
  return undefined
}

export function scanSource(file: string, text: string, events?: Set<string>, exceptions: Justifications = new Map()): ScanResult {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const result: ScanResult = { emissions: 0, problems: [], justified: new Set() }
  const context = { file, source, events, exceptions, result }
  for (const { node, message } of serializationHazards(source, events)) {
    if (!justified(context, node)) problem(context, node, message)
  }
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'hookSpecificOutput') checkEnvelope(context, node.initializer)
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'hookSpecificOutput') checkEnvelope(context, node.name)
    if (ts.isBinaryExpression(node)) {
      const value = assignmentValue(node)
      if (value) checkEnvelope(context, value)
    }
    if (ts.isStringLiteralLike(node)) checkJson(context, node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git') return []
    const file = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(file)
    return extensions.has(extname(file)) ? [file] : []
  })
}

function register(registrations: Map<string, Set<string>>, file: string, event: string) {
  const events = registrations.get(file) ?? new Set<string>()
  events.add(event)
  registrations.set(file, events)
}

function sdkRegistrations(root: string, registrations: Map<string, Set<string>>) {
  const file = 'bin/lib/sdk-role-profile.mjs'
  const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const fields = new Map(node.properties.filter(ts.isPropertyAssignment).map((field) => [propertyName(field.name), field.initializer]))
      const script = fields.get('script'), event = fields.get('event')
      if (script && event && ts.isStringLiteralLike(script) && ts.isStringLiteralLike(event)) register(registrations, `bin/${script.text}`, event.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  // This module declares the callback registration inline in buildWakeOptions.
  const wake = readFileSync(join(root, 'bin/lib/pilot-parent-wake.mjs'), 'utf8')
  if (/hooks:\s*\{\s*PreToolUse:/.test(wake)) register(registrations, 'bin/lib/pilot-parent-wake.mjs', 'PreToolUse')
}

export function scanPlugin(root: string, exceptions: Justifications = new Map()): ScanResult {
  const files = sourceFiles(root).map((absolute) => relative(root, absolute).replaceAll('\\', '/'))
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'))
  const { registrations, result } = scanManifest(manifest, new Set(files), exceptions)
  sdkRegistrations(root, registrations)
  for (const file of registrations.keys()) {
    if (!files.includes(file)) result.problems.push(`${file}: registered hook source file is not scanned`)
  }
  for (const file of files) {
    const scanned = scanSource(file, readFileSync(join(root, file), 'utf8'), registrations.get(file), exceptions)
    result.emissions += scanned.emissions
    result.problems.push(...scanned.problems)
    for (const key of scanned.justified) result.justified.add(key)
  }
  return result
}
