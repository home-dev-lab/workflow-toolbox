import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const TOOLKIT = join(import.meta.dirname, '../..')

function testFiles(dir: string, scripts = false): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return []
    const file = join(dir, entry.name)
    if (entry.isDirectory()) return testFiles(file, scripts)
    return entry.isFile() && (scripts ? /\.(?:[cm]?[jt]s)$/.test(file) : file.endsWith('.test.ts') && relative(TOOLKIT, file).split(/[\\/]/).includes('test')) ? [file] : []
  })
}

function pathnameOffenders(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const fileUrl = (node: ts.Node): node is ts.NewExpression =>
    ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' &&
    node.arguments?.length === 2 && node.arguments[1].getText(source) === 'import.meta.url' &&
    !(ts.isStringLiteral(node.arguments[0]) && /^https?:\/\//.test(node.arguments[0].text))
  const names = new Set<string>()
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && fileUrl(node.initializer)) names.add(node.name.text)
    ts.forEachChild(node, collect)
  }
  collect(source)
  const offenders: string[] = []
  const check = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'pathname' &&
      (fileUrl(node.expression) || (ts.isIdentifier(node.expression) && names.has(node.expression.text)))) {
      offenders.push(`${relative(TOOLKIT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
    }
    ts.forEachChild(node, check)
  }
  check(source)
  return offenders
}

it('never uses the pathname of a file URL as a filesystem path in toolkit tests', () => {
  const files = [...testFiles(join(TOOLKIT, 'packages')), ...testFiles(join(TOOLKIT, 'scripts', 'test'), true)]
  expect(files.flatMap(pathnameOffenders)).toEqual([])
})
