import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
// @ts-expect-error ESM census module
import { scanHostPrimitives, sourceFiles } from '../../../scripts/host-primitive-census.mjs'
// @ts-expect-error Function-hook collector ships as JavaScript source text
import { SNAPSHOT_PROGRAM } from '../../../../plugin/hooks/snapshot-program.js'

const ROOT = resolve(import.meta.dirname, '../../../../plugin')
const PROC_SEGMENTS = new Set(['stat', 'cmdline', 'status', 'cwd', 'environ', 'fd', 'fdinfo', 'uptime', 'loadavg'])

function isProcRoot(node: ts.Node): boolean {
  return (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && /^\/proc(?:\/|$)/.test(node.text)
}

function isProcJoin(node: ts.Node, ast: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node) || !/(?:^|\.)join$/.test(node.expression.getText(ast))) return false
  if (/^(?:procRoot|procDir|processDir)$/.test(node.arguments[0]?.getText(ast) ?? '')) return true
  return node.arguments.some((arg) => ts.isStringLiteralLike(arg) && PROC_SEGMENTS.has(arg.text))
}

function parsedViolations(file: string, source: string, descriptorsOnly = false): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const violations: string[] = []
  const visit = (node: ts.Node) => {
    if (!descriptorsOnly && isProcRoot(node)) {
      violations.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: procfs root`)
    }
    if (isProcJoin(node, ast)) violations.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: procfs path construction`)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return violations
}

describe('procfs host perimeter', () => {
  it('keeps every census procfs literal inside the host boundary', () => {
    const findings = scanHostPrimitives().findings.filter((finding: { primitive: string }) => finding.primitive === 'literal /proc')
    expect(findings, 'procfs root literals belong only to plugin/bin/lib/host').toEqual([])
  })

  it('also keeps template roots and embedded collector paths inside the host boundary', () => {
    const files: string[] = [...sourceFiles(ROOT), join(ROOT, 'hooks', 'snapshot-cli')]
    const violations = files.flatMap((file) => parsedViolations(relative(ROOT, file), readFileSync(file, 'utf8')))
    violations.push(...parsedViolations('hooks/snapshot-program.js:collector', SNAPSHOT_PROGRAM))
    expect(violations, 'procfs reads and path construction belong only to the host boundary').toEqual([])
  })

  it('keeps wake-floor descriptor and repeated identity paths behind named host operations', () => {
    const file = 'bin/lib/wake-floor-in-flight.mjs'
    const violations = parsedViolations(file, readFileSync(join(ROOT, file), 'utf8'), true)
    expect(violations, 'wake-floor must not construct stat, cmdline, environ, cwd, fd, or fdinfo paths').toEqual([])
  })
})
