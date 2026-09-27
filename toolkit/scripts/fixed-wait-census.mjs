import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { fixedWaitAllowList } from './fixed-wait-allow-list.mjs'

// Census of the waits a test makes on TIME rather than on an event.
//
// Two signals, read from the TypeScript AST of every test file except this census's own test (code
// inside a string or a template literal — a fixture child's source — is never a call here, so it is
// never counted):
//
// - `fixed-sleep`: a pause whose length is a number — setTimeout(cb, N) and its node:timers aliases,
//   setTimeout(N) from node:timers/promises under any local name, sleep/delay/pause(N),
//   Atomics.wait(buffer, index, value, N). What follows it is decided by how fast the host was.
// - `short-deadline`: a bound of at most SHORT_DEADLINE_MS on something another process or thread
//   produces — `Date.now() + N`, `Date.now() - start > N`, a wait helper's default patience or a number
//   (or `{ timeout: N }`) passed to one, or the `timeout` option of a child_process call.
//
// Numbers are resolved through `const` declarations in the enclosing scopes, with a shadowing
// parameter hiding an outer constant, so naming a short number does not hide it.
//
// The pause between two reads of a predicate is the tick of an event wait, not a wait on time, and is
// not reported — but only when its NEAREST loop is both bounded by the clock and exits on something
// that is not the clock. A loop that only waits for the clock to run out is a fixed sleep.
//
// A cap above SHORT_DEADLINE_MS on a predicate poll is the shape the suite wants, so it is not a signal.
// Every signal must be converted or carry a named exemption in fixed-wait-allow-list.mjs. The key names
// the file, the signal, the resolved number and the whole enclosing statement, so moving a site costs
// nothing while changing its number, or its statement, needs a fresh decision.

const ROOT = resolve(import.meta.dirname, '..')
const TEST_ROOTS = ['packages', 'examples/test', 'scripts/test']
const SELF = 'scripts/test/fixed-wait-census.test.ts'
export const SHORT_DEADLINE_MS = 10_000
const DEADLINE_NAME = /(?:timeout|patience|deadline|budget|limit|^ms$|Ms$|^wait)/i
const PROCESS_FUNCTIONS = new Set(['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'])
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process'])
const PROMISE_TIMER_MODULES = new Set(['timers/promises', 'node:timers/promises'])
const CALLBACK_TIMER_MODULES = new Set(['timers', 'node:timers'])
const WAIT_HELPER = /^(?:wait|poll|until|eventually)/i
const SLEEP_HELPER = /^(?:sleep|delay|pause)$/i
const KEY_TEXT_LENGTH = 160

function testFilesUnder(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return testFilesUnder(path)
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  })
}

function unwrap(node) {
  let current = node
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current) || ts.isSatisfiesExpression?.(current))) current = current.expression
  return current
}

function isScope(node) {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)
}

function scopeStatements(scope) {
  return ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.statements : scope.statements ?? []
}

// The declaration a name refers to at `from`: the nearest enclosing scope that declares it, where a
// function parameter of that name shadows every outer constant.
function declarationOf(name, from) {
  for (let current = from.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) && current.parameters?.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)) return undefined
    if (!isScope(current)) continue
    for (const statement of scopeStatements(current)) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
      const declaration = statement.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === name)
      if (declaration) return declaration
    }
  }
  return undefined
}

const BINARY = new Map([
  [ts.SyntaxKind.AsteriskToken, (left, right) => left * right],
  [ts.SyntaxKind.PlusToken, (left, right) => left + right],
  [ts.SyntaxKind.MinusToken, (left, right) => left - right],
  [ts.SyntaxKind.SlashToken, (left, right) => left / right],
])

function numberOf(input, depth = 0) {
  const node = unwrap(input)
  if (!node || depth > 8) return undefined
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''))
  if (ts.isIdentifier(node)) {
    const declaration = declarationOf(node.text, node)
    return declaration?.initializer ? numberOf(declaration.initializer, depth + 1) : undefined
  }
  if (ts.isBinaryExpression(node) && BINARY.has(node.operatorToken.kind)) {
    const left = numberOf(node.left, depth + 1)
    const right = numberOf(node.right, depth + 1)
    return left === undefined || right === undefined ? undefined : BINARY.get(node.operatorToken.kind)(left, right)
  }
  // A platform- or mode-dependent bound is only as patient as its shortest branch: reading it that way keeps a
  // conditional from hiding a fixed wait the literal form would have been flagged for.
  if (ts.isConditionalExpression(node)) {
    const branches = [numberOf(node.whenTrue, depth + 1), numberOf(node.whenFalse, depth + 1)].filter((value) => value !== undefined)
    return branches.length === 0 ? undefined : Math.min(...branches)
  }
  return undefined
}

function objectOf(input, depth = 0) {
  const node = unwrap(input)
  if (!node || depth > 8) return undefined
  if (ts.isObjectLiteralExpression(node)) return node
  if (ts.isIdentifier(node)) {
    const declaration = declarationOf(node.text, node)
    return declaration?.initializer ? objectOf(declaration.initializer, depth + 1) : undefined
  }
  return undefined
}

function propertyNumber(object, predicate) {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && predicate(property.name.text)) {
      const value = numberOf(property.initializer)
      if (value !== undefined) return { name: property.name.text, value }
    }
    if (ts.isShorthandPropertyAssignment(property) && predicate(property.name.text)) {
      const value = numberOf(property.name)
      if (value !== undefined) return { name: property.name.text, value }
    }
  }
  return undefined
}

function isShort(value) {
  return value !== undefined && value > 0 && value <= SHORT_DEADLINE_MS
}

// Which local names are timers and which are child_process functions, however they were imported.
function collectBindings(sourceFile) {
  const bindings = { promiseTimers: new Set(), callbackTimers: new Set(), timerNamespaces: new Map(), processes: new Set(), processNamespaces: new Set() }
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const module = statement.moduleSpecifier.text
    const named = statement.importClause?.namedBindings
    if (!named) continue
    if (ts.isNamespaceImport(named)) {
      if (PROMISE_TIMER_MODULES.has(module)) bindings.timerNamespaces.set(named.name.text, 'promise')
      if (CALLBACK_TIMER_MODULES.has(module)) bindings.timerNamespaces.set(named.name.text, 'callback')
      if (CHILD_PROCESS_MODULES.has(module)) bindings.processNamespaces.add(named.name.text)
      continue
    }
    for (const element of named.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (imported === 'setTimeout' && PROMISE_TIMER_MODULES.has(module)) bindings.promiseTimers.add(element.name.text)
      if (imported === 'setTimeout' && CALLBACK_TIMER_MODULES.has(module)) bindings.callbackTimers.add(element.name.text)
      if (PROCESS_FUNCTIONS.has(imported) && CHILD_PROCESS_MODULES.has(module)) bindings.processes.add(element.name.text)
    }
  }
  return bindings
}

// 'promise' when the delay is the first argument, 'callback' when it is the second, else undefined.
function timerKind(call, bindings) {
  const callee = call.expression
  if (ts.isIdentifier(callee)) {
    if (bindings.promiseTimers.has(callee.text)) return 'promise'
    if (bindings.callbackTimers.has(callee.text) || callee.text === 'setTimeout') return 'callback'
    return undefined
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.name.text === 'setTimeout') {
    if (bindings.timerNamespaces.has(callee.expression.text)) return bindings.timerNamespaces.get(callee.expression.text)
    if (['globalThis', 'window', 'global'].includes(callee.expression.text)) return 'callback'
  }
  return undefined
}

function isProcessCall(call, bindings) {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return bindings.processes.has(callee.text)
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && bindings.processNamespaces.has(callee.expression.text) && PROCESS_FUNCTIONS.has(callee.name.text)
}

function sleepSignal(call, bindings) {
  const kind = timerKind(call, bindings)
  if (kind) {
    const value = numberOf(kind === 'promise' ? call.arguments[0] : call.arguments[1])
    return value > 0 ? `setTimeout ${value} ms` : undefined
  }
  const callee = call.expression
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Atomics' && callee.name.text === 'wait') {
    const value = numberOf(call.arguments[3])
    return value > 0 ? `Atomics.wait ${value} ms` : undefined
  }
  // Only a bare helper name: `player.pause(500)` is a method of something else.
  if (ts.isIdentifier(callee) && SLEEP_HELPER.test(callee.text)) {
    const value = numberOf(call.arguments[0])
    return value > 0 ? `${callee.text} ${value} ms` : undefined
  }
  return undefined
}

function isClockRead(node) {
  const inner = unwrap(node)
  return ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && ts.isIdentifier(inner.expression.expression)
    && ((inner.expression.expression.text === 'Date' && inner.expression.name.text === 'now')
      || (inner.expression.expression.text === 'performance' && inner.expression.name.text === 'now'))
}

function containsClockRead(node) {
  let found = false
  const visit = (current) => {
    if (found || ts.isFunctionLike(current)) return
    if (isClockRead(current)) found = true
    else ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

const COMPARISON = new Set([ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken])

function elapsedBound(node) {
  if (!COMPARISON.has(node.operatorToken.kind)) return undefined
  const isElapsed = (side) => {
    const inner = unwrap(side)
    return ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.MinusToken && isClockRead(inner.left)
  }
  if (isElapsed(node.left)) return numberOf(node.right)
  if (isElapsed(node.right)) return numberOf(node.left)
  return undefined
}

function enclosingFunctionName(node) {
  let current = node.parent
  while (current && !ts.isFunctionLike(current)) current = current.parent
  if (!current) return undefined
  if (current.name && ts.isIdentifier(current.name)) return current.name.text
  if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text
  return undefined
}

function deadlineSignal(node, bindings) {
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const value = isClockRead(node.left) ? numberOf(node.right) : isClockRead(node.right) ? numberOf(node.left) : undefined
      if (isShort(value)) return `now() + ${value} ms`
    }
    const elapsed = elapsedBound(node)
    return isShort(elapsed) ? `elapsed bound ${elapsed} ms` : undefined
  }
  if (ts.isParameter(node) && node.initializer && ts.isIdentifier(node.name) && DEADLINE_NAME.test(node.name.text)) {
    const owner = enclosingFunctionName(node)
    const value = numberOf(node.initializer)
    return owner && WAIT_HELPER.test(owner) && isShort(value) ? `${owner}(${node.name.text} = ${value} ms)` : undefined
  }
  if (!ts.isCallExpression(node)) return undefined
  if (isProcessCall(node, bindings)) {
    for (const argument of node.arguments) {
      const object = objectOf(argument)
      const timeout = object && propertyNumber(object, (name) => name === 'timeout')
      if (timeout && isShort(timeout.value)) return `${node.expression.getText()} timeout: ${timeout.value} ms`
    }
    return undefined
  }
  const callee = node.expression
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined
  if (!name || !WAIT_HELPER.test(name)) return undefined
  for (const argument of node.arguments) {
    const value = numberOf(argument)
    if (isShort(value)) return `${name}(…, ${value} ms)`
    const object = objectOf(argument)
    const option = object && propertyNumber(object, (key) => DEADLINE_NAME.test(key))
    if (option && isShort(option.value)) return `${name}({ ${option.name}: ${option.value} ms })`
  }
  return undefined
}

// A loop condition (or the condition of an `if` in its body) is split on && and ||: a part that reads
// the clock bounds the loop, any other part is the event it waits for.
function conjuncts(node) {
  const inner = unwrap(node)
  if (ts.isBinaryExpression(inner) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(inner.operatorToken.kind)) {
    return [...conjuncts(inner.left), ...conjuncts(inner.right)]
  }
  return [inner]
}

function exits(statement) {
  let found = false
  const visit = (node) => {
    if (found || ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node) || ts.isBreakStatement(node) || ts.isThrowStatement(node)) found = true
    else ts.forEachChild(node, visit)
  }
  visit(statement)
  return found
}

function loopExits(loop) {
  const clock = { bounded: false, event: false }
  const condition = ts.isForStatement(loop) ? loop.condition : loop.expression
  for (const part of condition ? conjuncts(condition) : []) {
    if (containsClockRead(part)) clock.bounded = true
    else if (!(part.kind === ts.SyntaxKind.TrueKeyword)) clock.event = true
  }
  const visit = (node) => {
    if (ts.isFunctionLike(node) && !isPromiseExecutor(node)) return
    if (ts.isIterationStatement(node, false) && node !== loop) return
    if (ts.isIfStatement(node) && exits(node.thenStatement)) {
      for (const part of conjuncts(node.expression)) {
        if (containsClockRead(part)) clock.bounded = true
        else clock.event = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(loop.statement)
  return clock
}

function isPromiseExecutor(fn) {
  return ts.isNewExpression(fn.parent) && ts.isIdentifier(fn.parent.expression) && fn.parent.expression.text === 'Promise'
}

// Only the NEAREST loop decides, and it must be a poll: bounded by the clock AND exiting on an event.
function isPollTick(node) {
  for (let current = node.parent; current && (!ts.isFunctionLike(current) || isPromiseExecutor(current)); current = current.parent) {
    if (ts.isForOfStatement(current) || ts.isForInStatement(current)) return false
    if (ts.isWhileStatement(current) || ts.isDoStatement(current) || ts.isForStatement(current)) {
      const clock = loopExits(current)
      return clock.bounded && clock.event
    }
  }
  return false
}

function enclosingStatement(node) {
  let current = node
  while (current.parent && !isScope(current.parent)) current = current.parent
  return current
}

function position(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

export function scanSource(path, source) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bindings = collectBindings(sourceFile)
  const findings = []
  const record = (node, signal, detail) => {
    const statement = enclosingStatement(node).getText(sourceFile).replace(/\s+/g, ' ').trim().slice(0, KEY_TEXT_LENGTH)
    findings.push({ file: path, line: position(sourceFile, node), at: node.getStart(sourceFile), signal, detail, statement })
  }
  const visit = (node) => {
    const sleep = ts.isCallExpression(node) ? sleepSignal(node, bindings) : undefined
    if (sleep) {
      if (!isPollTick(node)) record(node, 'fixed-sleep', sleep)
    } else {
      const deadline = deadlineSignal(node, bindings)
      if (deadline) record(node, 'short-deadline', deadline)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return withKeys(findings)
}

// An approval names the site by what decides it — file, signal, resolved number, enclosing statement —
// never by its line number, so an unrelated edit above it cannot turn a correct tree red, while a new
// number or a rewritten statement does. Identical sites in one file are told apart by their order.
function withKeys(findings) {
  const seen = new Map()
  return [...findings]
    .sort((left, right) => left.at - right.at || left.signal.localeCompare(right.signal))
    .map((finding) => {
      const base = `${finding.file}:${finding.signal}:${finding.detail}:${finding.statement}`
      const ordinal = (seen.get(base) ?? 0) + 1
      seen.set(base, ordinal)
      return { file: finding.file, line: finding.line, signal: finding.signal, detail: finding.detail, key: ordinal === 1 ? base : `${base}#${ordinal}` }
    })
}

export function scanFixedWaits(root = ROOT) {
  return TEST_ROOTS.flatMap((directory) => testFilesUnder(resolve(root, directory)))
    .map((path) => relative(root, path).replaceAll('\\', '/'))
    .filter((path) => path !== SELF)
    .flatMap((path) => scanSource(path, readFileSync(resolve(root, path), 'utf8')))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.signal.localeCompare(right.signal))
}

export const EXEMPTION_CLASSES = ['duration-bound', 'not-a-wait', 'convertible']

// A named exemption says WHY the number is allowed. `convertible` admits a host-speed wait that is not
// converted yet, so it must name the card that owns the conversion; the other two classes are permanent.
export function validateAllowList(allowList = fixedWaitAllowList) {
  const problems = []
  for (const [key, entry] of allowList) {
    if (!EXEMPTION_CLASSES.includes(entry?.class)) problems.push(`${key}: class must be one of ${EXEMPTION_CLASSES.join(', ')}`)
    if (!entry?.reason?.trim()) problems.push(`${key}: reason is required`)
    if (entry?.class === 'convertible' && !/^\d+$/.test(entry.card ?? '')) problems.push(`${key}: a convertible exemption must name its owning card id`)
  }
  return problems
}

export function approvalEntry(finding) {
  return `  [${JSON.stringify(finding.key)}, { class: '<duration-bound|not-a-wait|convertible>', reason: '<one line>' }],`
}

export function checkFixedWaits(root = ROOT, allowList = fixedWaitAllowList) {
  const findings = scanFixedWaits(root)
  const foundKeys = new Set(findings.map((finding) => finding.key))
  return {
    findings,
    unapproved: findings.filter((finding) => !allowList.has(finding.key)),
    stale: [...allowList.keys()].filter((key) => !foundKeys.has(key)),
    invalid: validateAllowList(allowList),
  }
}

export function formatFinding(finding, allowList = fixedWaitAllowList) {
  const entry = allowList.get(finding.key)
  return `${finding.file}:${finding.line} ${finding.signal}: ${finding.detail}${entry ? ` [${entry.class}${entry.card ? ` card ${entry.card}` : ''}: ${entry.reason}]` : ''}`
}

function summary(findings, allowList) {
  const counts = new Map()
  for (const finding of findings) {
    const bucket = allowList.get(finding.key)?.class ?? 'unapproved'
    counts.set(`${finding.signal}/${bucket}`, (counts.get(`${finding.signal}/${bucket}`) ?? 0) + 1)
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([bucket, count]) => `${bucket}: ${count}`).join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = checkFixedWaits()
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result.findings, null, 2)}\n`)
  else process.stdout.write(`${result.findings.map((finding) => formatFinding(finding)).join('\n')}\n\n${summary(result.findings, fixedWaitAllowList)}\n`)
  if (process.argv.includes('--check') && (result.unapproved.length || result.stale.length || result.invalid.length)) {
    if (result.unapproved.length) process.stderr.write(`Fixed waits without a named exemption:\n${result.unapproved.map((finding) => formatFinding(finding)).join('\n')}\nWait on the event instead (a line, a file, a process state) under a cap above ${SHORT_DEADLINE_MS} ms, or add to scripts/fixed-wait-allow-list.mjs:\n${result.unapproved.map(approvalEntry).join('\n')}\n`)
    if (result.stale.length) process.stderr.write(`Stale fixed-wait exemptions:\n${result.stale.join('\n')}\n`)
    if (result.invalid.length) process.stderr.write(`Invalid fixed-wait exemptions:\n${result.invalid.join('\n')}\n`)
    process.exitCode = 1
  }
}
