import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const DEFAULT_PLUGIN_ROOT = resolve(import.meta.dirname, '../../plugin')
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process'])
const FILESYSTEM_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises'])
const OS_MODULES = new Set(['os', 'node:os'])
const HOST_MODULES = new Set([...CHILD_PROCESS_MODULES, ...FILESYSTEM_MODULES, ...OS_MODULES])
const EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs'])

// Ratchet reseeded 2026-09-21 after adding .js/.cjs plus complete child-process,
// filesystem and OS module calls. It may only decrease as calls move behind the adapter.
export const HOST_PRIMITIVE_CEILING = 1936

function sourceFiles(root) {
  const hostRoot = join(root, 'bin', 'lib', 'host')
  const generated = new Set([join(root, 'bin', 'wt-observe.mjs')])
  function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return path === hostRoot ? [] : walk(path)
      return entry.isFile() && EXECUTABLE_EXTENSIONS.has(extname(path)) && !generated.has(path) ? [path] : []
    })
  }
  return walk(root)
}

function requiredModule(node) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1 || !ts.isIdentifier(node.expression)
    || node.expression.text !== 'require' || !ts.isStringLiteral(node.arguments[0])) return null
  return HOST_MODULES.has(node.arguments[0].text) ? node.arguments[0].text : null
}

function hostBindings(sourceFile) {
  const direct = new Map()
  const namespaces = new Set()
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && HOST_MODULES.has(statement.moduleSpecifier.text)) {
      const bindings = statement.importClause?.namedBindings
      if (statement.importClause?.name) namespaces.add(statement.importClause.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          direct.set(element.name.text, element.propertyName?.text ?? element.name.text)
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const moduleName = declaration.initializer && requiredModule(declaration.initializer)
      if (!moduleName) continue
      if (ts.isIdentifier(declaration.name)) namespaces.add(declaration.name.text)
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) continue
          const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text
          direct.set(element.name.text, imported)
        }
      }
    }
  }
  return { direct, namespaces }
}

function rootIdentifier(node) {
  let current = node
  while (ts.isPropertyAccessExpression(current)) current = current.expression
  return ts.isIdentifier(current) ? current.text : null
}

function literalText(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

function isHardCodedPathSeparator(node, value) {
  if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) return false
  if (value === '/' || value === '\\') return true
  if (/^(?:\.{1,2}|~)?[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return true
  return ts.isRegularExpressionLiteral(node) && /\\\\|\[.*[\\/].*\]/.test(node.text)
}

function scanFile(path, root) {
  const source = readFileSync(path, 'utf8')
  const file = relative(root, path).replaceAll('\\', '/')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const bindings = hostBindings(sourceFile)
  const findings = []
  const add = (node, primitive) => findings.push({
    file,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    primitive,
  })

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && HOST_MODULES.has(node.moduleSpecifier.text)) {
      add(node, CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text) ? 'child_process import' : `${node.moduleSpecifier.text.replace('node:', '')} import`)
    }
    if (ts.isCallExpression(node) && requiredModule(node)) add(node, `${requiredModule(node).replace('node:', '')} require`)

    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'process' && node.name.text === 'platform') add(node, 'process.platform')
      if (node.expression.text === 'process' && node.name.text === 'kill') add(node, 'process.kill')
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && bindings.direct.has(node.expression.text)) add(node, bindings.direct.get(node.expression.text))
      if (ts.isPropertyAccessExpression(node.expression)) {
        const root = rootIdentifier(node.expression)
        if (root && bindings.namespaces.has(root)) add(node, node.expression.name.text)
        if (requiredModule(node.expression.expression)) add(node, node.expression.name.text)
      }
    }

    const value = literalText(node)
    if (value !== undefined) {
      if (/^\/proc(?:\/|$)/.test(value)) add(node, 'literal /proc')
      if (isHardCodedPathSeparator(node, value)) add(node, 'hard-coded path separator')
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return findings
}

export function scanHostPrimitives(root = DEFAULT_PLUGIN_ROOT) {
  const files = sourceFiles(root)
  const findings = files.flatMap((path) => scanFile(path, root))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.primitive.localeCompare(right.primitive))
  return { perimeterFiles: files.length, findings }
}

export function checkHostPrimitives(root = DEFAULT_PLUGIN_ROOT, ceiling = HOST_PRIMITIVE_CEILING) {
  const result = scanHostPrimitives(root)
  return { ...result, count: result.findings.length, ceiling, exceeded: result.findings.length > ceiling }
}

export function formatHostPrimitiveRefusal(result) {
  const files = [...new Set(result.findings.map((finding) => finding.file))]
  return [
    `Raw host primitive ceiling exceeded: ${result.count} > ${result.ceiling}.`,
    'Files containing counted primitives:',
    ...files.map((file) => `  ${file}`),
    'Remedy: Move host access behind plugin/bin/lib/host/, then lower HOST_PRIMITIVE_CEILING to the measured count.',
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = checkHostPrimitives()
  process.stdout.write(`Raw host primitives: ${result.count}/${result.ceiling} across ${result.perimeterFiles} perimeter files.\n`)
  if (result.exceeded) {
    process.stderr.write(`${formatHostPrimitiveRefusal(result)}\n`)
    process.exitCode = 1
  }
}
