import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { fixedWaitAllowList } from './fixed-wait-allow-list.mjs'

// Census of the waits a test makes on TIME rather than on an event.
//
// Two signals, both read from the TypeScript AST of every test file (code inside a string or a template
// literal — a fixture child's source — is never a call here, so it is never counted):
//
// - `fixed-sleep`: a pause whose length is a number — setTimeout(cb, N), await setTimeout(N) from
//   node:timers/promises, sleep(N), Atomics.wait(buffer, index, value, N). What happens after it is
//   decided by how fast the host was during those N milliseconds.
// - `short-deadline`: a bound of at most SHORT_DEADLINE_MS on something another process or thread
//   produces — `Date.now() + N`, an option or property named like a timeout, a wait helper's default
//   patience, or a number passed to a wait helper. A slow host crosses it with nothing wrong.
//
// A cap above SHORT_DEADLINE_MS on a predicate poll is the shape the suite wants (an event-driven wait
// with a generous cap), so it is not a signal. Every signal must be converted or carry a named
// exemption in fixed-wait-allow-list.mjs, keyed by its exact statement so moving it costs nothing and
// rewriting it needs a fresh decision.

const ROOT = resolve(import.meta.dirname, '..')
const TEST_ROOTS = ['packages', 'examples/test', 'scripts/test']
const SELF = 'scripts/test/fixed-wait-census.test.ts'
export const SHORT_DEADLINE_MS = 10_000
const DEADLINE_NAME = /(?:timeout|patience|deadline|^ms$|^wait)/i
const PROCESS_FUNCTIONS = new Set(['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'])
const WAIT_HELPER = /^(?:wait|poll|until|eventually)/i
const SLEEP_HELPER = /^(?:sleep|delay|pause)$/i

function testFilesUnder(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return testFilesUnder(path)
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  })
}

function literalValue(node, constants) {
  if (!node) return undefined
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''))
  if (ts.isParenthesizedExpression(node)) return literalValue(node.expression, constants)
  if (ts.isIdentifier(node)) return constants.get(node.text)
  if (ts.isBinaryExpression(node)) {
    const left = literalValue(node.left, constants)
    const right = literalValue(node.right, constants)
    if (left === undefined || right === undefined) return undefined
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right
  }
  return undefined
}

// A file-level `const NAME = <number>` is what most tests use to name a patience; resolving it keeps a
// named short number from hiding behind its name.
function collectConstants(sourceFile) {
  const constants = new Map()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const value = literalValue(declaration.initializer, constants)
      if (value !== undefined) constants.set(declaration.name.text, value)
    }
  }
  return constants
}

function calleeName(call) {
  if (ts.isIdentifier(call.expression)) return call.expression.text
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text
  return undefined
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  return undefined
}

function isShort(value) {
  return value !== undefined && value > 0 && value <= SHORT_DEADLINE_MS
}

function isDateNow(node) {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'Date'
    && node.expression.name.text === 'now'
}

function enclosingFunctionName(node) {
  let current = node.parent
  while (current && !ts.isFunctionLike(current)) current = current.parent
  if (!current) return undefined
  if (current.name && ts.isIdentifier(current.name)) return current.name.text
  if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text
  return undefined
}

// The `timeout` option of a child-process call kills the child when the host is slower than the number.
// Only that option is read: a `timeout` handed to the unit under test is the unit's input, not a wait
// the test makes, and counting those buried the real population under several hundred false hits.
function optionOfProcessCall(property) {
  const literal = property.parent
  if (!literal || !ts.isObjectLiteralExpression(literal)) return undefined
  const call = literal.parent
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(literal)) return undefined
  return PROCESS_FUNCTIONS.has(calleeName(call) ?? '') ? call : undefined
}

// `import { setTimeout as delay } from 'node:timers/promises'` is a sleep whatever the local name.
function collectTimerAliases(sourceFile) {
  const aliases = new Set()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!['timers/promises', 'node:timers/promises'].includes(statement.moduleSpecifier.text)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === 'setTimeout') aliases.add(element.name.text)
    }
  }
  return aliases
}

function sleepSignal(node, constants, timerAliases) {
  const name = calleeName(node)
  if (name === 'setTimeout' || (ts.isIdentifier(node.expression) && timerAliases.has(name))) {
    // setTimeout(cb, N) from the global, or await setTimeout(N) from node:timers/promises.
    const delay = node.arguments.length === 1 ? node.arguments[0] : node.arguments[1]
    const value = literalValue(delay, constants)
    return value !== undefined && value > 0 ? `setTimeout ${value} ms` : undefined
  }
  if (name === 'wait' && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Atomics') {
    const value = literalValue(node.arguments[3], constants)
    return value !== undefined && value > 0 ? `Atomics.wait ${value} ms` : undefined
  }
  if (name && SLEEP_HELPER.test(name)) {
    const value = literalValue(node.arguments[0], constants)
    return value !== undefined && value > 0 ? `${name} ${value} ms` : undefined
  }
  return undefined
}

function deadlineSignal(node, constants) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const value = isDateNow(node.left) ? literalValue(node.right, constants) : isDateNow(node.right) ? literalValue(node.left, constants) : undefined
    return isShort(value) ? `Date.now() + ${value} ms` : undefined
  }
  if (ts.isPropertyAssignment(node) && optionOfProcessCall(node)) {
    const name = propertyName(node.name)
    const value = literalValue(node.initializer, constants)
    return name === 'timeout' && isShort(value) ? `${calleeName(optionOfProcessCall(node))} timeout: ${value} ms` : undefined
  }
  if (ts.isParameter(node) && node.initializer && ts.isIdentifier(node.name) && DEADLINE_NAME.test(node.name.text)) {
    const owner = enclosingFunctionName(node)
    const value = literalValue(node.initializer, constants)
    return owner && WAIT_HELPER.test(owner) && isShort(value) ? `${owner}(${node.name.text} = ${value} ms)` : undefined
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node)
    if (!name || !WAIT_HELPER.test(name)) return undefined
    const short = node.arguments.map((argument) => literalValue(argument, constants)).find(isShort)
    return short === undefined ? undefined : `${name}(…, ${short} ms)`
  }
  return undefined
}

// The pause between two reads of a predicate, inside a loop that checks a deadline, is the tick of an
// event wait, not a wait on time: how long it is changes only how often the condition is read. The
// deadline that bounds the loop is examined on its own (`Date.now() + N`).
const LOOP_BOUND = /Date\.now\(\)|deadline|until/i

function isPromiseExecutor(fn) {
  return ts.isNewExpression(fn.parent) && ts.isIdentifier(fn.parent.expression) && fn.parent.expression.text === 'Promise'
}

function loopChecksDeadline(loop, sourceFile) {
  const condition = ts.isForStatement(loop) ? loop.condition : loop.expression
  if (condition && LOOP_BOUND.test(condition.getText(sourceFile))) return true
  const body = loop.statement
  const statements = ts.isBlock(body) ? body.statements : [body]
  return statements.some((statement) => ts.isIfStatement(statement) && LOOP_BOUND.test(statement.expression.getText(sourceFile)))
}

// Only the NEAREST loop decides: an outer loop that merely mentions a deadline does not make an inner
// pause the tick of a bounded wait.
function isPollTick(node, sourceFile) {
  let current = node.parent
  while (current && (!ts.isFunctionLike(current) || isPromiseExecutor(current))) {
    if (ts.isWhileStatement(current) || ts.isDoStatement(current) || ts.isForStatement(current)) return loopChecksDeadline(current, sourceFile)
    current = current.parent
  }
  return false
}

function position(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

export function scanSource(path, source) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const constants = collectConstants(sourceFile)
  const timerAliases = collectTimerAliases(sourceFile)
  const findings = []
  const visit = (node) => {
    const sleep = ts.isCallExpression(node) ? sleepSignal(node, constants, timerAliases) : undefined
    if (sleep && isPollTick(node, sourceFile)) { /* the tick of an event wait; its deadline is read on its own */ }
    else if (sleep) findings.push({ file: path, line: position(sourceFile, node), signal: 'fixed-sleep', detail: sleep })
    else {
      const deadline = deadlineSignal(node, constants)
      if (deadline) findings.push({ file: path, line: position(sourceFile, node), signal: 'short-deadline', detail: deadline })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return withStatementKeys(findings, source.split('\n'))
}

// An approval names the STATEMENT, never its line number: an unrelated edit above it must not turn a
// correct tree red. Identical statements in one file are told apart by their order.
function withStatementKeys(findings, lines) {
  const seen = new Map()
  const unique = new Map()
  for (const finding of findings) unique.set(`${finding.line}\0${finding.signal}\0${finding.detail}`, finding)
  return [...unique.values()]
    .sort((left, right) => left.line - right.line || left.signal.localeCompare(right.signal) || left.detail.localeCompare(right.detail))
    .map((finding) => {
      const base = `${finding.file}:${finding.signal}:${(lines[finding.line - 1] ?? '').trim().slice(0, 160)}`
      const ordinal = (seen.get(base) ?? 0) + 1
      seen.set(base, ordinal)
      return { ...finding, key: ordinal === 1 ? base : `${base}#${ordinal}` }
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
