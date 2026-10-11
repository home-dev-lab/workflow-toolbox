import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error ESM census module
import { scanHostPrimitives } from '../../../scripts/host-primitive-census.mjs'

const ROOT = resolve(import.meta.dirname, '../../../../plugin')
const GENERATED = new Set([join(ROOT, 'bin', 'wt-observe.mjs'), join(ROOT, 'bin', 'lib', 'vendor', 'yaml.mjs')])
const RAW_PARENT_TABLE = /(?:\[['"]-eo['"],\s*['"]pid=,ppid=['"]\]|Get-CimInstance\s+Win32_Process[^\n]*ParentProcessId)/
const temporaryDirectories: string[] = []

function sourceFiles(directory: string, hostRoot: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return path === hostRoot ? [] : sourceFiles(path, hostRoot)
    return entry.isFile() && extname(path) === '.mjs' && !GENERATED.has(path) ? [path] : []
  })
}

function processTableViolations(root: string): string[] {
  return sourceFiles(root, join(root, 'bin', 'lib', 'host'))
    .filter((path) => RAW_PARENT_TABLE.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path).replaceAll('\\', '/'))
}

function fixturePlugin(): string {
  const root = mkdtempSync(join(tmpdir(), 'host-process-perimeter-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, 'bin', 'lib', 'host'), { recursive: true })
  return root
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pid to parent-pid host perimeter', () => {
  it('keeps every raw signal and liveness primitive inside the host adapter', () => {
    expect(scanHostPrimitives().findings.filter((finding: { primitive: string }) => finding.primitive === 'process.kill')).toEqual([])
  })

  it('keeps the raw process-table primitive inside the host adapter', () => {
    expect(processTableViolations(ROOT)).toEqual([])
  })

  it.each([
    'execFileSync("ps", ["-eo", "pid=,ppid="])',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId',
  ])('catches a raw process table in a newly discovered module: %s', (source) => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'new-module.mjs'), source)

    expect(processTableViolations(root)).toEqual(['bin/new-module.mjs'])
  })

  it('accepts additional pure modules and process-table calls confined to the adapter', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'pure.mjs'), 'export const pure = true\n')
    writeFileSync(join(root, 'bin', 'lib', 'host', 'process-table.mjs'), 'execFileSync("ps", ["-eo", "pid=,ppid="])')

    expect(processTableViolations(root)).toEqual([])
  })

  it.each([
    'execFileSync("ps", ["-eo", "pid=,ppid="])',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId',
  ])('detects process-table operations in ordinary nested bin/lib modules: %s', (source) => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'lib', 'ordinary.mjs'), source)

    expect(processTableViolations(root)).toEqual(['bin/lib/ordinary.mjs'])
  })
})
