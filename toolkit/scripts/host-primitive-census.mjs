import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { isInvokedDirectly } from '../../plugin/bin/lib/host/entry-guard.mjs'
import { listGitIgnoredPaths, pathsRegexSource } from './git-ignored-inputs.mjs'

const DEFAULT_PLUGIN_ROOT = resolve(import.meta.dirname, '../../plugin')
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process'])
const FILESYSTEM_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises'])
const OS_MODULES = new Set(['os', 'node:os'])
const PROCESS_MODULES = new Set(['process', 'node:process'])
const REQUIRE_FACTORY_MODULES = new Set(['module', 'node:module'])
const HOST_MODULES = new Set([...CHILD_PROCESS_MODULES, ...FILESYSTEM_MODULES, ...OS_MODULES])
const EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs'])
// A parser of Bash command text, the Git Bash spelling of a Windows path, and the quoting of commands printed for a POSIX shell: their `/` and
// `\` literals are command text and shell or JSON escapes, whatever the host. Only the separator check
// is skipped for them; their imports and host calls are counted like any other file's.
const SHELL_GRAMMAR_FILES = new Set(['bin/lib/git-bash-path.mjs', 'bin/lib/rm-critical-path-core.mjs', 'bin/lib/remedy-quote.mjs'])

// Legacy host access is declared per source file and primitive kind. A declaration for
// plugin/<file> lives at host-primitive-allow-list/<file>.json and contains positive
// occurrence counts keyed by primitive. Pure new modules need no declaration. Reductions
// lower only that file's counts; unrelated files never share a budget or an edited list.
const DEFAULT_ALLOW_LIST_ROOT = resolve(import.meta.dirname, 'host-primitive-allow-list')
const declarationSources = new WeakMap()
const FIXED_PRIMITIVES = new Set([
  'child_process import', 'child_process require', 'fs import', 'fs require',
  'fs/promises import', 'fs/promises require', 'os import', 'os require',
  'process.platform', 'process.kill', 'literal /proc', 'hard-coded path separator',
])

// Host call kinds are identifier names from import/require bindings or property access.
// In particular, a colon can never be part of a call kind and cannot shift the file boundary.
function isPrimitiveKind(primitive) {
  return FIXED_PRIMITIVES.has(primitive) || /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(primitive)
}

export function hostDeclarationFile(path, root, pathApi = { relative, sep }) {
  return pathApi.relative(root, path).split(pathApi.sep).join('/')
}

function declarationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return declarationFiles(path)
    return entry.isFile() && entry.name.endsWith('.json') ? [path] : []
  })
}

export function loadHostPrimitiveAllowList(root = DEFAULT_ALLOW_LIST_ROOT) {
  const allowance = new Map()
  const files = []
  for (const path of declarationFiles(root)) {
    const file = hostDeclarationFile(path, root).slice(0, -'.json'.length)
    files.push(file)
    const counts = JSON.parse(readFileSync(path, 'utf8'))
    if (!counts || Array.isArray(counts) || typeof counts !== 'object') throw new Error(`Invalid host declaration: ${file}`)
    for (const [primitive, count] of Object.entries(counts)) {
      if (!isPrimitiveKind(primitive)) throw new Error(`Invalid host primitive kind: ${file}:${primitive}`)
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`Invalid host allowance: ${file}:${primitive}`)
      allowance.set(`${file}:${primitive}`, count)
    }
  }
  declarationSources.set(allowance, files)
  return allowance
}

export function hostPrimitiveCounts(findings) {
  const counts = new Map()
  for (const { file, primitive } of findings) {
    const key = `${file}:${primitive}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function isWithinRoot(root, path) {
  const input = relative(root, path)
  return input !== '..' && !input.startsWith(`..${sep}`) && !isAbsolute(input)
}

function sourceEntry(path, root) {
  try {
    const target = realpathSync(path)
    return isWithinRoot(root, target) ? { target, stat: statSync(target) } : null
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null
    throw error
  }
}

function consumeShebangQuote(state, character) {
  if (state.escaped) {
    state.word += character
    state.escaped = false
  } else if (character === '\\' && state.quote !== "'") state.escaped = true
  else if (state.quote) {
    if (character === state.quote) state.quote = ''
    else state.word += character
  } else if (character === '"' || character === "'") state.quote = character
  else return false
  return true
}

function shebangWords(command) {
  const words = []
  const state = { word: '', quote: '', escaped: false }
  for (const character of command) {
    if (consumeShebangQuote(state, character)) continue
    if (/\s/.test(character)) {
      if (state.word) words.push(state.word)
      state.word = ''
    } else state.word += character
  }
  return state.quote || state.escaped ? [] : [...words, state.word].filter(Boolean)
}

function envInterpreter(words) {
  while (words.length) {
    const word = words.shift()
    if (word === '-S' || word === '--split-string') continue
    if (word.startsWith('--split-string=')) return envInterpreter([...shebangWords(word.slice(15)), ...words])
    if (word.startsWith('-S')) return envInterpreter([...shebangWords(word.slice(2)), ...words])
    if (['-u', '--unset', '-C', '--chdir', '-a', '--argv0'].includes(word)) {
      words.shift()
      continue
    }
    if (word.startsWith('-') || /^[A-Za-z_]\w*=/.test(word)) continue
    return word
  }
  return undefined
}

function isNodeShebang(shebang) {
  // The kernel's direct interpreter path is not shell text. Only env's command
  // words need quote handling; unmatched quotes in direct Node arguments are literal.
  const command = shebang.slice(2).trimStart().split(/\s/, 1)[0]
  const executable = command.split(/[\/\\]/).at(-1)
  const interpreter = executable === 'env'
    ? envInterpreter(shebangWords(shebang.slice(2)).slice(1))?.split(/[\/\\]/).at(-1) : executable
  return interpreter === 'node' || interpreter === 'node.exe'
}

function isExecutableSource(path) {
  if (EXECUTABLE_EXTENSIONS.has(extname(path))) return true
  const bytes = readFileSync(path)
  if (bytes[0] !== 35 || bytes[1] !== 33) return false
  const newline = bytes.indexOf(10)
  const shebang = bytes.subarray(0, newline === -1 ? bytes.length : newline).toString('utf8')
  return isNodeShebang(shebang)
}

export function sourceFiles(root) {
  root = realpathSync(root)
  const ignoredSource = pathsRegexSource(listGitIgnoredPaths(root).paths, root, root)
  const ignored = ignoredSource ? new RegExp(ignoredSource) : null
  const hostRoot = join(root, 'bin', 'lib', 'host')
  // Generated third-party YAML grammar literals are not host access (same exemption
  // as the generated observatory launcher); their source is byte-identity checked.
  const generated = new Set([join(root, 'bin', 'wt-observe.mjs'), join(root, 'bin', 'lib', 'vendor', 'yaml.mjs')])
  const seenDirectories = new Set([root])
  const seenFiles = new Set()
  const excluded = (path, directory) => {
    const input = hostDeclarationFile(path, root) + (directory ? '/' : '')
    return !isWithinRoot(root, path) || isWithinRoot(hostRoot, path) || generated.has(path) || ignored?.test(input)
  }
  function walk(directory) {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name)
      const entry = sourceEntry(path, root)
      if (!entry) return []
      const { target, stat } = entry
      const isDirectory = stat.isDirectory()
      if (excluded(path, isDirectory) || excluded(target, isDirectory)) return []
      if (isDirectory) {
        if (seenDirectories.has(target)) return []
        seenDirectories.add(target)
        return walk(target)
      }
      if (!stat.isFile() || seenFiles.has(target) || !isExecutableSource(path)) return []
      seenFiles.add(target)
      return [target]
    })
  }
  return walk(root)
}

// Normalize transparent syntax at every expression boundary, rather than teaching
// each loader, receiver, callee and computed key its own parenthesis spellings.
function unwrapExpression(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isPartiallyEmittedExpression(node)) node = node.expression
  return node
}

function literalExpressionText(node) {
  return node && literalText(unwrapExpression(node))
}

function isNodeImport(symbol, moduleNames, names) {
  return symbol?.declarations?.some((declaration) => {
    let statement = declaration
    while (statement && !ts.isImportDeclaration(statement)) statement = statement.parent
    if (!statement || !moduleNames.has(statement.moduleSpecifier.text)) return false
    const name = ts.isImportSpecifier(declaration) ? declaration.propertyName?.text ?? declaration.name.text
      : ts.isNamespaceImport(declaration) ? '*' : 'default'
    return names.includes(name)
  }) ?? false
}

function isNodeNamespace(symbol, moduleNames, checker) {
  if (isNodeImport(symbol, moduleNames, ['default', '*'])) return true
  return symbol?.declarations?.some((declaration) => ts.isVariableDeclaration(declaration)
    && ts.isIdentifier(declaration.name) && declaration.initializer
    && loadedModule(declaration.initializer, checker, moduleNames)) ?? false
}

function isNodeRequireFactory(node, checker) {
  node = unwrapExpression(node)
  const member = accessName(node) === 'createRequire'
  const receiver = member ? unwrapExpression(node.expression) : node
  if (!ts.isIdentifier(receiver)) return false
  return isNodeImport(bindingSymbol(checker, receiver), REQUIRE_FACTORY_MODULES, member ? ['default', '*'] : ['createRequire'])
}

function isNodeRequireBinding(symbol, checker) {
  return symbol.declarations?.some((declaration) => {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false
    const initializer = unwrapExpression(declaration.initializer)
    if (!ts.isCallExpression(initializer)) return false
    return isNodeRequireFactory(initializer.expression, checker)
  }) ?? false
}

function isGlobalIdentifier(node, name, checker) {
  node = unwrapExpression(node)
  if (!ts.isIdentifier(node) || node.text !== name) return false
  const symbol = bindingSymbol(checker, node)
  // The JS binder synthesizes CommonJS require symbols without declarations.
  // Actual lexical shadows always carry their source declarations.
  if (!symbol?.declarations?.length) return true
  if (name === 'process') return isNodeNamespace(symbol, PROCESS_MODULES, checker)
  return name === 'require' && isNodeRequireBinding(symbol, checker)
}

function requiredModule(node, checker, moduleNames = HOST_MODULES) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1
    || !isGlobalIdentifier(node.expression, 'require', checker)) return null
  const name = literalExpressionText(node.arguments[0])
  return moduleNames.has(name) ? name : null
}

function importedModule(node, moduleNames = HOST_MODULES) {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null
  const name = literalExpressionText(node.arguments[0])
  return moduleNames.has(name) ? name : null
}

function loadedModule(node, checker, moduleNames = HOST_MODULES) {
  let awaited = false
  node = unwrapExpression(node)
  while (ts.isAwaitExpression(node)) {
    awaited = true
    node = unwrapExpression(node.expression)
  }
  return requiredModule(node, checker, moduleNames) ?? (awaited ? importedModule(node, moduleNames) : null)
}

function bindingSymbol(checker, node) {
  if (ts.isShorthandPropertyAssignment(node.parent)) return checker.getShorthandAssignmentValueSymbol(node.parent)
  return checker.getSymbolAtLocation(node)
}

function recordHostImport(statement, direct, namespaces, checker) {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
    && HOST_MODULES.has(statement.moduleSpecifier.text)) {
    const bindings = statement.importClause?.namedBindings
    if (statement.importClause?.name) namespaces.add(bindingSymbol(checker, statement.importClause.name))
    recordImportBindings(bindings, direct, namespaces, checker)
    return true
  }
  return false
}

function recordImportBindings(bindings, direct, namespaces, checker) {
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      direct.set(bindingSymbol(checker, element.name), element.propertyName?.text ?? element.name.text)
    }
  } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindingSymbol(checker, bindings.name))
}

function bindingPrimitive(element) {
  if (!element.propertyName) return element.name.text
  return ts.isComputedPropertyName(element.propertyName) ? literalExpressionText(element.propertyName.expression) : element.propertyName.text
}

function isNamespacePattern(element) {
  const primitive = bindingPrimitive(element)
  return element.dotDotDotToken || primitive === undefined || primitive === 'promises' || primitive === 'default'
}

function recordHostPrototype(pattern, direct, namespaces, checker) {
  if (!ts.isObjectBindingPattern(pattern)) return
  for (const element of pattern.elements) {
    if (bindingPrimitive(element) === 'prototype') {
      recordHostPattern(element.name, direct, namespaces, checker)
    }
  }
}

function recordHostPattern(pattern, direct, namespaces, checker) {
  if (ts.isIdentifier(pattern)) namespaces.add(bindingSymbol(checker, pattern))
  if (!ts.isObjectBindingPattern(pattern)) return
  for (const element of pattern.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
      // Nested namespaces and exported prototypes retain host identity. Other
      // primitive properties (for example readFileSync.name) remain metadata.
      if (isNamespacePattern(element)) {
        recordHostPattern(element.name, direct, namespaces, checker)
      }
      else recordHostPrototype(element.name, direct, namespaces, checker)
    }
    else {
      const primitive = bindingPrimitive(element)
      if (primitive !== undefined) direct.set(bindingSymbol(checker, element.name), primitive)
    }
  }
}

function recordHostVariable(declaration, direct, namespaces, checker) {
  if (declaration.initializer && loadedModule(declaration.initializer, checker)) {
    recordHostPattern(declaration.name, direct, namespaces, checker)
  }
}

function hostBindings(sourceFile) {
  // Bind only this parsed file: lexical symbols distinguish shadowing without resolving
  // host imports, loading libraries, or reading other source files.
  const options = { allowJs: true, allowNonTsExtensions: true, noLib: true, noResolve: true, types: [] }
  const program = ts.createProgram([sourceFile.fileName], options, {
    ...ts.createCompilerHost(options),
    getSourceFile: () => sourceFile,
  })
  assertParseable(sourceFile, program.getSyntacticDiagnostics(sourceFile))
  const checker = program.getTypeChecker()
  const direct = new Map()
  const namespaces = new Set()
  const visit = (node) => {
    recordHostImport(node, direct, namespaces, checker)
    if (ts.isVariableDeclaration(node)) recordHostVariable(node, direct, namespaces, checker)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { direct, namespaces, checker }
}

function accessRoot(node) {
  let current = unwrapExpression(node)
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression)
  }
  return current
}

function literalText(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

function accessName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) return literalExpressionText(node.argumentExpression)
  return undefined
}

function isRelativeModuleURL(node, value) {
  const parent = node.parent
  if (!/^\.{1,2}\//.test(value) || !ts.isNewExpression(parent) || !ts.isIdentifier(parent.expression)
    || parent.expression.text !== 'URL' || parent.arguments?.length !== 2 || parent.arguments[0] !== node) return false
  return isImportMetaURL(parent.arguments[1])
}

function isImportMetaURL(base) {
  return ts.isPropertyAccessExpression(base) && base.name.text === 'url'
    && ts.isMetaProperty(base.expression) && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && base.expression.name.text === 'meta'
}

function isHardCodedPathSeparator(node, value) {
  if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) return false
  if (isRelativeModuleURL(node, value)) return false
  if (value === '/' || value === '\\') return true
  if (/^(?:\.{1,2}|~)?[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return true
  return ts.isRegularExpressionLiteral(node) && /\\\\|\[.*[\\/].*\]/.test(node.text)
}

function isValueReference(node) {
  if (ts.isShorthandPropertyAssignment(node.parent)) return true
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return false
  return ts.isInExpressionContext(node)
}

function collectHostCall(node, bindings, add) {
  const required = requiredModule(node, bindings.checker)
  const imported = importedModule(node)
  if (required) add(node, `${required.replace('node:', '')} require`)
  if (imported) add(node, `${imported.replace('node:', '')} import`)
  const callee = unwrapExpression(node.expression)
  const name = accessName(callee)
  if (name !== undefined) {
    const root = accessRoot(callee.expression)
    const namespace = ts.isIdentifier(root) && bindings.namespaces.has(bindingSymbol(bindings.checker, root))
    if (namespace || loadedModule(root, bindings.checker)) add(node, name)
  }
}

function collectProcessAccess(node, checker, add) {
  const name = accessName(node)
  if (name !== undefined && isGlobalIdentifier(node.expression, 'process', checker)) {
    if (name === 'platform' || name === 'kill') add(node, `process.${name}`)
  }
}

function collectHostAccess(node, bindings, add) {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && HOST_MODULES.has(node.moduleSpecifier.text)) {
    add(node, `${node.moduleSpecifier.text.replace('node:', '')} import`)
  }
  if (ts.isCallExpression(node)) collectHostCall(node, bindings, add)
  collectProcessAccess(node, bindings.checker, add)
  if (ts.isIdentifier(node) && isValueReference(node)) {
    const primitive = bindings.direct.get(bindingSymbol(bindings.checker, node))
    if (primitive !== undefined) add(node, primitive)
  }
}

function assertParseable(sourceFile, diagnostics) {
  const diagnostic = diagnostics[0]
  if (diagnostic) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    throw new Error(`Unparseable host source: ${sourceFile.fileName}:${line + 1}:${character + 1}: ${message}`)
  }
}

function scanFile(path, root) {
  const source = readFileSync(path, 'utf8')
  const file = hostDeclarationFile(path, root)
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const bindings = hostBindings(sourceFile)
  const findings = []
  const add = (node, primitive) => findings.push({
    file,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    primitive,
  })

  const visit = (node) => {
    collectHostAccess(node, bindings, add)
    const value = literalText(node)
    if (value !== undefined) {
      if (/^\/proc(?:\/|$)/.test(value)) add(node, 'literal /proc')
      if (!SHELL_GRAMMAR_FILES.has(file) && isHardCodedPathSeparator(node, value)) add(node, 'hard-coded path separator')
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return findings
}

export function scanHostPrimitives(root = DEFAULT_PLUGIN_ROOT) {
  root = realpathSync(root)
  const files = sourceFiles(root)
  const findings = files.flatMap((path) => scanFile(path, root))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.primitive.localeCompare(right.primitive))
  return { perimeterFiles: files.length, findings }
}

export function checkHostPrimitives(root = DEFAULT_PLUGIN_ROOT, allowance = loadHostPrimitiveAllowList()) {
  root = realpathSync(root)
  const result = scanHostPrimitives(root)
  const counts = hostPrimitiveCounts(result.findings)
  const violations = [...new Set([...counts.keys(), ...allowance.keys()])].flatMap((key) => {
    const count = counts.get(key) ?? 0
    const allowed = allowance.get(key) ?? 0
    return count !== allowed ? [{ key, count, allowed }] : []
  })
  const sources = new Set(sourceFiles(root).map((path) => hostDeclarationFile(path, root)))
  for (const file of declarationSources.get(allowance) ?? []) {
    if (!sources.has(file)) violations.push({ key: file, count: 0, allowed: 0, missingSource: true })
  }
  const declaredCount = [...allowance.values()].reduce((total, count) => total + count, 0)
  return { ...result, count: result.findings.length, declaredCount, violations, exceeded: violations.length > 0 }
}

export function formatHostPrimitiveRefusal(result) {
  return [
    'Raw host primitive declaration mismatch:',
    ...result.violations.flatMap(({ key, count, allowed, missingSource }) => {
      const file = missingSource ? key : key.slice(0, key.lastIndexOf(':'))
      const quoted = `'${file.replaceAll("'", "'\\''")}'`
      return [
        missingSource ? `  ${file}: declaration has no source file` : `  ${key}: ${count} ${count > allowed ? '>' : '<'} ${allowed}`,
        `  Regenerate/lower: pnpm --dir toolkit exec node scripts/host-primitive-census.mjs --update-declaration ${quoted}`,
      ]
    }),
    'Remedy: Move host access behind plugin/bin/lib/host/, then lower the affected per-file declaration.',
    'For approved legacy access, declare its primitive counts in toolkit/scripts/host-primitive-allow-list/<plugin-relative-file>.json.',
    'Recheck with: pnpm --dir toolkit quality:host',
  ].join('\n')
}

export function updateHostPrimitiveDeclaration(file, root = DEFAULT_PLUGIN_ROOT, declarations = DEFAULT_ALLOW_LIST_ROOT) {
  const source = resolve(root, file)
  if (hostDeclarationFile(source, root) !== file || file.startsWith('../')) throw new Error(`Invalid source file: ${file}`)
  const findings = scanHostPrimitives(root).findings.filter((finding) => finding.file === file)
  const counts = Object.fromEntries([...hostPrimitiveCounts(findings)].map(([key, count]) => [key.slice(file.length + 1), count]))
  const target = resolve(declarations, `${file}.json`)
  if (findings.length === 0) rmSync(target, { force: true })
  else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(counts, null, 2)}\n`)
  }
}

if (isInvokedDirectly(import.meta.url)) {
  if (process.argv[2] === '--update-declaration' && process.argv.length === 4) {
    updateHostPrimitiveDeclaration(process.argv[3])
  } else {
    const result = checkHostPrimitives()
    process.stdout.write(`Raw host primitives: ${result.count} (${result.declaredCount} declared) across ${result.perimeterFiles} perimeter files.\n`)
    if (result.exceeded) {
      process.stderr.write(`${formatHostPrimitiveRefusal(result)}\n`)
      process.exitCode = 1
    }
  }
}
