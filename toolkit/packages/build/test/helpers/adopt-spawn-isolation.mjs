import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

const TARGET = /wt-adopt-(?:rules-)?check-hook\.mjs|(?:^|[/\\])install\.mjs/
const SPAWN = /^(?:spawnSync|spawn|execFileSync|execFile|fork)$/

// The scanner follows values through the scanned files and the project sources they import; it never needs a
// declaration from a package or the standard library: an ambient function has no body and an ambient variable
// no initializer, so both expand to the call or name itself whether or not they resolve. Parsing them anyway
// (about 10 MB per program) made every scan CPU-bound, so package and library declarations are served empty.
const PACKAGE_DIR = `${sep}node_modules${sep}`

function projectSourceHost(options) {
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => fileName.includes(PACKAGE_DIR)
    ? ts.createSourceFile(fileName, '', languageVersion)
    : read(fileName, languageVersion, onError, shouldCreate)
  return host
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(file) : /\.(?:[cm]?[jt]s)$/.test(entry.name) ? [file] : []
  })
}

function descendants(node, predicate) {
  const found = []
  const visit = (child) => {
    if (predicate(child)) found.push(child)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function declaration(checker, node) {
  let symbol = ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node)
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0]
}

function functionReturns(fn) {
  if (!fn?.body) return []
  if (!ts.isBlock(fn.body)) return [fn.body]
  return descendants(fn.body, ts.isReturnStatement)
    .filter((node) => {
      let parent = node.parent
      while (parent && parent !== fn && !ts.isFunctionLike(parent)) parent = parent.parent
      return parent === fn
    }).map((node) => node.expression).filter(Boolean)
}

function callable(checker, node) {
  const decl = declaration(checker, node)
  return ts.isVariableDeclaration(decl ?? {}) ? decl.initializer : decl
}

function bindCall(fn, call, bindings) {
  const bound = new Map(bindings)
  fn.parameters?.forEach((param, index) => bound.set(param, call.arguments[index] ?? param.initializer))
  return bound
}

function parameterValues(param, context) {
  const fn = param.parent
  const name = fn.name ?? (ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined)
  if (!name) return param.initializer ? [{ node: param.initializer, bindings: context.bindings }] : []
  return context.callsTo(name)
    .flatMap((call) => expand(call.arguments[fn.parameters.indexOf(param)] ?? param.initializer, context))
}

function propertyValues(node, context) {
  const key = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression?.text
  return objectPropertyValues(node.expression, key, context)
}

function objectPropertyValues(node, key, context) {
  return expand(node, context).flatMap((base) => {
    if (!ts.isObjectLiteralExpression(base.node)) return []
    const next = { ...context, bindings: base.bindings, depth: context.depth + 1 }
    for (const property of [...base.node.properties].reverse()) {
      if (property.name?.getText().replace(/['"]/g, '') === key) return expand(property.initializer ?? property.name, next)
      if (ts.isSpreadAssignment(property)) {
        const values = objectPropertyValues(property.expression, key, next)
        if (values.length) return values
      }
    }
    return []
  })
}

function identifierValues(node, context) {
  const decl = declaration(context.checker, node)
  if (context.bindings.has(decl)) return expand(context.bindings.get(decl), context)
  if (decl && ts.isParameter(decl)) return parameterValues(decl, context)
  if (decl && ts.isBindingElement(decl)) {
    return objectPropertyValues(decl.parent.parent.initializer, (decl.propertyName ?? decl.name).getText(), context)
  }
  return decl?.initializer ? expand(decl.initializer, context) : [{ node, bindings: context.bindings }]
}

function callValues(node, context) {
  const fn = callable(context.checker, node.expression)
  const returns = functionReturns(fn)
  return returns.length ? returns.flatMap((value) => expand(value, { ...context, bindings: bindCall(fn, node, context.bindings) }))
    : [{ node, bindings: context.bindings }]
}

function transparentExpression(node) {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ? node.expression : null
}

function expand(node, context) {
  if (!node || context.depth > 35) return []
  const next = { ...context, depth: context.depth + 1 }
  const transparent = transparentExpression(node)
  if (transparent) return expand(transparent, next)
  if (ts.isIdentifier(node)) return identifierValues(node, next)
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return propertyValues(node, next)
  if (ts.isCallExpression(node)) return callValues(node, next)
  if (ts.isConditionalExpression(node)) return [...expand(node.whenTrue, next), ...expand(node.whenFalse, next)]
  if (ts.isBinaryExpression(node)) return [...expand(node.left, next), ...expand(node.right, next)]
  return [{ node, bindings: context.bindings }]
}

function textValues(node, context) {
  return expand(node, context).flatMap((value) => {
    const next = { ...context, bindings: value.bindings, depth: context.depth + 1 }
    if (ts.isStringLiteralLike(value.node)) return [value.node.text]
    if (ts.isArrayLiteralExpression(value.node)) return value.node.elements.flatMap((entry) => textValues(ts.isSpreadElement(entry) ? entry.expression : entry, next))
    if (ts.isCallExpression(value.node)) return value.node.arguments.flatMap((arg) => textValues(arg, next))
    if (ts.isTemplateExpression(value.node)) return [value.node.head.text, ...value.node.templateSpans.flatMap((span) => [...textValues(span.expression, next), span.literal.text])]
    return []
  })
}

function envState(node, key, context) {
  const values = expand(node, context)
  if (!values.length) return false
  const states = values.map((value) => objectEnvState(value, key, context))
  if (states.some((state) => state === false)) return false
  return states.length && states.every((state) => state === true) ? true : undefined
}

function presentEnvValue(node, context) {
  const values = expand(node, context)
  return values.length > 0 && values.every((value) => value.node.getText() !== 'undefined'
    && value.node.kind !== ts.SyntaxKind.NullKeyword && value.node.kind !== ts.SyntaxKind.FalseKeyword
    && !(ts.isStringLiteralLike(value.node) && value.node.text === ''))
}

function objectEnvState(value, key, context) {
  if (!ts.isObjectLiteralExpression(value.node)) return false
  let state
  for (const property of value.node.properties) {
    const next = { ...context, bindings: value.bindings, depth: context.depth + 1 }
    if (ts.isSpreadAssignment(property)) {
      const spread = envState(property.expression, key, next)
      if (spread !== undefined) state = spread
    } else if (property.name?.getText().replace(/['"]/g, '') === key) {
      const initializer = property.initializer ?? property.name
      state = presentEnvValue(initializer, next)
    }
  }
  return state
}

function spawnEnv(call) {
  const options = call.arguments[2]
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined
  const property = options.properties.find((entry) => entry.name?.getText() === 'env')
  return property?.initializer ?? property?.name
}

function isSpawn(call, checker) {
  if (SPAWN.test(call.expression.getText().split('.').at(-1))) return true
  // Only a bare identifier can resolve to an import specifier; resolving any other callee would type-check it.
  if (!ts.isIdentifier(call.expression)) return false
  const imported = checker.getSymbolAtLocation(call.expression)?.declarations?.[0]
  if (!imported || !ts.isImportSpecifier(imported)) return false
  const module = imported.parent.parent.parent.moduleSpecifier?.text
  return ['node:child_process', 'child_process'].includes(module) && SPAWN.test((imported.propertyName ?? imported.name).text)
}

function spawnContexts(call, context) {
  let fn = call.parent
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent
  const name = fn?.name ?? (fn && ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined)
  const calls = name && context.callsTo(name)
  return calls?.length ? calls.map((invocation) => ({ ...context, bindings: bindCall(fn, invocation, context.bindings) })) : [context]
}

function spawnFinding(call, context) {
  const words = textValues(call.arguments[1], context)
  const target = words.some((word) => TARGET.test(word))
  // Entry-point tables and opaque wrapper arguments remain conservative. Pure inline probes
  // are not writers. Wrapper arguments and env are resolved from the SAME invocation.
  const dynamic = !words.length || (words.includes('bin') && !words.some((word) => word.endsWith('.mjs')))
  if (!target && !dynamic) return []
  const readOnly = !words.includes('--install') && words.some((word) => word === '--check' || word === '--diff')
  if (!words.some((word) => /wt-adopt-(?:rules-)?check-hook\.mjs/.test(word)) && readOnly) return []
  const missing = ['HOME', 'CLAUDE_CONFIG_DIR'].filter((key) => envState(spawnEnv(call), key, context) !== true)
  const file = call.getSourceFile()
  return missing.length ? [{ file: file.fileName, line: file.getLineAndCharacterOfPosition(call.getStart()).line + 1, missing }] : []
}

function nameText(node) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

function calleeName(call) {
  if (ts.isIdentifier(call.expression) || ts.isPrivateIdentifier(call.expression)) return call.expression.text
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined
}

// The calls whose callee resolves to the symbol declared by `name`, in source order. A callee spelled with
// another name cannot resolve to that symbol, so only same-name and unnamed callees are resolved: resolving
// every call up front type-checks each `expect(...).toBe(...)` chain of every scanned file.
function callIndex(calls, checker) {
  const resolved = new Map()
  const symbolOf = (call) => {
    if (!resolved.has(call)) resolved.set(call, checker.getSymbolAtLocation(call.expression))
    return resolved.get(call)
  }
  return (name) => {
    const symbol = checker.getSymbolAtLocation(name)
    const text = symbol === undefined ? undefined : nameText(name)
    return calls.filter((call) => {
      const callee = text === undefined ? undefined : calleeName(call)
      return (callee === undefined || callee === text) && symbolOf(call) === symbol
    })
  }
}

function scanSource(file, checker, calls, callsTo) {
  const context = { checker, callsTo, bindings: new Map(), depth: 0 }
  const scope = TARGET.test(file.text)
  if (!scope) return []
  return calls.filter((call) => call.getSourceFile() === file && isSpawn(call, checker))
    .flatMap((call) => spawnContexts(call, context).flatMap((bound) => spawnFinding(call, bound)))
}

export function scanAdoptSpawnIsolation(root, suppliedFiles) {
  const files = suppliedFiles ?? ['packages/build/test', 'scripts/test'].flatMap((dir) => filesUnder(join(root, dir)))
  const scoped = files.filter((file) => TARGET.test(readFileSync(file, 'utf8')))
  const options = { allowJs: true, noLib: true, types: [], target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }
  const program = ts.createProgram(scoped, options, projectSourceHost(options))
  const checker = program.getTypeChecker()
  const sources = scoped.map((file) => program.getSourceFile(file)).filter(Boolean)
  const calls = sources.flatMap((file) => descendants(file, ts.isCallExpression))
  const findings = sources.flatMap((file) => scanSource(file, checker, calls, callIndex(calls, checker)))
  return [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()]
    .map((finding) => ({ ...finding, file: relative(root, finding.file).replaceAll('\\', '/') }))
}
