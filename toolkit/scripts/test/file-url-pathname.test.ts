import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'

const TOOLKIT = join(import.meta.dirname, '../..')
const temporaryDirectories: string[] = []

function fixtureSource(text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'file-url-pathname-'))
  temporaryDirectories.push(root)
  const file = join(root, 'probe.test.ts')
  writeFileSync(file, text)
  return file
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) rmSync(root, { recursive: true, force: true })
})

function testFiles(dir: string, scripts = false): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return []
    const file = join(dir, entry.name)
    if (entry.isDirectory()) return testFiles(file, scripts)
    return entry.isFile() && (scripts ? /\.(?:[cm]?[jt]s)$/.test(file) : file.endsWith('.test.ts') && relative(TOOLKIT, file).split(/[\\/]/).includes('test')) ? [file] : []
  })
}

function pathnameOffenders(file: string, parseSource = ts.createSourceFile): string[] {
  const text = readFileSync(file, 'utf8')
  if (!text.includes('pathname') && !/\\u[0-9a-fA-F{]/.test(text)) return []
  return unfilteredPathnameOffenders(file, text, parseSource)
}

// The original unfiltered guard is also the comparison oracle for the candidate filter.
function unfilteredPathnameOffenders(file: string, text = readFileSync(file, 'utf8'), parseSource = ts.createSourceFile): string[] {
  const source = parseSource(file, text, ts.ScriptTarget.Latest, true)
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
  expect(files.flatMap((file) => pathnameOffenders(file))).toEqual([])
})

const SOURCE_CASES = [
  { title: 'literal property', text: "const u = new URL('./x', import.meta.url); u.pathname", flagged: true, parses: 1 },
  { title: 'escaped property', text: "const u = new URL('./x', import.meta.url); u.\\u0070athname", flagged: true, parses: 1 },
  { title: 'braced escape', text: "new URL('./x', import.meta.url).\\u{70}athname", flagged: true, parses: 1 },
  { title: 'file scheme', text: "new URL('file:///tmp/x', import.meta.url).pathname", flagged: true, parses: 1 },
  { title: 'neither token', text: 'export const pure = true', flagged: false, parses: 0 },
  { title: 'unrelated escape', text: 'const \\u0061 = 1', flagged: false, parses: 1 },
  { title: 'unrelated property', text: 'const u = {}; u.pathname', flagged: false, parses: 1 },
  { title: 'remote URL', text: "new URL('https://example.test', import.meta.url).pathname", flagged: false, parses: 1 },
]

it.each(SOURCE_CASES)('candidate filter: $title', ({ text, flagged, parses }) => {
  const file = fixtureSource(text)
  const parseSource = vi.fn(ts.createSourceFile)
  if (text.includes('\\u') && flagged) expect(readFileSync(file, 'utf8')).not.toContain('pathname')

  expect(pathnameOffenders(file, parseSource)).toEqual(flagged ? [`${relative(TOOLKIT, file)}:1`] : [])
  expect(parseSource).toHaveBeenCalledTimes(parses)
})

it.each(SOURCE_CASES)('matches the unfiltered base guard: $title', ({ text }) => {
  const file = fixtureSource(text)

  expect(pathnameOffenders(file)).toEqual(unfilteredPathnameOffenders(file))
  expect(readFileSync(file, 'utf8')).toBe(text)
})

it('preserves the unfiltered base guard read error', () => {
  const missing = join(fixtureSource(''), '..', 'missing.test.ts')

  expect(() => pathnameOffenders(missing)).toThrowError(expect.objectContaining({ code: 'ENOENT' }))
  expect(() => unfilteredPathnameOffenders(missing)).toThrowError(expect.objectContaining({ code: 'ENOENT' }))
})
