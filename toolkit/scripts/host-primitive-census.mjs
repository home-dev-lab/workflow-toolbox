import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { isInvokedDirectly } from '../../plugin/bin/lib/host/entry-guard.mjs'
import { listGitIgnoredPaths, pathsRegexSource } from './git-ignored-inputs.mjs'

const DEFAULT_PLUGIN_ROOT = resolve(import.meta.dirname, '../../plugin')
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process'])
const FILESYSTEM_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises'])
const OS_MODULES = new Set(['os', 'node:os'])
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

function isExecutableSource(path) {
  if (EXECUTABLE_EXTENSIONS.has(extname(path))) return true
  const bytes = readFileSync(path)
  if (bytes[0] !== 35 || bytes[1] !== 33) return false
  const newline = bytes.indexOf(10)
  const shebang = bytes.subarray(0, newline === -1 ? bytes.length : newline).toString('utf8')
  return /^#![^\r\n]*(?:[\/\\]|\s)node(?:[ \t\r]|$)/.test(shebang)
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

function requiredModule(node) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1 || !ts.isIdentifier(node.expression)
    || node.expression.text !== 'require' || !ts.isStringLiteral(node.arguments[0])) return null
  return HOST_MODULES.has(node.arguments[0].text) ? node.arguments[0].text : null
}

function importedModule(node) {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword
    || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) return null
  return HOST_MODULES.has(node.arguments[0].text) ? node.arguments[0].text : null
}

function loadedModule(node) {
  while (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression
  return requiredModule(node) ?? importedModule(node)
}

function recordHostImport(statement, direct, namespaces) {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
    && HOST_MODULES.has(statement.moduleSpecifier.text)) {
    const bindings = statement.importClause?.namedBindings
    if (statement.importClause?.name) namespaces.add(statement.importClause.name.text)
    recordImportBindings(bindings, direct, namespaces)
    return true
  }
  return false
}

function recordImportBindings(bindings, direct, namespaces) {
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      direct.set(element.name.text, element.propertyName?.text ?? element.name.text)
    }
  } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
}

function recordHostVariable(declaration, direct, namespaces) {
  const moduleName = declaration.initializer && loadedModule(declaration.initializer)
  if (!moduleName) return
  if (ts.isIdentifier(declaration.name)) namespaces.add(declaration.name.text)
  if (ts.isObjectBindingPattern(declaration.name)) {
    for (const element of declaration.name.elements) {
      if (!ts.isIdentifier(element.name)) continue
      const imported = element.propertyName?.text ?? element.name.text
      direct.set(element.name.text, imported)
    }
  }
}

function hostBindings(sourceFile) {
  const direct = new Map()
  const namespaces = new Set()
  for (const statement of sourceFile.statements) {
    if (recordHostImport(statement, direct, namespaces)) continue
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) recordHostVariable(declaration, direct, namespaces)
  }
  return { direct, namespaces }
}

function rootIdentifier(node) {
  let current = node
  while (accessName(current) !== undefined) current = current.expression
  return ts.isIdentifier(current) ? current.text : null
}

function literalText(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

function accessName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) return literalText(node.argumentExpression)
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
  const required = requiredModule(node)
  const imported = importedModule(node)
  if (required) add(node, `${required.replace('node:', '')} require`)
  if (imported) add(node, `${imported.replace('node:', '')} import`)
  const name = accessName(node.expression)
  if (name !== undefined) {
    const root = rootIdentifier(node.expression)
    if (root && bindings.namespaces.has(root)) add(node, name)
    if (loadedModule(node.expression.expression)) add(node, name)
  }
}

function collectProcessAccess(node, add) {
  const name = accessName(node)
  if (name !== undefined && ts.isIdentifier(node.expression) && node.expression.text === 'process') {
    if (name === 'platform' || name === 'kill') add(node, `process.${name}`)
  }
}

function collectHostAccess(node, bindings, add) {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && HOST_MODULES.has(node.moduleSpecifier.text)) {
    add(node, `${node.moduleSpecifier.text.replace('node:', '')} import`)
  }
  if (ts.isCallExpression(node)) collectHostCall(node, bindings, add)
  collectProcessAccess(node, add)
  if (ts.isIdentifier(node) && bindings.direct.has(node.text) && isValueReference(node)) add(node, bindings.direct.get(node.text))
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
